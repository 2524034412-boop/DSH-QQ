// 温湿度接进「唤醒提示」的那一层：文件在 → 提示里有一行；过期 / 没设备 → 一个字都不多。
// 用真实 bridge.js 的 buildWakePromptV2，只把 state/environment.json 当夹具。
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';

async function fixture(run, { reading, config, world } = {}) {
  const files = {};
  if (reading !== undefined) files['state/environment.json'] = reading;
  if (world !== undefined) files['roles/world.md'] = world;
  const h = await bridgeHarness({
    files,
    config: {
      socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, ...(config?.socialV2 ?? {}) },
      ...(config ?? {})
    }
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(KEY)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key: KEY, ...body }));
  });
  try { await run({ h, st, request }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

test('有新鲜读数时，唤醒提示里带一行「缝那边」，说明是他那边的天气', () => fixture(async ({ h }) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.match(prompt, /【缝那边】/);
  assert.match(prompt, /23\.4°C/);
  assert.match(prompt, /湿度 58%/);
  assert.match(prompt, /别把数字原样念出来/);
  // 这一行必须排在时间之后，别塞在人设段后面
  assert.ok(prompt.indexOf('【时间】') < prompt.indexOf('【缝那边】'));
}, { reading: { at: Date.now() - 60_000, tempC: 23.4, humidity: 58.2, place: '书房' } }));

test('读数过期就不提（10 分钟以上的旧数不能当现在）', () => fixture(async ({ h }) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.doesNotMatch(prompt, /【缝那边】/);
}, { reading: { at: Date.now() - 3 * 3600_000, tempC: 23.4, humidity: 58.2 } }));

test('没接设备时提示词与之前逐字一致（空串，不多一个换行）', () => fixture(async ({ h }) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.doesNotMatch(prompt, /【缝那边】/);
  assert.doesNotMatch(prompt, /体感用/);
}));

test('enabled=false 时就算有读数也不注入', () => fixture(async ({ h }) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.doesNotMatch(prompt, /【缝那边】/);
}, { reading: { at: Date.now(), tempC: 23.4, humidity: 58.2 }, config: { environment: { enabled: false } } }));

test('qq_environment 背后的接口：读数 + 新鲜度 + 提示话术', () => fixture(async ({ request }) => {
  const r = await request('environment');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.deviceConnected, true);
  assert.equal(r.data.stale, false);
  assert.equal(r.data.reading.tempC, 23.4);
  assert.ok(r.data.ageMs >= 0);
  assert.match(r.data.hint, /他那边的空气|他那边/);
  assert.match(r.data.hint, /别报/);
}, { reading: { at: Date.now() - 30_000, tempC: 23.4, humidity: 58.2, place: '书房' } }));

test('没设备时接口明确说没有，不给编造留口子', () => fixture(async ({ request }) => {
  const r = await request('environment');
  assert.equal(r.status, 200);
  assert.equal(r.data.deviceConnected, false);
  assert.equal(r.data.stale, true);
  assert.match(r.data.hint, /别编/);
}));

// 世界设定（roles/world.md）必须每次唤醒都带：它决定她怎么理解「缝」和「他那边」。
test('世界设定会进唤醒提示，且排在环境那一行前面', () => fixture(async ({ h }) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.match(prompt, /【世界】/);
  assert.match(prompt, /异世界/);
  assert.match(prompt, /缝/);
  assert.ok(prompt.indexOf('【世界】') < prompt.indexOf('【缝那边】'), '先讲世界，再给读数');
}, {
  reading: { at: Date.now(), tempC: 23.4, humidity: 58.2 },
  world: '# 世界\n我住在一个异世界。他用魔法开了一道很细的缝，从缝里能看见他那边的空气。'
}));

test('没有 world.md 时不注入世界段（不凭空捏设定）', () => fixture(async ({ h }) => {
  const prompt = h.buildWakePromptV2(KEY, 'question');
  assert.doesNotMatch(prompt, /【世界】/);
}));
