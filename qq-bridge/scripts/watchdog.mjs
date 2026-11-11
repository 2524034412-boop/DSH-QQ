#!/usr/bin/env node
// 看门狗：每 10 分钟检查一遍，缺什么补什么。
//   - DSH 没起来 → 启动 DSH，等它就绪
//   - SnowLuma（5099）没起来 → 拉起
//   - 桥接（3100）没起来，或 config 的 baseUrl 与 DSH 实际端口不一致 → 跑一键对齐（会重启桥接）
//   - SnowLuma 在、但 OneBot（3000/3001）连续两次都没起来 → 重启 SnowLuma 重新注入
// 用法：
//   node scripts/watchdog.mjs            # 常驻，每 10 分钟一次
//   node scripts/watchdog.mjs --once     # 只检查一次就退出（自检用）
// 日志：state/watchdog.log；单实例锁：state/watchdog.lock
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const LOG = path.join(STATE, 'watchdog.log');
const LOCK = path.join(STATE, 'watchdog.lock');
const CONFIG = path.join(ROOT, 'config.json');
const DSH_EXE = 'D:\\DSH\\DeepSeek Harness.exe';
const SNOWLUMA_DIR = 'D:\\snowlunar\\SnowLuma-v1.14.22-win-x64 (1)';
const SNOWLUMA_NODE = path.join(SNOWLUMA_DIR, 'node.exe');

