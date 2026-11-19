// 网页群聊 · P0
// 目标只有一个：证明「网页 → 她 → 网页」这条路通。
// 不碰 state/，不碰正在跑的 QQ 链路，只新开一个入口。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { makeMediaHandler } from './media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(HERE, 'data');
const PUBLIC = path.join(HERE, 'public');
fs.mkdirSync(DATA, { recursive: true });

const INVITE_FILE = path.join(DATA, 'invites.json');
const MEMBER_FILE = path.join(DATA, 'members.json');

const PORT = Number(process.env.WC_PORT || 3300);
const HOST = process.env.WC_HOST || '127.0.0.1';
const GROUP_NAME = process.env.WC_GROUP || '鲸鱼池';
const HER_NAME = process.env.WC_HER_NAME || '小鲸鱼';   // QQ 上就叫这个，网页里保持一致


const CARD_FILE = path.join(ROOT, 'roles', '独立AI.md');

let cardCache = { mtime: 0, text: '' };
function herCard() {
  try {
    const st = fs.statSync(CARD_FILE);
    if (cardCache.mtime !== st.mtimeMs) {
      cardCache = { mtime: st.mtimeMs, text: fs.readFileSync(CARD_FILE, 'utf8') };
    }
    return cardCache.text;
  } catch { return ''; }
}
// 用 minimal preset：不带 QQ 那套工具，纯粹回文字。桥接的 qq-chat 带工具，
// 新会话里会卡在工具审批上，turn 永远不结束（P0 实测踩过）。
const HER_PRESET = process.env.WC_PRESET || 'minimal';

// ── 配置 ────────────────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// 接桥接（P1）：网页群在桥接那边是一个"假群号"，跟 QQ 群走同一条处理链，
// 所以记忆、好感、唤醒规则全是同一个她。设 WC_BRAIN=local 则退回本地直连 DSH。
const WC = cfg.webchat || {};
const WEB_GROUP_ID = String((WC.groups || [900000001])[0]);
const WEB_TOKEN = String(WC.token || '');
const BRIDGE_INBOUND = 'http://127.0.0.1:' + (WC.inboundPort || 3102);
const USE_BRIDGE = process.env.WC_BRAIN !== 'local';
let typingTimer = null;
const HER_NAMES = /小鲸鱼|鲸鱼|deepseek|d老师|d师傅|大肥鱼|小肥鱼/i;

// ── 小工具 ──────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function nowIso() { return new Date().toISOString(); }
const LOG_FILE = path.join(DATA, 'server.log');
function log(...args) {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
  try { console.log(line); } catch {}
}

let invites = readJson(INVITE_FILE, { codes: [] });
let members = readJson(MEMBER_FILE, { members: [] });

// ── 群消息（只留最近 300 条在内存）──────────────────────────────────────
const history = [];
let seq = 0;
function pushMessage(msg) {
  msg.id = ++seq;
  msg.at = nowIso();
  history.push(msg);
  if (history.length > 300) history.splice(0, history.length - 300);
  broadcast({ type: 'msg', msg });
  return msg;
}

// ── 多媒体（表情包 / 语音 / 上传）──────────────────────────────────────
const mediaHandler = makeMediaHandler({ DATA, token: WEB_TOKEN, pushMessage, broadcast, HER_NAME });

// ── SSE 广播 ────────────────────────────────────────────────────────────
const streams = new Set();
function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of streams) {
    try { res.write(line); } catch { streams.delete(res); }
  }
}
function memberList() {
  return members.members
    .filter((m) => !m.kicked)
    .map((m) => ({ nick: m.nick, joinedAt: m.joinedAt }));
}

// ── 邀请码 ──────────────────────────────────────────────────────────────
function codeStatus(c) {
  if (c.revoked) return 'revoked';
  if (c.used >= c.maxUses) return 'used-up';
  if (c.expiresAt && Date.now() > c.expiresAt) return 'expired';
  return 'ok';
}

