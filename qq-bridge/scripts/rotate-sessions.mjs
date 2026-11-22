#!/usr/bin/env node
// 让 QQ 那边换成新会话（新系统提示才会生效）。
// 用法：先停桥接，再跑 `node scripts/rotate-sessions.mjs --apply`，然后启动桥接。
// 不加 --apply 只预览。
import fs from 'node:fs';
import path from 'node:path';

const STATE = path.resolve('state');
const FILE = path.join(STATE, 'sessions.json');
const apply = process.argv.includes('--apply');

if (!fs.existsSync(FILE)) { console.log('找不到 state/sessions.json'); process.exit(1); }
const raw = fs.readFileSync(FILE, 'utf8');
const j = JSON.parse(raw);
const keys = Object.keys(j.sessions || {});
console.log('当前绑定', keys.length, '个会话：');
for (const k of keys) console.log('  ' + k + ' → ' + String(j.sessions[k]).slice(0, 16) + '…');

if (!apply) {
  console.log('\n（预览模式）加上 --apply 才会真的清空映射。');
  console.log('清空后：桥接启动时会为这些会话各开一个新的 DSH 会话；');
  console.log('记忆、人格、摘要仍会由桥接重新注入，历史聊天记录不受影响。');
  process.exit(0);
}

const bak = FILE + '.bak-rotate-' + new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(bak, raw, 'utf8');
console.log('\n已备份 →', path.basename(bak));

j.sessions = {};
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log('✅ 已清空会话映射（sessionPolicies 保留）');
console.log('现在启动桥接：它会为每个会话开新的 DSH 会话。');