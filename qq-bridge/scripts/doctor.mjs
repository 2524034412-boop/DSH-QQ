// 一键体检：把所有"能不能用"变成红绿灯。
// 用法：node scripts/doctor.mjs [--json]
// 退出码：0 全绿；1 有红的（黄的不影响退出码）。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const asJson = process.argv.includes('--json');
const results = [];
const add = (level, name, detail, hint) => results.push({ level, name, detail, hint });

const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, file), 'utf8')); } catch { return fallback; }
};

function tcp(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function httpStatus(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

// 1) 桥接
const bridgeUp = await tcp(3100);
add(bridgeUp ? 'ok' : 'bad', '桥接 :3100', bridgeUp ? '在听' : '连不上',
  'cd D:\\DSH\\qq-bridge 后跑 start.bat');

// 2) 传感器接入端口
const sensorUp = await tcp(3101);
add(sensorUp ? 'ok' : 'bad', '传感器端口 :3101', sensorUp ? '在听' : '连不上', '桥接没起时它也不在');

// 3) SnowLuma（QQ 网关）
const wsUp = await tcp(3000);
const wsUp2 = await tcp(3001);
add(wsUp && wsUp2 ? 'ok' : 'bad', 'SnowLuma :3000/:3001', `${wsUp ? '3000✓' : '3000✗'} ${wsUp2 ? '3001✓' : '3001✗'}`,
  'QQ 掉线或 SnowLuma 没开；开机自启里有它');

// 4) DSH Web：端口以桥接运行时对齐后的为准（config 里的 baseUrl 可能已经过时）
const cfgRaw = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } })();
const consoleToken = (() => { try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();
let dshBase = String(cfgRaw.dsh?.baseUrl || 'http://127.0.0.1:3080');
try {
  const st = await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:3100/api/status?token=${encodeURIComponent(consoleToken)}`, { timeout: 3000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
  const live = st?.dsh?.baseUrl || st?.snowluma?.dshBaseUrl || st?.dshBaseUrl;
  if (live) dshBase = String(live);
} catch {}
const dshPort = Number(new URL(dshBase).port || 80);
const dshUp = await tcp(dshPort);
add(dshUp ? 'ok' : 'bad', `DSH :${dshPort}`, dshUp ? '在听' : '连不上', 'DSH 没开或端口变了；桥接的 align 脚本会自动对齐');

// 5) 传感器数据新鲜度
const env = readJson('environment.json');
if (!env || !Number(env.at)) {
  add('warn', '传感器读数', '还没有任何读数', '板子没插 / 采集器没跑 / 串口选错');
} else {
  const ageSec = Math.round((Date.now() - Number(env.at)) / 1000);
  const level = ageSec <= 120 ? 'ok' : ageSec <= 900 ? 'warn' : 'bad';
  add(level, '传感器读数', `${ageSec} 秒前 · ${env.tempC}°C / ${Math.round(env.humidity)}%`,
    ageSec > 900 ? '采集器可能挂了或板子被拔' : '');
  if (Number.isFinite(Number(env.motionAgo))) {
    const stuck = env.motion === true && Number(env.motionAgo) < 3;
    add(stuck ? 'warn' : 'ok', '人体感应', stuck ? '此刻报"有人"（如果你在动就正常）' : '没人动', '');
  }
}

// 6) 采集器进程 / 串口
const { execFileSync } = await import('node:child_process');
let comOk = false;
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    '[System.IO.Ports.SerialPort]::GetPortNames() -join ","'], { encoding: 'utf8', timeout: 8000 }).trim();
  comOk = /COM\d+/i.test(out);
  add(comOk ? 'ok' : 'bad', '串口', comOk ? out : '没找到串口设备', '板子没插 / 驱动没装 / 线只供电');
} catch {
  add('warn', '串口', '检测失败', '');
}

// 7) 记忆与历史规模
const mem = readJson('memory-global.json', { entries: [] });
const memCount = Array.isArray(mem.entries) ? mem.entries.length : 0;
const memLevel = memCount > 500 ? 'warn' : 'ok';
add(memLevel, '记忆', `${memCount} 条`, memCount > 500 ? '超过 500 条，考虑调低上限或手动整理' : '');

const histLines = (() => {
  try { return fs.readFileSync(path.join(STATE, 'environment-history.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
})();
add('ok', '环境历史', `${histLines} 条（上限 4000 ≈ 33 小时）`, '');

// 8) 账本大小
const ledger = (() => { try { return fs.statSync(path.join(STATE, 'token-usage.jsonl')).size; } catch { return 0; } })();
add(ledger > 8 * 1024 * 1024 ? 'warn' : 'ok', '花费账本', `${(ledger / 1024 / 1024).toFixed(2)} MB`, ledger > 8 * 1024 * 1024 ? '超过 8MB 会自动轮转' : '');

// 9) 余额（如果能读到）
const bal = readJson('balance.json');
if (bal && Number.isFinite(Number(bal.total ?? bal.balance))) {
  const v = Number(bal.total ?? bal.balance);
  add(v < 2 ? 'bad' : v < 10 ? 'warn' : 'ok', 'DeepSeek 余额', `¥${v.toFixed(2)}`, v < 10 ? '低于预警线' : '');
}

// 10) 面板可达
if (bridgeUp) {
  const token = (() => { try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();
  const code = await httpStatus(`http://127.0.0.1:3100/dashboard?token=${encodeURIComponent(token)}`);
  add(code === 200 ? 'ok' : 'warn', '控制面板', `HTTP ${code || '无响应'}`, code === 200 ? '' : '令牌可能不对，看 state/console-token');
}

if (asJson) {
  console.log(JSON.stringify({ at: Date.now(), results }, null, 2));
} else {
  const icon = { ok: '✅', warn: '⚠️', bad: '❌' };
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`小鲸鱼体检 · ${when}\n`);
  for (const r of results) {
    console.log(`${icon[r.level] || '·'} ${r.name.padEnd(18)} ${r.detail}`);
    if (r.hint && r.level !== 'ok') console.log(`   ↳ ${r.hint}`);
  }
  const bad = results.filter((r) => r.level === 'bad').length;
  const warn = results.filter((r) => r.level === 'warn').length;
  console.log(`\n合计：${results.filter((r) => r.level === 'ok').length} 绿 / ${warn} 黄 / ${bad} 红`);
}

process.exit(results.some((r) => r.level === 'bad') ? 1 : 0);