// ── 会话 ────────────────────────────────────────────────────────────────
function parseCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function whoami(req) {
  const token = parseCookie(req, 'wc');
  if (!token) return null;
  members = readJson(MEMBER_FILE, { members: [] }); // 踢人要立刻生效，不能等重启
  const m = members.members.find((x) => x.token === token);
  if (!m || m.kicked) return null;
  return m;
}

// ── DSH：让她回话 ───────────────────────────────────────────────────────
const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
  token: cfg.dsh.authToken,
  tokenExplicit: cfg.dsh.authTokenExplicit === true,
  header: cfg.dsh.authHeader,
  prefix: cfg.dsh.authPrefix,
  allowRemote: cfg.dsh.allowRemote === true,
});

let sessionId = null;
let sessionReady = null;
const collectors = new Map();
const textBuf = new Map(); // turn -> 累积的 assistant 文本
const waiters = new Map(); // sessionId -> [resolve]

async function ensureSession() {
  if (sessionId) return sessionId;
  if (sessionReady) return sessionReady;
  sessionReady = (async () => {
    const dir = path.join(DATA, 'her-workspace');
    fs.mkdirSync(dir, { recursive: true });
    const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
    const params = { workspaceId: ws.workspace.workspaceId };
    params.agentPreset = HER_PRESET;
    const created = unwrap(await api.sessions.create(params), 'sessions.create');
    sessionId = String(created.sessionId);
    try {
      await api.sessions.selectModel?.({
        sessionId,
        provider: cfg.dsh.provider,
        model: cfg.dsh.model,
        reasoningEffort: cfg.dsh.reasoningEffort,
      });
    } catch (e) { log('选模型失败（不影响回话）:', e.message); }
    api.events.follow(sessionId);
    startPump();
    log('她的网页会话已建:', sessionId);
    return sessionId;
  })().catch((e) => { sessionReady = null; throw e; });
  return sessionReady;
}

let pumping = false;
function startPump() {
  if (pumping) return;
  pumping = true;
  (async () => {
    for (;;) {
      try {
        log('事件流开始连接…');
        let firstFrames = 0;
        for await (const envelope of api.events.mux({})) {
          const frame = envelope?.payload;
          framesSeen++;
          if (lastFrames.length >= 12) lastFrames.shift();
          lastFrames.push(String(frame?.event?.type || frame?.type || '?'));
          log('帧:', frame?.event?.type || frame?.type, JSON.stringify(frame?.event?.data || {}).slice(0, 90));
          if (!frame || frame.type !== 'session/event') continue;
          const sid = String(frame.sessionId || '');
          const ev = frame.event || {};
          // 不用 createTurnCollector：这一版 DSH 的首个回合只发 step/start，
          // 没有 turn/start，collector 会因为「没建过 turn」把整段丢掉。
          // 直接按 turn 号累加 assistant 文本，turn/end 时结算。
          if (ev.type === 'assistant/message') {
            const turn = ev.data?.turn;
            if (turn != null) {
              const blocks = ev.data?.message?.content || [];
              let text = '';
              for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
              if (text) textBuf.set(turn, (textBuf.get(turn) || '') + text);
            }
          } else if (ev.type === 'turn/end') {
            const turn = ev.data?.turn;
            const text = turn != null ? (textBuf.get(turn) || '') : '';
            if (turn != null) textBuf.delete(turn);
            const arr = waiters.get(sid) || [];
            const w = arr.shift();
            if (w) w(text);
          }
        }
      } catch (e) {
        log('事件流断开，3 秒后重连:', e.message);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
}

function waitTurn(sid, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const arr = waiters.get(sid) || [];
      const i = arr.indexOf(resolve);
      if (i >= 0) arr.splice(i, 1);
      reject(new Error('等她回话超时'));
    }, timeoutMs);
    const wrapped = (text) => { clearTimeout(timer); resolve(text); };
    const arr = waiters.get(sid) || [];
    arr.push(wrapped);
    waiters.set(sid, arr);
  });
}

function recentForPrompt(limit = 12) {
  return history.slice(-limit)
    .map((m) => (m.role === 'her' ? `鲸鱼女孩：${m.text}` : `${m.nick}：${m.text}`))
    .join('\n');
}

