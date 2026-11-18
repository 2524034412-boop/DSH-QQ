// 单独跑一次记忆整理（默认 dry-run，只看会发生什么）。
// 用法：
//   node scripts/consolidate-memory.mjs           # 只看报告，不改文件
//   node scripts/consolidate-memory.mjs --apply   # 真的写回 memory-global.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consolidateMemories, normalizeTier } from '../src/memory-consolidate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'state', 'memory-global.json');
const apply = process.argv.includes('--apply');

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const entries = Array.isArray(raw.entries) ? raw.entries : [];
const result = consolidateMemories(entries, { now: Date.now(), maxEntries: 400 });

const count = (list, tier) => list.filter((e) => normalizeTier(e.tier) === tier).length;
console.log(`整理前 ${result.before} 条 → 整理后 ${result.after} 条`);
console.log(`合并 ${result.merged.length} 组，丢弃 ${result.dropped.length} 条（超上限）`);
console.log(`层级：核心 ${count(result.entries, 'core')} / 长期 ${count(result.entries, 'long')} / 短期 ${count(result.entries, 'short')}`);
for (const m of result.merged.slice(0, 8)) console.log(`  合并 keep=${m.keep} absorb=${m.absorb} sim=${m.sim}`);

if (apply) {
  const backup = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(FILE, backup);
  fs.writeFileSync(FILE, JSON.stringify({ entries: result.entries, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  console.log(`已写回（备份 ${path.basename(backup)}）`);
} else {
  console.log('（dry-run，没有改文件；加 --apply 才写）');
}