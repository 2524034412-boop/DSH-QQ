#!/usr/bin/env node
// 开机自启：确保 DSH / SnowLuma 在跑，再对齐 DSH 端口并拉起桥接。
// 由「开机自启.vbs」在登录时以隐藏窗口调用；日志写 state/autostart.log。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const LOG = path.join(STATE, 'autostart.log');
const DSH_EXE = 'D:\\DSH\\DeepSeek Harness.exe';
const QQ_EXE = 'D:\\QQ\\QQ.exe';
const SNOWLUMA_DIR = 'D:\\snowlunar\\SnowLuma-v1.14.22-win-x64 (1)';
const SNOWLUMA_NODE = path.join(SNOWLUMA_DIR, 'node.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`;
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch {}
  try { process.stdout.write(line); } catch {}
}

function tasklistHas(image) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], {
      encoding: 'utf8', windowsHide: true
    });
    return out.toLowerCase().includes(image.toLowerCase());
  } catch { return false; }
}

function portListening(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).some((l) => l.includes('LISTENING') && l.includes(`127.0.0.1:${port} `));
  } catch { return false; }
}

function startDetached(file, args, cwd) {
  const child = spawn(file, args, {
    cwd, detached: true, windowsHide: true, stdio: 'ignore'
  });
  child.unref();
  return child.pid;
}

async function main() {
  log('──────── autostart begin ────────');

  // 1) DSH
  if (!tasklistHas('DeepSeek Harness.exe')) {
    log('DSH 未运行，启动…');
    // 用 spawn + stdio:'ignore'，不要 cmd /c start + execFileSync：
    // execFileSync 会等 stdout 管道关闭，而 start 拉起的 DSH 继承了那个管道句柄，
    // 于是「管道永不关闭 → execFileSync 永不返回」（2026-10-29 看门狗就是这样卡死的）。
    try {
      const child = spawn(DSH_EXE, [], { cwd: 'D:\\DSH', detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      log(`DSH 已拉起（PID ${child.pid}）`);
    } catch (e) {
      log(`DSH 启动失败：${e.message}`);
    }
  } else {
    log('DSH 已在运行');
  }

  // 2) QQ：通常由注册表 Run 键（QQNT）自启；这里兜底，并给 QQ 一点登录时间
  if (!tasklistHas('QQ.exe')) {
    log('QQ 未运行，启动…');
    try {
      const child = spawn(QQ_EXE, [], { cwd: 'D:\\QQ', detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      log(`QQ 已拉起（PID ${child.pid}）`);
    } catch (e) {
      log(`QQ 启动失败：${e.message}`);
    }
  } else {
    log('QQ 已在运行');
  }
  // 原来这里最多等 20×3s＝60 秒，再加 5 秒「登录缓冲」：QQ 没开的时候，点一次「对接」
  // 就要干等 65 秒才有反应（2026-10-31 早上就是这么慢的）。
  // 但桥接本身不依赖 QQ —— 它只需要 DSH；QQ 起来之后 SnowLuma 会自己重新注入。
  // 所以这里只等 10 秒确认进程出现，剩下的交给看门狗和 SnowLuma。
  for (let i = 0; i < 4 && !tasklistHas('QQ.exe'); i++) await sleep(2500);
  if (!tasklistHas('QQ.exe')) {
    log('⚠️ QQ 还没起来：先继续对齐桥接（QQ 起来后 SnowLuma 会自己注入）');
  } else {
    await sleep(1500); // 给自动登录留一点时间，减少「注入早于登录」的竞态
  }

  // 3) SnowLuma（端口 5099 在听就认为已运行）
  if (!portListening(5099)) {
    log('SnowLuma 未运行，启动…');
    try {
      const pid = startDetached(SNOWLUMA_NODE, ['index.mjs'], SNOWLUMA_DIR);
      log(`SnowLuma 已拉起（PID ${pid}）`);
    } catch (e) {
      log(`SnowLuma 启动失败：${e.message}`);
    }
  } else {
    log('SnowLuma 已在运行');
  }

  // 3) 等 DSH 就绪后对齐端口并拉起桥接（最多等 180 秒）
  log('等待 DSH 就绪并对齐端口…');
  await new Promise((resolve) => {
    const outFd = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'align-dsh-port.mjs'), '--wait', '180'], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', outFd, outFd]
    });
    child.on('exit', (code) => {
      try { fs.closeSync(outFd); } catch {}
      log(`align 退出码 ${code}`);
      resolve();
    });
    child.on('error', (e) => {
      log(`align 启动失败：${e.message}`);
      resolve();
    });
  });

  log('──────── autostart end ────────');

  // 4) 看门狗：每 10 分钟自检，缺什么补什么（单实例）
  startWatchdogIfNeeded();
}

// 锁里的 PID 可能已经被系统复用给别的进程（watchdog.lock 只存数字）。
// 以前只做 process.kill(pid, 0) 探测，遇到 PID 复用就永远认为「看门狗已在运行」，
// 于是看门狗死了也再没人拉起。这里额外核对命令行里是否真的有 watchdog.mjs。
function pidIsWatchdog(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`
    ], { encoding: 'utf8', windowsHide: true });
    return /watchdog\.mjs/i.test(out);
  } catch { return false; }
}

function startWatchdogIfNeeded() {
  const lock = path.join(STATE, 'watchdog.lock');
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (pid > 0 && pidIsWatchdog(pid)) { log('看门狗已在运行'); return; }
    if (pid > 0) log(`看门狗锁里的 PID ${pid} 不是看门狗（PID 被复用？），重新拉起`);
  } catch {}
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'watchdog.mjs')], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore'
    });
    child.unref();
    log(`看门狗已启动（PID ${child.pid}）`);
  } catch (e) {
    log(`看门狗启动失败：${e.message}`);
  }
}

main().catch((e) => log(`autostart 异常：${e?.message ?? e}`));
