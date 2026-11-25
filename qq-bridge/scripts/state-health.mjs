#!/usr/bin/env node
/**
 * 状态文件体检：一条命令看 9 个情感状态文件是不是活的。
 *
 *   node scripts/state-health.mjs
 *
 * 只读。输出：存在？能解析？多少条？最后写入？是不是「暂时没数据」还是「坏了」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE = path.join(ROOT, 'state');

/** 每个文件怎么算「条数」 */
const FILES = [
  ['mood.json', (j) => Object.keys(j.moods || j || {}).length, '当前情绪/衰减'],
  ['affinity.json', (j) => Object.keys(j.people || j || {}).length, '好感·喜爱·仇恨'],
  ['impressions.json', (j) => Object.keys(j.people || j || {}).length, '长期印象'],
  ['events.json', (j) => (Array.isArray(j.events) ? j.events : Object.keys(j)).length, '事件备忘录'],
  ['romance.json', (j) => (j.crush ? 1 : 0), '试探/恋爱阶段'],
  ['pursuit.json', (j) => Object.keys(j.people || j || {}).length, '被追/起哄'],
  ['misread.json', (j) => (Array.isArray(j.items) ? j.items.length : 0), '误会'],
  ['stress.json', (j) => Object.keys(j.people || j || {}).length, '压力/破防'],
  ['together.json', (j) => (Array.isArray(j.items) ? j.items.length : 0), '共同经历']
];

const now = Date.now();
const rows = [];

for (const [name, count, role] of FILES) {
  const p = path.join(STATE, name);
  const row = { name, role, exists: fs.existsSync(p), state: '', count: 0, ageMin: null, size: 0 };
  if (row.exists) {
    const st = fs.statSync(p);
    row.size = st.size;
    row.ageMin = Math.round((now - st.mtimeMs) / 60000);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      row.count = Number(count(j)) || 0;
      // 状态判定：空但新鲜 = 正常没数据；空且旧 = 可疑
      if (row.count === 0) row.state = row.ageMin < 180 ? '空·正常' : '空·可疑';
      else row.state = '活';
    } catch (error) {
      row.state = '坏了(JSON)';
      row.error = String(error?.message || error).slice(0, 60);
    }
  } else {
    row.state = '不存在';
  }
  rows.push(row);
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\n状态文件体检');
console.log('─'.repeat(78));
console.log(pad('文件', 20) + pad('状态', 12) + pad('条数', 6) + pad('最后写入', 14) + '职责');
console.log('─'.repeat(78));
for (const r of rows) {
  const age = r.ageMin === null ? '—' : r.ageMin < 60 ? `${r.ageMin} 分钟前` : r.ageMin < 1440 ? `${Math.round(r.ageMin / 60)} 小时前` : `${Math.round(r.ageMin / 1440)} 天前`;
  const flag = ['坏了(JSON)', '不存在', '空·可疑'].includes(r.state) ? '⚠️ ' : '   ';
  console.log(flag + pad(r.name, 17) + pad(r.state, 12) + pad(r.count, 6) + pad(age, 14) + r.role);
}
console.log('─'.repeat(78));

const bad = rows.filter((r) => ['坏了(JSON)', '不存在', '空·可疑'].includes(r.state));
if (!bad.length) {
  console.log('结论：9 个文件都能读，没有坏的。');
} else {
  console.log(`结论：${bad.length} 个需要留意 → ${bad.map((b) => b.name + '(' + b.state + ')').join('、')}`);
  console.log('注意：「不存在」不一定坏 —— 有些线要真实信号触发才会创建（如 pursuit 需要有人追她）。');
}

// 顺带看两个通用设施
for (const [f, tip] of [['tool-calls.jsonl', '工具调用记账'], ['transcripts', '聊天记录目录']]) {
  const p = path.join(STATE, f);
  if (!fs.existsSync(p)) { console.log(`${tip}: 还没有（${f}）`); continue; }
  const st = fs.statSync(p);
  const size = st.isDirectory() ? '目录' : `${Math.round(st.size / 1024)}KB`;
  console.log(`${tip}: ${size}，最后写入 ${Math.round((now - st.mtimeMs) / 60000)} 分钟前`);
}