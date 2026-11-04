import fs from 'node:fs';
import { spawn } from 'node:child_process';

const token = fs.readFileSync('D:/DSH/qq-bridge/state/console-token', 'utf8').trim();
const dry = process.argv.includes('--dry');
const shutdown = process.argv.includes('--shutdown');

const res = await fetch('http://127.0.0.1:3100/api/console/goodnight', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify({ dry })
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
if (!res.ok) process.exitCode = 1;

if (shutdown && !dry) {
  console.log('60 秒后关机…');
  const child = spawn('shutdown', ['/s', '/t', '60', '/c', '晚安，去睡觉啦'], { detached: true, stdio: 'ignore' });
  child.unref();
}
