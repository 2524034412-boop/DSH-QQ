// 「她眼中的社交圈」纯函数单测。无外部依赖，node scripts/test-relation-graph.mjs
import assert from 'node:assert/strict';
import {
  BANDS, DAY_MS, bandOf, distanceFor, maskUid, stabilityDays, retentionOf,
  warningOf, collectDiscipline, buildSocialGraph, buildPersonLinks, buildSemanticEdges
} from '../src/relation-graph.js';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

const NOW = 1793500000000;

console.log('relation-graph');

// ── 缺字段不产生 NaN ────────────────────────────────────────────────────
ok('空输入不崩、不产生 NaN', () => {
  const g = buildSocialGraph({});
  assert.equal(g.nodes.length, 0);
  assert.equal(g.owner, null);
  assert.ok(Number.isFinite(g.now));
});

ok('字段全缺的人仍然拿到可用数值', () => {
  const g = buildSocialGraph({ affinity: { '123456789': {} }, now: NOW });
  const n = g.nodes[0];
  for (const k of ['score', 'love', 'loyalty', 'stability', 'retention', 'distance', 'size']) {
    assert.ok(Number.isFinite(n[k]), `${k} 不是有限数：${n[k]}`);
  }
  assert.equal(n.band, 'stranger');
  assert.equal(n.warningLevel, 0);
});

ok('非法 uid / 自己 / 主人被剔除', () => {
  const g = buildSocialGraph({
    affinity: { abc: { score: 10 }, '111': { score: 10 }, '222': { score: 30 }, '333': { score: 50 } },
    selfUid: '111', ownerQQ: '222', now: NOW
  });
  assert.deepEqual(g.nodes.map((n) => n.uid), ['333']);
  assert.equal(g.owner.uid, '222');
});

ok('昵称是她自己的条目（deepseek 助手）不进"别人"', () => {
  const g = buildSocialGraph({
    affinity: {
      '9001': { score: 32, name: '只帆船的deepseek助手' },
      '9002': { score: 40, name: '只帆船的DeepSeek助手' },
      '9003': { score: 20, name: '徐昕宇' }
    },
    selfName: '只帆船的deep seek助手',
    now: NOW
  });
  assert.deepEqual(g.nodes.map((n) => n.uid), ['9003']);
});

// ── 距离随好感单调 ──────────────────────────────────────────────────────
ok('距离随好感单调不增', () => {
  let prev = Infinity;
  for (const s of [0, 10, 25, 40, 60, 80, 95, 100]) {
    const d = distanceFor(s);
    assert.ok(d <= prev + 1e-9, `score ${s} 距离反而变大`);
    assert.ok(d >= 0.2 - 1e-9 && d <= 1 + 1e-9, `score ${s} 距离越界：${d}`);
    prev = d;
  }
});

ok('好感档位边界正确', () => {
  assert.equal(bandOf(0).key, 'stranger');
  assert.equal(bandOf(19.9).key, 'stranger');
  assert.equal(bandOf(20).key, 'familiar');
  assert.equal(bandOf(40).key, 'known');
  assert.equal(bandOf(65).key, 'friend');
  assert.equal(bandOf(85).key, 'special');
  assert.equal(bandOf(1000).key, 'special');
  assert.equal(bandOf(-5).key, 'stranger');
  assert.equal(BANDS.length, 5);
});

// ── 纪律：描边与虚线 ────────────────────────────────────────────────────
ok('警告等级映射到描边色', () => {
  assert.equal(warningOf({ level: 0 }, NOW).stroke, '');
  assert.equal(warningOf({ level: 1 }, NOW).stroke, '#ffd166');
  assert.equal(warningOf({ level: 2 }, NOW).stroke, '#ffa94d');
  assert.equal(warningOf({ level: 3 }, NOW).stroke, '#ff6b5e');
  assert.equal(warningOf({ level: 9 }, NOW).level, 3, '等级要钳到 3');
});

ok('冷处理未到期才算虚线', () => {
  assert.equal(warningOf({ level: 1, ignoreUntil: NOW + 3600_000 }, NOW).cooling, true);
  assert.equal(warningOf({ level: 1, ignoreUntil: NOW - 1000 }, NOW).cooling, false);
  assert.equal(warningOf({ level: 1, ignoreUntil: 0 }, NOW).cooling, false);
});

ok('discipline 复合键 "group:NNN|uid" 能拆出 uid 并取最高等级', () => {
  const map = collectDiscipline({
    'group:111|222': { level: 1 },
    'group:333|222': { level: 3 },
    'group:444|555': { level: 2 }
  }, NOW);
  assert.equal(map.get('222').level, 3);
  assert.equal(map.get('555').level, 2);
  assert.equal(map.size, 2);
});

// ── 衰减与亮度 ──────────────────────────────────────────────────────────
ok('稳定度随喜爱/消息数增长', () => {
  const low = stabilityDays({ love: 0, count: 0, score: 0 });
  const high = stabilityDays({ love: 90, count: 400, score: 90 });
  assert.ok(high > low, `${high} 应大于 ${low}`);
  assert.ok(low >= 1.5 && high <= 90);
});

