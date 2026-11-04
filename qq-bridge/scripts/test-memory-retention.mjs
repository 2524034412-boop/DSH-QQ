import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS, annotate, associationDegrees, daysUntil, retention, stabilityDays, summarize } from '../src/memory-retention.js';

const NOW = Date.UTC(2026, 9, 31, 12);
const mk = (o) => ({ tier: 'long', tags: [], createdAt: NOW, updatedAt: NOW, expiresAt: 0, ...o });

test('保持率从 1 开始单调下降，且永远在 0..1', () => {
  const s = stabilityDays(mk({}));
  let prev = 2;
  for (let d = 0; d <= 90; d += 3) {
    const r = retention(s, NOW, NOW + d * DAY_MS);
    assert.ok(r <= prev && r >= 0 && r <= 1);
    prev = r;
  }
  assert.equal(retention(s, NOW, NOW), 1);
});

test('核心几乎不衰减，长期慢，短期快', () => {
  const at = (tier, days) => retention(stabilityDays(mk({ tier, expiresAt: tier === 'short' ? NOW + 3 * DAY_MS : 0 })), NOW, NOW + days * DAY_MS, tier === 'short' ? NOW + 3 * DAY_MS : 0);
  assert.ok(at('core', 60) > 0.98);
  // 长期记忆要"记得久"：两周基本还牢，三个月大约掉到四成，一年仍有余温
  assert.ok(at('long', 14) > 0.75, '两周后仍应保持 75% 以上');
  assert.ok(at('long', 90) > 0.2 && at('long', 90) < 0.55, '三个月约掉到两三成到五成');
  assert.ok(at('long', 365) > 0, '一年后仍有残余');
  assert.equal(at('short', 3.5), 0, '短期过了 expiresAt 就是已遗忘（桥接会真实删除）');
  assert.ok(at('short', 2.9) < 0.1);
});

test('被反复强化的记忆更牢（updatedAt-createdAt 越长 S 越大）', () => {
  const fresh = stabilityDays(mk({}));
  const rehearsed = stabilityDays(mk({ createdAt: NOW - 20 * DAY_MS }));
  assert.ok(rehearsed > fresh * 1.5);
});

test('联想越丰富越牢；超过 10 人的标签不算联想（与连线规则一致）', () => {
  const crowd = Array.from({ length: 12 }, () => mk({ tags: ['群'] }));
  assert.deepEqual(new Set(associationDegrees(crowd)), new Set([0]));
  const pair = [mk({ tags: ['a'] }), mk({ tags: ['a', 'b'] }), mk({ tags: ['b'] })];
  assert.deepEqual(associationDegrees(pair), [1, 2, 1]);
  assert.ok(stabilityDays(pair[1], 2) > stabilityDays(pair[0], 0));
});

test('daysUntil 与 retention 互相印证', () => {
  const e = mk({ updatedAt: NOW - 5 * DAY_MS, createdAt: NOW - 5 * DAY_MS });
  const s = stabilityDays(e);
  const d = daysUntil(s, e.updatedAt, NOW, 0.5);
  assert.ok(Math.abs(retention(s, e.updatedAt, NOW + d * DAY_MS) - 0.5) < 1e-6);
  assert.equal(daysUntil(stabilityDays(mk({ tier: 'core' })), NOW, NOW, 0.5), Infinity);
});

test('缺失/异常字段不会产生 NaN', () => {
  for (const bad of [{}, { tier: 'x' }, { updatedAt: 'abc' }, { createdAt: NOW + 9e9 }]) {
    const meta = annotate([bad])[0];
    assert.ok(Number.isFinite(meta.s) && meta.s > 0);
    assert.ok(Number.isFinite(retention(meta.s, meta.u, NOW, meta.x)));
  }
});

test('summarize 给出面板需要的曲线', () => {
  const list = [mk({ tier: 'core' }), mk({}), mk({ tier: 'short', expiresAt: NOW + DAY_MS })];
  const sum = summarize(list, NOW, 60, 12);
  assert.equal(sum.series.long.length, 13);
  assert.ok(sum.series.core[12] > 0.98);
  assert.ok(sum.series.long[12] < sum.series.long[0]);
  assert.equal(sum.series.short[12], 0);
  assert.ok(sum.average > 0 && sum.average <= 1);
});
