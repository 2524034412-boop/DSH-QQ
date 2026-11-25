import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = 'private:123';
const original = '明天下午面试，有点慌';
const initialTime = new Date(2026, 10, 25, 18).getTime();
const dueAt = new Date(2026, 10, 26, 18).getTime();
const reason = (id) => 'followUp:' + id;

async function withFixture(run, { state, time = initialTime } = {}) {
  let now = time;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const h = await bridgeHarness({
    files: state ? { 'state/social-v2.json': state } : {},
    config: { socialV2: { proactive: { enabled: true }, budget: { enabled: false } } },
    globals: { Date: TestDate }
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));

  const request = async (route, body = {}, destination = key) => {
    const token = h.getSocialV2State(destination).agentToken;
    const url = 'http://127.0.0.1:' + server.address().port + '/api/socialV2/' + route;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ key: destination, ...body }),
      signal: AbortSignal.timeout(3000)
    });
    return { status: response.status, data: await response.json() };
  };

  const append = (text, messageId) =>
    h.appendSocialV2Message(key, '朋友', text, text, false, true, messageId, [], '123');
  const register = (sourceMessageId = '-101') => request('memory-append', {
    category: 'pendingThought', content: '面试结束后可以问问',
    extra: { followUpAt: new Date(dueAt).toISOString(), sourceMessageId }
  });
  const persisted = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  try {
    return await run({
      h, st, request, append, register, persisted, advance: (time) => { now = time; },
      send: (id) => request('send-message', { messages: '你那个面试结束了没', followUpId: id })
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

async function scheduledPrompt(h, st) {
  h.scheduleFollowUpV2(key, st, 0, true);
  for (let attempt = 0; attempt < 40 && h.calls.prompts.length === 0; attempt++) await delay(10);
  assert.equal(h.calls.prompts.length, 1, 'due item should wake the original private session');
  return h.calls.prompts[0].content[0].text;
}

test('registers against the original private message, restores across a restart, and sends only once', async () => {
  const setup = await withFixture(async ({ h, st, request, append, register, persisted, send }) => {
    assert.equal((await register()).status, 400);
    append(original, '-101');
    const group = await request('memory-append', {
      category: 'pendingThought', content: '要跟进',
      extra: { followUpAt: new Date(dueAt).toISOString(), sourceMessageId: '-101' }
    }, 'group:456');
    assert.equal(group.status, 403);
    const first = await register();
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const id = first.data.followUp.id;
    assert.equal((await register()).data.followUp.id, id);
    assert.equal((await send(id)).status, 409);
    assert.ok(st.followUpTimer);
    assert.equal(h.calls.prompts.length, 0);
    return { id, state: persisted() };
  });
  const afterSend = await withFixture(async ({ h, st, request, send, persisted }) => {
    const text = await scheduledPrompt(h, st);
    assert.match(text, /【私聊定时跟进】private:123/);
    assert.ok(text.includes(original));
    assert.ok(text.includes(setup.id));
    assert.equal((await request('send-message', { messages: '普通发送缺少跟进 ID' })).status, 409);
    assert.notEqual((await request('send-burst', { messages: ['不能绕过跟进发送'] })).status, 200);
    assert.equal((await request('send-message', { messages: ['一', '二'], followUpId: setup.id })).status, 409);
    const sends = await Promise.all([send(setup.id), send(setup.id)]);
    assert.deepEqual(sends.map((result) => result.status).sort(), [200, 409], JSON.stringify(sends));
    const qq = h.calls.http.filter((call) => call.url.endsWith('/send_private_msg'));
    assert.equal(qq.length, 1);
    assert.equal(qq[0].body.user_id, 123);
    return persisted();
  }, { state: setup.state, time: dueAt + 1000 });
  await withFixture(async ({ h, send }) => {
    await h.sendWakePromptV2(key, reason(setup.id));
    assert.equal((await send(setup.id)).status, 409);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.calls.http.length, 0);
  }, { state: afterSend, time: dueAt + 15 * 60_000 });
});

test('surfaces an already reported result and supports closing it before the timer', async () => {
  await withFixture(async ({ h, append, register, request, advance, persisted }) => {
    append(original, '-101');
    const item = (await register()).data.followUp;
    advance(dueAt - 60 * 60_000);
    append('面完了，刚收到通过通知', '102');
    const normalPrompt = h.buildWakePromptV2(key, 'private');
    assert.ok(normalPrompt.includes(item.id));
    assert.match(normalPrompt, /已经给了结果/);
    const removed = await request('memory-remove', { category: 'pendingThought', followUpId: item.id });
    assert.equal(removed.status, 200);
    advance(dueAt + 1000);
    await h.sendWakePromptV2(key, reason(item.id));
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(persisted().conversations[key].followUps[0].state, 'dismissed');
  });
});

test('includes the full intervening exchange and rejects a send if fresh input arrived after review', async () => {
  await withFixture(async ({ h, st, append, register, advance, send }) => {
    append(original, '-101');
    const item = (await register()).data.followUp;
    advance(dueAt - 60 * 60_000);
    append('还没开始，在等前一位', '102');
    advance(dueAt + 1000);
    const text = await scheduledPrompt(h, st);
    assert.match(text, /还没开始，在等前一位/);
    assert.match(text, /已经给了结果.*直接收尾/);
    append('已经结束了，准备回家', '103');
    assert.equal((await send(item.id)).status, 409);
    assert.equal(h.calls.http.length, 0);
  });
});

test('dismisses a due follow-up when recent history has lost messages', async () => {
  await withFixture(async ({ h, st, append, register, advance, persisted }) => {
    append(original, '-101');
    const item = (await register()).data.followUp;
    append('面试改期了', '102');
    append('另外还有个事', '103');
    st.recentMessages = st.recentMessages.filter((msg) => msg.seq !== 2);
    advance(dueAt + 1000);
    await h.sendWakePromptV2(key, reason(item.id));
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(persisted().conversations[key].followUps[0].state, 'dismissed');
  });
});

test('rechecks a due follow-up after an explicit DSH rejection', async () => {
  await withFixture(async ({ h, st, append, register, advance, send, persisted }) => {
    append(original, '-101');
    const item = (await register()).data.followUp;
    const acceptedPrompt = h.api.sessions.prompt;
    h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'fixture', message: 'busy' } } });
    advance(dueAt + 1000);
    await h.sendWakePromptV2(key, reason(item.id));
    assert.equal(persisted().conversations[key].followUps[0].state, 'pending');
    assert.equal((await send(item.id)).status, 409);

    h.api.sessions.prompt = acceptedPrompt;
    await scheduledPrompt(h, st);
    assert.equal((await send(item.id)).status, 200);
  });
});

test('correction retains identity and forgetting dismisses the matching follow-up', async () => {
  await withFixture(async ({ request, append, register, st }) => {
    append(original, '-101');
    await register();
    const route = 'global-memory-append';
    const { data } = await request(route, { text: '周一面试' });
    const id = data.entry.id;
    const change = { text: '周二面试', replaceId: id, previousText: '周一面试' };
    assert.equal((await request(route, change)).data.entry.id, id);
    assert.equal((await request(route, change)).status, 400);
    const removed = await request('global-memory-remove', { id, followUpId: st.followUps[0].id });
    assert.equal(removed.data.removed, 1);
    assert.equal(st.followUps[0].state, 'dismissed');
  });
});
