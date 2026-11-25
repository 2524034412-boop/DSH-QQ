#!/usr/bin/env node
/**
 * 人格化体检：一条命令看「她像不像人」和「她到底在用什么工具」。
 *
 *   node scripts/humanize-check.mjs            # 最近 7 天
 *   node scripts/humanize-check.mjs --days 3
 *
 * 数据来源：state/transcripts（她说过的话）+ state/tool-calls.jsonl（工具调用记账）。
 * 只读，不改任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE = path.join(ROOT, 'state');
const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const DAYS = daysArg >= 0 ? Math.max(1, Number(args[daysArg + 1]) || 7) : 7;
const CUT = Date.now() - DAYS * 86400000;

function readJsonl(p, cut) {
  const out = [];
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!cut || Number(o.at || o.t) >= cut) out.push(o);
    } catch {}
  }
  return out;
}

// ── 她说过的话 ─────────────────────────────────────────────────────────────
const msgs = [];
const perKey = new Map();
(function walk(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs < CUT) continue;
    for (const o of readJsonl(p, CUT)) {
      if (!o.me) continue;
      const t = String(o.x || '');
      msgs.push(t);
      const conv = path.basename(path.dirname(p));
      perKey.set(conv, (perKey.get(conv) || 0) + 1);
    }
  }
})(path.join(STATE, 'transcripts'));

const total = msgs.length;
const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
const avg = total ? msgs.reduce((s, m) => s + m.length, 0) / total : 0;
const long = msgs.filter((m) => m.length > 60).length;
const short = msgs.filter((m) => m.length <= 6).length;
const question = msgs.filter((m) => /[？?]/.test(m)).length;
const exclam = msgs.filter((m) => /[！!]/.test(m)).length;
const halfLine = msgs.filter((m) => /……|\.\.\.|—$|、$/.test(m)).length;
const emoji = msgs.filter((m) => /[\u{1F300}-\u{1FAFF}]/u.test(m)).length;
const BLACKLIST = ['这话我认', '我心里有数', '你自己信吗', '我守着', '这话说得不轻', '这笔账我记着'];
const black = msgs.filter((m) => BLACKLIST.some((w) => m.includes(w))).length;
const explain = msgs.filter((m) => /(其实|总之|简单说|换句话说|也就是说|本质上是)/.test(m)).length;
const quote = msgs.filter((m) => /「.*」|“.*”/.test(m)).length;

// 复读检测：相邻两条完全一样
let repeat = 0;
for (let i = 1; i < msgs.length; i++) if (msgs[i].trim() === msgs[i - 1].trim() && msgs[i].trim()) repeat += 1;

console.log(`\n═══ 她最近 ${DAYS} 天 ═══`);
console.log(`消息 ${total} 条｜平均 ${avg.toFixed(1)} 字｜长句(>60) ${long}(${pct(long)}%)｜短句(≤6) ${short}(${pct(short)}%)`);
console.log(`问句 ${pct(question)}%｜感叹 ${pct(exclam)}%｜半句/省略 ${pct(halfLine)}%｜emoji ${pct(emoji)}%｜带引号转述 ${pct(quote)}%`);
console.log(`禁用句式 ${black}｜解释腔 ${explain}｜相邻复读 ${repeat}`);
console.log(`各会话条数：${[...perKey.entries()].map(([k, v]) => `${k.replace(/^(group|private)_/, '$1:')}=${v}`).join(' ') || '（无）'}`);

// ── 工具调用 ───────────────────────────────────────────────────────────────
const calls = readJsonl(path.join(STATE, 'tool-calls.jsonl'), CUT);
const byTool = new Map();
for (const c of calls) byTool.set(c.tool, (byTool.get(c.tool) || 0) + 1);
const toolRows = [...byTool.entries()].sort((a, b) => b[1] - a[1]);

// 已注册的工具（配置里没写 = 开）
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const flags = cfg.socialV2?.tools || {};
const KNOWN = ['getPrompt', 'getUnread', 'getRecent', 'sendMessage', 'sendBurst', 'reply', 'waitMessages',
  'markRead', 'setWakeConfig', 'remember', 'recall', 'forget', 'memory', 'gallery', 'together', 'say', 'sendVoice',
  'sendSticker', 'listStickers', 'getStickerImage', 'collectSticker', 'stickerNote', 'setStickerRemark',
  'sendSelfie', 'selfie', 'getImages', 'getMessageDetail', 'getForwardMsg', 'sendPoke', 'mood', 'affinity',
  'relation', 'events', 'impression', 'meme', 'slangQuery', 'slangSubmit', 'transcript', 'reading', 'balance',
  'groupFiles', 'newSession', 'handover', 'environment', 'space', 'biliPriority', 'judgeOffense', 'feedback', 'getMyRecent'];

const enabled = KNOWN.filter((k) => flags[k] !== false);
const used = new Set(toolRows.map(([k]) => k.replace(/^qq_/, '')));
const neverUsed = enabled.filter((k) => !used.has(k));

console.log(`\n═══ 工具（最近 ${DAYS} 天）═══`);
if (!toolRows.length) {
  console.log('（还没有记账数据：这是刚加的统计，要等她下次调用工具才有）');
} else {
  console.log(`调用 ${calls.length} 次，用到 ${used.size} 个工具`);
  for (const [k, v] of toolRows.slice(0, 15)) console.log(`  ${String(v).padStart(4)}  ${k}`);
}
console.log(`\n开着但一次没用的（${neverUsed.length}/${enabled.length}）：${neverUsed.join('、') || '（无）'}`);
const off = KNOWN.filter((k) => flags[k] === false);
console.log(`配置里关掉的：${off.join('、') || '（无）'}`);