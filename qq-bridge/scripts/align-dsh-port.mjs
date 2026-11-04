#!/usr/bin/env node
// 一键对齐 DSH 端口并（重）启动 qq-bridge。
// 用途：DSH 每次启动端口可能变化，双击“一键对齐DSH端口.cmd”即可：
//   1) 扫描本机 127.0.0.1 监听端口，用 DSH 特有的 401 响应识别当前 DSH 端口；
//   2) 把 config.json 的 dsh.baseUrl 改成该端口；
//   3) 停掉旧桥接、清锁、重新拉起，并检查 SnowLuma / DSH 是否连上。
// 不依赖任何外部包，node 运行时用桥接启动脚本里同一个。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config.json');
const STATE = path.join(ROOT, 'state');
const LOG_OUT = path.join(STATE, 'run-out.log');
const LOG_ERR = path.join(STATE, 'run-err.log');
const CONSOLE_PORT = 3100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => console.log(s);

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function localhostPorts() {
  const out = sh('netstat', ['-ano']);
  const set = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue;
    const cols = line.trim().split(/\s+/);
    const m = /^127\.0\.0\.1:(\d+)$/.exec(cols[1] || '');
    if (m) set.add(Number(m[1]));
  }
  return [...set].sort((a, b) => a - b);
}

async function isDsh(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    const body = await r.text();
    // DSH 的未鉴权响应体：dsh web authentication required; reopen the URL printed by dsh web.
    return body.includes('dsh web authentication required');
  } catch {
    return false;
  }
}

function isListening(port) {
  try {
    const out = sh('netstat', ['-ano']);
    return out.split(/\r?\n/).some((l) => l.includes('LISTENING') && l.includes(`127.0.0.1:${port} `));
  } catch {
    return false;
  }
}

function bridgePids() {
  // 以前只找 Name='node.exe'。但桥接也可能是 Electron 以 node 模式拉起来的
  // （DSH 插件用 process.execPath 启动时会变成 "DeepSeek Harness.exe"），
  // 那样就漏掉不杀 —— 旧实例占着 3100，新实例 EADDRINUSE，「一键对接」看着成功其实没连上。
  // 现在按命令行匹配，不看进程名。
  const ps = [
    'Get-CimInstance Win32_Process |',
    "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*qq-bridge*' -and $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*align-dsh-port*' } |",
    'ForEach-Object { $_.ProcessId }'
  ].join(' ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', windowsHide: true
    });
    return out.split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try { sh('taskkill', ['/PID', String(pid), '/F']); } catch {}
}