ok('保持率随时间衰减，且与 memory-retention 同公式', () => {
  const r0 = retentionOf(NOW, 10, NOW);
  const r1 = retentionOf(NOW - 10 * DAY_MS, 10, NOW);
  assert.ok(Math.abs(r0 - 1) < 1e-9);
  assert.ok(Math.abs(r1 - Math.exp(-1)) < 1e-6, `10 天/稳定 10 天 应为 e^-1，实际 ${r1}`);
  assert.equal(retentionOf(0, 10, NOW), 0, '没有 lastAt 视为 0');
});

ok('时间流拨到未来，久没聊的人先暗下去', () => {
  const g = buildSocialGraph({
    affinity: {
      '100': { score: 80, lastAt: NOW - 1 * DAY_MS, count: 200 },
      '200': { score: 20, lastAt: NOW - 30 * DAY_MS, count: 2 }
    },
    now: NOW
  });
  const soon = buildSocialGraph({
    affinity: {
      '100': { score: 80, lastAt: NOW - 1 * DAY_MS, count: 200 },
      '200': { score: 20, lastAt: NOW - 30 * DAY_MS, count: 2 }
    },
    now: NOW + 60 * DAY_MS
  });
  const a = soon.nodes.find((n) => n.uid === '100');
  const b = soon.nodes.find((n) => n.uid === '200');
  assert.ok(a.retention > b.retention, '亲近的人衰减应更慢');
  const before = g.nodes.find((n) => n.uid === '200').retention;
  assert.ok(b.retention < before, '未来应该更暗');
});

// ── 隐私 ────────────────────────────────────────────────────────────────
ok('QQ 号默认打码', () => {
  assert.equal(maskUid('2524034412'), '2524****12');
  assert.equal(maskUid('123'), '1**');
  assert.equal(maskUid(''), '未知');
});

ok('返回对象里没有整份 state 字段', () => {
  const g = buildSocialGraph({
    affinity: { '2524034412': { score: 90, love: 40, lastAt: NOW }, '1234': { score: 30, lastAt: NOW } },
    impressions: { '1234': { text: '话少', sentiment: '中性', traits: ['话少'] } },
    ownerQQ: '2524034412',
    now: NOW
  });
  const json = JSON.stringify(g);
  for (const forbidden of ['agentToken', 'lastText', 'wakeConfig', 'consoleToken']) {
    assert.ok(!json.includes(forbidden), `不应包含 ${forbidden}`);
  }
});

// ── 群分组 ──────────────────────────────────────────────────────────────
ok('同群的人归到同一组，并按人数排序', () => {
  const g = buildSocialGraph({
    affinity: { '1': { score: 10 }, '2': { score: 20 }, '3': { score: 30 } },
    memberships: { '1': ['111'], '2': ['111'], '3': ['222'] },
    groupStats: { 'group:111': { speaks: 5, msgs: 9, joys: 2, bonus: 1 }, 'group:222': { speaks: 0, msgs: 1 } },
    now: NOW
  });
  assert.equal(g.groups[0].id, '111');
  assert.equal(g.groups[0].members, 2);
  assert.equal(g.groups[0].msgs, 9);
  assert.equal(g.nodes.find((n) => n.uid === '3').group, '222');
});

ok('没有聊天记录时退回 lastConv，仍能归组', () => {
  const g = buildSocialGraph({
    affinity: {
      '1': { score: 10, lastConv: 'group:111' },
      '2': { score: 20, lastConv: 'group:111' },
      '3': { score: 30 }
    },
    memberships: {},
    groupStats: { 'group:111': { speaks: 1, msgs: 2 } },
    now: NOW
  });
  assert.equal(g.nodes.find((n) => n.uid === '1').group, '111');
  assert.equal(g.groups.find((x) => x.id === '111').members, 2, '两个人都要算进群人数');
  assert.equal(g.nodes.find((n) => n.uid === '3').group, '', '没有归属的人不该被瞎归类');
});

// ── 人与人之间的连线 ────────────────────────────────────────────────────
console.log('person links');

ok('接话：A 说完 5 分钟内 B 接上，记 1 次', () => {
  const r = buildPersonLinks({
    messages: [
      { t: 1000, u: '1', g: 'g1', x: '在吗' },
      { t: 1500, u: '2', g: 'g1', x: '在' }
    ]
  });
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].replies, 1);
  assert.equal(r.edges[0].b, '2');
});

ok('同一个人连发不算接话，但最后一句仍可被别人接', () => {
  const consecutive = buildPersonLinks({
    messages: [
      { t: 1000, u: '1', g: 'g1', x: '在吗' },
      { t: 1100, u: '1', g: 'g1', x: '喂' }
    ]
  });
  assert.equal(consecutive.edges.length, 0, '自己连发不该产生连线');

  const replied = buildPersonLinks({
    messages: [
      { t: 1000, u: '1', g: 'g1', x: '在吗' },
      { t: 1100, u: '1', g: 'g1', x: '喂' },
      { t: 1200, u: '2', g: 'g1', x: '在' }
    ]
  });
  assert.equal(replied.edges.length, 1, '被人接上应该有线');
  assert.equal(replied.edges[0].replies, 1, '只算一次，不要 1→1 和 1→2 重复计');
});