const ONCE = process.argv.includes('--once');
const INTERVAL_MS = Math.max(30_000, Number(process.env.WATCHDOG_INTERVAL_MS || 10 * 60 * 1000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`;
  try {
    try {
      const st = fs.statSync(LOG);
      if (st.size > 1024 * 1024) fs.writeFileSync(LOG, '');
    } catch {}
    fs.appendFileSync(LOG, line, 'utf8');
  } catch {}
  try { process.stdout.write(line); } catch {}
}

function tasklistHas(image) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { encoding: 'utf8', windowsHide: true });
    return out.toLowerCase().includes(image.toLowerCase());
  } catch { return false; }
}

function listening(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).some((l) => l.includes('LISTENING') && l.includes(`127.0.0.1:${port} `));
  } catch { return false; }
}

function localhostPorts() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    const set = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const m = /^127\.0\.0\.1:(\d+)$/.exec((line.trim().split(/\s+/)[1]) || '');
      if (m) set.add(Number(m[1]));
    }
    return [...set].sort((a, b) => a - b);
  } catch { return []; }
}

async function findDshPort() {
  for (const port of localhostPorts()) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200) });
      const body = await r.text();
      if (body.includes('dsh web authentication required')) return port;
    } catch {}
  }
  return null;
}

// 以前是 execFileSync('cmd', ['/c','start', ...])：execFileSync 要等 stdout 管道关闭，
// 而 start 拉起的 DSH 会继承那个管道句柄 → **cmd 早退了，管道却一直开着**，
// execFileSync 就永远不返回。2026-10-29 21:35 就是这样卡死的：日志停在「DSH 不可达」，
// 之后既没有超时日志也没有下一次 check，看门狗活着但再也不干活。
// 改成 spawn + stdio:'ignore'（不建管道）+ detached：立刻返回，DSH 自己跑。
function startDsh() {
  try {
    const child = spawn(DSH_EXE, [], { cwd: 'D:\\DSH', detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log(`DSH 未运行 → 已拉起（PID ${child.pid}）`);
  } catch (e) {
    log(`DSH 启动失败：${e.message}`);
  }
}

function startSnowluma() {
  try {
    const child = spawn(SNOWLUMA_NODE, ['index.mjs'], { cwd: SNOWLUMA_DIR, detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    log(`SnowLuma 未运行 → 已拉起（PID ${child.pid}）`);
  } catch (e) {
    log(`SnowLuma 启动失败：${e.message}`);
  }
}

async function runAlign(waitSec) {
  return new Promise((resolve) => {
    const outFd = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'align-dsh-port.mjs'), '--wait', String(waitSec)], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', outFd, outFd]
    });
    child.on('exit', (code) => {
      try { fs.closeSync(outFd); } catch {}
      resolve(code);
    });
    child.on('error', (e) => {
      log(`align 启动失败：${e.message}`);
      resolve(-1);
    });
  });
}

function configBaseUrl() {
  try {
    return String(JSON.parse(fs.readFileSync(CONFIG, 'utf8'))?.dsh?.baseUrl ?? '');
  } catch {
    return '';
  }
}

let onebotDownStreak = 0;
// 只有「OneBot 曾经正常过、后来掉了」才值得重启 SnowLuma；
// 如果 QQ 本来就没登录（夜间关机/未登录），重启 SnowLuma 是白折腾，只会刷日志。
let everSeenOneBotUp = false;
// 开机后首次恢复：QQ 已在跑但 OneBot 一直没起来（注入早于登录 / hook 卡住），
// 允许主动重启一次 SnowLuma 重新注入；只做一次，避免反复折腾。
let bootRecoveryTried = false;

async function checkOnce() {
  log('──── check ────');
  const fixes = [];

  // 0) 夜间休眠：她已在群里道过晚安，DSH 是用户主动关的 → 到早上之前不要把它拉起来。
  let nightSleep = null;
  try {
    const p = path.join(ROOT, 'state', 'dsh-sleep.json');
    if (fs.existsSync(p)) nightSleep = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  if (nightSleep && Number(nightSleep.until) > Date.now()) {
    const left = Math.round((Number(nightSleep.until) - Date.now()) / 60000);
    log(`夜间休眠中（还有 ${left} 分钟），跳过 DSH 启动`);
    return;
  }
  if (nightSleep) {
    try { fs.unlinkSync(path.join(ROOT, 'state', 'dsh-sleep.json')); } catch {}
    log('夜间休眠已结束，恢复自检');
  }

  // 1) DSH
  let dshPort = await findDshPort();
  if (!dshPort) {
    log('DSH 不可达');
    startDsh();
    for (let i = 0; i < 30 && !dshPort; i++) {
      await sleep(3000);
      dshPort = await findDshPort();
    }
    if (dshPort) log(`DSH 已就绪：127.0.0.1:${dshPort}`);
    else log('⚠️ DSH 等待超时（180 秒）');
  }

  // 2) SnowLuma
  if (!listening(5099)) {
    log('SnowLuma（5099）不在监听');
    startSnowluma();
    await sleep(8000);
    fixes.push('snowluma');
  }

  // 2.5) 精调语音（GPT-SoVITS）常驻服务
  try {
    const cfgNow = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (cfgNow.socialV2?.voice?.engine === 'gptsovits' && cfgNow.socialV2?.voice?.keepWarm === true && !listening(9880)) {
      log('TTS 服务（9880）不在监听 → 启动');
      spawn('D:\\DSH\\tts\\venv\\Scripts\\pythonw.exe', ['-s', 'api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', 'GPT_SoVITS/configs/tts_infer.yaml'], {
        cwd: 'D:\\DSH\\tts\\GPT-SoVITS',
        env: {
          ...process.env,
          PYTHONPATH: 'D:\\DSH\\tts\\GPT-SoVITS;D:\\DSH\\tts\\GPT-SoVITS\\GPT_SoVITS',
          PATH: 'D:\\DSH\\tts\\bin;' + (process.env.PATH || ''),
          NLTK_DATA: 'D:\\DSH\\tts\\nltk_data',
          MPLCONFIGDIR: 'D:\\DSH\\tts\\cache\\mpl',
          TMP: 'D:\\DSH\\tts\\tmp',
          TEMP: 'D:\\DSH\\tts\\tmp',
          version: 'v2Pro'
        },
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref();
      fixes.push('tts');
    }
  } catch (e) {
    log('TTS 服务检查失败：' + (e?.message ?? e));
  }
  // 3) 桥接 / 端口对齐
  const needAlign = dshPort && (!listening(3100) || configBaseUrl() !== `http://127.0.0.1:${dshPort}`);
  if (needAlign) {
    if (!listening(3100)) log('桥接（3100）不在监听 → 重新拉起');
    else log(`baseUrl 与 DSH 实际端口不一致（${configBaseUrl()} ≠ 127.0.0.1:${dshPort}）→ 重新对齐`);
    const code = await runAlign(dshPort ? 60 : 180);
    log(`对齐脚本退出码 ${code}`);
    fixes.push('bridge');
  } else {
    log('桥接与端口正常');
  }

  // 4) OneBot（SnowLuma 在、但 3000/3001 没起来，通常是 QQ 掉线或 hook 退化）
  const snowUp = listening(5099);
  const onebotUp = listening(3000) && listening(3001);
  if (snowUp && !onebotUp) {
    onebotDownStreak += 1;
    log(`⚠️ SnowLuma 在但 OneBot 未监听（第 ${onebotDownStreak} 次）`);
    const bootRecover = !everSeenOneBotUp && !bootRecoveryTried && tasklistHas('QQ.exe');
    if (onebotDownStreak >= 2 && (everSeenOneBotUp || bootRecover)) {
      if (bootRecover) {
        bootRecoveryTried = true;
        log('QQ 在跑但 OneBot 一直没起来 → 开机恢复：重启 SnowLuma 重新注入（只尝试一次）');
      }
      log('连续两次异常 → 重启 SnowLuma 尝试重新注入');
      try {
        const procs = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.ExecutablePath -like '*snowlunar*' } | ForEach-Object { $_.ProcessId }"
        ], { encoding: 'utf8', windowsHide: true }).split(/\s+/).filter((x) => /^\d+$/.test(x));
        for (const pid of procs) {
          try { execFileSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true }); } catch {}
        }
      } catch {}
      await sleep(3000);
      startSnowluma();
      onebotDownStreak = 0;
      everSeenOneBotUp = false; // 重启后要重新观察到 OneBot 正常，才允许下一次自动重启
      fixes.push('snowluma-restart');
      await sleep(8000);
    }
  } else if (snowUp && onebotUp) {
    onebotDownStreak = 0;
    everSeenOneBotUp = true;
  }

  const ok = Boolean(dshPort) && listening(5099) && listening(3100) && listening(3000) && listening(3001);
  log(ok ? '✅ 全部正常' : '⚠️ 仍有异常，见上方日志');
  return { ok, fixes };
}

// 锁里只有 PID：PID 被系统复用时会误判「已有实例」而直接退出，
// 结果看门狗静默死掉、再没人拉起。所以再核对一次命令行是不是 watchdog.mjs。
function pidIsWatchdog(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`
    ], { encoding: 'utf8', windowsHide: true });
    return /watchdog\.mjs/i.test(out);
  } catch { return false; }
}

function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (pid > 0 && pidIsWatchdog(pid)) return false; // 已有实例
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid), 'utf8');
  return true;
}

function releaseLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (pid === process.pid) fs.unlinkSync(LOCK);
  } catch {}
}

async function main() {
  if (ONCE) {
    await checkOnce();
    return;
  }
  if (!acquireLock()) {
    console.log('已有看门狗在运行，退出');
    return;
  }
  log(`看门狗启动（PID ${process.pid}，每 ${Math.round(INTERVAL_MS / 60000)} 分钟检查）`);
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  for (;;) {
    try {
      await checkOnce();
    } catch (e) {
      log(`检查异常：${e?.message ?? e}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => log(`看门狗异常：${e?.message ?? e}`));
