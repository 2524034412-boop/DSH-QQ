import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const personal = 'private:123';
const group = 'group:456';
const time = new Date(2026, 10, 25, 18).getTime();
const link = 'https://m.bilibili.com/video/BV1AbCdEfG12/?spm_id_from=test&p=2';
const canonical = 'https://www.bilibili.com/video/BV1AbCdEfG12?p=2';

async function fixture(run, state, globals = {}) {
  let now = time;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const h = await bridgeHarness({
    files: state ? { 'state/social-v2.json': state } : {},
    config: { socialV2: { send: { burstEnabled: true }, proactive: { enabled: true } } },
    globals: { Date: TestDate, ...globals }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = async (key, route, fields, tokenKey = key) => {
    const token = h.getSocialV2State(tokenKey).agentToken;
    const url = 'http://127.0.0.1:' + server.address().port + '/api/socialV2/' + route;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ key, ...fields }), signal: AbortSignal.timeout(4000)
    });
    return { status: response.status, data: await response.json() };
  };
  const append = (key, text, id, userId = '123', addressed = false) =>
    h.appendSocialV2Message(key, '朋友', text, text, false, false, id, [], userId, [], addressed);
  const sent = () => h.calls.http.filter((call) => /\/send_(?:private|group)_msg$/.test(call.url));
  const persisted = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  try { return await run({ h, request, append, sent, persisted, setTime: (ms) => { now = ms; } }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

async function untilFirstSent(sent) {
  for (let attempt = 0; attempt < 100 && sent().length === 0; attempt++) await delay(5);
  assert.equal(sent().length, 1);
}

test('private correction stops the remaining bubbles and releases their send quota', async () => {
  await fixture(async ({ h, request, append, sent }) => {
    append(personal, '你继续说', '21');
    const pending = request(personal, 'send-message', {
      messages: ['第一句', '第二句', '第三句'], gapMode: 'fixed', gapMs: 900
    });
    await untilFirstSent(sent);
    append(personal, '等等，我说的是另一个', '22');
    const res = await pending;
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.interrupted, true);
    assert.equal(res.data.sent, 1);
    assert.equal(res.data.cancelled, 2);
    assert.equal(sent().length, 1);
    const st = h.getSocialV2State(personal);
    assert.equal(st.sendTimes.length, 1);
    assert.equal(st.recentMessages.filter((msg) => msg.isSelf).length, 1);
  });
});

test('group chatter does not interrupt a burst and an explicitly addressed correction does', async () => {
  await fixture(async ({ request, append, sent }) => {
    append(group, '讲讲看', '21', '111');
    const pending = request(group, 'send-message', { messages: ['一句', '下一句'], gapMode: 'fixed', gapMs: 160 });
    await untilFirstSent(sent);
    append(group, '[表情]', '22', '111');
    append(group, '等等，我说的是午饭', '23', '222');
    assert.equal((await pending).data.sent, 2);
  });
  await fixture(async ({ request, append, sent }) => {
    append(group, '讲讲看', '21', '111');
    const pending = request(group, 'send-message', { messages: ['一句', '下一句'], gapMode: 'fixed', gapMs: 900 });
    await untilFirstSent(sent);
    append(group, '@小鲸鱼 等等，我说的是另一个', '22', '222', true);
    assert.equal((await pending).data.cancelled, 1);
    assert.equal(sent().length, 1);
  });
});

test('private preferences are tied to the source conversation, persist, and cancel work follow-ups', async () => {
  const state = await fixture(async ({ request, append, persisted }) => {
    append(personal, '明天要面试', '21');
    const body = {
      category: 'pendingThought', content: '面试结束可以问问',
      extra: { followUpAt: new Date(time + 24 * 3600_000).toISOString(), sourceMessageId: '21' }
    };
    assert.equal((await request(personal, 'memory-append', body)).status, 200);
    const preferences = { workFollowUps: false, casualLinks: false, quietAtNight: true };
    assert.equal((await request(personal, 'chat-preferences', { preferences, sourceMessageId: '999' })).status, 400);
    append(personal, '工作等我提，别主动发链接，夜里别找我', '22');
    const updated = await request(personal, 'chat-preferences', { preferences, sourceMessageId: '22' });
    assert.deepEqual(updated.data.preferences, preferences);
    assert.equal((await request(group, 'chat-preferences', {})).status, 403);
    assert.equal((await request(personal, 'memory-append', body)).status, 409);
    assert.equal((await request(personal, 'send-message', { biliVideo: link })).status, 409);
    const snapshot = persisted();
    assert.equal(snapshot.conversations[personal].followUps[0].state, 'dismissed');
    return snapshot;
  });

  await fixture(async ({ request, append, sent, setTime }) => {
    const read = await request(personal, 'chat-preferences', {});
    assert.deepEqual(read.data.preferences, { workFollowUps: false, casualLinks: false, quietAtNight: true });
    setTime(new Date(2026, 10, 25, 23, 30).getTime());
    append(personal, '链接可以发了，但你先告诉我这个怎么弄', '88');
    await request(personal, 'chat-preferences', { preferences: { casualLinks: true }, sourceMessageId: '88' });
    assert.equal((await request(personal, 'send-message', { biliVideo: link })).status, 409);
    assert.equal((await request(personal, 'send-message', { messages: '你从设置里打开就行' })).status, 200);
    assert.equal(sent().length, 1);
  }, state);
});

test('shares a validated Bilibili link to the current group and persists the duplicate check', async () => {
  const state = await fixture(async ({ request, sent, persisted }) => {
    assert.equal((await request(group, 'send-message', { biliVideo: 'https://bilibili.com.example.invalid/video/BV1AbCdEfG12' })).status, 400);
    assert.equal((await request(group, 'send-message', { biliVideo: link }, personal)).status, 403);
    const results = await Promise.all([
      request(group, 'send-message', { biliVideo: link, caption: '这个光影挺好看' }),
      request(group, 'send-message', { biliVideo: link, caption: '这个光影挺好看' })
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409], JSON.stringify(results));
    const message = sent()[0].body;
    assert.equal(sent().length, 1);
    assert.equal(message.group_id, 456);
    assert.match(message.message[0].data.text, /这个光影挺好看/);
    assert.ok(message.message[0].data.text.includes(canonical));
    assert.doesNotMatch(message.message[0].data.text, /spm_id_from/);
    return persisted();
  });

  await fixture(async ({ request, sent }) => {
    assert.equal((await request(group, 'send-message', { biliVideo: 'BV1AbCdEfG12' })).status, 409);
    assert.equal((await request(group, 'send-message', { biliVideo: 'https://b23.tv/aB123?tracking=old' })).status, 200);
    assert.equal(sent().length, 1);
    assert.equal(sent()[0].body.message[0].data.text, 'https://b23.tv/aB123');
  }, state);
});

test('Bilibili share can retry a confirmed rejection but holds an uncertain attempt', async () => {
  let attempt = 0;
  const fakeGateway = async (url) => {
    assert.ok(String(url).endsWith('/send_group_msg'));
    attempt += 1;
    if (attempt === 1) return Response.json({ status: 'failed', retcode: 100, wording: 'fixture reject' });
    if (attempt === 3) throw new Error('fixture lost acknowledgement');
    return Response.json({ status: 'ok', retcode: 0, data: { message_id: 5 } });
  };
  await fixture(async ({ request }) => {
    assert.equal((await request(group, 'send-message', { biliVideo: link })).status, 500);
    assert.equal((await request(group, 'send-message', { biliVideo: link })).status, 200);
    const short = { biliVideo: 'https://b23.tv/aB123' };
    assert.equal((await request(group, 'send-message', short)).status, 500);
    assert.equal((await request(group, 'send-message', short)).status, 409);
    assert.equal(attempt, 3);
  }, undefined, { fetch: fakeGateway });
});
