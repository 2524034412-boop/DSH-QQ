import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { romanceStage } from '../src/qq-romance.js';

const key = 'private:123';
const group = 'group:456';
const time = new Date(2026, 10, 25, 18).getTime();

async function fixture(run, { saved, familiar = false, gateway } = {}) {
  let now = time;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const files = {
    ...(saved ? { 'state/social-v2.json': saved } : {}),
    ...(familiar ? { 'state/romance.json': { crush: { uid: '123', stage: 'chosen' } } } : {})
  };
  const h = await bridgeHarness({ files, globals: { Date: TestDate, ...(gateway ? { fetch: gateway } : {}) } });
  h.setMode('reserved2');
  const state = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const send = async (messages, extra = {}, destination = key) => {
    const token = h.getSocialV2State(destination).agentToken;
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/socialV2/send-message', {
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ key: destination, messages, ...extra }),
      signal: AbortSignal.timeout(4000)
    });
    return { status: response.status, data: await response.json() };
  };
  const receive = (text, id, destination = key) =>
    h.appendSocialV2Message(destination, '朋友', text, text, false, false, id, [], '123');
  const savedState = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  try {
    return await run({ h, state, send, receive, savedState, advance: (ms) => { now += ms; } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

test('familiarity and generated suggestions do not count as romance; a delivered hint does', async () => {
  let reject = true;
  const gateway = async () => Response.json(reject
    ? { status: 'failed', retcode: 100 } : { status: 'ok', retcode: 0 });
  await fixture(async ({ h, send, state, receive, advance }) => {
    receive('等会要打游戏吗', '1');
    assert.match(h.buildWakePromptV2(key, 'private'), /你们聊得熟了/);
    assert.equal(state.romance, null);
    const result = await send('你明天要是还想打，叫我', { romanceHint: true });
    assert.equal(result.status, 500);
    assert.equal(state.romance, null);

    reject = false;
    assert.equal((await send('你明天要是还想打，叫我', { romanceHint: true })).status, 200);
    assert.equal(romanceStage(state.romance), 'hinted');
    assert.match(h.buildWakePromptV2(key, 'private'), /害羞可以发个表情/);
    assert.equal((await send('昨天跟你聊得很开心', { romanceHint: true })).status, 409);
    advance(8 * 24 * 3600_000);
    receive('昨晚的番看了没', '2');
    assert.equal(romanceStage(state.romance), 'hinted');
    assert.equal((await send('看了，那个字幕笑死我了')).status, 200);
  }, { familiar: true, gateway });
});

test('repeated or quoted affection does not force reciprocation; either side can ask for time', async () => {
  await fixture(async ({ h, send, receive, state }) => {
    receive('朋友说「我喜欢你」', '1');
    assert.equal(state.romance, null);
    for (let i = 2; i < 8; i++) receive('我喜欢你', String(i));
    assert.equal(romanceStage(state.romance), 'received');
    assert.match(h.buildWakePromptV2(key, 'private'), /还没想好/);
    assert.doesNotMatch(h.buildWakePromptV2(key, 'private'), /【忍不住了】|【攻略进度/);

    assert.equal((await send('我还没想好')).status, 200);
    assert.equal(romanceStage(state.romance), 'thinking');
    receive('我喜欢你', '8');
    assert.equal(romanceStage(state.romance), 'thinking');
    assert.equal((await send('你看到那段字幕没，离谱死了')).status, 200);
  });

  await fixture(async ({ send, receive, state }) => {
    assert.equal((await send('我其实有点喜欢你')).status, 200);
    assert.equal(romanceStage(state.romance), 'expressed');
    receive('我还没想好', '1');
    assert.equal(romanceStage(state.romance), 'thinking');
    assert.equal((await send('我们在一起吧')).status, 409);
    assert.equal((await send('要不先说回那个番？')).status, 200);
    receive('我想好了，可以聊聊我们了', '2');
    assert.equal(romanceStage(state.romance), 'expressed');
  });
});

test('mutual interest remains distinct from an accepted invitation, and survives restart', async () => {
  const saved = await fixture(async ({ send, receive, state, savedState }) => {
    receive('我喜欢你', '1');
    assert.equal((await send('我也喜欢你')).status, 200);
    assert.equal(romanceStage(state.romance), 'mutual');
    receive('我们在一起了', '2');
    assert.equal(romanceStage(state.romance), 'mutual');
    receive('你愿意和我交往吗', '3');
    assert.equal(romanceStage(state.romance), 'invited');
    assert.equal((await send('我愿意')).status, 200);
    assert.equal(romanceStage(state.romance), 'confirmed');
    return savedState();
  });
  await fixture(async ({ h, receive, state }) => {
    assert.equal(romanceStage(state.romance), 'confirmed');
    receive('以后还是做朋友吧', '4');
    assert.equal(romanceStage(state.romance), 'friends');
    receive('我喜欢你', '10', group);
    assert.equal(h.getSocialV2State(group).romance, null);
    assert.doesNotMatch(h.buildWakePromptV2(group, 'anyMessage'), /【这段私聊的关系】/);
  }, { saved });
});

test('an unrelated short affirmative does not accept an earlier invitation', async () => {
  await fixture(async ({ send, receive, state }) => {
    receive('我们在一起吧', '1');
    receive('改天你想一起打游戏吗', '2');
    assert.equal((await send('我愿意')).status, 200);
    assert.equal(romanceStage(state.romance), 'invited');
  });
});
