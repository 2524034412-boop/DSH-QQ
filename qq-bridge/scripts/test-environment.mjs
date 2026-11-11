// 外接温湿度的纯函数回归：读数校验、新鲜度、给模型的那句话、24 小时趋势。
// 不启桥接、不连设备 —— 这几条决定了「读数脏了会不会污染人设」。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeReading, environmentLine, isFresh, readingAgeMs, summarizeHistory, DEFAULT_STALE_MINUTES } from '../src/environment.js';

const NOW = 1_800_000_000_000;

test('一条正常的读数被规整成固定形状', () => {
  const r = normalizeReading({ tempC: 23.44, humidity: 58.26, place: '书房', pressure: 1012.34, battery: 87.6, rssi: -63.4, fw: 'esp32-sht30' }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.reading, {
    at: NOW, tempC: 23.4, humidity: 58.3, pressure: 1012.3, battery: 88, rssi: -63, place: '书房', fw: 'esp32-sht30'
  });
});

test('别名字段也认（temp/temperature/hum/rh），踩坑的板子不用改固件', () => {
  assert.equal(normalizeReading({ temp: 20, rh: 40 }, NOW).reading.tempC, 20);
  assert.equal(normalizeReading({ temperature: 20, hum: 40 }, NOW).reading.humidity, 40);
});

test('缺字段 / 超范围 / 垃圾输入一律拒绝，绝不把 NaN 写进状态', () => {
  assert.equal(normalizeReading(null, NOW).ok, false);
  assert.equal(normalizeReading({ humidity: 50 }, NOW).ok, false);
  assert.equal(normalizeReading({ tempC: 20 }, NOW).ok, false);
  assert.equal(normalizeReading({ tempC: 200, humidity: 50 }, NOW).ok, false);
  assert.equal(normalizeReading({ tempC: 20, humidity: 150 }, NOW).ok, false);
  assert.equal(normalizeReading({ tempC: 'hot', humidity: 50 }, NOW).ok, false);
  assert.equal(normalizeReading({ tempC: NaN, humidity: 50 }, NOW).ok, false);
});

test('可选字段脏了就丢掉，不影响主读数', () => {
  const r = normalizeReading({ tempC: 20, humidity: 50, pressure: 5, battery: 900, rssi: 20 }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reading.pressure, undefined);
  assert.equal(r.reading.battery, undefined);
  assert.equal(r.reading.rssi, undefined);
});

test('新鲜度：默认 10 分钟，过了就不算', () => {
  const r = { at: NOW, tempC: 20, humidity: 50 };
  assert.equal(isFresh(r, { now: NOW + 60_000 }), true);
  assert.equal(isFresh(r, { now: NOW + (DEFAULT_STALE_MINUTES + 1) * 60_000 }), false);
  assert.equal(readingAgeMs(r, NOW + 60_000), 60_000);
  assert.equal(readingAgeMs(null, NOW), Infinity);
});

test('给模型的那句话是「他那边的天气」，不报读数、不提技术', () => {
  const line = environmentLine({ at: NOW, tempC: 23.44, humidity: 58.2, place: '书房' }, { now: NOW + 2 * 60_000 });
  assert.match(line, /23\.4°C/);
  assert.match(line, /湿度 58%/);
  assert.match(line, /他那边的空气/);
  assert.match(line, /不是你这边的/);
  assert.match(line, /别把数字原样念出来/);
  assert.match(line, /从缝里看到的/);
  assert.doesNotMatch(line, /传感器|仪表盘|API|电脑/);
  assert.match(line, /2 分钟前/);
});

test('数据过期就整句话消失（缝起雾了就不说话）', () => {
  const stale = environmentLine({ at: NOW, tempC: 23.4, humidity: 58 }, { now: NOW + 3 * 3600_000 });
  assert.equal(stale, '');
  assert.equal(environmentLine(null, { now: NOW }), '');
  assert.equal(environmentLine({ at: NOW }, { now: NOW }), '');
});

// 世界设定：她住在四季如春的异世界，传感器量的是「他那边」，不是她那边。
// 所以读数里不该出现房间名，也不该说「你现在在书房」。
test('抬头是「缝那边」，不带房间名', () => {
  const line = environmentLine({ at: NOW, tempC: 23.4, humidity: 58, place: '书房' }, { now: NOW });
  assert.match(line, /【缝那边】/);
  assert.doesNotMatch(line, /书房/);
  assert.doesNotMatch(line, /你现在在/);
  assert.doesNotMatch(line, /我身边/);
});

test('交代清楚「你这边永远是舒服的」，所以不要去抱怨自己的冷热', () => {
  const line = environmentLine({ at: NOW, tempC: 23.4, humidity: 58 }, { now: NOW });
  assert.match(line, /你这边永远是舒服的/);
  assert.match(line, /不是你这边的/);
});

test('24 小时趋势算最小值/最大值/平均', () => {
  const entries = [
    { at: NOW - 3 * 3600_000, tempC: 20, humidity: 40 },
    { at: NOW - 2 * 3600_000, tempC: 24, humidity: 60 },
    { at: NOW - 1 * 3600_000, tempC: 22, humidity: 50 },
    { at: NOW - 30 * 3600_000, tempC: 99, humidity: 99 } // 24 小时外，必须被排除
  ];
  const s = summarizeHistory(entries, { now: NOW, hours: 24 });
  assert.equal(s.samples, 3);
  assert.deepEqual(s.temp, { min: 20, max: 24, avg: 22 });
  assert.deepEqual(s.humidity, { min: 40, max: 60, avg: 50 });
  assert.equal(summarizeHistory([], { now: NOW }), null);
});