async function main() {
  say('════════ qq-bridge 一键对齐 DSH 端口 ════════');

  // --wait <秒>：开机自启时 DSH 可能还没起来，最多等这么久。
  const waitIdx = process.argv.indexOf('--wait');
  const waitSec = waitIdx >= 0 ? Math.max(0, Number(process.argv[waitIdx + 1]) || 180) : 0;
  const deadline = Date.now() + waitSec * 1000;
  let found = [];
  for (;;) {
    const ports = localhostPorts();
    const probes = await Promise.all(ports.map(async (p) => ({ p, ok: await isDsh(p) })));
    found = probes.filter((x) => x.ok).map((x) => x.p);
    if (found.length) break;
    if (Date.now() >= deadline) break;
    say('⏳ 等待 DSH 启动…');
    await sleep(3000);
  }

  if (!found.length) {
    say('❌ 没找到正在运行的 DSH Web 服务。');
    say('   请先打开 DeepSeek Harness，再双击本脚本。');
    process.exitCode = 1;
    return;
  }
  const port = found[0];
  const baseUrl = `http://127.0.0.1:${port}`;
  say(`🔎 当前 DSH：${baseUrl}`);

  // 1) 对齐 config.json
  let raw;
  try {
    raw = fs.readFileSync(CONFIG, 'utf8');
  } catch (e) {
    say(`❌ 读不到 config.json：${e.message}`);
    process.exitCode = 1;
    return;
  }
  let oldBase = '';
  try { oldBase = JSON.parse(raw)?.dsh?.baseUrl ?? ''; } catch {}
  if (oldBase === baseUrl) {
    say('✅ config.json 里的 dsh.baseUrl 已是最新');
  } else {
    const next = raw.replace(/("baseUrl"\s*:\s*")[^"]*(")/, `$1${baseUrl}$2`);
    fs.writeFileSync(CONFIG, next, 'utf8');
    say(`✏️  已更新 config.json：${oldBase || '(空)'} → ${baseUrl}`);
  }

  // 2) 重启桥接
  const old = bridgePids();
  for (const p of old) {
    say(`⏹  停止旧桥接 PID ${p}`);
    killPid(p);
  }
  try { fs.unlinkSync(path.join(STATE, 'bridge.lock')); } catch {}
  await sleep(1500);
  // 等端口真的放出来：旧实例退出要一点时间，抢跑就会 EADDRINUSE。
  for (let i = 0; i < 10 && isListening(CONSOLE_PORT); i++) await sleep(500);
  if (isListening(CONSOLE_PORT)) {
    say(`⚠️  端口 ${CONSOLE_PORT} 还被占着 —— 新桥接可能起不来。`);
    say('   看看是不是有别的程序（或没权限结束的旧桥接）占着这个端口。');
  }

  let outFd;
  let errFd;
  // 日志是追加的：记下当前长度，后面只看「这次启动之后」新增的部分。
  // 否则上一次成功留下的「DSH 已就绪」还在，会让这次的失败被当成成功（2026-11-04 踩到）。
  let logFrom = 0;
  try { logFrom = fs.statSync(LOG_OUT).size; } catch {}
  try {
    // 'a' 而不是 'w'：每次重启都把上一次的日志清空，等于把「按了按钮之后发生过什么」
    // 的证据一起删掉（2026-10-29 排查 oneclick 时因此丢了一整段记录）。
    outFd = fs.openSync(LOG_OUT, 'a');
    errFd = fs.openSync(LOG_ERR, 'a');
  } catch (e) {
    say(`❌ 无法写 state 日志：${e.message}`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd]
  });
  child.unref();
  try { fs.closeSync(outFd); fs.closeSync(errFd); } catch {}
  say(`▶️  已启动桥接 PID ${child.pid}`);

  // 3) 等它连上 —— 以桥接自己的 /diag 为准。
  // 不看 run-out.log 了：stdout 重定向到文件是块缓冲的，连上了也可能还没落盘，
  // 于是明明成功却报「未连接」（2026-11-04 就是这样误报的）。/diag 免令牌、直读真状态。
  let consoleUp = false;
  let diag = null;
  let log = '';
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    consoleUp = isListening(CONSOLE_PORT);
    try { log = fs.readFileSync(LOG_OUT, 'utf8').slice(logFrom); } catch {}
    try {
      const r = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/diag`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) diag = await r.json();
    } catch {}
    if (consoleUp && diag && diag.dsh === true && diag.snowluma === true) break;
  }

  const snowlumaOk = !!(diag && diag.snowluma === true);
  const dshOk = !!(diag && diag.dsh === true);
  const onebotUp = !!(diag && diag.onebot === true) || (isListening(3000) && isListening(3001));

  say('');
  say(`控制台：${consoleUp ? '✅' : '❌'} http://127.0.0.1:${CONSOLE_PORT}`);
  say(`SnowLuma：${snowlumaOk ? '✅ 已连接' : '❌ 未连接'}`);
  say(`DSH：${dshOk ? '✅ 已就绪' : '❌ 未就绪'}`);
  say(`OneBot：${onebotUp ? '✅ 3000/3001 在听' : '❌ 3000/3001 未监听'}`);

  if (!snowlumaOk || !onebotUp) {
    say('');
    say('👉 请检查 SnowLuma：打开 http://127.0.0.1:5099 →「进程注入」→ 刷新 → 加载 QQ 进程');
  }
  if (!dshOk) {
    say('');
    say('👉 DSH 没连上：确认 DSH 已打开，然后重跑本脚本。');
  }
  say('');
  if (snowlumaOk && dshOk && consoleUp) say('🎉 一切就绪，可以正常聊了。');
}

main().catch((e) => {
  console.error('❌ 脚本出错：', e?.message ?? e);
  process.exitCode = 1;
});
