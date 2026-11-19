// 邀请码管理
//   node webchat/invite.mjs new --note 朋友 --max 1 --hours 24
//   node webchat/invite.mjs list
//   node webchat/invite.mjs revoke ABC123

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
fs.mkdirSync(DATA, { recursive: true });
const INVITE_FILE = path.join(DATA, 'invites.json');

function read() { try { return JSON.parse(fs.readFileSync(INVITE_FILE, 'utf8')); } catch { return { codes: [] }; } }
function write(v) {
  const tmp = `${INVITE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
  fs.renameSync(tmp, INVITE_FILE);
}
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看错的 I O 0 1
function makeCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function status(c) {
  if (c.revoked) return '已收回';
  if (c.used >= c.maxUses) return '已用完';
  if (c.expiresAt && Date.now() > c.expiresAt) return '已过期';
  return '可用';
}

const cmd = process.argv[2] || 'list';
const db = read();

if (cmd === 'new') {
  const note = arg('note', '');
  const maxUses = Math.max(1, Math.min(50, Number(arg('max', 1)) || 1));
  const hours = Math.max(1, Math.min(720, Number(arg('hours', 72)) || 72));
  const isOwner = process.argv.includes('--owner');
  let code = makeCode();
  while (db.codes.some((c) => c.code === code)) code = makeCode();
  const entry = {
    code,
    note,
    maxUses,
    used: 0,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + hours * 3600_000,
    revoked: false,
    owner: isOwner,
  };
  db.codes.push(entry);
  write(db);
  console.log('');
  console.log('  邀请码：' + code);
  console.log(`  备注：${note || '(无)'}   可用 ${maxUses} 次    ${hours} 小时后过期${isOwner ? '（老大专用）' : ''}`);
  console.log('');
} else if (cmd === 'list') {
  if (!db.codes.length) { console.log('还没有邀请码。用 new 生成一个。'); process.exit(0); }
  console.log('');
  for (const c of db.codes) {
    const exp = c.expiresAt ? new Date(c.expiresAt).toLocaleString('zh-CN') : '永久';
    console.log(`  ${c.code}   ${status(c).padEnd(4)}  ${c.used}/${c.maxUses}   ${exp}   ${c.note || ''}`);
  }
  console.log('');
} else if (cmd === 'revoke') {
  const code = (process.argv[3] || '').toUpperCase();
  const c = db.codes.find((x) => x.code === code);
  if (!c) { console.log('没有这个码：' + code); process.exit(1); }
  c.revoked = true;
  write(db);
  console.log(`已收回 ${code}`);
} else {
  console.log('用法： new | list | revoke <code>');
}
