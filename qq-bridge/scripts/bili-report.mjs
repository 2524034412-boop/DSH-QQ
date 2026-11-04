#!/usr/bin/env node
// 生成「浏览记录.txt」：把她每天刷到的 B 站内容整理成可读清单（含她自己的优先级）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.BILI_OUT_DIR || 'C:\\Users\\25240\\.dsh\\bili-duty\\out';
const OUT = path.join(ROOT, '浏览记录.txt');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseDigest(text) {
  const items = [];
  for (const block of String(text ?? '').split(/^###\s+/m).slice(1)) {
    const bv = /^(BV[0-9A-Za-z]+)/.exec(block.trim());
    const titleM = /\*\*(.+?)\*\*\s*[｜|]\s*UP：(.+?)\s*[｜|]\s*([^\n]*)/.exec(block);
    const urlM = /(https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]+)/.exec(block);
    const takeM = /我的一句话：\s*([^\n]+)/.exec(block);
    if (!bv && !titleM) continue;
    items.push({
      bv: bv ? bv[1] : '',
      title: titleM ? titleM[1].trim() : (bv ? bv[1] : ''),
      up: titleM ? titleM[2].trim() : '',
      plays: titleM ? titleM[3].trim() : '',
      url: urlM ? urlM[1] : (bv ? `https://www.bilibili.com/video/${bv[1]}` : ''),
      takeaway: takeM ? takeM[1].trim() : ''
    });
  }
  return items;
}

function main() {
  const priority = readJson(path.join(ROOT, 'state', 'bili-priority.json'), {});
  const shareTimes = readJson(path.join(ROOT, 'state', 'bili-share.json'), {});
  let files = [];
  try { files = fs.readdirSync(OUT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse(); } catch {}
  const lines = [];
  lines.push('════════ 她刷到的 B 站（浏览记录）════════');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`数据目录：${OUT_DIR}`);
  lines.push('');
  if (!files.length) {
    lines.push('（还没有任何记录——插件跑一轮后就会生成）');
  }
  let total = 0;
  const all = [];
  for (const f of files.slice(0, 14)) {
    const day = f.replace(/\.md$/, '');
    const items = parseDigest(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
    total += items.length;
    lines.push(`── ${day}（${items.length} 条）──`);
    for (const it of items) {
      const lv = Number(priority[it.bv]) || 0;
      const star = lv ? `[我评 ${lv}/5] ` : '';
      lines.push(`  ${star}${it.title}`);
      lines.push(`    ${it.up ? `UP：${it.up}` : ''}${it.plays ? ` ｜ ${it.plays}` : ''}`);
      if (it.takeaway) lines.push(`    看点：${it.takeaway}`);
      lines.push(`    ${it.url}`);
      lines.push('');
      all.push({ ...it, level: lv });
    }
  }
  lines.push('════════ 汇总 ════════');
  lines.push(`共 ${files.length} 天 / ${total} 条视频`);
  const faved = all.filter((x) => x.level >= 4).sort((a, b) => b.level - a.level);
  if (faved.length) {
    lines.push('她最喜欢的（评分 ≥4）：');
    for (const x of faved.slice(0, 10)) lines.push(`  ${x.level}/5 ${x.title} ${x.url}`);
  }
  const shared = Object.keys(shareTimes);
  lines.push(`分享过的会话：${shared.length ? shared.map((k) => `${k}（${new Date(shareTimes[k]).toLocaleString('zh-CN', { hour12: false })}）`).join('；') : '暂无'}`);
  lines.push('');
  fs.writeFileSync(OUT, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
  console.log(`已生成：${OUT}（${files.length} 天 / ${total} 条）`);
}

main();