async function herReply(trigger) {
  const sid = await ensureSession();
  const card = herCard();
  const members1 = memberList().map((m) => m.nick).join('、') || '你自己';
  const prompt = [
    '【网页群聊】',
    `这是你自己的一个小群，群名「${GROUP_NAME}」。群里有：${members1}。`,
    '注意：这里的你，和 QQ 群里那个你是同一个人，下面是同一张人格卡。',
    '',
    '═══ 你的人格卡 ═══',
    card,
    '═══ 人格卡结束 ═══',
    '',
    '最近的对话：',
    recentForPrompt(),
    '',
    '刚刚有人对你说：' + trigger,
    '',
    '硬规则：',
    '1. 只输出你要发的那句话本身，不要引号、不要旁白、不要解释你为什么这么说。',
    '2. 一两句，短。不要分点、不要总结、不要客服腔。',
    '3. 这一轮**禁止调用任何工具**（尤其不要用任何以 qq_ 开头的工具），只回文字。',
    '4. 这是网页测试，不要提 QQ、群号、机器人。',
  ].join('\n');

  const before = Date.now();
  await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: prompt }] });
  const text = await waitTurn(sid, 120000);
  log(`她回了（${Date.now() - before}ms）:`, text.slice(0, 60));
  return cleanReply(text);
}