ok('超过时间窗不算', () => {
  const r = buildPersonLinks({
    messages: [
      { t: 0, u: '1', g: 'g1', x: 'a' },
      { t: 6 * 60 * 1000, u: '2', g: 'g1', x: 'b' }
    ]
  });
  assert.equal(r.edges.length, 0);
});

ok('跨群不算同一段对话', () => {
  const r = buildPersonLinks({
    messages: [
      { t: 0, u: '1', g: 'g1', x: 'a' },
      { t: 100, u: '2', g: 'g2', x: 'b' }
    ]
  });
  assert.equal(r.edges.length, 0);
});

ok('@提及按 0.5 计权重，且能对上昵称', () => {
  const r = buildPersonLinks({
    messages: [
      { t: 0, u: '1', g: 'g1', x: '@张三 你看这个' }
    ],
    names: { '3': '张三' }
  });
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].mentions, 1);
  assert.equal(r.edges[0].weight, 0.5);
});

ok('她自己（selfUid）不参与连线', () => {
  const r = buildPersonLinks({
    messages: [
      { t: 0, u: '999', g: 'g1', x: 'a' },
      { t: 100, u: '2', g: 'g1', x: 'b' }
    ],
    selfUid: '999'
  });
  assert.equal(r.edges.length, 0);
});

ok('topN 截断，strength 归一化到最强那条', () => {
  const messages = [];
  for (let i = 0; i < 5; i++) {
    messages.push({ t: i * 10000, u: '1', g: 'g1', x: 'a' });
    messages.push({ t: i * 10000 + 100, u: '2', g: 'g1', x: 'b' });
  }
  messages.push({ t: 999999, u: '3', g: 'g1', x: 'c' });
  messages.push({ t: 999999 + 100, u: '4', g: 'g1', x: 'd' });
  const r = buildPersonLinks({ messages, topN: 1 });
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].strength, 1);
  assert.equal(r.total, 2, 'total 报告的是全部对数');
});

ok('缺字段 / 空数据不崩也不产生 NaN', () => {
  const r = buildPersonLinks({});
  assert.deepEqual(r.edges, []);
  assert.equal(r.total, 0);
  const r2 = buildPersonLinks({ messages: [{}, { t: 'x', u: 'abc', g: null, x: 3 }] });
  assert.equal(r2.edges.length, 0);
});

// ── 语义关系（她自己记的）────────────────────────────────────────────────
console.log('semantic relations');

const NODES = [{ uid: '11' }, { uid: '22' }, { uid: '33' }];
const OWNER = { uid: '99' };

ok('只保留两端都在图里的人', () => {
  const e = buildSemanticEdges({
    '11': [{ to: '22', kind: '亲近' }],
    '33': [{ to: '404', kind: '对立' }]      // 404 不在图里
  }, NODES, OWNER, '');
  assert.equal(e.length, 1);
  assert.equal(e[0].b, '22');
});

ok('非法 kind / 自己跟自己 / 她本人 都被忽略', () => {
  const e = buildSemanticEdges({
    '11': [{ to: '22', kind: '暧昧' }, { to: '11', kind: '亲近' }],
    '77': [{ to: '22', kind: '亲近' }]        // 77 是 selfUid
  }, NODES, OWNER, '77');
  assert.equal(e.length, 0);
});

ok('同一对人两个方向：合并成一条，mutual=true', () => {
  const e = buildSemanticEdges({
    '11': [{ to: '22', kind: '亲近', note: '常一起打游戏' }],
    '22': [{ to: '11', kind: '亲近' }]
  }, NODES, OWNER, '');
  assert.equal(e.length, 1);
  assert.equal(e[0].mutual, true);
  assert.equal(e[0].note, '常一起打游戏');
});

ok('kind 冲突时按 对立 > 依赖 > 亲近 取代表', () => {
  const e = buildSemanticEdges({
    '11': [{ to: '22', kind: '亲近' }],
    '22': [{ to: '11', kind: '对立' }]
  }, NODES, OWNER, '');
  assert.equal(e[0].kind, '对立');
  assert.equal(e[0].kinds.length, 2);
});

ok('主人也在「图里的人」范围内', () => {
  const e = buildSemanticEdges({ '11': [{ to: '99', kind: '依赖' }] }, NODES, OWNER, '');
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, '依赖');
});

ok('空数据 / 坏结构不崩', () => {
  assert.deepEqual(buildSemanticEdges({}, [], null, ''), []);
  assert.deepEqual(buildSemanticEdges({ '11': 'not-array' }, NODES, OWNER, ''), []);
});

console.log(`\n${pass} 项通过`);