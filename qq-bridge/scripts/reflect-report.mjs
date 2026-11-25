// 把 state/reflections.jsonl 汇总成一份给人看的周报，写到存档目录。
// 用法：node scripts/reflect-report.mjs [天数=7] [--write]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/DSH/qq-bridge';
const FILE = path.join(ROOT, 'state', 'reflections.jsonl');
const days = Math.max(1, Number(process.argv[2]) || 7);
const write = process.argv.includes('--write');

const since = Date.now() - days * 86400000;
const rows = fs.existsSync(FILE)
  ? fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const recent = rows.filter((r) => Number(r.at) >= since);
if (!recent.length) { console.log('这段时间没有反思记录'); process.exit(0); }

const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const lines = [];
lines.push(`# 她的反思周报（最近 ${days} 天）`, '');
lines.push(`共 ${recent.length} 条：开机日总结 ${recent.filter((r) => r.kind === 'daily').length} 条，随口反思 ${recent.filter((r) => r.kind !== 'daily').length} 条。`, '');
for (const r of recent) {
  lines.push(`## ${fmt(r.at)}${r.kind === 'daily' ? '（开机日总结）' : ''}`, '', r.text.trim(), '');
}
// 关键词粗统计：看她反复在说哪些词
const stop = new Set(['今天', '一个', '什么', '自己', '这个', '不是', '就是', '有点', '觉得', '应该', '可以', '没有', '因为', '所以', '但是', '时候', '一样', '真的', '这句', '下次', '想改', '学到', '反思']);
const freq = new Map();
for (const r of recent) {
  const s = String(r.text).replace(/[，。！？、；：“”（）\s]/g, ' ');
  for (const w of s.split(' ')) if (w.length >= 2 && w.length <= 4 && !stop.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
}
const top = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12);
lines.push('## 反复出现的词', '', top.map(([w, c]) => `${w}（${c}）`).join('、') || '（暂无）', '');
lines.push('## 怎么用这份报告', '', '- 看「建议改动」类的话有没有重复：重复三次以上就该动手改提示词', '- 看「哪句不像人」有没有同一类毛病反复出现', '- 看「学到的说话方式」是不是越来越具体（具体=真的在听）', '');

const md = lines.join('\n');
if (write) {
  const out = `D:/DSH/存档/她的反思周报-${new Date().toISOString().slice(0, 10)}.md`;
  fs.writeFileSync(out, md, 'utf8');
  console.log('已写入', out);
} else {
  console.log(md);
}