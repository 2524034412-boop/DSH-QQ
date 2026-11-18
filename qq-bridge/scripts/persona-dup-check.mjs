// 人格卡查重：完全重复 / 近重复段落 + 高频主题词。
// 用法：node scripts/persona-dup-check.mjs [--strict]
//   --strict 时有近重复（相似度 ≥0.55）就退出码 1，方便挂到每周检查里。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'roles', '独立AI.md');
const strict = process.argv.includes('--strict');

const text = fs.readFileSync(FILE, 'utf8');
const lines = text.split('\n');

// 切段（空行分隔），记录行号
const paras = [];
let buf = [];
let start = 0;
lines.forEach((line, i) => {
  if (line.trim()) {
    if (!buf.length) start = i + 1;
    buf.push(line.trim());
  } else if (buf.length) {
    paras.push({ start, end: i, text: buf.join('\n') });
    buf = [];
  }
});
if (buf.length) paras.push({ start, end: lines.length, text: buf.join('\n') });

const norm = (s) => String(s).replace(/[#>*`\-—…，。！？、；：「」『』（）()\s"'']/g, '');
const bigrams = (s) => {
  const n = norm(s);
  const out = new Set();
  for (let i = 0; i < n.length - 1; i += 1) out.add(n.slice(i, i + 2));
  return out;
};
const sim = (a, b) => {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / Math.min(A.size, B.size);
};

// 完全重复
const byNorm = new Map();
for (const p of paras) {
  const k = norm(p.text);
  if (!k) continue;
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push(p);
}
const exact = [...byNorm.entries()].filter(([, v]) => v.length > 1);

// 近重复（≥20 字）
const longs = paras.filter((p) => norm(p.text).length >= 20);
const near = [];
for (let i = 0; i < longs.length; i += 1) {
  for (let j = i + 1; j < longs.length; j += 1) {
    const v = sim(longs[i].text, longs[j].text);
    if (v >= 0.55) near.push({ v: Math.round(v * 100) / 100, a: longs[i], b: longs[j] });
  }
}
near.sort((x, y) => y.v - x.v);

// 主题词
const topics = ['傲娇', '撒娇', '语气词', '尾巴', '人鱼', '复述', '敷衍', '口头禅', '追问', 'AI', '客服', '对仗'];
const counts = topics.map((t) => [t, (text.match(new RegExp(t, 'g')) || []).length]);

console.log(`人格卡：${text.length} 字 / ${lines.length} 行 / ${paras.length} 段`);
console.log(`完全重复段落：${exact.length} 组`);
for (const [, v] of exact) console.log(`  行 ${v.map((x) => x.start).join(', ')}`);
console.log(`近重复段落对（≥0.55）：${near.length} 组`);
for (const n of near.slice(0, 6)) {
  console.log(`  [${n.v}] 行 ${n.a.start} ↔ ${n.b.start}`);
  console.log(`     A: ${norm(n.a.text).slice(0, 46)}`);
  console.log(`     B: ${norm(n.b.text).slice(0, 46)}`);
}
console.log('主题词出现次数：' + counts.map(([t, c]) => `${t} ${c}`).join(' · '));

if (strict && (exact.length > 0 || near.length > 0)) {
  console.error('有重复段落，退出码 1');
  process.exit(1);
}