function cleanReply(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/g, '').trim();
  t = t.replace(/^["“'「]/, '').replace(/["”'」]$/, '').trim();
  t = t.replace(/^(鲸鱼女孩|小鲸鱼|我)\s*[:：]\s*/, '').trim();
  if (t.length > 300) t = t.slice(0, 300);
  return t;
}

// ── 她该不该开口 ────────────────────────────────────────────────────────
let lastHerAt = 0;
let framesSeen = 0;
const lastFrames = [];
let lastError = null;
let herBusy = false;

function shouldReply(text) {
  if (HER_NAMES.test(text)) return true;
  if (text.includes('@鲸鱼女孩')) return true;
  const gap = Date.now() - lastHerAt;
  if (gap < 15000) return false;
  return Math.random() < 0.35;
}

async function deliverToBridge(me, text) {
  broadcast({ type: 'typing', on: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => broadcast({ type: 'typing', on: false }), 90000);
  try {
    const r = await fetch(BRIDGE_INBOUND + '/incoming', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webchat-token': WEB_TOKEN },
      body: JSON.stringify({ groupId: WEB_GROUP_ID, uid: me.uid, nick: me.nick, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('桥接 ' + r.status);
  } catch (e) {
    broadcast({ type: 'typing', on: false });
    log('桥接没接上:', e.message);
    pushMessage({ role: 'sys', text: '（桥接没接上：' + e.message + '）' });
  }
}

async function maybeReply(text) {
  if (herBusy) return;
  if (!shouldReply(text)) return;
  herBusy = true;
  try {
    await new Promise((r) => setTimeout(r, 600));
    broadcast({ type: 'typing', on: true });
    const reply = await herReply(text);
    broadcast({ type: 'typing', on: false });
    if (reply) {
      lastHerAt = Date.now();
      pushMessage({ role: 'her', nick: HER_NAME, text: reply });
    }
  } catch (e) {
    broadcast({ type: 'typing', on: false });
    lastError = e.message;
    log('她没回:', e.message);
    pushMessage({ role: 'sys', text: `（她这会儿没接上话：${e.message}）` });
  } finally {
    herBusy = false;
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const lastSay = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (await mediaHandler(req, res, url)) return;

    // 静态
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/j/'))) {
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }

    // 进门
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const code = String(body.code || '').trim();
      const nick = String(body.nick || '').trim().slice(0, 16);
      if (!code || !nick) return sendJson(res, 400, { ok: false, error: '邀请码和昵称都要填' });

      // 每次都从磁盘重读：否则新发的码要重启才认，收回的码也停不下来
      invites = readJson(INVITE_FILE, { codes: [] });
      members = readJson(MEMBER_FILE, { members: [] });

      const inv = invites.codes.find((c) => c.code.toUpperCase() === code.toUpperCase());
      if (!inv) return sendJson(res, 403, { ok: false, error: '邀请码不对' });
      const st = codeStatus(inv);
      if (st === 'revoked') return sendJson(res, 403, { ok: false, error: '这个码已经被收回' });
      if (st === 'used-up') return sendJson(res, 403, { ok: false, error: '这个码用完了' });
      if (st === 'expired') return sendJson(res, 403, { ok: false, error: '这个码过期了' });

      inv.used += 1;
      writeJson(INVITE_FILE, invites);

      const token = crypto.randomBytes(24).toString('base64url');
      const ownerUid = Number((inv.owner && cfg.ownerQQ) ? cfg.ownerQQ : 0) || (800000000 + crypto.randomInt(1, 99999999));
      members.members.push({ token, nick, uid: ownerUid, isOwner: !!inv.owner, code: inv.code, joinedAt: nowIso(), kicked: false });
      writeJson(MEMBER_FILE, members);

      broadcast({ type: 'members', list: memberList() });
      pushMessage({ role: 'sys', text: `${nick} 进群了` });

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `wc=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      return res.end(JSON.stringify({ ok: true, nick }));
    }

    if (req.method === 'GET' && url.pathname === '/api/debug') {
      if (!whoami(req)) return sendJson(res, 401, { ok: false, error: '还没进门' });
      return sendJson(res, 200, {
        ok: true,
        herBusy, sessionId, hasSession: !!sessionId,
        framesSeen, lastFrames, lastError: lastError ? String(lastError) : null,
        lastHerAt, historyLen: history.length,
      });
    }

    // 桥接把她说的话投到这里（她本人在桥接里生成，出口换成网页）
    if (req.method === 'POST' && url.pathname === '/api/her-message') {
      if (!WEB_TOKEN || String(req.headers['x-webchat-token'] || '') !== WEB_TOKEN) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text || '').trim();
      clearTimeout(typingTimer);
      broadcast({ type: 'typing', on: false });
      if (!text) return sendJson(res, 200, { ok: true, id: null });
      const msg = pushMessage({ role: 'her', nick: HER_NAME, text });
      return sendJson(res, 200, { ok: true, id: msg.id });
    }

    const me = whoami(req);
    if (!me) return sendJson(res, 401, { ok: false, error: '还没进门' });

    // 历史
    if (req.method === 'GET' && url.pathname === '/api/history') {
      return sendJson(res, 200, { ok: true, group: GROUP_NAME, me: me.nick, messages: history, members: memberList() });
    }

    // 事件流
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', group: GROUP_NAME, me: me.nick, members: memberList(), messages: history })}\n\n`);
      streams.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ka); streams.delete(res); });
      return;
    }

    // 说话
    if (req.method === 'POST' && url.pathname === '/api/say') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text || '').trim().slice(0, 500);
      const mediaUrl = String(body.mediaUrl || '').trim();
      if (!text && !mediaUrl) return sendJson(res, 400, { ok: false, error: '空的' });

      const last = lastSay.get(me.token) || 0;
      if (Date.now() - last < 1200) return sendJson(res, 429, { ok: false, error: '慢一点' });
      lastSay.set(me.token, Date.now());

      const msg = mediaUrl
        ? pushMessage({ role: 'user', nick: me.nick, text: text || '[图片]', kind: 'image', src: mediaUrl })
        : pushMessage({ role: 'user', nick: me.nick, text });
      const plain = mediaUrl ? ('[图片]' + (text ? '　' + text : '')) : text;
      if (USE_BRIDGE) deliverToBridge(me, plain); else maybeReply(plain);
      return sendJson(res, 200, { ok: true, msg });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log('请求出错:', e.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log(`网页群聊已启动： http://${HOST}:${PORT}`);
  log(`群名：${GROUP_NAME}   她的人格卡：roles/独立AI.md`);
  log(`邀请码：node webchat/invite.mjs new --note 朋友 --max 1 --hours 24`);
});













