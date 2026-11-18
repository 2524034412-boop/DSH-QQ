// 说话风格体检：把「人机味」拆成可数的指标，改前改后各跑一次对比。
// 用法：node scripts/speak-audit.mjs [天数，默认 2]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'state', 'transcripts');
const days = Math.max(1, Number(process.argv[2]) || 2);

function dayList(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i += 1) {
    const x = new Date(d.getTime() - i * 86400000);
    const pad = (v) => String(v).padStart(2, '0');
    out.push(`${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`);
  }
  return out.reverse();
}

const strip = (s) => String(s).replace(/[\s，。！？…、~～,.!?]/g, '');
const ACK = /^(行|行吧|行行行|好|好的|嗯|嗯嗯|对|对对|成|可以|确实|收到|懂了|哦|哦哦|知道了|没问题|ok|OK)$/i;
const ACK_HEAD = /^(行|嗯|好|对|成|确实|可以)[，,。！!…\s]/;
const TEMPLATE = /(这句我认|我认了|我认，|我收下了|记本子上|存下来了|这碗我认|我记着了|我记住了)/;
const RESTATE = /(你(说|讲)的(这|那)|这句话(最|真)|挺(难|不)得|想想挺|这种(底子|信任)|教得好|说到点子)/;
const MAXIM = /(不是.{1,8}(而是|，是)|的是你|的是我)/;
// 「DeepSeek 腔」：把日常话包装成有分量、对仗、像座右铭的句子。
// 来源是一张对比图的反面教材——右边那列（"这话我认""这笔账我记着"）。
const DS_HALLMARK = /(这话我认|这笔账|我听着[，,、]?\s*你往下|这话说得不轻|这事我心里有数|这事我心里有数|这个问题我?先不接|这话我记下了|你自己信吗|睡吧[，,、]?\s*我守着|话我记下了)/;

const msgs = [];
const daysWanted = new Set(dayList(days));
for (const dir of fs.readdirSync(DIR)) {
  const full = path.join(DIR, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const f of fs.readdirSync(full)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) || !daysWanted.has(f.replace('.jsonl', ''))) continue;
    for (const line of fs.readFileSync(path.join(full, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (!j.me || !j.x) continue;
      msgs.push({ key: dir, text: String(j.x), t: Number(j.t) || 0 });
    }
  }
}

if (!msgs.length) {
  console.log('没有找到她最近的发言记录');
  process.exit(0);
}

const lens = msgs.map((m) => m.text.length).sort((a, b) => a - b);
const median = lens[Math.floor(lens.length / 2)];
const p90 = lens[Math.floor(lens.length * 0.9)];
const ack = msgs.filter((m) => ACK.test(strip(m.text)));
const ackHead = msgs.filter((m) => ACK_HEAD.test(m.text));
const tpl = msgs.filter((m) => TEMPLATE.test(m.text));
const restate = msgs.filter((m) => RESTATE.test(m.text));
const maxim = msgs.filter((m) => MAXIM.test(m.text));
const dsTone = msgs.filter((m) => DS_HALLMARK.test(m.text));
const counter = new Map();
for (const m of msgs) counter.set(m.text, (counter.get(m.text) || 0) + 1);
const repeated = [...counter].filter(([, n]) => n > 1);

const pct = (n) => `${((n / msgs.length) * 100).toFixed(1)}%`;
console.log(`近 ${days} 天她的发言：${msgs.length} 条（${[...new Set(msgs.map((m) => m.key))].length} 个会话）\n`);
console.log(`单字/两字纯应答    ${String(ack.length).padStart(3)} 条  ${pct(ack.length)}   ← 越低越好，目标 <3%`);
console.log(`行/嗯/好/对 开头   ${String(ackHead.length).padStart(3)} 条  ${pct(ackHead.length)}   ← 目标 <10%`);
console.log(`「这句我认」模板    ${String(tpl.length).padStart(3)} 条  ${pct(tpl.length)}   ← 目标 <2%`);
console.log(`复述+评价           ${String(restate.length).padStart(3)} 条  ${pct(restate.length)}   ← 目标 <8%`);
console.log(`对仗/金句           ${String(maxim.length).padStart(3)} 条  ${pct(maxim.length)}   ← 目标 <2%`);
console.log(`DeepSeek 腔         ${String(dsTone.length).padStart(3)} 条  ${pct(dsTone.length)}   ← 目标 0%：出现就是「端着的深刻」`);
console.log(`\n长度：中位 ${median} 字，p90 ${p90} 字，最短 ${lens[0]}，最长 ${lens[lens.length - 1]}`);
console.log(`  长度方差小 = 每条都差不多长 = 机器节奏。中位 6~12 字、p90 25 字以上比较像人。`);
console.log(`\n原样重复的句子 ${repeated.length} 种，最多重复 ${Math.max(...counter.values())} 次`);
for (const [t, n] of repeated.sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${n}× ${t}`);

if (ack.length) {
  console.log('\n纯应答样本：');
  for (const m of ack.slice(0, 8)) console.log(`  「${m.text}」`);
}
if (tpl.length) {
  console.log('\n模板句样本：');
  for (const m of tpl.slice(0, 6)) console.log(`  「${m.text}」`);
}
