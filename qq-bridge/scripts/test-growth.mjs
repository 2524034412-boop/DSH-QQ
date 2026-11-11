// 「慢慢长出来的样子」：她从书里/聊天里学来的小习惯，怎么进提示词、怎么被限住。
// 关键不是能学，而是**别学成拼盘**：最多 3 条、每条 50 字、只加不换。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const now = Date.now();

async function fixture(run, entries) {
  const h = await bridgeHarness({
    files: { 'state/memory-global.json': { entries } },
    config: { socialV2: { sticker: { enabled: false }, proactive: { enabled: false } } }
  });
  h.setMode('reserved2');
  h.getSocialV2State(KEY);
  try { await run(h); } finally { await h.close(); }
}

test('带「学来的」标签的记忆会进提示词', () => fixture((h) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.match(prompt, /【慢慢长出来的样子】/);
  assert.match(prompt, /说话前先顿一下，像在挑词/);
  assert.match(prompt, /不是谁给的设定/);
  assert.match(prompt, /别整段照演/);
}, [
  { id: 'm1', text: '说话前先顿一下，像在挑词', tags: ['学来的'], tier: 'long', createdAt: now, updatedAt: now },
  { id: 'm2', text: '喜欢的人说话时会不自觉放轻声音', tags: ['学来的', '人设'], tier: 'long', createdAt: now, updatedAt: now - 1000 }
]));

test('最多 3 条，按最近更新排序', () => fixture((h) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  const block = prompt.slice(prompt.indexOf('【慢慢长出来的样子】'));
  assert.match(block, /第4条/);
  assert.doesNotMatch(block, /第1条/, '只留最近 3 条，旧的不能一起堆上来');
}, [
  { id: 'a', text: '第1条', tags: ['学来的'], createdAt: now, updatedAt: now - 4000 },
  { id: 'b', text: '第2条', tags: ['学来的'], createdAt: now, updatedAt: now - 3000 },
  { id: 'c', text: '第3条', tags: ['学来的'], createdAt: now, updatedAt: now - 2000 },
  { id: 'd', text: '第4条', tags: ['学来的'], createdAt: now, updatedAt: now - 1000 }
]));

test('没学过就一个字都不加（不凭空捏性格）', () => fixture((h) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.doesNotMatch(prompt, /【慢慢长出来的样子】/);
}, [
  { id: 'x', text: '一条普通记忆', tags: ['读书'], createdAt: now, updatedAt: now }
]));

test('别的群学来的、以及过期的，不算她的样子', () => fixture((h) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.doesNotMatch(prompt, /别的群的学到的/);
  assert.doesNotMatch(prompt, /已经过期的/);
}, [
  { id: 'p', text: '别的群的学到的', tags: ['学来的'], scope: 'group:999', createdAt: now, updatedAt: now },
  { id: 'q', text: '已经过期的', tags: ['学来的'], expiresAt: now - 60_000, createdAt: now, updatedAt: now }
]));

// 兜底：老记忆里有「人设」标签但其实在讲 bot / AI 味，注进去会当场破功。
test('带 OOC 词的记忆不能进「长出来的样子」', () => fixture((h) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.doesNotMatch(prompt, /【慢慢长出来的样子】/);
  assert.doesNotMatch(prompt, /AI 味/);
}, [
  { id: 'meta', text: '主人喜欢调试 bot 人格，觉得我 AI 味重会直接说', tags: ['学来的', '人设'], createdAt: now, updatedAt: now }
]));

test('每条最多 50 字，避免一本书的整段描述糊上来', () => fixture((h) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  const line = prompt.split('\n').find((l) => l.startsWith('- 很长的一段性格描述'));
  assert.ok(line, '这条应该出现');
  assert.ok(line.length <= 52, `单条被截到 50 字，实际 ${line.length}`);
}, [
  { id: 'long', text: '很长的一段性格描述'.repeat(20), tags: ['学来的'], createdAt: now, updatedAt: now }
]));
