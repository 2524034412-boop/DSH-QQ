import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { MOOD_EMOTIONS, decayMood, moodExpression, supportSignal } from '../src/qq-emotions.js';

const privateKey = 'private:123';
const groupKey = 'group:456';
const start = new Date(2026, 10, 25, 18).getTime();
const minute = 60_000;

async function fixture(run, { files } = {}) {
  let now = start;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const h = await bridgeHarness({ files, globals: { Date: FixedDate } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const call = async (route, key, payload, tokenKey = key) => {
    const token = h.getSocialV2State(tokenKey).agentToken;
    const base = 'http://127.0.0.1:' + server.address().port + '/api/';
    const response = await fetch(base + route + '?key=' + encodeURIComponent(key), {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token',
        ...(!route.startsWith('debug/') ? { 'x-agent-token': token } : {}), 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify({ key, ...payload }),
      signal: AbortSignal.timeout(4000)
    });
    return { status: response.status, data: await response.json() };
  };
  const append = (key, text, id, uid, atSelf = false) =>
    h.appendSocialV2Message(key, '朋友', text, text, false, false, id, [], uid, [], atSelf);
  try {
    return await run({ h, call, append, advance: (duration) => { now += duration; },
      mood: (key, mood) => call('socialV2/mood', key, mood) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

test('all fifteen emotions have separate light, strong and fading behavior', () => {
  assert.equal(MOOD_EMOTIONS.length, 15);
  const lines = new Set();
  for (const emotion of MOOD_EMOTIONS) {
    const seeded = { emotion, intensity: 4, at: start };
    const ttl = 120 * minute;
    assert.equal(decayMood(seeded, start, ttl).intensity, 4);
    const fading = decayMood(seeded, start + 70 * minute, ttl);
    assert.ok(fading, emotion);
    assert.ok(fading.intensity > 0 && fading.intensity < 4, emotion);
    assert.equal(fading.fading, true, emotion);
    const strong = moodExpression(seeded);
    const light = moodExpression(fading);
    assert.ok(strong && light && strong !== light, emotion);
    lines.add(strong);
    assert.ok((decayMood(seeded, start + ttl - 1, ttl)?.intensity ?? 0) <= 1, emotion);
    assert.equal(decayMood(seeded, start + ttl, ttl), null);
  }
  assert.equal(lines.size, 15);
  assert.equal(supportSignal('我是在维修电脑'), '');
  assert.equal(supportSignal('我在上班'), '');
  assert.equal(supportSignal('对不起'), 'comfort');
  assert.equal(supportSignal('哦，我听反了'), 'repair');
});

test('existing moods load, repeated reports keep their timestamps, and ambient context has no private details', async () => {
  await fixture(async ({ h, mood, append, advance }) => {
    assert.equal((await mood(privateKey)).data.mood.emotion, '开心');
    append(privateKey, '我刚才说了个容易误会的事', '101', '123');
    const form = { emotion: '害怕', intensity: 4, reason: '刚才真的以为说错了', sourceMessageId: '101' };
    assert.equal((await mood(privateKey, { ...form, sourceMessageId: '999' })).status, 400);
    const old = (await mood(privateKey, form)).data.mood;
    advance(20 * minute);
    const next = (await mood(privateKey, form)).data.mood;
    assert.equal(old.at, next.at);
    const foreign = (await mood(groupKey)).data.mood;
    assert.equal(foreign.ambient, true);
    assert.equal(foreign.intensity, 1);
    assert.equal(foreign.reason, undefined);
    assert.equal(foreign.source, undefined);
    assert.doesNotMatch(h.buildWakePromptV2(groupKey, 'anyMessage'), /刚才真的以为说错了/);
    assert.equal((await mood(groupKey, { emotion: '好奇', intensity: 2, reason: '本群的话题' })).status, 200);
    assert.equal((await mood(groupKey)).data.mood.emotion, '好奇');

    await mood(privateKey, { emotion: '开心', intensity: 3, term: 'long', reason: '最近的日子挺好' });
    await mood(privateKey, { emotion: '安心', intensity: 2, reason: '听懂那句了' });
    const settled = (await mood(privateKey)).data;
    assert.equal(settled.mood.previousEmotion, '害怕');
    assert.equal(settled.longMood.emotion, '开心');
  }, { files: { 'state/mood.json': { moods: { [privateKey]: { emotion: '开心', intensity: 2, at: start } } } } });
});

test('same-conversation explanation softens the linked feeling gradually; casual comfort does not replace it', async () => {
  await fixture(async ({ h, mood, append, advance }) => {
    append(groupKey, '@小鲸鱼 刚才那句很容易被听岔', '100', '111', true);
    const form = { emotion: '害怕', intensity: 4, reason: '以为这句是对我说的', sourceMessageId: '100' };
    assert.equal((await mood(groupKey, form)).status, 200);
    const explain = '我是在气那个 bug';
    assert.equal(h.noteComfort(groupKey, explain, '222', { directed: true }), 0);
    assert.equal(h.noteComfort(groupKey, explain, '111', { directed: false }), 0);
    assert.ok(h.noteComfort(groupKey, '没事的', '111', { directed: true }) > 0);
    assert.equal((await mood(groupKey)).data.mood.intensity, 4);
    assert.ok(h.noteComfort(groupKey, explain, '111', { directed: true, messageId: '101' }) > 0);
    assert.equal((await mood(groupKey)).data.mood.intensity, 3);
    advance(11 * minute);
    h.noteComfort(groupKey, '哦，我听反了', '111', { directed: true, messageId: '102' });
    assert.equal((await mood(groupKey)).data.mood.intensity, 2);
    advance(11 * minute);
    h.noteComfort(groupKey, '对不起，我刚才说重了', '111', { directed: true, messageId: '103' });
    const end = (await mood(groupKey)).data.mood;
    assert.equal(end.emotion, '安心');
    assert.equal(end.previousEmotion, '害怕');
    assert.equal(end.source.messageId, '103');
  });
});

test('praise reacts to the actual addressed message and stops prompting after a reply', async () => {
  await fixture(async ({ h, append, mood }) => {
    await mood(privateKey, { emotion: '害羞', intensity: 3 });
    assert.doesNotMatch(h.buildWakePromptV2(privateKey, 'private'), /【被夸之后】|【眼前一句肯定】/);
    append(groupKey, '右边那点暖色调得真好看', '101', '222');
    assert.doesNotMatch(h.buildWakePromptV2(groupKey, 'anyMessage'), /【眼前一句肯定】/);
    append(groupKey, '@小鲸鱼 右边那点暖色调得真好看', '102', '222', true);
    assert.match(h.buildWakePromptV2(groupKey, 'anyMessage'), /你为什么这么做/);
    h.recordSentMessagesV2(groupKey, ['那个我调了挺久']);
    assert.doesNotMatch(h.buildWakePromptV2(groupKey, 'anyMessage'), /【眼前一句肯定】/);
  });
});

test('high-pressure preview and pause stay local and recovery releases stress without relationship rewards', async () => {
  await fixture(async ({ call, h, mood }) => {
    await mood(groupKey, { emotion: '委屈', intensity: 4 });
    const dry = await call('debug/breakdown', groupKey, { dry: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.data));
    assert.equal(dry.data.active, false);
    assert.equal(dry.data.preview.emotion, '委屈');
    const actual = await call('debug/breakdown', groupKey, {});
    assert.equal(actual.data.active, true);
    assert.equal(h.calls.http.length, 0);
    assert.equal(h.calls.prompts.length, 0);
    assert.match(h.buildWakePromptV2(groupKey, 'anyMessage'), /哪件事被听岔了/);
    assert.doesNotMatch(h.buildWakePromptV2(privateKey, 'private'), /哪件事被听岔了/);
    const denied = await call('socialV2/breakdown-recover', groupKey, { level: 2 }, privateKey);
    assert.equal(denied.status, 403);
    const recovering = await call('socialV2/breakdown-recover', groupKey, { level: 2 });
    assert.equal(recovering.status, 200, JSON.stringify(recovering.data));
    assert.equal(recovering.data.stress, 80);
    const repeated = await call('socialV2/breakdown-recover', groupKey, { level: 3 });
    assert.equal(repeated.data.stressCut, 0);
    assert.equal(repeated.data.stress, 80);
    assert.deepEqual(recovering.data.gained, { affection: 0, love: 0 });
    assert.equal((await mood(groupKey)).data.mood.intensity, 3);
  }, { files: { 'state/stress.json': { conv: { [groupKey]: { value: 96, at: start } } } } });
});
