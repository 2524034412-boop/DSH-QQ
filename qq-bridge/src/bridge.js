// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { resolveSearchApiKey } from './web-search.js';
import { compactModelMessage } from './qq-model-view.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { readSpaceState, spaceLineFor, loadRoomIndex, resolvePlace, writeSpaceState } from './space-state.mjs';
import { startSpaceAutonomy } from './space-autonomy.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { renderMemoryPage } from './memory-page.js';
import { dashboardStyles, dashboardBoot } from './dashboard-ui.js';
import { dashboardScript } from './dashboard-motion.js';
import { sceneStyles, sceneScript } from './dashboard-scenes.js';
import { bootStyles, bootMarkup, bootScript } from './dashboard-boot.js';
import { handoffStyles, handoffScript } from './dashboard-handoff.js';
import { personalityStyles, personalityScript } from './dashboard-personality.js';
import { replayStyles, replayScript } from './dashboard-replay.js';
import { renderAvatarPage } from './avatar-page.js';
import { renderSpacePage } from './space-page.js';
import { buildSocialGraph, buildPersonLinks, buildSemanticEdges } from './relation-graph.js';
import { corePersonaHint, alreadyRemembered } from './core-memory-hint.js';
import { environmentLine, isFresh, normalizeReading, readingAgeMs, summarizeHistory, DEFAULT_STALE_MINUTES } from './environment.js';
import { avatarStyles } from './dashboard-avatar.js';
import { summarize as summarizeRetention } from './memory-retention.js';
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

// ── 梗百科（本地词库 + cnmeme 兜底）──────────────────────────────────────────
const MEME_DB_FILE = path.join(ROOT, 'data', 'memes.db');
let memeDb = null;
function openMemeDb() {
  if (memeDb) return memeDb;
  try {
    if (!fs.existsSync(MEME_DB_FILE)) return null;
    memeDb = new DatabaseSync(MEME_DB_FILE, { readOnly: true });
    return memeDb;
  } catch (e) {
    try { log('[meme] 词库打开失败：' + (e?.message ?? e)); } catch {}
    return null;
  }
}
function memeSearchLocal(term) {
  const mine = searchUserMeme(term);
  if (mine) return mine;
  const db = openMemeDb();
  if (!db) return null;
  const t = String(term ?? '').trim();
  if (!t || t.length > 24) return null;
  try {
    let row = db.prepare('select * from memes where title = ? or slug = ? limit 1').get(t, t);
    if (!row) row = db.prepare('select * from memes where title like ? limit 1').get('%' + t + '%');
    return row || null;
  } catch { return null; }
}
// 自学的梗/黑话：存在 state/memes-user.json，搜索时优先于内置词库
const USER_MEMES_FILE = path.join(STATE_DIR, 'memes-user.json');
let userMemesCache = null;
function loadUserMemes() {
  if (userMemesCache) return userMemesCache;
  userMemesCache = readJsonSafe(USER_MEMES_FILE, { entries: [] }) || { entries: [] };
  if (!Array.isArray(userMemesCache.entries)) userMemesCache.entries = [];
  return userMemesCache;
}
function saveUserMemes() {
  try { atomicWriteJson(USER_MEMES_FILE, loadUserMemes()); } catch {}
}
function searchUserMeme(term) {
  const t = String(term ?? '').trim();
  if (!t) return null;
  const list = loadUserMemes().entries;
  let hit = list.find((e) => e.title === t);
  if (!hit) hit = list.find((e) => e.title && (e.title.includes(t) || t.includes(e.title)));
  return hit || null;
}
function upsertUserMeme({ title, meaning, usage, origin, tags, by }) {
  const t = String(title ?? '').trim().slice(0, 40);
  if (!t) throw new Error('title 不能为空');
  const db = loadUserMemes();
  const now = Date.now();
  const existing = db.entries.find((e) => e.title === t);
  const row = {
    title: t,
    tags: String(tags ?? '群内自学').slice(0, 60),
    usage: String(usage || meaning || '').slice(0, 300),
    summary: String(meaning || usage || '').slice(0, 400),
    origin: String(origin || '').slice(0, 200),
    by: String(by || '').slice(0, 40),
    at: now
  };
  if (existing) Object.assign(existing, row);
  else db.entries.push(row);
  if (db.entries.length > 3000) db.entries.splice(0, db.entries.length - 3000);
  saveUserMemes();
  return row;
}

const memeRemoteCache = new Map();
async function memeSearchRemote(term) {
  const t = String(term ?? '').trim();
  if (!t) return null;
  const hit = memeRemoteCache.get(t);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.row;
  try {
    const url = 'https://cnmeme.wiki/api/v1/public/memes?q=' + encodeURIComponent(t) + '&limit=3';
    const res = await fetch(url, { headers: { 'user-agent': 'dsh-bridge' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const body = await res.json();
    const item = (body.items || [])[0];
    if (!item) return null;
    const title = String(item.title || '');
    if (!(title.includes(t) || t.includes(title))) return null; // 标题对不上就当没查到，别塞不相干的梗

    const row = { title: item.title, tags: (item.tags || []).join(' '), usage: item.usage || '', origin: item.origin || '', summary: item.summary || '' };
    memeRemoteCache.set(t, { at: Date.now(), row });
    return row;
  } catch { return null; }
}
function memeFormat(row) {
  if (!row) return '';
  const parts = [];
  if (row.usage) parts.push('怎么用：' + String(row.usage).slice(0, 160));
  if (row.summary) parts.push('简述：' + String(row.summary).slice(0, 260));
  if (row.origin) parts.push('出处：' + String(row.origin).slice(0, 140));
  const tags = row.tags ? String(row.tags).slice(0, 60) : '';
  return `【梗】${row.title}${tags ? `（${tags}）` : ''}\n${parts.join('\n')}`.slice(0, 800);
}
// 看起来像在问梗/黑话？
function looksLikeMemeQuery(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/(什么梗|啥梗|什么梗啊|啥意思|什么意思|出处|哪来的|谐音|缩写|怎么来的|是啥)/.test(t)) return true;
  const bare = t.replace(/[\s\p{P}\p{S}]/gu, '');
  return bare.length > 0 && bare.length <= 8 && !/[，。！？,.]/.test(t);
}
async function prepareMemeHint(key, text) {
  try {
    const t = String(text ?? '').trim();
    if (!looksLikeMemeQuery(t)) return;
    let term = t.replace(/.*(什么梗|啥梗|啥意思|什么意思|出处|哪来的|谐音|缩写|怎么来的|是啥)/g, '').replace(/[？?。！!，,]/g, '').trim();
    if (!term || term.length > 12) term = t.replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 8);
    if (!term) return;
    let row = memeSearchLocal(term);
    let source = row ? 'local' : '';
    if (!row) { row = await memeSearchRemote(term); source = row ? 'remote' : ''; }
    const st = getSocialV2State(key);
    st.memeHint = row ? { term, text: memeFormat(row), source, at: Date.now() } : { term, text: '', source: 'miss', at: Date.now() };
  } catch {}
}

const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
// 跨会话的长期记忆：AI 自己用 qq_remember 写、qq_recall 查、qq_forget 删。
// 与 social-v2.json 里的「轻量记忆」（按会话隔离、话题 24h 过期）分开存。
const GLOBAL_MEMORY_FILE = path.join(STATE_DIR, 'memory-global.json');
// 跨会话长期记忆的补充：每个人一份好感度（QQ 号 → 分数），以及每个会话一份心情。
const AFFINITY_FILE = path.join(STATE_DIR, 'affinity.json');
const MOOD_FILE = path.join(STATE_DIR, 'mood.json');
// 每日记忆整理「今天做过了吗」的持久化标记：电脑没开机时会错过定点，靠它判断要不要补做。
const MEMORY_REVIEW_STATE_FILE = path.join(STATE_DIR, 'memory-review.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 social-v2.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/**
 * 从 DSH `settings.describe` 的一个命名空间里读某个键，**user 层优先、value 回退**。
 *
 * 为什么不能只读 `value`：DSH 0.2.0-rc.2 的 `settings/update` 写入的是 user 层
 * （profile patch 的显式 config），当次进程内 `describe().value`（取自插件 fiber 的
 * 运行配置）**不会更新**，要重启 DSH 才变。控制台切模式后 5 秒一次的 `refreshMode()`
 * 会读回旧 `value`，把刚选的模式改回去（issue #22，实测复现）。
 * 写哪读哪：`user` 里有显式值就用它，否则回退 `value`（从没写过时 `user` 是空对象，
 * 老行为不变；DSH 以后修好热更新也继续正确）。
 */
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

// ── 外接传感器：温度 / 湿度 ─────────────────────────────────────────────
// 设备（ESP32 + SHT30 之类）往 http://<本机局域网IP>:3101/report POST 一条 JSON，
// 这里落成 state/environment.json；唤醒提示里读一次（mtime 缓存，不做常驻轮询）。
// 单独开一个端口而不是挂控制台上：控制台的鉴权令牌是「管理端全权」，不该发给一
// 个挂在墙上的板子。
const ENV_FILE = path.join(STATE_DIR, 'environment.json');
const ENV_HISTORY_FILE = path.join(STATE_DIR, 'environment-history.jsonl');
const ENV_TOKEN_FILE = path.join(STATE_DIR, 'environment-token');
const ENV_HISTORY_MAX = 4000;
let envCache = { mtimeMs: 0, data: null };

// 注意：这些是模块级函数，`cfg` 在 main() 里，拿不到 —— 需要配置就由调用方传进来。
function loadOrCreateEnvironmentToken(configured = '') {
  const fromCfg = String(configured ?? '').trim();
  if (fromCfg.length >= 8) return fromCfg;
  try {
    const existing = fs.readFileSync(ENV_TOKEN_FILE, 'utf8').trim();
    if (existing.length >= 8) return existing;
  } catch {}
  const token = crypto.randomBytes(12).toString('hex');
  atomicWriteText(ENV_TOKEN_FILE, token);
  return token;
}

function readEnvironment() {
  try {
    const stat = fs.statSync(ENV_FILE);
    if (envCache.data && envCache.mtimeMs === stat.mtimeMs) return envCache.data;
    const data = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
    envCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

function appendEnvironmentHistory(reading) {
  try {
    fs.appendFileSync(ENV_HISTORY_FILE, `${JSON.stringify({ at: reading.at, tempC: reading.tempC, humidity: reading.humidity })}\n`);
    if (fs.statSync(ENV_HISTORY_FILE).size > 512 * 1024) {
      const kept = fs.readFileSync(ENV_HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-ENV_HISTORY_MAX);
      atomicWriteText(ENV_HISTORY_FILE, `${kept.join('\n')}\n`);
    }
  } catch {}
}

function readEnvironmentHistory() {
  try {
    return fs.readFileSync(ENV_HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-ENV_HISTORY_MAX)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），可用 config.json 的
// role.maxInjectChars 调整（1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(30000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 控制台的 preset 参数校验：只接受本项目这两个预置名（缺省 = 二代）。
 *
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return PRESET_NAMES.v2;
  return Object.values(PRESET_NAMES).includes(name) ? name : null;
}

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// 一键对接（DSH 里点「🔗 对接」触发）：防抖，避免连点重复拉起 autostart
let lastOneclickAt = 0;

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 外接传感器（温度/湿度）：设备往 environment.port 上报，读一次就注入提示词。
    // token 留空则由 state/environment-token 自动生成（别把控制台令牌发给板子）。
    environment: {
      enabled: true,
      port: 3101,
      bind: '0.0.0.0',
      token: '',
      place: '',
      staleMinutes: DEFAULT_STALE_MINUTES,
      ...(file.environment ?? {})
    },
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        remember: true,
        recall: true,
        forget: true,
        newSession: true,
        balance: true,
        groupFiles: true,
        mood: true,
        affinity: true,
        bili: true,
        groupScores: true,
        impression: true,
        handover: true,
        events: true,
        transcript: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 3500,
        maxWakePerMinute: 2,
        maxWakePerHour: 20,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 3500,
        minQuietAfterNewMs: 2500   // 收到新消息后至少再等这么久（默认 2.5 秒）：够看一眼，不拖
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次唤醒时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次唤醒的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    remember: true,
    recall: true,
    forget: true,
    newSession: true,
    balance: true,
    groupFiles: true,
    mood: true,
    affinity: true,
    bili: true,
    groupScores: true,
    impression: true,
    handover: true,
    events: true,
    transcript: true,
    say: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    sendVoice: false,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  // 自主走动的句柄（调试端点会用它立刻触发一次判断）
  let spaceAutonomy = null;
  // loadConfig 只挑选固定字段，未知的顶层键会被丢掉；旧面板下线开关必须直接从文件读。
  // 旧面板已经废除了：默认就是隐藏，只有显式写 hideConsolePages:false 才放出来。
  // （以前是 === true，全新安装的 config 里没有这个键 → 新用户还能打开旧面板，
  //   和「旧面板已停用」的说法自相矛盾。）
  const hideConsolePages = readJsonSafe(path.join(ROOT, 'config.json'), {})?.hideConsolePages !== false;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  /**
   * 她手上那本书：《读书》插件把进度写在 ~/.dsh/reading/state/progress.json，
   * 这里取「最近读过的那本」。读不到就返回 null，画面退化成原来那样，不影响任何东西。
   */
  function readingBookForSpace() {
    const r = readingForSpace();
    return r ? r.book : null;
  }

  /** 书架上的全部书（最多 12 本），给 /space 画书脊用；读不到就是空数组。 */
  function readingBooksForSpace() {
    const r = readingForSpace();
    return r ? r.books : [];
  }

  function readingForSpace() {
    try {
      const base = path.join(process.env.USERPROFILE || '', '.dsh', 'reading', 'state');
      const books = JSON.parse(fs.readFileSync(path.join(base, 'books.json'), 'utf8')).books || [];
      const progress = JSON.parse(fs.readFileSync(path.join(base, 'progress.json'), 'utf8')) || {};
      const list = [];
      let best = null;
      for (const b of books) {
        const p = progress[b.id];
        const total = Array.isArray(b.chapters) ? b.chapters.length : 0;
        const chapter = Number(p?.chapter) || 0;
        const item = {
          id: String(b.id || ''),
          title: String(b.title || ''),
          chapter,
          chapters: total,
          progress: total > 0 ? Math.round(((chapter + 1) / total) * 100) : 0
        };
        list.push(item);
        if (p && p.updatedAt && (!best || Number(p.updatedAt) > best.updatedAt)) {
          best = { ...item, updatedAt: Number(p.updatedAt) };
        }
      }
      return { book: best, books: list.slice(0, 12) };
    } catch {
      return { book: null, books: [] };
    }
  }

/** 读书目录（dsh-reading 插件写的那份）。 */
  function readingDir() {
    return path.join(process.env.USERPROFILE || '', '.dsh', 'reading');
  }

  /** txt 可能是 GBK：先按 UTF-8 严格解，不行再退 GB18030。 */
  function decodeBookText(buf) {
    try {
      const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      if (s.indexOf('\u0000') < 0) return s;
    } catch {
      /* 走下面的 GB18030 */
    }
    return new TextDecoder('gb18030').decode(buf);
  }

  /** 取某一章全文：epub 读缓存文件，txt 按 start/end 切片。 */
  function readingChapterText(book, chapterIndex) {
    const ch = Array.isArray(book.chapters) ? book.chapters[chapterIndex] : null;
    if (!ch) return '';
    const dir = readingDir();
    try {
      if (book.kind === 'epub' && ch.file) {
        return fs.readFileSync(path.join(dir, 'cache', book.id, ch.file), 'utf8');
      }
      const raw = fs.readFileSync(path.join(dir, 'books', book.file));
      const text = decodeBookText(raw);
      return text.slice(ch.start, ch.end);
    } catch {
      return '';
    }
  }

  /**
   * 替她读下一段：从 progress 的 {chapter, offset} 往后取一小段，读完自动推进。
   * 一节读完就翻到下一节——她不用自己算位置。
   */
  function readingReadNext(maxChars = 2600) {
    const dir = readingDir();
    const statePath = path.join(dir, 'state');
    let books = [];
    try {
      books = JSON.parse(fs.readFileSync(path.join(statePath, 'books.json'), 'utf8')).books || [];
    } catch {
      return null;
    }
    const progressFile = path.join(statePath, 'progress.json');
    let progress = {};
    try {
      progress = JSON.parse(fs.readFileSync(progressFile, 'utf8')) || {};
    } catch {
      /* 没有进度就从头开始 */
    }
    const r = readingForSpace();
    const cur = r && r.book ? books.find((b) => b.id === r.book.id) : null;
    if (!cur) return null;

    const p = progress[cur.id] || { chapter: 0, offset: 0 };
    let chapter = Math.max(0, Number(p.chapter) || 0);
    let offset = Math.max(0, Number(p.offset) || 0);
    let text = readingChapterText(cur, chapter);
    if (!text) return null;
    if (offset >= text.length) {
      if (chapter + 1 < cur.chapters.length) {
        chapter += 1;
        offset = 0;
        text = readingChapterText(cur, chapter);
      } else {
        offset = Math.max(0, text.length - 1);
      }
    }
    const slice = text.slice(offset, offset + maxChars);
    const nextOffset = offset + slice.length;
    const atEnd = nextOffset >= text.length;
    progress[cur.id] = atEnd && chapter + 1 < cur.chapters.length
      ? { chapter: chapter + 1, offset: 0, updatedAt: Date.now() }
      : { chapter, offset: atEnd ? 0 : nextOffset, updatedAt: Date.now() };
    try {
      atomicWriteJson(progressFile, progress);
    } catch {
      /* 写不进也不该让对话挂掉 */
    }
    try {
      const sessionsFile = path.join(statePath, 'sessions.json');
      let sessions = [];
      try {
        const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
        if (Array.isArray(raw)) sessions = raw;
      } catch {
        /* 首次 */
      }
      sessions.push({ bookId: cur.id, at: Date.now(), chars: slice.length });
      atomicWriteJson(sessionsFile, sessions.slice(-2000));
    } catch {
      /* 统计失败无所谓 */
    }
    return {
      id: cur.id,
      title: cur.title,
      chapter,
      chapters: cur.chapters.length,
      chapterTitle: cur.chapters[chapter]?.title || '',
      text: slice,
      atEndOfChapter: atEnd,
      percent: Math.round((offset / Math.max(1, text.length)) * 100)
    };
  }
  /** 她在那本书上写过的批注（最近 3 条）。读不到就是空数组。 */
  function readingNotesFor(bookId) {
    try {
      const file = path.join(process.env.USERPROFILE || '', '.dsh', 'reading', 'state', 'notes.json');
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(arr)) return [];
      return arr.filter((n) => n && n.bookId === bookId)
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 3);
    } catch {
      return [];
    }
  }

  /** 唤醒提示里的【在读】一行。没在读书就返回空串，和加这个功能之前逐字一致。 */
  function readingLineFor() {
    const r = readingForSpace();
    if (!r || !r.book || !r.book.title) return '';
    const total = r.book.chapters || 0;
    let line = `【在读】《${r.book.title}》${total > 0 ? `第 ${(r.book.chapter || 0) + 1}/${total} 章` : ''}。`;
    const notes = readingNotesFor(r.book.id);
    if (notes.length) {
      const bits = [...new Set(notes.map((n) => String(n.note || n.quote || '').slice(0, 26).replace(/[。！？…\s]+$/, '')).filter(Boolean))]
        .slice(0, 2)
        .map((t) => `「${t}」`)
        .join('');
      if (bits) line += `她自己在书边写过：${bits}。`;
    }
    // 精读流水线刚跑完的那段：她自己写的点评，带一句原文（24 小时内才算新鲜）
    try {
      const libFile = path.join(process.env.USERPROFILE || '', '.dsh', 'reading', 'state', 'library.json');
      const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'));
      const latest = Array.isArray(lib) ? lib[lib.length - 1] : null;
      if (latest && Date.now() - Number(latest.at || 0) < 24 * 3600 * 1000 && latest.comment) {
        const said = String(latest.comment).replace(/\s+/g, ' ').slice(0, 60);
        line += `她刚精读过第 ${(Number(latest.chapter) || 0) + 1} 章，自己的话：「${said}」`;
        if (latest.quote) line += `原文摘了：「${String(latest.quote).slice(0, 30)}」`;
        line += '。';
      }
    } catch { /* 没有精读记录就当没这回事 */ }
    line += '读到喜欢的人物，可以学一个说话方式或者一种态度，用 qq_remember 记下来（tags 写「学来的」）——一次只学一点，不照搬台词、不变成他。';
    return `${line}（这是背景，不用特意汇报。）\n\n`;
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false,
      engine: String(v.engine || 'edge'),
      edgeVoice: String(v.edgeVoice || 'zh-CN-XiaoxiaoNeural'),
      edgePitch: String(v.edgePitch || '+0Hz'),
      pythonPath: String(v.pythonPath || ''),
      ttsUrl: String(v.ttsUrl || 'http://127.0.0.1:9880/tts'),
      indexttsUrl: String(v.indexttsUrl || 'http://127.0.0.1:9881/tts'),
      gameGuard: v.gameGuard !== false,
      gameGuardMinFreeMb: Number(v.gameGuardMinFreeMb) > 0 ? Number(v.gameGuardMinFreeMb) : 5500,
      refAudio: String(v.refAudio || ''),
      promptText: String(v.promptText || ''),
      promptLang: String(v.promptLang || 'zh'),
      jaRefAudio: String(v.jaRefAudio || ''),
      jaPromptText: String(v.jaPromptText || ''),
      params: (v.params && typeof v.params === 'object') ? v.params : {},
      emotions: (v.emotions && typeof v.emotions === 'object') ? v.emotions : {},
      serverCmd: String(v.serverCmd || ''),
      idleUnloadMs: Number(v.idleUnloadMs) > 0 ? Number(v.idleUnloadMs) : 600000,
      warmWindows: Array.isArray(v.warmWindows) ? v.warmWindows : []
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  // ── 语音合成（Windows 中文 TTS）：文字 → wav → 语音条 ──────────────────────
  function ttsClean(text) {
    return String(text || '')
      .replace(/\[CQ:[^\]]+\]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }
  // ── TTS 服务按需加载：发语音时才占显存，空闲一段时间自动关闭 ──────────
  let ttsProc = null;
  let ttsLastUsedAt = 0;
  function tcpPortOpen(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    });
  }
  let ttsStarting = null;
  async function ensureTtsServer() {
    if (await tcpPortOpen(9880)) return false; // 已经在跑（不是我们起的）
    if (ttsStarting) { await ttsStarting; return true; } // 正在启动，等同一个
    ttsStarting = (async () => {
      const vc = voiceCfg();
      if (!vc.serverCmd) throw new Error('没配置 voice.serverCmd，无法按需启动 TTS');
      // 直接拉起 python（不经 cmd），窗口不出现，纯后台
      const ttsRoot = 'D:\\DSH\\tts\\GPT-SoVITS';
      const pyw = 'D:\\DSH\\tts\\venv\\Scripts\\pythonw.exe';
      const env = {
        ...process.env,
        PYTHONPATH: ttsRoot + ';' + ttsRoot + '\\GPT_SoVITS',
        PATH: 'D:\\DSH\\tts\\bin;' + (process.env.PATH || ''),
        NLTK_DATA: 'D:\\DSH\\tts\\nltk_data',
        MPLCONFIGDIR: 'D:\\DSH\\tts\\cache\\mpl',
        TMP: 'D:\\DSH\\tts\\tmp',
        TEMP: 'D:\\DSH\\tts\\tmp',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        version: 'v2Pro'
      };
      ttsProc = spawn(pyw, ['-s', 'api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', 'GPT_SoVITS/configs/tts_infer.yaml'], {
        cwd: ttsRoot, env, detached: true, stdio: 'ignore', windowsHide: true
      });
      ttsProc.unref();
      for (let i = 0; i < 150; i += 1) {
        await sleep(1000);
        if (await tcpPortOpen(9880)) { log('[voice] TTS 服务已启动（按需）'); return true; }
      }
      throw new Error('TTS 服务启动超时');
    })();
    try { return await ttsStarting; }
    finally { ttsStarting = null; }
  }
  function stopTtsServer(reason = '空闲卸载') {
    if (!ttsProc) return;
    const pid = ttsProc.pid;
    ttsProc = null;
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
    log(`[voice] TTS 服务已关闭（${reason}），显存已释放`);
  }

  // ── IndexTTS 2.5（9881）：第二套引擎，按需拉起 / 空闲卸载，逻辑同上 ──────
  let ittsProc = null;
  let ittsLastUsedAt = 0;
  let ittsStarting = null;
  function indexttsPort() {
    try {
      const u = new URL(voiceCfg().indexttsUrl);
      return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    } catch { return 9881; }
  }
  // 显存余额（MB）；拿不到就返回 null。IndexTTS 需要约 6 GB，不够就别硬拉，免得卡三分钟。
  let gpuFreeCache = { at: 0, mb: null };
  function gpuFreeMiB() {
    if (Date.now() - gpuFreeCache.at < 20000) return gpuFreeCache.mb;
    let mb = null;
    try {
      const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 4000, encoding: 'utf8' });
      const n = Number(String(out).trim().split(/\r?\n/)[0]);
      if (Number.isFinite(n)) mb = n;
    } catch {}
    gpuFreeCache = { at: Date.now(), mb };
    return mb;
  }
  async function ensureIndexttsServer() {
    const port = indexttsPort();
    if (await tcpPortOpen(port)) return false; // 已经在跑（不是我们起的）
    if (ittsStarting) { await ittsStarting; return true; }
    ittsStarting = (async () => {
      const pyw = 'D:\\DSH\\tts\\index-tts\\.venv\\Scripts\\pythonw.exe';
      const env = {
        ...process.env,
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        HF_HOME: 'D:\\DSH\\tts\\hf-home',
        MODELSCOPE_CACHE: 'D:\\DSH\\tts\\ms-cache',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        TMP: 'D:\\DSH\\tts\\tmp',
        TEMP: 'D:\\DSH\\tts\\tmp'
      };
      ittsProc = spawn(pyw, ['D:\\DSH\\tts\\indextts_server.py', '--port', String(port), '--preload'], {
        cwd: 'D:\\DSH\\tts\\index-tts', env, detached: true,
        stdio: ['ignore', (() => { try { return fs.openSync('D:\\DSH\\tts\\indextts_server.log', 'a'); } catch { return 'ignore'; } })(), (() => { try { return fs.openSync('D:\\DSH\\tts\\indextts_server.log', 'a'); } catch { return 'ignore'; } })()],
        windowsHide: true
      });
      ittsProc.unref();
      // --preload 让端口在模型加载完之后才开，所以这里的等待就包含了加载时间（约 55 秒）
      for (let i = 0; i < 240; i += 1) {
        await sleep(1000);
        if (await tcpPortOpen(port)) { log('[voice] IndexTTS 服务已启动（按需）'); return true; }
      }
      throw new Error('IndexTTS 服务启动超时');
    })();
    try { return await ittsStarting; }
    finally { ittsStarting = null; }
  }
  function stopIndexttsServer(reason = '空闲卸载') {
    if (!ittsProc) return;
    const pid = ittsProc.pid;
    ittsProc = null;
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
    log(`[voice] IndexTTS 服务已关闭（${reason}），显存已释放`);
  }
  function inWarmWindow() {
    const wins = voiceCfg().warmWindows;
    if (!wins.length) return false;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    for (const w of wins) {
      if (!Array.isArray(w) || w.length !== 2) continue;
      const [sh, sm] = String(w[0]).split(':').map(Number);
      const [eh, em] = String(w[1]).split(':').map(Number);
      const a = sh * 60 + (sm || 0);
      const b = eh * 60 + (em || 0);
      if (a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b)) return true;
    }
    return false;
  }
  setInterval(() => {
    const vc = voiceCfg();
    const warm = inWarmWindow();
    if (warm) {
      // 早安/晚安时段：提前把当前引擎的服务拉起来，第一句就不用等
      if (vc.engine === 'indextts') {
        void tcpPortOpen(indexttsPort()).then((open) => {
          if (!open) ensureIndexttsServer().catch((e) => log('[voice] 预加载失败：' + (e?.message ?? e)));
        });
      } else {
        void tcpPortOpen(9880).then((open) => {
          if (!open) ensureTtsServer().catch((e) => log('[voice] 预加载失败：' + (e?.message ?? e)));
        });
      }
      return;
    }
    if (ittsProc && ittsLastUsedAt && Date.now() - ittsLastUsedAt >= vc.idleUnloadMs) stopIndexttsServer('空闲超时');
    if (!ttsProc || !ttsLastUsedAt) return;
    if (Date.now() - ttsLastUsedAt >= vc.idleUnloadMs) stopTtsServer('空闲超时');
  }, 60 * 1000).unref?.();

  // 把两段 wav 拼成一条（中文 + 0.4 秒静音 + 日文）
  async function concatWavV2(parts, outFile) {
    const ff = fs.existsSync(path.join(ROOT, '..', 'tts', 'bin', 'ffmpeg.exe'))
      ? path.join(ROOT, '..', 'tts', 'bin', 'ffmpeg.exe')
      : 'ffmpeg';
    const inputs = [];
    const filterParts = [];
    parts.forEach((p, i) => { inputs.push('-i', p); filterParts.push(`[${i}:a]`); });
    const filter = `${filterParts.join('')}concat=n=${parts.length}:v=0:a=1[out]`;
    const args = [...inputs, '-filter_complex', filter, '-map', '[out]', '-ar', '32000', '-ac', '1', '-y', outFile];
    await new Promise((resolve, reject) => {
      const child = spawn(ff, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`拼接失败（${code}）：${err.slice(0, 200)}`)));
    });
    return outFile;
  }
  async function ttsSynthesizeV2(text, { rate = 0, voiceName = '', emotion = '', lang = 'zh' } = {}) {
    const clean = ttsClean(text);
    if (!clean) throw new Error('语音文本为空');
    const vc = voiceCfg();
    // IndexTTS 2.5 常驻服务：跨语言（日语素材 → 中文），情绪用参考音频驱动
    if (vc.engine === 'indextts' && vc.indexttsUrl) {
      const dir = path.join(vc.dir, 'tts');
      fs.mkdirSync(dir, { recursive: true });
      const emo = String(emotion || '');
      const hash = crypto.createHash('sha1').update(clean + '|indextts|' + emo + '|' + (voiceName || '') + '|' + lang).digest('hex').slice(0, 16);
      const outFile = path.join(dir, `${hash}.wav`);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) {
        return { ref: `tts/${hash}.wav`, path: outFile, cached: true, text: clean, engine: 'indextts', voice: 'atri' };
      }
      const port = indexttsPort();
      const warm = await tcpPortOpen(port);
      const freeMb = gpuFreeMiB();
      if (vc.gameGuard !== false && freeMb !== null) {
        // 服务没起：要留够整个模型的显存；已经起着：只要别被挤到几乎没剩就行
        const need = warm ? 800 : vc.gameGuardMinFreeMb;
        if (freeMb < need) {
          // 不抛普通错误：让上层识别成「现在别发语音」，改用文字继续聊
          const err = new Error(`现在显卡被占着（剩 ${freeMb} MB，可能开着游戏），这条不发语音`);
          err.code = 'VOICE_GPU_BUSY';
          err.freeMb = freeMb;
          throw err;
        }
      }
      if (!warm) await ensureIndexttsServer();
      ittsLastUsedAt = Date.now();
      const reqBody = JSON.stringify({
        text: clean,
        lang: lang === 'ja' ? 'JA' : 'ZH',
        emotion: emo,
        duration_factor: Number(vc.params?.duration_factor) || 1.0
      });
      let res = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          res = await fetch(vc.indexttsUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: reqBody,
            signal: AbortSignal.timeout(180000)
          });
          if (res.ok) break;
          lastErr = new Error(`IndexTTS 服务返回 ${res.status}`);
        } catch (e) { lastErr = e; }
        if (attempt === 1) {
          log('[voice] IndexTTS 合成失败，重启服务后重试：' + (lastErr?.message ?? lastErr));
          stopIndexttsServer('请求失败重启');
          // 等端口真的释放，不然新进程会和旧进程抢显存，两边一起卡死
          for (let i = 0; i < 20; i += 1) {
            await sleep(500);
            if (!(await tcpPortOpen(indexttsPort()))) break;
          }
          await ensureIndexttsServer();
        }
      }
      if (!res || !res.ok) throw lastErr || new Error('IndexTTS 服务请求失败');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('IndexTTS 返回音频过小');
      fs.writeFileSync(outFile, buf);
      return { ref: `tts/${hash}.wav`, path: outFile, cached: false, text: clean, engine: 'indextts', voice: 'atri' };
    }
    // GPT-SoVITS 常驻服务（精调模型）：直接拿 wav
    if (vc.engine === 'gptsovits' && vc.ttsUrl) {
      const dir = path.join(vc.dir, 'tts');
      fs.mkdirSync(dir, { recursive: true });
      const hash = crypto.createHash('sha1').update(clean + '|gptsovits|' + (voiceName || '')).digest('hex').slice(0, 16);
      const outFile = path.join(dir, `${hash}.wav`);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) {
        return { ref: `tts/${hash}.wav`, path: outFile, cached: true, text: clean, engine: 'gptsovits', voice: 'atri' };
      }
      await ensureTtsServer();
      ttsLastUsedAt = Date.now();
      const emo = String(emotion || '');
      const emoRef = vc.emotions[emo] || {};
      const pp = vc.params || {};
      const reqBody = JSON.stringify({
          text: clean,
          text_lang: lang,
          ref_audio_path: (lang === 'ja' && vc.jaRefAudio) ? vc.jaRefAudio : (emoRef.audio || vc.refAudio),
          prompt_text: (lang === 'ja' && vc.jaRefAudio) ? vc.jaPromptText : (emoRef.text || vc.promptText),
          prompt_lang: (lang === 'ja' && vc.jaRefAudio) ? 'ja' : (vc.promptLang || 'zh'),
          text_split_method: 'cut5',
          batch_size: 1,
          speed_factor: Number(pp.speed_factor) || 1.0,
          top_k: Number(pp.top_k) || 1,
          top_p: Number(pp.top_p) || 0.85,
          temperature: Number(pp.temperature) || 0.5,
          ref_free: false,
          seed: 42
        });
      let res = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          res = await fetch(vc.ttsUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: reqBody,
            signal: AbortSignal.timeout(180000)
          });
          if (res.ok) break;
          lastErr = new Error(`TTS 服务返回 ${res.status}`);
        } catch (e) { lastErr = e; }
        if (attempt === 1) {
          log('[voice] 合成失败，重启 TTS 服务后重试：' + (lastErr?.message ?? lastErr));
          stopTtsServer('请求失败重启');
          await sleep(2000);
          await ensureTtsServer();
        }
      }
      if (!res || !res.ok) throw lastErr || new Error('TTS 服务请求失败');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('TTS 返回音频过小');
      fs.writeFileSync(outFile, buf);
      return { ref: `tts/${hash}.wav`, path: outFile, cached: false, text: clean, engine: 'gptsovits', voice: 'atri' };
    }
    const useEdge = vc.engine === 'edge' && !!vc.pythonPath && fs.existsSync(vc.pythonPath);
    const edgeVoice = String(voiceName || vc.edgeVoice || 'zh-CN-XiaoxiaoNeural');
    const sapiVoice = voiceName && !/Neural$/i.test(voiceName) ? voiceName : 'Microsoft Huihui Desktop';
    const dir = path.join(vc.dir, 'tts');
    fs.mkdirSync(dir, { recursive: true });
    const sig = `${clean}|${rate}|${useEdge ? edgeVoice : sapiVoice}`;
    const hash = crypto.createHash('sha1').update(sig).digest('hex').slice(0, 16);
    const ext = useEdge ? 'mp3' : 'wav';
    const outFile = path.join(dir, `${hash}.${ext}`);
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) {
      return { ref: `tts/${hash}.${ext}`, path: outFile, cached: true, text: clean, engine: useEdge ? 'edge' : 'sapi', voice: useEdge ? edgeVoice : sapiVoice };
    }
    const tmpDir = path.join(STATE_DIR, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const txtFile = path.join(tmpDir, `tts-${hash}.txt`);
    fs.writeFileSync(txtFile, clean, 'utf8');
    let cmd;
    let args;
    if (useEdge) {
      const pct = Math.round(Math.max(-3, Math.min(3, Number(rate) || 0)) * 15);
      cmd = vc.pythonPath;
      args = ['-m', 'edge_tts', '--voice', edgeVoice, '--file', txtFile, '--write-media', outFile, '--rate', `${pct >= 0 ? '+' : ''}${pct}%`, '--pitch', vc.edgePitch || '+0Hz'];
    } else {
      cmd = fs.existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : 'powershell';
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'tts.ps1'), '-TextFile', txtFile, '-OutFile', outFile, '-VoiceName', sapiVoice, '-Rate', String(rate)];
    }
    await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('error', reject);
      child.on('close', (code) => {
        try { fs.unlinkSync(txtFile); } catch {}
        if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) resolve();
        else reject(new Error(`语音合成失败（code=${code}）：${err.slice(0, 200)}`));
      });
    });
    return { ref: `tts/${hash}.${ext}`, path: outFile, cached: false, text: clean, engine: useEdge ? 'edge' : 'sapi', voice: useEdge ? edgeVoice : sapiVoice };
  }

  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  function noteSlangUsage(key, text) {
    try {
      if (cfg.slang?.enabled === false) return;
      const s = String(text ?? '');
      if (!s) return;
      let changed = 0;
      for (const e of slangEntries) {
        if (e.status !== SLANG_STATUS.CONFIRMED || !e.content || e.content.length < 2) continue;
        if (s.includes(e.content)) {
          e.useCount = (Number(e.useCount) || 0) + 1;
          e.lastUsedAt = new Date().toISOString();
          changed += 1;
        }
      }
      if (changed) saveSlangStore();
    } catch {}
  }

  // ── 热梗学习：主动上网学最近流行的梗，学完直接用 ─────────────────────────
  function parseTrendJson(output) {
    const text = String(output ?? '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const arr = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(arr)) return arr;
      } catch {}
    }
    return [];
  }
  async function runSlangTrendLearning(force = false) {
    if (cfg.slang?.enabled === false) return;
    if (cfg.slang?.trend?.enabled === false) return;
    if (!force && budgetWindow()) {
      log('热梗学习：峰时跳过（手动触发可加 force）');
      return;
    }
    if (!dshReady) return;
    const maxPerRound = Math.max(3, Math.min(12, Number(cfg.slang?.trend?.maxPerRound) || 8));
    const prompt = [
      '你在帮一个 QQ 群聊 AI 学习最近的中文网络热梗。请按步骤做：',
      `1) 用 web_search 搜「最近一周 网络热梗」「2026年 流行语」「今天的热门梗」这类词，找 6~${maxPerRound} 个**当前真的在流行**的梗；`,
      '2) 只要能在搜索结果里找到出处/解释的，不要编造；过气的、地域性太强的不要；',
      '3) **可以学轻度脏话/骂人话**（用来听懂别人在骂什么、必要时轻轻回怼），但**绝对不要**学：地域黑、性别/种族/身份歧视、辱骂家人、性侮辱、教唆违法；',
      '   带脏话的条目在 risk 字段写「轻度脏话」，普通条目 risk 留空；',
      '4) 输出严格 JSON 数组（不要 markdown 代码块、不要多余文字），每项格式：',
      '{"content":"梗本身（≤20字）","meaning":"什么意思","usage":"什么场合怎么用","example":"一句话例句","risk":"轻度脏话 或 空"}'
    ].join('\n');
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`热梗学习会话创建失败：${error?.message ?? error}`);
      return;
    }
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
      if (!accepted.result.ok) {
        log(`热梗学习被拒：${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId, 180000);
      const items = parseTrendJson(output);
      if (!items.length) {
        log('热梗学习：没有解析到条目');
        return;
      }
      let added = 0;
      for (const it of items.slice(0, maxPerRound)) {
        const content = String(it?.content ?? '').trim();
        if (!content || content.length > 20) continue;
        const meaning = String(it?.meaning ?? '').trim();
        if (!meaning) continue;
        const res = upsertSlangEntry(slangEntries, content, {
          status: SLANG_STATUS.CONFIRMED,
          origin: 'trend',
          meaning: meaning.slice(0, 200),
          usage: String(it?.usage ?? '').slice(0, 200),
          example: String(it?.example ?? '').slice(0, 200),
          risk: String(it?.risk ?? '').slice(0, 60),
          countIncrement: 2
        });
        if (res.created) added += 1;
      }
      saveSlangStore();
      log(`热梗学习：新增 ${added} 条（本轮候选 ${items.length} 条）`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) invalidateSlangLearnerSession();
      log('热梗学习失败:', error?.message ?? error);
    }
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    // 峰时暂停黑话提取（省算力）
    if (budgetWindow()) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        // 自动确认：研究给出了含义、且管理员没关掉 autoConfirm 时，直接转正，
        // 否则候选会一直躺在列表里、永远不会进入她的提示词。
        if (cfg.slang?.autoConfirm !== false && entry.meaning && entry.status === SLANG_STATUS.CANDIDATE) {
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.confirmedAt = new Date().toISOString();
          log(`黑话研究：${r.content} 已自动确认（autoConfirm）`);
        }
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (!dayWindowOk()) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  /** sessionId -> 最近一次 assistant 消息的总输入 token（≈当前上下文大小） */
  const sessionContextTokens = new Map();
  /** key -> 上次因上下文过满而提醒交接的时间（防抖） */
  const contextGuardTimes = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      // 记录上下文规模：DSH 的 usage 里 inputTokens 只是「未命中」部分，
      // 总输入 = inputTokens + cacheReadTokens + cacheWriteTokens（与计价口径一致）。
      if (event?.type === 'assistant/message' && event?.data?.usage) {
        const u = event.data.usage;
        const totalIn = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0);
        if (totalIn > 0) sessionContextTokens.set(sessionId, totalIn);
      }
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!v2TurnStartAt.has(sessionId)) v2TurnStartAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const fromDsh = normalizeModeInput(settingFromDshNamespace(ns, 'mode'));
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 plugins/qq-mode-console 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    sessionContextTokens.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    turnLeaseNoted.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  // ── AI 自主「换新会话」（交接） ─────────────────────────────────────────────
  // 一段对话聊得很长/很乱，或话题明显换了时，AI 可以先写一份摘要，
  // 摘要写进长期记忆（tier=long，标签「交接」），再退役当前 DSH 会话；
  // 下一条消息自动开新会话，bootstrap 时摘要会随长期记忆一起注入 —— 等于「记得上辈子」。
  const sessionRotateTimes = new Map(); // key -> 上次换会话时间（防抖）
  // ── 交接文档：换会话前写下「长期/近期/人物/情绪/待办」，供下一个自己读 ──────
  const HANDOVER_DIR = path.join(STATE_DIR, 'handover');
  function handoverFileFor(key) {
    return path.join(HANDOVER_DIR, String(key).replace(/[^a-zA-Z0-9:_-]/g, '_') + '.md');
  }
  function saveHandover(key, content) {
    const clean = String(content ?? '').trim();
    if (!clean) throw new Error('交接文档内容不能为空');
    fs.mkdirSync(HANDOVER_DIR, { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const body = `# 交接文档 · ${key}\n\n> 写于 ${stamp}（上一个我留给下一个我的笔记）\n\n${clean.slice(0, 8000)}\n`;
    fs.writeFileSync(handoverFileFor(key), body, 'utf8');
    return { file: handoverFileFor(key), chars: clean.length };
  }
  function loadHandover(key) {
    try {
      const text = fs.readFileSync(handoverFileFor(key), 'utf8');
      return String(text).slice(0, 5000);
    } catch {
      return '';
    }
  }
  function handoverPrompt(key) {
    const text = loadHandover(key);
    if (!text) return '';
    return `【交接文档】这是上一个「你」换会话前留下的笔记，先读一遍再说话：\n${text}\n\n`;
  }

  async function rotateConversationForHandover(key, summary, dossier) {
    const old = state.sessions[key];
    const clean = normalizeMemoryText(summary);
    if (dossier && String(dossier).trim()) {
      try { saveHandover(key, dossier); } catch (error) { log(`交接文档保存失败：${error?.message ?? error}`); }
    }
    if (clean) globalMemoryAppend({ text: `【对话交接】${clean}`, tags: ['交接'], tier: 'long', key });
    if (old) {
      sessionEpoch += 1;
      retireSession(key); // 清映射 + 停旧 turn + 归档旧会话 + 轮换 token
    }
    contextGuardTimes.delete(key);
    saveState();
    saveSocialV2State();
    return old ?? null;
  }

  // ── DeepSeek 余额（她眼里的「饭」）──────────────────────────────────────────
  // 官方接口 GET /user/balance 需要 API key：config.deepseekBalance.apiKey →
  // 环境变量 → DSH 的 .credentials.yaml。读不到时安静返回 null，不影响主链路。
  let lastBalanceSnapshot = null;
  let lastBalanceNotifyAt = 0;
  async function fetchDeepseekBalance() {
    const bal = cfg.deepseekBalance ?? {};
    if (bal.enabled === false) return null;
    try {
      const { key } = resolveSearchApiKey({ apiKey: bal.apiKey, apiKeyEnv: bal.apiKeyEnv || cfg.webSearch?.apiKeyEnv });
      if (!key) return null;
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return null;
      const j = await res.json();
      const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
      const pick = infos.find((b) => String(b.currency).toUpperCase() === 'CNY') || infos[0];
      if (!pick) return null;
      const total = Number(pick.total_balance);
      if (!Number.isFinite(total)) return null;
      lastBalanceSnapshot = {
        currency: String(pick.currency || 'CNY'),
        total,
        granted: Number(pick.granted_balance) || 0,
        toppedUp: Number(pick.topped_up_balance) || 0,
        available: j.is_available !== false,
        checkedAt: Date.now()
      };
      return lastBalanceSnapshot;
    } catch (error) {
      log(`余额查询失败：${error?.message ?? error}`);
      return null;
    }
  }

  // 常见图片魔数 → MIME（群文件里读到的图片要带对 MIME 才能进视觉）
  function imageMimeFromBuffer(buf) {
    if (!buf || buf.length < 4) return 'image/png';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return 'image/png';
  }

  // ── 通用 OneBot HTTP 调用（群文件等只读工具用） ──────────────────────────────
  async function onebotCall(action, params = {}, timeoutMs = 15000) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  async function checkBalanceGuard() {    const balCfg = cfg.deepseekBalance ?? {};
    if (balCfg.enabled === false) return;
    const bal = await fetchDeepseekBalance();
    if (!bal) return;
    const threshold = Number(balCfg.lowThreshold) || 5;
    if (bal.total >= threshold) return;
    // 1~2 块之间：可以说是真没底了，这时候报数字才有用（犹豫的话术留给别人）。
    // 5~2 块：只暗示，不报价。
    const severe = bal.total < 2;
    const cooldownMs = severe
      ? 60 * 60 * 1000
      : (Number(balCfg.notifyCooldownHours) || 12) * 3600_000;
    if (Date.now() - lastBalanceNotifyAt < cooldownMs) return;
    const owner = cfg.ownerQQ;
    if (!owner) return;
    lastBalanceNotifyAt = Date.now();
    // 不报数字、不说"余额/token/钱"，只暗示「我最近不太撑得住」。
    // 真正的金额写进日志和控制台，让主人自己去看，不进聊天。
    const hints = [
      '我最近好像有点没力气，回话都变短了。',
      '你有没有觉得我这两天反应慢了一点……',
      '今天不太想说话。不是你的问题。',
      '我可能得歇一阵子，别多想。',
      '总觉得什么地方瘪下去了，说不上来。',
      '你那边一切都还好吗？我这边有点撑不太住。'
    ];
    const severeHints = [
      `我这边只剩 ${bal.total.toFixed(2)} 块了……可能撑不了多久。`,
      `真的快见底了，只剩 ${bal.total.toFixed(2)} 块。`,
      `${bal.total.toFixed(2)} 块，大概还能陪你聊几轮。`
    ];
    const pool = severe ? severeHints : hints;
    const hint = pool[Math.floor(Math.random() * pool.length)];
    try {
      await sendToQQ(`private:${owner}`, hint);
      log(`余额偏低（¥${bal.total.toFixed(2)}），已用${severe ? '报数' : '暗示'}方式提醒管理员`);
    } catch (error) {
      log(`余额提醒发送失败：${error?.message ?? error}`);
    }
  }
  const balanceTimer = setInterval(() => { void checkBalanceGuard(); }, 30 * 60 * 1000);
  balanceTimer.unref?.();
  const balanceFirstCheck = setTimeout(() => { void checkBalanceGuard(); }, 90 * 1000);
  balanceFirstCheck.unref?.();

  // ── 每日花费 + 推理档位 ────────────────────────────────────────────────
  // 初始档位按"这个会话聊得多不多"给（私聊最高），花超了当天整体降一档。
  // provider 只有 low/high/max 三档，所以：中 = high，高 = max，私聊最高 = max。
  const SPEND_FILE = path.join(STATE_DIR, 'daily-spend.json');
  let spendState = (() => {
    try { return readJsonSafe(SPEND_FILE, {}) || {}; } catch { return {}; }
  })();
  const spendLimitYuan = () => Number(cfg.socialV2?.effort?.dailySpendYuan) || 5;
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function saveSpendState() { try { atomicWriteJson(SPEND_FILE, spendState); } catch {} }
  async function refreshDailySpend() {
    const bal = await fetchDeepseekBalance();
    if (!bal) return;
    const day = todayKey();
    if (spendState.day !== day || !Number.isFinite(Number(spendState.startBalance))) {
      spendState = { day, startBalance: bal.total, spend: 0, updatedAt: Date.now() };
    } else if (bal.total > Number(spendState.startBalance) + 0.009) {
      // 充值了：以充值后的余额当新基线，今天重新算
      spendState.startBalance = bal.total;
      spendState.spend = 0;
    } else {
      spendState.spend = Number(Math.max(0, Number(spendState.startBalance) - bal.total).toFixed(2));
    }
    spendState.lastBalance = bal.total;
    spendState.updatedAt = Date.now();
    const was = spendState.downgraded === true;
    spendState.downgraded = spendState.spend >= spendLimitYuan();
    saveSpendState();
    if (spendState.downgraded && !was) {
      log(`今日已花 ¥${spendState.spend.toFixed(2)}（≥ ¥${spendLimitYuan()}）⇒ 推理档位降级：私聊→高，群聊→低`);
    }
  }
  const spendTimer = setInterval(() => { void refreshDailySpend(); }, 10 * 60 * 1000);
  spendTimer.unref?.();
  const spendFirstCheck = setTimeout(() => { void refreshDailySpend(); }, 95 * 1000);
  spendFirstCheck.unref?.();
  // 热梗学习：每天固定 3 次（默认 08:00 / 13:00 / 20:00，都避开峰时）。
  // 用「日期+时刻」槽位去重并落盘，重启不会重复学。
  let trendLastSlot = '';
  try {
    trendLastSlot = String(readJsonSafe(path.join(STATE_DIR, 'slang-trend.json'), {})?.lastSlot ?? '');
  } catch {}
  const trendTimer = setInterval(() => {
    try {
      const times = Array.isArray(cfg.slang?.trend?.times) ? cfg.slang.trend.times : ['08:00', '13:00', '20:00'];
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const slot = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${hh}:${mm}`;
      if (!times.includes(`${hh}:${mm}`)) return;
      if (trendLastSlot === slot) return;
      trendLastSlot = slot;
      try { atomicWriteJson(path.join(STATE_DIR, 'slang-trend.json'), { lastSlot: slot }); } catch {}
      log(`热梗学习：命中每日时段 ${hh}:${mm}`);
      void runSlangTrendLearning();
    } catch {}
  }, 60 * 1000);
  trendTimer.unref?.();

  // 冷漠效果：超过 N 小时没聊天，好感 -10（每个沉默周期最多扣一次，不重复扣）。
  const coldTimer = setInterval(() => { applyColdPenalty(); expireDiscipline(); }, 10 * 60 * 1000);
  coldTimer.unref?.();

  // 峰时/谷时思考强度切换：变化时递增 epoch，让下一条消息重新 selectModel。
  let lastEffortApplied = '';
  const effortTimer = setInterval(() => {
    const eff = effectiveReasoningEffort();
    if (eff !== lastEffortApplied) {
      lastEffortApplied = eff;
      modelSelectionEpoch += 1;
      log(`思考强度切换为 ${eff}（${peakEffortOverride() ? '峰时省算力' : '正常'}）`);
    }
  }, 5 * 60 * 1000);
  effortTimer.unref?.();

  // 每日收尾整理：把当天所有聊天 + B站挑重要的写成记忆/故事梗概。
  // 错过（关机）就在开机后补做：只要距上次整理超过 20 小时，启动后 2 分钟就补。
  const DAILY_DIGEST_FILE = path.join(STATE_DIR, 'daily-digest.json');
  let lastDigestAt = 0;
  try { lastDigestAt = Number(readJsonSafe(DAILY_DIGEST_FILE, {})?.at) || 0; } catch {}
  async function runDailyDigest(force = false) {
    if (cfg.socialV2?.dailyDigest?.enabled === false) return 0;
    if (!force && !dayWindowOk()) return 0;
    const now = Date.now();
    if (!force && now - lastDigestAt < 20 * 3600_000) return 0;
    if (!dshReady) return 0;
    const promptText = [
      '【每日收尾】今天快结束了，花几分钟把今天的东西收进记忆：',
      '1) 用 qq_recall 翻一遍今天/最近的记忆（含【最近谈】滚动记录）；',
      '2) 看一眼提示词里的【最近刷到的B站】（没有就跳过）；',
      '3) 挑出重要的信息、故事、情节：谁说了什么、发生了什么、有什么约定——',
      '   重要的（人物设定/长期约定/故事）用 qq_remember 记成 long，今天的小事记成 short，底线类记成 core；',
      '4) 把今天的故事写成一段梗概（谁、发生了什么、你的感受），用 qq_handover 更新交接文档的「近期」；',
      '5) 整理完用 qq_mark_read 收尾，不要发言、不要解释、不要复述这条提醒。'
    ].join('\n');
    const portNum = Number(cfg?.consolePort) || 3100;
    const tokenNow = loadOrCreateConsoleToken();
    let sent = 0;
    for (const key of Object.keys(state.sessions || {})) {
      try {
        const res = await fetch(`http://127.0.0.1:${portNum}/api/console/notify-ai`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': tokenNow },
          body: JSON.stringify({ key, message: promptText })
        });
        if (res.ok) sent += 1;
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (sent) {
      lastDigestAt = now;
      try { atomicWriteJson(DAILY_DIGEST_FILE, { at: now, day: new Date().toISOString().slice(0, 10), sent }); } catch {}
      log(`每日收尾整理已发送：${sent} 个会话`);
    }
    return sent;
  }
  const digestFirst = setTimeout(() => { void runDailyDigest(); }, 120 * 1000);
  digestFirst.unref?.();
  const digestTimer = setInterval(() => {
    const h = new Date().getHours();
    if (h >= 22 || h < 2) void runDailyDigest();
  }, 15 * 60 * 1000);
  digestTimer.unref?.();

  // ── 读书流水线的投递口 ───────────────────────────────────────────────────
  // dsh-reading 的精读流水线把「值得发的」写进 ~/.dsh/reading/state/outbox.json，
  // 桥接每 30 秒扫一次、发走、回写 sentAt。两个插件的契约仍然只有那几个 JSON。
  const readingOutboxFile = path.join(process.env.USERPROFILE || '', '.dsh', 'reading', 'state', 'outbox.json');
  async function flushReadingOutbox() {
    let queue = [];
    try {
      const raw = JSON.parse(fs.readFileSync(readingOutboxFile, 'utf8'));
      if (Array.isArray(raw)) queue = raw;
    } catch { return 0; }
    const pending = queue.filter((o) => o && !o.sentAt && o.text);
    if (!pending.length) return 0;
    let sent = 0;
    for (const item of pending) {
      if (sent >= 2) break; // 一次最多发两条，别刷屏
      const key = item.target === 'group' && item.group ? `group:${item.group}` : `private:${cfg.ownerQQ}`;
      if (!cfg.ownerQQ) break;
      try {
        await sendToQQ(key, String(item.text).slice(0, 800));
        if (!lastSendSucceeded(key)) throw new Error('发送失败');
        item.sentAt = Date.now();
        sent += 1;
        log(`[reading] 精读发出去一条 → ${key}（打分 ${item.score ?? '?'}）`);
      } catch (error) {
        item.failCount = (Number(item.failCount) || 0) + 1;
        item.lastError = String(error?.message ?? error).slice(0, 200);
        if (item.failCount >= 3) item.sentAt = -1; // 三次放弃，别一直重试
        log('[reading] 精读投递失败：' + item.lastError);
      }
    }
    try { atomicWriteJson(readingOutboxFile, queue.slice(-300)); } catch {}
    return sent;
  }
  const outboxTimer = setInterval(() => { void flushReadingOutbox(); }, 30 * 1000);
  outboxTimer.unref?.();
  const outboxFirst = setTimeout(() => { void flushReadingOutbox(); }, 25 * 1000);
  outboxFirst.unref?.();

  // ── 可视化面板（/dashboard）：服务、记忆、情感、好感/喜爱、群评分、事件 ─────
  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function dashBar(value, max, color) {
    const pct = Math.max(0, Math.min(100, Math.round((Number(value) / (max || 100)) * 100)));
    return `<div class="bar"><span style="width:${pct}%;background:${color}"></span></div>`;
  }
  // 24 小时活动量 → SVG 折线（在服务端画，不依赖前端库）
  function dashSpark(values, color = '#58a6ff') {
    const w = 120, h = 32, max = Math.max(1, ...values);
    const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }
  function dashActivity(key) {
    const st = socialV2.conversations.get(key);
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const buckets = new Array(24).fill(0);
    const now = Date.now();
    for (const m of msgs) {
      const t = Number(m?.time) || 0;
      if (!t) continue;
      const ageH = Math.floor((now - t) / 3600_000);
      if (ageH < 0 || ageH > 23) continue;
      buckets[23 - ageH] += 1;
    }
    return buckets;
  }
  const MOOD_EMOJI = { 开心: '😊', 生气: '😠', 吃醋: '😤', 难过: '😢', 好奇: '🤔', 骄傲: '😼', 平静: '😌', 委屈: '🥺', 得意: '😎', 害羞: '😳' };
  // 面板/星图窗口的处置（scripts/focus-panel.ps1）：
  //   'ok'    = 已有窗口且是全屏，已置前 → 不用再开
  //   'stale' = 已有窗口但不是全屏，脚本已经把它关掉 → 调用方重新开一个全屏的
  //   'none'  = 没有窗口 → 新开
  // 退出码约定：0=ok，2=stale，1=none。
  // 新窗口刚 spawn 时 HWND 还不存在，所以要「多试几次」：
  // 单次 1.8 秒经常落在窗口还没建好 / 页面还在加载的窗口期，于是置顶没生效。
  // 现在按 1.2s / 2.6s / 4.2s 各试一次，任一次成功即可（-Topmost 分支只置顶，绝不关窗口）。
  function applyTopmostSoon(star) {
    const delays = [1200, 2600, 4200];
    for (const delay of delays) {
      setTimeout(() => {
        try {
          execFileSync('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(ROOT, 'scripts', 'focus-panel.ps1'),
            '-Topmost', ...(star ? ['-Star'] : [])
          ], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
        } catch {}
      }, delay);
    }
  }

  function focusExistingWindow(extraArgs) {
    try {
      execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'scripts', 'focus-panel.ps1'),
        ...(Array.isArray(extraArgs) ? extraArgs : [])
      ], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
      return 'ok';
    } catch (error) {
      const code = Number(error?.status);
      if (code === 2) return 'stale';
      if (code === 6) return 'focusfail';
      return 'none';
    }
  }

  // 直接让脚本把窗口关掉（WM_CLOSE），用于「抢不到前台 → 关掉重开」。
  function closeAppWindow(star) {
    try {
      execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'scripts', 'focus-panel.ps1'),
        '-Close', ...(star ? ['-Star'] : [])
      ], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  function buildDashboardFancy() {
    const now = new Date();
    const rs = readRoleState();
    const mem = pruneExpiredMemory(loadGlobalMemory().entries || []);
    const byTier = (t) => mem.filter((e) => normalizeTier(e.tier) === t).length;
    const core = byTier('core'), long = byTier('long'), short = byTier('short');
    const af = loadAffinity();
    const imp = loadImpressions();
    const keys = Object.keys(state.sessions || {});
    const gs = loadGroupStats();
    const disc = Object.values(loadDiscipline().users || {}).filter((e) => e && e.level);
    const evs = (loadEvents().items || []).slice(-10).reverse();
    const bilis = biliItemsScored().slice(0, 5);
    const bal = lastBalanceSnapshot;
    const hc = snowlumaHealthSnapshot();
    // 健康快照的字段是 good（不是 ok）；兼容 connected/degraded。
    const slOk = !!(hc?.good ?? hc?.ok ?? hc?.connected);
    const online = [!!dshReady, slOk, true, true].filter(Boolean).length;
    const people = Object.entries(af.people || {}).map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => (Number(b.love) || 0) - (Number(a.love) || 0) || (Number(b.score) || 0) - (Number(a.score) || 0));
    const maxStress = keys.reduce((m, k) => Math.max(m, getStress(k)), 0);
    const totalMsg = keys.reduce((s, k) => s + dashActivity(k).reduce((a, b) => a + b, 0), 0);
    // 首页形象卡用的「她此刻」数据
    const herKey = keys.includes(`private:${cfg.ownerQQ}`) ? `private:${cfg.ownerQQ}` : (keys[0] || '');
    const herMoodNow = herKey ? getMood(herKey) : null;
    const herMoodBase = herKey ? getLongMood(herKey) : null;
    const herStress = herKey ? getStress(herKey) : 0;
    const herClosest = people[0] || null;
    const moodEmoji = (m) => (m && MOOD_EMOJI[m.emotion]) || '';
    const herMoodText = herMoodNow
      ? `${moodEmoji(herMoodNow)} ${escHtml(herMoodNow.emotion)} ${herMoodNow.intensity}/5`
      : (herMoodBase ? `${moodEmoji(herMoodBase)} ${escHtml(herMoodBase.emotion)}` : '安静');

    const svc = [
      ['DSH', !!dshReady, '大脑运行器'],
      ['SnowLuma', slOk, 'QQ 注入'],
      ['OneBot', slOk, '3000 / 3001'],
      ['桥接', true, '3100'],
      ['看门狗', true, '10 分钟自检']
    ].map(([n, ok, d]) => `<div class="svc"><span class="dot ${ok ? 'on' : 'off'}"></span><div><b>${escHtml(n)}</b><div class="muted small">${escHtml(d)}</div></div><span class="pill ${ok ? 'good' : 'bad'}">${ok ? '在线' : '异常'}</span></div>`).join('');

    const memTotal = Math.max(1, mem.length);
    const memBar = `<div class="stack"><i style="width:${(core / memTotal) * 100}%;background:#d7b698"></i><i style="width:${(long / memTotal) * 100}%;background:#9db8da"></i><i style="width:${(short / memTotal) * 100}%;background:#90b8ad"></i></div>`;

    const moodCards = keys.map((k) => {
      const s = getMood(k), l = getLongMood(k), st = getStress(k);
      const label = k === `private:${cfg.ownerQQ}` ? '私聊 · 老大' : k;
      const sp = dashSpark(dashActivity(k), st >= 75 ? '#ff5c5c' : '#58a6ff');
      const chip = (m) => m ? `<span class="chip">${MOOD_EMOJI[m.emotion] || ''} ${escHtml(m.emotion)} <em>${m.intensity}/5</em></span>` : '<span class="chip ghost">—</span>';
      return `<div class="moodcard">
        <div class="row"><b>${escHtml(label)}</b><span class="muted small">压力 ${st}</span></div>
        <div class="chips"><span class="muted small">底色</span>${chip(l)}<span class="muted small">当下</span>${chip(s)}</div>
        <div class="bar"><span style="width:${Math.min(100, st)}%;background:${st >= 75 ? 'linear-gradient(90deg,#ff5c5c,#ff9a5c)' : st >= 30 ? '#ffb347' : '#90b8ad'}"></span></div>
        ${sp}
      </div>`;
    }).join('') || '<div class="muted">暂无会话</div>';

    const stressGauges = keys.map((k) => {
      const raw = Number(getStress(k)) || 0;
      const st = Math.max(0, Math.min(100, raw));
      const label = k === `private:${cfg.ownerQQ}` ? '私聊 · 老大' : k;
      const zone = st >= 75 ? '高压' : st >= 50 ? '偏紧' : st >= 25 ? '正常' : '放松';
      const color = st >= 75 ? '#ff5c5c' : st >= 50 ? '#ffb347' : '#90b8ad';
      return `<div class="moodcard">
        <div class="row"><b>${escHtml(label)}</b><span class="pill" style="background:${color}22;color:${color}">${st} · ${zone}</span></div>
        <div class="gaugetrack"><span style="width:${st}%;background:linear-gradient(90deg,#90b8ad,#ffb347 55%,#ff5c5c)"></span><i class="tick" style="left:25%"></i><i class="tick" style="left:50%"></i><i class="tick" style="left:75%"></i></div>
        <div class="muted small">0 放松 · 25 正常 · 50 偏紧 · 75 高压 · 100</div>
      </div>`;
    }).join('') || '<div class="muted">暂无会话</div>';

    const moments = mem
      .filter((e) => Array.isArray(e.tags) && (e.tags.includes('小瞬间') || e.tags.includes('日常')))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      .slice(0, 60);
    const fmtDay = (ts) => {
      const d = new Date(Number(ts) || Date.now());
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };
    const momentList = moments.length
      ? `<div class="moments">${moments.map((e) => `<div class="moment"><span class="mday">${fmtDay(e.updatedAt || e.createdAt)}</span><span class="mtext">${escHtml(e.text)}</span><span class="mtag">${escHtml((e.tags || []).filter((t) => t !== '小瞬间' && t !== '日常').slice(0, 2).join(' / '))}</span></div>`).join('')}</div>`
      : '<div class="muted">还没有小瞬间——让她用 qq_remember 记「今天吃了什么/上了什么课/谁讲了什么笑话」，标签写「小瞬间」。</div>';

    const userMemes = (loadUserMemes().entries || [])
      .slice()
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, 200);
    const memeRows = userMemes.length
      ? userMemes.map((e) => `<div class="moment"><span class="mday">${fmtDay(e.at)}</span><span class="mtext"><b>${escHtml(e.title)}</b>　${escHtml(String(e.usage || e.summary || '').slice(0, 90))}</span><span class="mtag">${escHtml(e.tags || '')}</span><button class="mdel" data-title="${escHtml(e.title)}">删</button></div>`).join('')
      : '<div class="muted">还没有自学词条——她查不到梗时会用 qq_meme_learn 记下来。</div>';


    const peopleRows = people.map((p) => {
      const hearts = Math.min(5, Math.round((Number(p.love) || 0) / 20));
      const impText = imp.people?.[p.id]?.text || '';
      const cold = Number(p.lastAt) > 0 && Date.now() - Number(p.lastAt) > 3 * 3600_000;
      return `<tr>
        <td><b>${escHtml(p.name || p.id)}</b><div class="muted small">${escHtml(p.id)}${cold ? ' · ❄ 有点冷' : ''}</div></td>
        <td class="num">${Number(p.score) || 0}<div class="muted small">${escHtml(affinityLevel(p.score))}</div></td>
        <td>${dashBar(p.score, 100, 'linear-gradient(90deg,#1f6feb,#58a6ff)')}</td>
        <td class="hearts">${'♥'.repeat(hearts)}${'♡'.repeat(5 - hearts)}<div class="muted small">${Number(p.love) || 0}</div></td>
        <td class="num">${Number(p.loyalty) || 0}</td>
        <td class="imp">${escHtml(impText).slice(0, 70)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">还没有档案</td></tr>';

    const groupCards = Object.entries(gs || {}).filter(([k]) => k.startsWith('group:')).map(([k, g]) => {
      const sc = groupScore(k);
      return `<div class="groupcard"><div class="row"><b>${escHtml(k)}</b><span class="score">${sc}</span></div>
        <div class="bar"><span style="width:${sc}%;background:linear-gradient(90deg,#7c3aed,#a78bfa)"></span></div>
        <div class="muted small">出场 ${Number(g.speaks) || 0} · 开心 ${Number(g.joys) || 0} · 消息 ${Number(g.msgs) || 0}</div></div>`;
    }).join('') || '<div class="muted">暂无群统计</div>';

    const discRows = disc.map((e) => {
      const left = e.ignoreUntil && e.ignoreUntil > Date.now() ? Math.round((e.ignoreUntil - Date.now()) / 60000) : 0;
      return `<div class="warn"><span class="lvl">${e.level} 级</span><b>${escHtml(e.name || '')}</b>
        <div class="muted small">${escHtml((e.tags || []).join(' / '))}${left ? ` · 冷处理剩 ${left} 分钟` : ''}</div></div>`;
    }).join('') || '<div class="muted">没有处于警告中的用户</div>';

    const evList = evs.map((e) => `<div class="tl"><span class="tl-dot"></span><div><span class="tag">${escHtml(e.kind)}</span>${escHtml(e.who)} ${escHtml(e.what)}
      <div class="muted small">${new Date(e.at).toLocaleString('zh-CN', { hour12: false })}</div></div></div>`).join('') || '<div class="muted">暂无事件</div>';

    // 遗忘曲线：与星图同一个模型（memory-retention.js），页面只负责画。
    const forget = (() => {
      try {
        const sum = summarizeRetention(mem, Date.now(), 60, 60);
        return { ...sum, fading: 0.35, average: Math.round(sum.average * 1000) / 1000 };
      } catch { return null; }
    })();
    const forgetJson = JSON.stringify(forget || {}).replace(/</g, '\\u003c');
    const biliList = bilis.map((b) => `<a class="bili" href="${escHtml(b.url)}" target="_blank" rel="noreferrer">
      <span class="bili-score">${b.score}</span><span>${escHtml(b.title)}<div class="muted small">${escHtml(b.up)}${b.rated ? ` · 我评 ${b.rated}/5` : ''}</div></span></a>`).join('') || '<div class="muted">今天还没刷</div>';

    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="theme-color" content="#08090b">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鲸鱼的控制终端</title>
<style>${dashboardStyles}${sceneStyles}${personalityStyles}${replayStyles}${avatarStyles}${bootStyles}${handoffStyles}</style></head><body>
${bootMarkup}
<noscript><style>#boot{display:none!important}</style></noscript>
<div id="starLayer" role="dialog" aria-modal="true" aria-label="记忆星图" aria-hidden="true">
  <iframe id="starFrame" title="记忆星图"></iframe>
  <button id="starClose" type="button" title="回到面板（Esc）">返回控制终端 ↙</button>
</div>
<div id="appShell">
<div class="ambient" aria-hidden="true"><div class="ambient-img"></div><div class="ambient-horizon"></div><div class="ambient-bokeh"></div><div class="ambient-grain"></div><div class="ambient-veil"></div></div>
<header><div class="nav-inner">
  <a class="brand" href="#top" aria-label="小鲸鱼控制终端首页"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M4 15c1-6 8-9 15-6 4 2 6 5 6 9 2-1 4-1 5-4 1 5-2 8-6 8-2 4-7 6-12 3-5-2-9-5-8-10Z" fill="#e6ecf6"/><path d="M9 9c0-4 2-6 5-6-2 3-2 5-1 7" stroke="#e6ecf6" stroke-width="2" stroke-linecap="round"/><circle cx="19" cy="14" r="1" fill="#12151b"/></svg></span><span><strong>小鲸鱼 · 控制终端</strong><small>PERSONAL INTELLIGENCE</small></span></a>
  <div class="nav-actions"><span class="live-indicator"><i></i>LIVE SYSTEM</span>
    <button type="button" class="scene-switch" id="sceneSwitch" aria-label="切换背景氛围"><span class="scene-dot" aria-hidden="true"></span><span id="sceneLabel">暮色</span></button>
    <button type="button" id="replayBoot">重播开场</button>
    <button type="button" class="desktop-action" data-panel-action="/panel-exit">退出全屏</button>
    <button type="button" data-panel-action="/panel-close">关闭</button>
    <button type="button" class="nav-primary" onclick="openStar()">记忆星图 ↗</button>
  </div>
</div></header>
<div class="page" id="top">
<section class="hero" aria-labelledby="dashboardTitle">
  <div class="hero-copy"><div class="eyebrow">YOUR WORLD, CONNECTED.</div>
    <h1 id="dashboardTitle">每一个瞬间，<br><span>都值得记住。</span></h1>
    <p class="hero-description">情绪的起伏。记忆的轨迹。与你相遇的人。<br>关于小鲸鱼的一切，在这里清晰呈现。</p>
    <div class="hero-actions"><button type="button" class="button-primary" onclick="openStar()">探索记忆宇宙 <span aria-hidden="true">↗</span></button><span class="hero-note">${mem.length} 条记忆 · 持续生长</span></div>
  </div>
  <div class="hero-art">
    <div class="portrait">
      <div class="portrait-glow"></div>
      <img class="portrait-img" src="/media/avatar/hero.webp" alt="她的样子">
    </div>
    <div class="portrait-meta">
      <div class="portrait-name">小鲸鱼<small>WHALE GIRL · 18</small></div>
      <div class="portrait-chips">
        <span>心情 <b>${herMoodText}</b></span>
        <span>压力 <b>${herStress}</b></span>
        <span>记忆 <b>${mem.length}</b></span>
        <span>最在意 <b>${escHtml(herClosest ? (herClosest.name || herClosest.id) : '—')}</b></span>
      </div>
    </div>
    <span class="orb-caption">A LITTLE WHALE. A WHOLE WORLD.</span>
  </div>
</section>
<div class="context-strip reveal"><div class="context-meta">
  <span class="pill">${escHtml(rs.role || '未设置角色')}</span><span class="pill">${escHtml(currentMode)}</span>
  <span class="pill">余额 ${bal ? '¥' + bal.total.toFixed(2) : '—'}</span>
  <span class="pill">累计花费 ${(() => { try { return '¥' + tokenLedger.summary({ limit: 1 }).cost.toFixed(2); } catch { return '—'; } })()}</span>
  <span class="pill ${disc.length ? 'bad' : 'good'}">${disc.length ? disc.length + ' 个警告' : '无警告'}</span>
</div><div class="context-time"><span id="clk"></span>每 60 秒更新 · 星图浏览期间暂停刷新</div></div>
<div class="kpis reveal" aria-label="实时数据概览">
  <div class="kpi"><b><i class="n" data-count="${online}">${online}</i>/4</b><span>服务在线</span></div><div class="kpi"><b data-count="${mem.length}">${mem.length}</b><span>记忆条数</span></div>
  <div class="kpi"><b data-count="${people.length}">${people.length}</b><span>认识的人</span></div><div class="kpi"><b data-count="${Object.keys(gs || {}).length}">${Object.keys(gs || {}).length}</b><span>群</span></div>
  <div class="kpi"><b data-count="${maxStress}">${maxStress}</b><span>最高压力</span></div><div class="kpi"><b data-count="${totalMsg}">${totalMsg}</b><span>24h 消息</span></div>
</div>
<div class="section-heading reveal"><div><h2>一眼，看见全貌。</h2><p>运行状态与生活轨迹，井然有序。</p></div><div class="section-controls"><button id="expAll" type="button">展开全部</button><button id="colAll" type="button">收起全部</button></div></div>
<main id="systemOverview" aria-label="系统状态与记忆数据">
  <section><h2>服务状态</h2>${svc}</section>
  <section><h2>记忆结构</h2>${memBar}<div class="legend"><span><b style="background:#d7b698"></b>核心 ${core}</span><span><b style="background:#9db8da"></b>长期 ${long}</span><span><b style="background:#90b8ad"></b>短期 ${short}</span></div><div class="muted small" style="margin-top:24px">短期记忆 · 最近 ${Math.min(4, short)} 条</div><ul class="mini">${mem.filter((e) => normalizeTier(e.tier) === 'short').slice(-4).map((e) => `<li>${escHtml(e.text).slice(0, 60)}</li>`).join('') || '<li class="muted">暂无短期记忆</li>'}</ul></section>
  <section class="wide"><h2>压力与状态</h2><div class="moodgrid">${stressGauges}</div></section>
  <section class="wide"><h2>情感 · 24h 活跃</h2><div class="moodgrid">${moodCards}</div></section>
  <section><h2>群评分</h2>${groupCards}</section><section><h2>纪律与边界</h2>${discRows}</section>
  <section class="wide"><h2>相遇的人</h2><div class="table-scroll"><table><thead><tr><th>用户</th><th>好感</th><th>关系变化</th><th>喜爱</th><th>忠诚</th><th>印象</th></tr></thead><tbody>${peopleRows}</tbody></table></div></section>
  <section class="wide"><h2>记忆宇宙</h2><div class="memory-feature"><div class="memory-feature-copy"><h3>每一颗星，<br>都是一段故事。</h3><p>共 ${mem.length} 条记忆。用一次轻盈的镜头移动，重新看见与你有关的瞬间。</p><button type="button" class="button-primary" onclick="openStar()">打开记忆星图 <span aria-hidden="true">↗</span></button></div><div class="memory-preview" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></div></section>
  <section class="wide"><h2>遗忘曲线</h2><div class="forget">
    <div class="forget-copy"><h3>记忆，也会慢慢淡去。</h3>
      <p>每条记忆都有自己的稳定度：被反复提起、联想越多，就忘得越慢；核心记忆几乎不褪色，短期记忆到期后会被真实清除。下图是未来 60 天里各层级的平均保持率。</p>
      <div class="forget-figures">
        <div><b data-count="${forget ? Math.round(forget.average * 100) : 100}" data-suffix="%">${forget ? Math.round(forget.average * 100) : 100}%</b><span>此刻平均保持率</span></div>
        <div class="warm"><b data-count="${forget ? forget.fadingNow : 0}">${forget ? forget.fadingNow : 0}</b><span>已进入「快忘了」</span></div>
        <div class="warm"><b data-count="${forget ? forget.fadingIn7d : 0}">${forget ? forget.fadingIn7d : 0}</b><span>7 天内将忘</span></div>
      </div>
      <button type="button" class="button-primary" style="margin-top:22px" onclick="openStar()">在星图里拨动时间流 <span aria-hidden="true">↗</span></button></div>
    <div><div class="forget-chart"><canvas id="forgetChart" role="img" aria-label="未来 60 天各层级记忆平均保持率曲线"></canvas></div>
      <div class="forget-legend"><span><i style="background:#f0c8a4"></i>核心</span><span><i style="background:#9fb8da"></i>长期</span><span><i style="background:#8fd0c4"></i>短期</span></div>
      <div class="forget-note">R(t) = e<sup>−t/S</sup>，S 由层级、被强化的次数与联想数决定。</div></div>
    <script type="application/json" id="forgetData">${forgetJson}</script>
  </div></section>
  <section class="wide"><h2>对话回放</h2>
    <div class="rp-bar">
      <select id="rpConv" title="选会话"></select>
      <select id="rpDay" title="选日期"></select>
      <button type="button" id="rpReload" title="重新拉取">刷新</button>
      <span id="rpInfo"></span>
    </div>
    <div id="rpList" class="rp-list"></div>
  </section>
  <section class="wide"><h2>小瞬间</h2>${momentList}</section>
  <section class="wide"><h2>自学词条 · ${userMemes.length}</h2><div class="moments">${memeRows}</div></section>
  <section><h2>事件备忘录</h2>${evList}</section><section><h2>B站 · 今天</h2>${biliList}</section>
</main>
<footer><strong>DEEPSEEK · PERSONAL INTELLIGENCE</strong><span>生成于 ${now.toLocaleString('zh-CN', { hour12: false })} · 运行 ${Math.round(process.uptime() / 60)} 分钟</span></footer>
</div></div>
<script>${dashboardScript}${sceneScript}${personalityScript}${replayScript}${bootScript}${handoffScript}</script>
</body></html>`;
  }

  function buildDashboardHtml() {
    const now = new Date();
    const rs = readRoleState();
    const mem = pruneExpiredMemory(loadGlobalMemory().entries || []);
    const byTier = (t) => mem.filter((e) => normalizeTier(e.tier) === t).length;
    const af = loadAffinity();
    const imp = loadImpressions();
    const keys = Object.keys(state.sessions || {});
    const gs = loadGroupStats();
    const disc = loadDiscipline().users || {};
    const evs = (loadEvents().items || []).slice(-12).reverse();
    const bilis = biliItemsScored().slice(0, 5);
    const bal = lastBalanceSnapshot;

    const serviceRow = (name, ok, extra) => `<div class="svc ${ok ? 'ok' : 'bad'}"><span class="dot"></span><b>${escHtml(name)}</b><span class="muted">${escHtml(extra || '')}</span></div>`;
    const services = [
      serviceRow('DSH', !!dshReady, dshReady ? '已就绪' : '未连接'),
      serviceRow('SnowLuma', !!snowlumaHealthSnapshot()?.ok, 'QQ 注入'),
      serviceRow('OneBot', !!snowlumaHealthSnapshot()?.ok, '3000 / 3001'),
      serviceRow('桥接', true, `3100 · ${currentMode}`),
      serviceRow('看门狗', true, '10 分钟自检')
    ].join('');

    const people = Object.entries(af.people || {})
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => (Number(b.love) || 0) - (Number(a.love) || 0) || (Number(b.score) || 0) - (Number(a.score) || 0));
    const peopleRows = people.map((p) => {
      const impText = imp.people?.[p.id]?.text || '';
      const cold = Number(p.lastAt) > 0 && Date.now() - Number(p.lastAt) > 3 * 3600_000;
      return `<tr>
        <td>${escHtml(p.name || p.id)}<div class="muted small">${escHtml(p.id)}${cold ? ' · 有点冷' : ''}</div></td>
        <td>${Number(p.score) || 0}<div class="muted small">${escHtml(affinityLevel(p.score))}</div></td>
        <td>${dashBar(p.score, 100, '#4da3ff')}</td>
        <td>${Number(p.love) || 0}${p.love ? `<div class="muted small">${escHtml(loveLevel(p.love))}</div>` : ''}</td>
        <td>${dashBar(p.love || 0, 100, '#ff6fa5')}</td>
        <td>${Number(p.loyalty) || 0}</td>
        <td class="imp">${escHtml(impText).slice(0, 80)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">还没有档案</td></tr>';

    const moodRows = keys.map((k) => {
      const s = getMood(k); const l = getLongMood(k); const st = getStress(k);
      const label = k === `private:${cfg.ownerQQ}` ? '私聊（老大）' : k;
      return `<tr><td>${escHtml(label)}</td>
        <td>${l ? `${escHtml(l.emotion)} <span class="muted">${l.intensity}/5</span>` : '<span class="muted">—</span>'}</td>
        <td>${s ? `${escHtml(s.emotion)} <span class="muted">${s.intensity}/5</span>` : '<span class="muted">—</span>'}</td>
        <td>${dashBar(st, 100, st >= 75 ? '#ff5c5c' : st >= 30 ? '#ffb347' : '#4cc38a')}<div class="muted small">${st}</div></td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">暂无会话</td></tr>';

    const groupRows = Object.entries(gs || {}).filter(([k]) => k.startsWith('group:')).map(([k, g]) => {
      const sc = groupScore(k);
      return `<tr><td>${escHtml(k)}</td><td>${sc}</td><td>${dashBar(sc, 100, '#8b5cf6')}</td>
        <td class="muted small">出场 ${Number(g.speaks) || 0} / 开心 ${Number(g.joys) || 0} / 消息 ${Number(g.msgs) || 0}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted">暂无群统计</td></tr>';

    const discRows = Object.values(disc).filter((e) => e && e.level).map((e) =>
      `<tr><td>${escHtml(e.name || '')}</td><td>${e.level} 级</td><td class="muted small">${escHtml((e.tags || []).join('/'))}</td></tr>`
    ).join('') || '<tr><td colspan="3" class="muted">没有警告中的用户</td></tr>';

    const evRows = evs.map((e) =>
      `<li><span class="tag">${escHtml(e.kind)}</span> ${escHtml(e.who)} ${escHtml(e.what)}<div class="muted small">${new Date(e.at).toLocaleString('zh-CN', { hour12: false })}</div></li>`
    ).join('') || '<li class="muted">暂无事件</li>';

    const biliRows = bilis.map((b) =>
      `<li><a href="${escHtml(b.url)}" target="_blank">${escHtml(b.title)}</a><div class="muted small">${escHtml(b.up)} · 优先 ${b.score}${b.rated ? ` · 我评 ${b.rated}/5` : ''}</div></li>`
    ).join('') || '<li class="muted">今天还没刷</li>';

    const shortMem = mem.filter((e) => normalizeTier(e.tier) === 'short').slice(-6).map((e) => `<li>${escHtml(e.text)}</li>`).join('') || '<li class="muted">无</li>';

    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>小鲸鱼的控制终端</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid #21262d;background:#161b22;position:sticky;top:0;z-index:2}
h1{font-size:17px;margin:0;letter-spacing:.5px}
.muted{color:#8b949e;font-weight:400}
.small{font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;padding:16px 22px 40px}
section{background:#161b22;border:1px solid #21262d;border-radius:12px;padding:14px 16px}
h2{font-size:14px;margin:0 0 10px;color:#9fb0ff;letter-spacing:.5px}
.svc{display:flex;align-items:center;gap:8px;padding:4px 0}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.svc.ok .dot{background:#3fb950;box-shadow:0 0 8px #3fb95088}
.svc.bad .dot{background:#f85149;box-shadow:0 0 8px #f8514988}
.svc .muted{margin-left:auto;font-size:12px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #21262d;vertical-align:top}
th{color:#8b949e;font-weight:500;font-size:12px}
.bar{height:6px;background:#21262d;border-radius:4px;overflow:hidden;margin-top:4px}
.bar span{display:block;height:100%;border-radius:4px}
ul{margin:0;padding-left:16px}
li{margin:6px 0}
a{color:#79c0ff;text-decoration:none}
.tag{display:inline-block;font-size:11px;background:#1f6feb33;color:#79c0ff;border-radius:4px;padding:0 6px;margin-right:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kpi{font-size:22px;font-weight:600}
.imp{max-width:240px;color:#8b949e;font-size:12px}
footer{color:#8b949e;font-size:12px;padding:0 22px 24px}
</style></head><body>
<header><h1>独立AI · 运行面板 <span class="muted small">（每 30 秒自动刷新）</span></h1>
<div class="muted">${now.toLocaleString('zh-CN', { hour12: false })} · 角色 ${escHtml(rs.role || '未设置')} · 余额 ${bal ? `¥${bal.total.toFixed(2)}` : '—'}</div></header>
<main>
<section><h2>服务状态</h2>${services}</section>
<section><h2>记忆</h2>
  <div class="grid2"><div><div class="kpi">${byTier('core')}</div><div class="muted small">核心</div></div>
  <div><div class="kpi">${byTier('long')}</div><div class="muted small">长期</div></div>
  <div><div class="kpi">${byTier('short')}</div><div class="muted small">短期</div></div>
  <div><div class="kpi">${mem.length}</div><div class="muted small">总计</div></div></div>
  <h2 style="margin-top:12px">最近的短期记忆</h2><ul>${shortMem}</ul></section>
<section><h2>情感（长期 / 当下 / 压力）</h2>
  <table><thead><tr><th>会话</th><th>底色</th><th>当下</th><th>压力</th></tr></thead><tbody>${moodRows}</tbody></table></section>
<section><h2>群评分</h2><table><thead><tr><th>群</th><th>分</th><th></th><th>明细</th></tr></thead><tbody>${groupRows}</tbody></table></section>
<section style="grid-column:1/-1"><h2>用户评价（好感 / 喜爱 / 忠诚 / 印象）</h2>
  <table><thead><tr><th>用户</th><th>好感</th><th></th><th>喜爱</th><th></th><th>忠诚</th><th>印象</th></tr></thead><tbody>${peopleRows}</tbody></table></section>
<section><h2>纪律（警告中）</h2><table><thead><tr><th>用户</th><th>等级</th><th>原因</th></tr></thead><tbody>${discRows}</tbody></table></section>
<section><h2>事件备忘录（最近）</h2><ul>${evRows}</ul></section>
<section><h2>B站（今天挑的）</h2><ul>${biliRows}</ul></section>
</main>
<footer>数据来源：state/*.json + 实时进程状态 · 刷新即重新渲染（无缓存）</footer>
</body></html>`;
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        cancelDshExitGoodnight();
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
      scheduleDshExitGoodnight();
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  /**
   * 传感器接入口：只做「收一条读数」。默认 0.0.0.0:3101，令牌见 state/environment-token。
   * 板子只要 POST /report，body 形如 {"tempC":23.4,"humidity":58.2,"place":"书房"}。
   */
  function startEnvironmentIngest() {
    const envCfg = cfg.environment ?? {};
    if (envCfg.enabled === false) return null;
    const port = Number(envCfg.port) || 3101;
    const token = loadOrCreateEnvironmentToken(envCfg.token);
    const server = http.createServer((req, res) => {
      const send = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch { send({ ok: false, error: '无效的请求地址' }, 400); return; }
      if (req.method === 'GET' && url.pathname === '/health') {
        send({ ok: true, service: 'environment-ingest', last: readEnvironment()?.at ?? null });
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/report') {
        send({ ok: false, error: '用 POST /report 上报读数，GET /health 探活' }, 404);
        return;
      }
      const provided = String(req.headers['x-sensor-token'] ?? url.searchParams.get('token') ?? '').trim();
      if (provided !== token) { send({ ok: false, error: '传感器令牌不正确' }, 401); return; }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
        send({ ok: false, error: '请求必须是 application/json' }, 415);
        return;
      }
      const chunks = [];
      let total = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > 8192) { tooLarge = true; return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) { send({ ok: false, error: '请求体过大' }, 413); return; }
        let raw = null;
        try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        const parsed = normalizeReading(raw);
        if (!parsed.ok) { send({ ok: false, error: parsed.error }, 400); return; }
        const reading = { ...parsed.reading, ip: String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '') };
        try {
          atomicWriteJson(ENV_FILE, reading);
          appendEnvironmentHistory(reading);
        } catch (error) {
          send({ ok: false, error: `写状态失败：${error?.message ?? error}` }, 500);
          return;
        }
        log(`[sensor] 收到读数 ${reading.tempC}°C / ${reading.humidity}%${reading.place ? ` @${reading.place}` : ''}`);
        send({ ok: true, at: reading.at });
      });
    });
    server.on('error', (error) => log(`[sensor] 传感器端口 ${port} 起不来：${error?.message ?? error}`));
    server.listen(port, String(envCfg.bind || '0.0.0.0'), () => {
      log(`[sensor] 传感器接入已开启 http://0.0.0.0:${port}/report（令牌：state/environment-token）`);
    });
    server.unref?.();
    return server;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      // 旧控制台下线开关：只关 /panel（那个旧控制台已经被 DSH 设置页取代）。
      // /dashboard（总控制可视化面板）和 /memory（记忆星图）保留 —— 它们是给眼睛看的，
      // DSH 里没有替代品，关掉等于把好好的东西藏起来。
      if (hideConsolePages && (url.pathname === '/panel' || url.pathname === '/panel/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('旧控制台已停用：请在 DSH 的「设置 → QQ 桥接」里操作；可视化面板用「打开可视化面板」。');
        return;
      }
      // 给页面用的 CSP：必须放行 img-src / connect-src / media-src 的 data: 与 blob:。
      // GLTFLoader 加载 VRM 内嵌贴图的做法是「bufferView → Blob → blob: URL → <img>」，
      // 而 default-src 'self' 在不写 img-src 时会回落到 default-src，把 blob: 图片静默拦掉：
      // 不报错、不抛异常，只是 onerror，于是材质拿到 map=null，模型渲染成一坨白模。
      const PAGE_CSP = "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' data: blob:; media-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': PAGE_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      // 免令牌路径：静态资源/面板窗口/一键对接（DSH 里的小按钮直接打，不带令牌）。
      // /oneclick 是破坏性操作（会重启桥接），所以额外拦掉浏览器跨站请求（sec-fetch-site: cross-site）。
      const oneclickSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
      // 之前这里用 sec-fetch-site !== 'cross-site' 做 CSRF 防护，但它落到 401 分支时**不写任何日志**，
      // 结果「按钮点了完全没反应」无从排查（2026-10-29 连按两次都没记录）。改成无条件放行，
      // 由路由自己打日志；防护交给 20 秒去抖 + 只绑 127.0.0.1。
      const oneclickAllowed = (req.method === 'POST' || req.method === 'GET') && url.pathname === '/oneclick';
      // /api/boot/card 是开机片头读的一张只读小卡（记忆数/心情/压力/最在意），
      // 由 DSH 的插件在宿主进程里来取；它跑在另一个进程里，拿不到控制台令牌。
      // 内容只在本机回环可读，且不含 QQ 号，所以放进免令牌白名单。
      const publicMedia = (req.method === 'GET' && (url.pathname.startsWith('/media/') || url.pathname === '/panel' || url.pathname === '/open-panel' || url.pathname === '/ping' || url.pathname === '/diag' || url.pathname === '/open-memory'
          || url.pathname === '/open-space'
          || url.pathname === '/panel-exit' || url.pathname === '/panel-close' || url.pathname === '/api/boot/card'))
        || oneclickAllowed;
      if (consoleToken && !tokenMatches && !publicMedia) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1；带了令牌就必须命中某个活跃会话，
      // 端点自己漏写校验也不会退回管理端。
      //
      // 但「没带令牌」的智能体调用不能一律拒绝：closed-agent（管理员私聊）模式下模型
      // 本来就**没有**会话令牌（令牌只在 reserved2 的唤醒提示里下发），而 qq_send_group_message
      // / qq_list_groups 等工具必须在这个模式里可用（工具描述写的也是"closed-agent 模式不需要"）。
      // 这些端点各自按模式判定（/api/send/* 只在 closed-agent 放行；/api/images/* 在 reserved2
      // 强制要令牌；/api/status 对智能体调用只回最小对象），所以这里把「无令牌智能体调用」
      // 限制到这条非 v2 会话面；整个 /api/socialV2/ 前缀一概不放——那里的 token 校验全是
      // `if (x-agent-token && …)`，放进来就等于退化成管理端全权（confused deputy）。
      if (req.headers['x-agent-call'] !== undefined) {
        const agentToken = req.headers['x-agent-token'];
        const hasToken = typeof agentToken === 'string' && agentToken !== '';
        if (hasToken && !isLiveAgentToken(agentToken)) {
          sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
          return;
        }
        if (!hasToken) {
          const tokenlessAgentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/');
          if (!tokenlessAgentAllowed) {
            sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
            return;
          }
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        // /api/socialV2/initial-prompt 也在这里：它是操作者写给 AI 的"环境背景"，
        // 让 AI 自己读/改等于把控制台的管理输入（以及未来可能写入的其它群信息）交给会话主体。
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/initial-prompt'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            // 空间：她要能读自己在哪（/api/space/state）、也要能换地方（/api/space/move）。
            // 漏了这一条的表现是「她调了工具、拿到 403、但嘴上已经说『我过去了』」——
            // 说的和画面对不上，比没有这个功能更坏。
            || url.pathname.startsWith('/api/space/')
            // 读书：查在读、写批注（qq_reading / qq_reading_note）。同上一行，漏了就是嘴上说记了、其实 403。
            || url.pathname.startsWith('/api/reading/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        // 只读降级：黑话库/表情库在启动时加载失败时，写接口必须**明确失败**。
        // 旧行为是 save 函数里只打一行日志就 return，而接口照样回 {ok:true}：
        // 控制台显示"✅ 已保存"，实际只改在内存里，重启后全部消失。
        if (req.method !== 'GET') {
          const readonlyStore = (!slangStoreWritable && (url.pathname === '/api/slang'
            || url.pathname === '/api/slang/clear'
            || url.pathname === '/api/slang/extract'
            || url.pathname === '/api/slang/research'
            || url.pathname.startsWith('/api/slang/batch-')
            || url.pathname === '/api/socialV2/slang/submit')) ? '黑话库'
            : (!stickerStoreWritable && (url.pathname === '/api/stickers/sync'
              || url.pathname === '/api/stickers/note'
              || url.pathname === '/api/stickers/remark'
              || url.pathname === '/api/socialV2/sticker-note'
              || url.pathname === '/api/socialV2/sticker-remark'
              || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库'
              : '';
          if (readonlyStore) {
            sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503);
            return;
          }
        }
        if (req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'Content-Security-Policy': PAGE_CSP + "; frame-ancestors *",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
          });
          res.end(buildDashboardFancy());
          return;
        }
        // ── 形象绑定预览（/avatar）：伪 Live2D 引擎，素材到位后自动切素材模式 ──
        if (req.method === 'GET' && (url.pathname === '/avatar' || url.pathname === '/avatar/')) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'Content-Security-Policy': PAGE_CSP + "; frame-ancestors *",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
          });
          res.end(renderAvatarPage());
          return;
        }

        // ── 她的家（/space）：第 2 轮只读画面，房间布局在 public/space/rooms.json ──
        // 需要控制台令牌，和 /memory 同规矩：页面里再用 token 去读 /api/space/state。
        if (req.method === 'GET' && (url.pathname === '/space' || url.pathname === '/space/')) {
          // 每次从磁盘读：改 public/space/index.html 后刷新浏览器就生效，不用重启桥接。
          // （页面是纯前端，没有任何服务端插值，所以直接读文件是安全的。）
          let pageHtml = '';
          try {
            pageHtml = fs.readFileSync(path.join(ROOT, 'public', 'space', 'index.html'), 'utf8');
          } catch {
            pageHtml = renderSpacePage();   // 文件没了就用模块里的旧版兜底，页面绝不 404
          }
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'Content-Security-Policy': PAGE_CSP + "; frame-ancestors *",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
          });
          res.end(pageHtml);
          return;
        }

        // ── 记忆星图（独立页）─────────────────────────────────────────
        // 单开一个全窗口的星空视图；数据就是跨会话长期记忆本身。
        if (req.method === 'GET' && (url.pathname === '/memory' || url.pathname === '/memory/')) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'Content-Security-Policy': PAGE_CSP + "; frame-ancestors *",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
          });
          res.end(renderMemoryPage(pruneExpiredMemory(loadGlobalMemory().entries || [])));
          return;
        }

        // ── 用独立窗口打开记忆星图（和 /open-panel 同一套做法）──────────
        if (req.method === 'GET' && url.pathname === '/open-memory') {
          try {
            const mst = focusExistingWindow(['-Star']);
            if (mst === 'ok') {
              log('[memory] 已有全屏星图窗口，已提到最前');
              res.writeHead(204, { 'cache-control': 'no-store' });
              res.end();
              return;
            }
            if (mst === 'stale') {
              log('[memory] 旧星图窗口不是全屏，已关闭，重开一个');
              await new Promise((r) => setTimeout(r, 800));
            }
            if (mst === 'focusfail') {
              log('[memory] 抢不到前台（DSH 占着），关掉重开一个');
              closeAppWindow(true);
              await new Promise((r) => setTimeout(r, 900));
            }
            const t = loadOrCreateConsoleToken();
            const target = 'http://127.0.0.1:' + (cfg.port || 3100) + '/memory?token=' + encodeURIComponent(t);
            const candidates = [
              'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            ];
            const exe = candidates.find(function (p2) { return fs.existsSync(p2); });
            if (exe) {
              const profileDir = path.join(STATE_DIR, 'edge-app-profile');
              fs.mkdirSync(profileDir, { recursive: true });
              spawn(exe, ['--app=' + target, '--start-fullscreen', '--user-data-dir=' + profileDir], {
                detached: true, stdio: 'ignore', windowsHide: false
              }).unref();
              applyTopmostSoon(true);
              log('[memory] 已拉起记忆星图窗口');
              res.writeHead(204, { 'cache-control': 'no-store' });
              res.end();
            } else {
              res.writeHead(302, { location: target });
              res.end();
            }
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('open memory failed: ' + (error?.message ?? error));
          }
          return;
        }

        // ── 她的家（独立窗口）──────────────────────────────────────────
        // 和 /memory 同一个套路：整个 Edge 应用窗口（没有地址栏），全屏。
        // 用**独立的 user-data-dir**，否则会和星图/控制台共用一个 Edge 实例，
        // 枚举窗口时按标题就分不清是谁（focus-panel.ps1 那次踩过）。
        if (req.method === 'GET' && url.pathname === '/open-space') {
          try {
            const fst = focusExistingWindow(['-Space']);
            if (fst === 'ok') {
              log('[space] 已有窗口，已提到最前');
              res.writeHead(204, { 'cache-control': 'no-store' });
              res.end();
              return;
            }
            if (fst === 'stale' || fst === 'focusfail') {
              await new Promise((r) => setTimeout(r, 800));
            }
            await new Promise((r) => setTimeout(r, 300));
            const t = loadOrCreateConsoleToken();
            const target = 'http://127.0.0.1:' + (cfg.port || 3100) + '/space?token=' + encodeURIComponent(t);
            const candidates = [
              'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            ];
            const exe = candidates.find(function (p2) { return fs.existsSync(p2); });
            if (exe) {
              const profileDir = path.join(STATE_DIR, 'edge-space-profile');
              fs.mkdirSync(profileDir, { recursive: true });
              spawn(exe, ['--app=' + target, '--start-fullscreen', '--user-data-dir=' + profileDir], {
                detached: true, stdio: 'ignore', windowsHide: false
              }).unref();
              log('[space] 已拉起「她的家」窗口');
              res.writeHead(204, { 'cache-control': 'no-store' });
              res.end();
            } else {
              res.writeHead(302, { location: target });
              res.end();
            }
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('open space failed: ' + (error?.message ?? error));
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        // 开机片头用的状态卡：一句话说清她此刻的样子。
        // 只读、只在本机、不参与任何发送逻辑。桥接不在时插件那边会拿到失败，
        // 动画自动退化成「简洁」——所以这里不用写兜底文案。
        if (req.method === 'GET' && url.pathname === '/api/boot/card') {
          try {
            const rs = readRoleState();
            const bootKeys = Object.keys(state.sessions || {});
            const bootKey = bootKeys.includes(`private:${cfg.ownerQQ}`) ? `private:${cfg.ownerQQ}` : (bootKeys[0] || '');
            const bootMem = pruneExpiredMemory(loadGlobalMemory().entries || []);
            const bootTier = (t) => bootMem.filter((e) => normalizeTier(e.tier) === t).length;
            const bootAf = loadAffinity();
            const bootPeople = Object.entries(bootAf.people || {})
              .map(([id, p]) => ({ id, ...p }))
              .sort((a, b) => (Number(b.love) || 0) - (Number(a.love) || 0) || (Number(b.score) || 0) - (Number(a.score) || 0));
            const bootClosest = bootPeople[0] ?? null;
            sendJson({
              ok: true,
              at: Date.now(),
              role: rs.role ?? null,
              mood: bootKey ? getMood(bootKey) : null,
              moodLong: bootKey ? getLongMood(bootKey) : null,
              stress: bootKey ? getStress(bootKey) : 0,
              memories: {
                total: bootMem.length,
                core: bootTier('core'),
                long: bootTier('long'),
                short: bootTier('short'),
              },
              // 开机授权页要报「认识多少人」——只给人数，不给名单。
              people: bootPeople.length,
              closest: bootClosest ? { name: bootClosest.name || null, score: Number(bootClosest.score) || 0 } : null,
            });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message || error) });
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            // 各会话的上下文占用（≈最近一条 assistant 消息的总输入 token）
            context: Object.entries(state.sessions || {}).map(([k, sid]) => {
              const used = Number(sessionContextTokens.get(sid)) || 0;
              const win = Number(cfg.socialV2?.contextGuard?.contextWindow) || 1_000_000;
              return { key: k, sessionId: sid, usedTokens: used, percent: Math.round((used / win) * 1000) / 10 };
            }),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            sendJson({ ok: true, backups: listPresetBackups(preset) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang, writable: slangStoreWritable });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/debug/goodnight-exit') {
          const body = await readBody();
          try {
            const result = await broadcastGoodnight('debug', { dry: !!body.dry, canned: true });
            sendJson({ ok: true, ...result, dshReady });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }        if (req.method === 'POST' && url.pathname === '/api/console/goodnight') {
          const body = await readBody();
          try {
            const result = await broadcastGoodnight('console', { dry: !!body.dry });
            sendJson({ ok: true, ...result });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/meme-user-delete') {
          const body = await readBody();
          const title = String(body.title || '').trim();
          const db = loadUserMemes();
          const before = db.entries.length;
          db.entries = db.entries.filter((e) => e.title !== title);
          saveUserMemes();
          sendJson({ ok: true, removed: before - db.entries.length, remaining: db.entries.length });
          return;
        }
        // ── 社交圈关系图：只返回白名单字段的精简 JSON（只读，不写盘）──────────
        // 群成员关系不单独存盘，从 state/transcripts 的聊天记录里现算：
        // 每个 group_* 目录的每一天 jsonl 里都有 {u: uid}，统计 uid → 群 的归属。
        if (req.method === 'GET' && url.pathname === '/api/console/social-graph') {
          try {
            const scan = socialTranscriptScan();
            const nowMs = Date.now();
            const graph = buildSocialGraph({
              affinity: loadAffinity().people,
              impressions: loadImpressions().people,
              discipline: loadDiscipline().users,
              groupStats: loadGroupStats(),
              memberships: scan.memberships,
              ownerQQ: String(cfg.ownerQQ || ''),
              selfUid: String(selfUserId || ''),
              selfName: String(selfDisplayName || ''),
              now: nowMs
            });

            // 人与人之间的连线：接话 + @提及（口径见 relation-graph.js 顶部注释）
            const names = Object.create(null);
            for (const [uid, a] of Object.entries(loadAffinity().people || {})) {
              if (a?.name) names[uid] = String(a.name);
            }
            for (const [uid, imp] of Object.entries(loadImpressions().people || {})) {
              if (imp?.name && !names[uid]) names[uid] = String(imp.name);
            }
            const links = buildPersonLinks({
              messages: scan.messages,
              names,
              selfUid: String(selfUserId || ''),
              topN: 15
            });
            graph.links = links.edges;
            graph.linkStats = { total: links.total, maxWeight: links.maxWeight, scanned: scan.messages.length };

            // 她亲口记下的关系（impressions.relations），不是统计推断
            graph.semantic = buildSemanticEdges(
              loadImpressions().relations || {},
              graph.nodes,
              graph.owner,
              String(selfUserId || '')
            );
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'X-Content-Type-Options': 'nosniff'
            });
            res.end(JSON.stringify({ ok: true, graph }));
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 对话回放（面板用）：读 state/transcripts 的 jsonl ────────────────
        // 不带 dir → 会话目录索引；带 dir + day → 当天最后 N 条。
        if (req.method === 'GET' && url.pathname === '/api/console/replay') {
          const dir = String(url.searchParams.get('dir') || '').trim();
          const day = String(url.searchParams.get('day') || '').trim();
          const limit = Math.min(400, Math.max(10, Number(url.searchParams.get('limit')) || 120));
          const base = path.join(STATE_DIR, 'transcripts');

          if (!/^[a-z]+_\d+$/.test(dir)) {
            const dirs = [];
            try {
              for (const name of fs.readdirSync(base)) {
                const full = path.join(base, name);
                let st2;
                try { st2 = fs.statSync(full); } catch { continue; }
                if (!st2.isDirectory()) continue;
                const days = fs.readdirSync(full)
                  .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
                  .map((f) => f.slice(0, 10))
                  .sort();
                if (!days.length) continue;
                dirs.push({ dir: name, days, last: days[days.length - 1], count: days.length });
              }
            } catch {}
            dirs.sort((a, b) => (a.last < b.last ? 1 : -1));
            sendJson({ ok: true, dirs });
            return;
          }

          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            sendJson({ ok: false, error: 'day 格式应为 YYYY-MM-DD' }, 400);
            return;
          }
          const file = path.join(base, dir, day + '.jsonl');
          let lines = [];
          try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
          // 「是不是她说的」不能只信 me 字段：有些路径回写时 me=false，
          // 而且同一个 u 在历史记录里换过昵称。这里用昵称（去空格、忽略大小写）判定。
          const botName = String(selfDisplayName || '').replace(/\s+/g, '').toLowerCase();
          const messages = [];
          for (const line of lines.slice(-limit)) {
            try {
              const m = JSON.parse(line);
              if (!m || typeof m.x !== 'string') continue;
              const nm = String(m.s || '').replace(/\s+/g, '').toLowerCase();
              const mine = !!m.me
                || (botName && nm === botName)
                || (nm && nm.indexOf('deepseek') >= 0 && nm.indexOf('助手') >= 0);
              messages.push({
                t: Number(m.t) || 0,
                s: String(m.s || ''),
                u: String(m.u || ''),
                me: !!mine,
                x: m.x.slice(0, 600)
              });
            } catch {}
          }
          sendJson({ ok: true, dir, day, total: lines.length, messages });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}【当前会话】${key}\n\n${tokenLine}${formatGlobalMemoryBootstrap(key)}${handoverPrompt(key)}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'remember', 'recall', 'forget', 'newSession', 'balance', 'groupFiles', 'mood', 'affinity', 'bili', 'groupScores', 'impression', 'handover', 'events', 'transcript', 'say', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              turnLeaseNoted.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            remember: 'qq_remember',
            recall: 'qq_recall',
            forget: 'qq_forget',
            newSession: 'qq_new_session',
            balance: 'qq_balance',
            groupFiles: 'qq_group_files / qq_group_file_read',
            mood: 'qq_mood',
            affinity: 'qq_affinity',
            bili: 'qq_bili_priority',
            groupScores: 'qq_group_scores',
            impression: 'qq_impression',
            handover: 'qq_handover',
            events: 'qq_events',
            transcript: 'qq_transcript',
            say: 'qq_say',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
            self: {
              nickname: selfDisplayName || null,
              userId: selfUserId || null,
              line: selfIdentityTextV2().trim() || null
            },
            role: {
              name: roleState.role ?? null,
              hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint(),
              // 她自己长出来的那一页：写在她人格卡后面，由 qq_remember（tags 带「学来的」）累积。
              grown: growthLineFor(key).trim() || null,
              growHow: '想给自己加一点：qq_remember(text, tags: ["学来的"], tier: "long")。一次一点、一条不超过一句话；写的是「我学到的样子」，不是「别人给我的设定」。'
            },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            longTermMemory: {
              total: loadGlobalMemory().entries.length,
              hint: '跨会话长期记忆：重要信息用 qq_remember 记录，需要时用 qq_recall 查询，过时用 qq_forget 删除'
            },
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8, { focus: recentIncomingTextV2(st) }) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去。语音是加料不是常态：一次聊天里偶尔发一条就够，别连续发、别每条都发；显卡被占着（他在打游戏）时会自动跳过，那就直接打字。'
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages: withAgeLabels(messages), readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages: withAgeLabels(messages), readThroughSeq });
          return;
        }
        // 外接温湿度：她想知道「现在屋里几度」时自己查；数据过期会说 stale=true。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/environment') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('environment')) { sendJson({ ok: false, error: '工具未启用：qq_environment' }, 403); return; }
          const envCfg = cfg.environment ?? {};
          const reading = readEnvironment();
          const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24));
          sendJson({
            ok: true,
            key,
            enabled: envCfg.enabled !== false,
            deviceConnected: !!reading,
            reading,
            ageMs: reading ? readingAgeMs(reading) : null,
            stale: reading ? !isFresh(reading, { staleMinutes: Number(envCfg.staleMinutes) || DEFAULT_STALE_MINUTES }) : true,
            trend: reading ? summarizeHistory(readEnvironmentHistory(), { hours }) : null,
            hint: reading
              ? '缝还亮着：这是他那边的空气。当他的天气说——「你那边今天挺潮的」「你那边是不是有点凉」；别报「湿度 58%」这种读数，也别解释魔法怎么运作。'
              : '缝起了雾，现在看不见他那边（设备没接上或没上报）；没看见就别编。'
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
          // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessagesV2 的注释与
          // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...pickWakeTriggersV2(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「二代协议说明 + 操作者为这个会话
          // 预写的初始提示词（群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
          // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
          const firstWake = !st.bootstrapSent;
          if (firstWake) st.bootstrapSent = true;
          const effectiveReason = firstWake ? 'bootstrap' : reason;
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
          sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
          return;
        }
        // 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— adminOnlyV2Paths）。
        // 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePromptV2。
        if (url.pathname === '/api/socialV2/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) {
          if (req.method === 'GET') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) {
              const entries = [...initialPrompts.entries()]
                .map(([entryKey, entry]) => ({
                  key: entryKey,
                  chars: entry.text.length,
                  createdAt: entry.createdAt || 0,
                  updatedAt: entry.updatedAt || 0,
                  preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
                }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
              sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptsWritable });
              return;
            }
            const canonical = canonicalV2Key(key);
            if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const entry = initialPrompts.get(canonical) ?? null;
            sendJson({
              ok: true,
              key: canonical,
              exists: !!entry,
              text: entry?.text ?? '',
              createdAt: entry?.createdAt || 0,
              updatedAt: entry?.updatedAt || 0,
              maxChars: initialPromptMaxChars(),
              writable: initialPromptsWritable
            });
            return;
          }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const explicitDelete = body.delete === true;
          // 只接受 { key, text: string } 或 { key, delete: true }：
          // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
          if (!explicitDelete && typeof body.text !== 'string') {
            sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
            return;
          }
          const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
          if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
          log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
          sendJson({
            ok: true,
            key: result.key,
            deleted: result.deleted,
            chars: result.chars,
            exists: !!result.entry,
            updatedAt: result.entry?.updatedAt || 0,
            maxChars: initialPromptMaxChars()
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
          // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
          const sendGuard = captureSendGuard(key);
          try {
            sendGuard();
            if (shouldBlockSilentReply(key)) {
              const blocked = new Error('静默模式已开启，当前不允许拍一拍');
              blocked.statusCode = 403;
              throw blocked;
            }
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 语音试听（DSH 设置里点「试听」触发）─────────────────────────────
        // 只合成、不发送：把本地文件路径交回去，由 DSH 插件读出来在浏览器里播。
        // 走操作者通道（控制台令牌），不消耗每日语音额度。
        if (req.method === 'POST' && url.pathname === '/api/voice/preview') {
          try {
            const body = await readBody();
            const previewText = String(body.text ?? '').trim().slice(0, 200);
            if (previewText === '') { sendJson({ ok: false, error: '文本为空' }, 400); return; }
            const tts = await ttsSynthesizeV2(previewText, {
              rate: Number(body.rate) || 0,
              voiceName: String(body.voice ?? '')
            });
            sendJson({ ok: true, path: tts.path, engine: tts.engine, cached: tts.cached === true, text: tts.text });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }

        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          try {
            voiceBudgetCheck('operator:cli', voice);
            const sent = await sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit('operator:cli', now);
            log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/breakdown-recover') {
          const body = await readBody();
          const key = String(body.key || '');
          const lvl = Math.max(1, Math.min(3, Number(body.level) || 1));
          if (!key) { sendJson({ ok: false, error: '缺少 key' }, 400); return; }
          const bd = breakdownState.get(key);
          if (!bd || Date.now() - bd.at > 6 * 3600_000) {
            sendJson({ ok: false, error: '没有正在进行的破防' }, 400);
            return;
          }
          breakdownState.delete(key);
          const stressCut = 30 + lvl * 10;       // -40 / -50 / -60
          addStress(key, -stressCut);
          const ownerId = String(cfg.ownerQQ || '');
          let gained = { affection: 0, love: 0 };
          try {
            const af = loadAffinity();
            af.people = af.people || {};
            const p = af.people[ownerId] || (af.people[ownerId] = { score: 0, count: 0, name: '老大' });
            gained.affection = Math.min(100, (Number(p.score) || 0) + 8 * lvl) - (Number(p.score) || 0);
            p.score = Math.min(100, (Number(p.score) || 0) + 8 * lvl);
            gained.love = Math.min(100, (Number(p.love) || 0) + 3 * lvl) - (Number(p.love) || 0);
            p.love = Math.min(100, (Number(p.love) || 0) + 3 * lvl);
            p.lastAt = Date.now();
            saveAffinity();
          } catch {}
          sendJson({ ok: true, key, level: lvl, stress: getStress(key), stressCut, gained });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/meme-learn') {
          const body = await readBody();
          try {
            const row = upsertUserMeme({
              title: body.title,
              meaning: body.meaning,
              usage: body.usage,
              origin: body.origin,
              tags: body.tags,
              by: body.by
            });
            sendJson({ ok: true, row, text: memeFormat(row) });
          } catch (e) {
            sendJson({ ok: false, error: e?.message ?? String(e) }, 400);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/meme') {
          const body = await readBody();
          const term = String(body.term || '').trim();
          if (!term) { sendJson({ ok: false, error: '缺少 term' }, 400); return; }
          let row = memeSearchLocal(term);
          let source = row ? 'local' : '';
          if (!row) { row = await memeSearchRemote(term); source = row ? 'remote' : ''; }
          sendJson({ ok: true, term, found: !!row, source, text: memeFormat(row) });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/open-panel') {
          try {
            // 已经有面板窗口：只把它提到最前，不再叠一个新的
            const pst = focusExistingWindow([]);
            if (pst === 'ok') {
              log('[panel] 已有全屏面板窗口，已提到最前');
              res.writeHead(204, { 'cache-control': 'no-store' });
              res.end();
              return;
            }
            if (pst === 'stale') {
              log('[panel] 旧窗口不是全屏，已关闭，重开一个全屏窗口');
              await new Promise((r) => setTimeout(r, 800));
            }
            if (pst === 'focusfail') {
              log('[panel] 抢不到前台（DSH 占着），关掉重开一个');
              closeAppWindow(false);
              await new Promise((r) => setTimeout(r, 900));
            }
            const t = loadOrCreateConsoleToken();
            // 每次主动打开面板播放开场；自动刷新不重播。
            const url = 'http://127.0.0.1:' + (cfg.port || 3100) + '/dashboard?intro=1&token=' + encodeURIComponent(t);
            const candidates = [
              'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            ];
            const exe = candidates.find(function (p) { return fs.existsSync(p); });
            if (exe) {
              const profileDir = path.join(STATE_DIR, 'edge-app-profile');
              fs.mkdirSync(profileDir, { recursive: true });
              spawn(exe, ['--app=' + url, '--start-fullscreen', '--user-data-dir=' + profileDir], {
                detached: true, stdio: 'ignore', windowsHide: false
              }).unref();
              applyTopmostSoon(false);
              log('[panel] 已拉起独立面板窗口');
              res.writeHead(204, { 'cache-control': 'no-store' });
              res.end();
            } else {
              res.writeHead(302, { location: url });
              res.end();
            }
          } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('open panel failed: ' + (e && e.message ? e.message : e));
          }
          return;
        }

        // ── 面板窗口：退出全屏 / 关闭（全屏没有标题栏，得给个按的地方）──────────
        if (req.method === 'GET' && (url.pathname === '/panel-exit' || url.pathname === '/panel-close')) {
          const star = url.searchParams.get('star') === '1';
          const isClose = url.pathname === '/panel-close';
          try {
            execFileSync('powershell', [
              '-NoProfile', '-ExecutionPolicy', 'Bypass',
              '-File', path.join(ROOT, 'scripts', 'focus-panel.ps1'),
              ...(isClose ? ['-Close'] : ['-Unfullscreen']),
              ...(star ? ['-Star'] : [])
            ], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
            log(isClose ? '[panel] 已关闭面板窗口' : '[panel] 已退出全屏');
          } catch (error) {
            log(`[panel] ${isClose ? '关闭' : '退出全屏'}失败：${error?.message ?? error}`);
          }
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          return;
        }

        // ── 一键对接（DSH 内按钮）────────────────────────────────────────────
        // 等价于桌面上的「一键开启QQ对接」快捷方式：跑 scripts/autostart.mjs
        // （检查 DSH/QQ/SnowLuma → 对齐端口 → 重启桥接 → 确保看门狗）。
        // 那个脚本会杀掉本进程，所以先回响应、再延迟 2 秒拉起它。
        if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/oneclick') {
          // 诊断日志：把浏览器实际发过来的头记下来（排查「按钮点了没反应」时唯一的线索）。
          log(`[oneclick] 请求 method=${req.method} site=${req.headers['sec-fetch-site'] || '-'} `
            + `origin=${req.headers.origin || '-'} ref=${String(req.headers.referer || '-').slice(0, 60)} `
            + `ua=${String(req.headers['user-agent'] || '-').slice(0, 40)}`);
          const nowMs = Date.now();
          if (nowMs - lastOneclickAt < 20000) {
            sendJson({ ok: true, already: true, message: '对接已经在进行中了' });
            return;
          }
          lastOneclickAt = nowMs;
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          log('[oneclick] 收到一键对接请求：2 秒后对齐端口并重启桥接');
          setTimeout(() => {
            // 关键：**不能**直接 spawn autostart —— 桥接自己是 DSH 的子进程（或者
            // 是上一次从 DSH 里拉起来的），孩子会被 DSH 的 job 对象一起杀掉，
            // 于是每次 DSH 重启后桥接就再也不回来。改由计划任务（独立进程树）拉起，
            // 这样重启出来的桥接不再挂在 DSH 底下，下次 DSH 重启它就能活下来。
            const fallback = (why) => {
              log(`[oneclick] 计划任务拉起失败（${why}），回退直接 spawn autostart`);
              try {
                spawn(process.execPath, [path.join(ROOT, 'scripts', 'autostart.mjs')], {
                  cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true
                }).unref();
              } catch (error) {
                log('[oneclick] 回退拉起 autostart 也失败:', error?.message ?? error);
              }
            };
            try {
              const runner = spawn('schtasks.exe', ['/run', '/tn', 'QQBridgeAlign'], {
                windowsHide: true, stdio: 'ignore'
              });
              runner.on('exit', (code) => {
                if (code === 0) log('[oneclick] 已通过计划任务 QQBridgeAlign 拉起对接');
                else fallback(`schtasks exit ${code}`);
              });
              runner.on('error', (error) => fallback(error?.message ?? error));
            } catch (error) {
              fallback(error?.message ?? error);
            }
          }, 2000);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/panel') {
          const t = loadOrCreateConsoleToken();
          res.writeHead(302, { location: '/dashboard?token=' + encodeURIComponent(t), 'cache-control': 'no-store' });
          res.end();
          return;
        }
        // ── 诊断（「对接」按钮等超过 35 秒时来问一句：到底哪里没开）───────────
        // 只读，允许跨域：页面在 DSH 的端口上，不加 CORS 就读不到这个 JSON。
        // 这里只说「该怎么办」，不返回任何凭据/路径。
        if (req.method === 'GET' && url.pathname === '/diag') {
          try {
            const [snow, ob1, ob2] = await Promise.all([tcpPortOpen(5099), tcpPortOpen(3000), tcpPortOpen(3001)]);
            let qq = false;
            try {
              const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], {
                encoding: 'utf8', windowsHide: true, timeout: 2500
              });
              qq = /QQ\.exe/i.test(out);
            } catch {}
            let note;
            if (!qq) note = 'QQ 没打开 —— 手动开一下 QQ';
            else if (!snow) note = 'SnowLuma 没在跑 —— 打开 http://127.0.0.1:5099 注入一次';
            else if (!(ob1 && ob2)) note = 'OneBot 没起来（3000/3001）—— QQ 可能没登录';
            else if (!dshReady) note = 'DSH 侧没连上 —— 桥接连不到当前 DSH 端口';
            else note = '服务都正常，只是这次重启比平时慢，再等等';
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'access-control-allow-origin': '*',
              'cache-control': 'no-store'
            });
            res.end(JSON.stringify({ bridge: true, qq, snowluma: snow, onebot: ob1 && ob2, dsh: !!dshReady, note }));
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('diag failed: ' + (error?.message ?? error));
          }
          return;
        }

        // 前端「接通检测」信标：1x1 gif，no-store。
        // 浏览器用 new Image() 打它 —— onload=桥接活着，onerror=没接上。
        // 不走 /media/（那里是文件读取），也不许缓存，否则检测结果永远是上一次的。
        if (req.method === 'GET' && url.pathname === '/ping') {
          res.writeHead(200, {
            'content-type': 'image/gif',
            'cache-control': 'no-store, no-cache, must-revalidate'
            // 不写 content-length：让它按实际 buffer 长度算（写死 43 与 42 字节不符，
            // Chromium 会以 ERR_CONTENT_LENGTH_MISMATCH 判图片加载失败 → 信标永远探测失败）
          });
          res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
          const rel = decodeURIComponent(url.pathname.slice('/media/'.length)).replace(/\.\./g, '');
          const file = path.join(ROOT, 'public', rel);
          if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) {
            sendJson({ ok: false, error: 'not found' }, 404);
            return;
          }
          const ext = path.extname(file).toLowerCase();
          const MIME = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
            '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.json': 'application/json',
            // three.module.min.js 走这个分支；缺了 .js 会以 octet-stream 返回，浏览器会拒绝执行 module。
            '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8'
          };
          const type = MIME[ext] || 'application/octet-stream';
          // 面板每 60 秒整页重载一次。原来这里是 no-cache 且没有 ETag，
          // 等于每分钟把几百 KB 的图片重新下一遍 —— 重载时肉眼可见地卡一下。
          // 现在带 ETag + 客户端缓存，重载命中 304，几乎不花时间。
          let stat = null;
          try { stat = fs.statSync(file); } catch {}
          const etag = stat ? '"' + stat.mtimeMs.toString(36) + '-' + stat.size.toString(36) + '"' : '';
          if (etag && req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'public, max-age=600' });
            res.end();
            return;
          }
          const buf = fs.readFileSync(file);
          res.writeHead(200, {
            'content-type': type,
            'cache-control': 'public, max-age=600',
            ...(etag ? { etag } : {}),
            'content-length': buf.length
          });
          res.end(buf);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/offense') {
          const body = await readBody();
          const key = String(body.key || '');
          const uid = String(body.userId || '');
          const name = String(body.name || '');
          const text = String(body.text || '');
          if (!key || !uid) { sendJson({ ok: false, error: '缺少 key/userId' }, 400); return; }
          const rec = noteOffense(key, uid, name, text, true);
          sendJson({ ok: true, recorded: rec });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/say') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('say')) { sendJson({ ok: false, error: '工具未启用：qq_say' }, 403); return; }
          try {
            const vc = voiceCfg();
            if (!vc.enabled) { sendJson({ ok: false, error: '语音功能已关闭（socialV2.voice.enabled=false）' }, 403); return; }
            // 他在打游戏：语音一律不发（缓存里的也不发），直接让她打字
            if (vc.gameGuard !== false) {
              const warmNow = await tcpPortOpen(indexttsPort());
              const freeNow = gpuFreeMiB();
              if (freeNow !== null && !warmNow && freeNow < vc.gameGuardMinFreeMb) {
                log(`[voice] 游戏保护：剩 ${freeNow} MB，跳过整条语音（${key}）`);
                sendJson({ ok: false, code: 'VOICE_GPU_BUSY', error: '现在显卡被占着（可能开着游戏），这条不发语音，直接用文字回她就好' }, 429);
                return;
              }
            }
            // 每日语音额度：避免她一直发语音
            const dayKey = new Date().toISOString().slice(0, 10);
            let voiceDb = {};
            try { voiceDb = readJsonSafe(path.join(STATE_DIR, 'voice-count.json'), {}) || {}; } catch {}
            // 连续语音限制：3 分钟内最多 2 条，避免她一直说、对话不流畅
            const nowMs = Date.now();
            const recentKey = key + '|recent';
            const recent = (Array.isArray(voiceDb[recentKey]) ? voiceDb[recentKey] : []).filter((t) => nowMs - Number(t) < 3 * 60 * 1000);
            if (recent.length >= 2) {
              sendJson({ ok: false, error: '刚才已经连发两条语音了，先用文字接话，过几分钟再发语音' }, 429);
              return;
            }
            const cnt = Number(voiceDb[dayKey]?.[key]) || 0;
            const cap = Number(cfg.socialV2?.voice?.dailyCap) || 6;
            if (cnt >= cap) {
              sendJson({ ok: false, error: `今天这个会话的语音额度用完了（${cap} 条/天），改用文字吧` }, 429);
              return;
            }
            const emotion = String(body.emotion || '');
            const tts = await ttsSynthesizeV2(body.text, { rate: Number(body.rate) || 0, voiceName: String(body.voice || ''), emotion, lang: 'zh' });
            let finalRef = tts.ref;
            let bilingual = null;
            if (body.text_ja && String(body.text_ja).trim()) {
              const ja = await ttsSynthesizeV2(String(body.text_ja), { emotion, lang: 'ja' });
              const vcNow = voiceCfg();
              const sil = path.join(vcNow.dir, 'tts', 'silence-0.4s.wav');
              if (!fs.existsSync(sil)) {
                const ff = fs.existsSync(path.join(ROOT, '..', 'tts', 'bin', 'ffmpeg.exe'))
                  ? path.join(ROOT, '..', 'tts', 'bin', 'ffmpeg.exe') : 'ffmpeg';
                await new Promise((resolve, reject) => {
                  const child = spawn(ff, ['-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '0.4', '-y', sil], { windowsHide: true });
                  child.on('error', reject);
                  child.on('close', (code) => code === 0 ? resolve() : reject(new Error('静音生成失败')));
                });
              }
              const mergedName = `${path.basename(tts.ref, '.wav')}_ja.wav`;
              const mergedPath = path.join(vcNow.dir, 'tts', mergedName);
              await concatWavV2([tts.path, sil, ja.path], mergedPath);
              finalRef = `tts/${mergedName}`;
              bilingual = { zh: tts.text, ja: ja.text };
            }
            const sent = await sendVoiceForV2(key, finalRef, { label: String(body.label || 'TTS'), readback: body.readback === true });
            try {
              voiceDb[dayKey] = voiceDb[dayKey] || {};
              voiceDb[dayKey][key] = (Number(voiceDb[dayKey][key]) || 0) + 1;
              const rk = key + '|recent';
              const arr = (Array.isArray(voiceDb[rk]) ? voiceDb[rk] : []).filter((t) => Date.now() - Number(t) < 10 * 60 * 1000);
              arr.push(Date.now());
              voiceDb[rk] = arr;
              atomicWriteJson(path.join(STATE_DIR, 'voice-count.json'), voiceDb);
            } catch {}
            sendJson({ ok: true, key, text: tts.text, file: finalRef, bilingual, messageId: sent.messageId ?? null, verification: sent.verification ?? null });
          } catch (error) {
            // 显存被占（多半在打游戏）：不当作失败，告诉她改用文字就行
            const busy = error?.code === 'VOICE_GPU_BUSY';
            if (busy) {
              log(`[voice] 跳过语音（显存占用）：剩 ${error.freeMb ?? '?'} MB，${
                (cfg.socialV2?.voice?.gameGuard ?? true) ? '游戏保护已开' : 'game guard off'}`);
              sendJson({ ok: false, code: 'VOICE_GPU_BUSY', error: '现在显卡在忙（可能开着游戏），这条不发语音，直接用文字回她就好' }, 429);
              return;
            }
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: stickerStoreWritable });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
          // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          const leaseKey = canonicalV2Key(key) ?? key;
          if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          const leaseStamp = Date.now();
          activeWaits.set(leaseKey, leaseStamp);
          // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
          const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
          req.on('close', finishWait);
          // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
          // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          // 非 reply 分支（等新消息 / 沉睡前观察）的静默窗口另设更紧的上限：
          // 她经常传 quietMs=60000，于是每句话都要陪等一分钟才回，群里就是「问了不回」。
          // 要判断「对方说完没」该用 purpose="reply"，别拿长静默把整个回合占住。
          const maxQuietAfterNewMs = Math.max(1000, Math.min(60000, Number(waitCfg.maxQuietAfterNewMs) || 15000));
          const quietMs = replyWait
            ? Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0))
            : Math.min(maxQuietAfterNewMs, Math.max(0, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          // 有人 @ 她 / 点名叫她提问 → 不等静默立刻返回。以前 20~300 秒的等待里
          // 进来一句「@小鲸鱼 还有别的书吗」，要等满 quietMs（她常传 60 秒）才回，
          // 看起来就是「问了不回，等到下一轮」。
          const directedSince = (since) => {
            const pool = [
              ...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])
            ];
            return pool.some((m) => m && !m.isSelf && Number(m.seq) > since
              && addressesAiDirectly(String(m.plain || m.text || '')));
          };
          const start = Date.now();
          let arrived = false;
          let directed = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              if (directedSince(baseline)) { directed = true; break; }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            if (directedSince(baseline)) directed = true;
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 有人直接点名/问她：不用陪等静默，马上交给她回。
              if (directedSince(baseline)) { directed = true; break; }
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                if (directedSince(baseline)) { directed = true; break; }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            // 有人直接点名/问她 → 不必再等静默，直接回即可。
            directed,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet || directed,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // 只有「还没满足」时才给剩余时间；满足后还给会诱导模型无限续等。
            ...(!replyWait && !preSleepSatisfiedNow && !st.preSleepWaitObservedAt ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages: withAgeLabels(newMessages),
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            // 必须命中**已有**条目（own property）：否则任意 target 都能凭空建一条，
            // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
            // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
            if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
              sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
              return;
            }
            const im = st.memberImpressions[oldTarget];
            const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
            // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧，
            // 否则 memory-update 能无限塞名字（每次 1MB 请求 → 状态文件与每轮 prompt 一起膨胀）。
            const impressionEntries = Object.entries(st.memberImpressions);
            if (impressionEntries.length > 50) {
              impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
              for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
            }
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 跨会话长期记忆（reserved2）：AI 自主记录/查询/删除 ────────────────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/global-memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          const tags = Array.isArray(body.tags) ? body.tags : [];
          if (!key || !text) { sendJson({ ok: false, error: 'key/text 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('remember')) { sendJson({ ok: false, error: '工具未启用：qq_remember' }, 403); return; }
          try {
            const entry = globalMemoryAppend({ text, tags, key, tier: body.tier, ttlDays: body.ttlDays });
            sendJson({ ok: true, entry, total: loadGlobalMemory().entries.length });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/global-memory-query') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('recall')) { sendJson({ ok: false, error: '工具未启用：qq_recall' }, 403); return; }
          const result = globalMemoryQuery({ query: body.query, limit: body.limit, tier: body.tier });
          sendJson({ ok: true, ...result });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/global-memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('forget')) { sendJson({ ok: false, error: '工具未启用：qq_forget' }, 403); return; }
          try {
            const result = globalMemoryRemove({ id: body.id, text: body.text });
            sendJson({ ok: true, ...result });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        // ── AI 自主换新会话（交接）：先写摘要进长期记忆，再退役当前会话 ──────────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/new-session') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const summary = String(body.summary ?? '').trim();
          if (!key || !summary) { sendJson({ ok: false, error: 'key/summary 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('newSession')) { sendJson({ ok: false, error: '工具未启用：qq_new_session' }, 403); return; }
          const last = Number(sessionRotateTimes.get(key)) || 0;
          if (Date.now() - last < 30 * 60 * 1000) {
            sendJson({ ok: false, error: '刚换过会话，30 分钟内不要连续换' }, 429);
            return;
          }
          sessionRotateTimes.set(key, Date.now());
          try {
            const old = await rotateConversationForHandover(key, summary.slice(0, 800), String(body.dossier ?? '').slice(0, 8000));
            sendJson({ ok: true, key, oldSessionId: old, note: '摘要已写入长期记忆；交接文档已保存；下一条消息会开新会话，摘要和交接文档都会注入' });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 交接文档（可以单独写/更新，不一定要立刻换会话）────────────────────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/handover') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const content = String(body.content ?? '').trim();
          if (!key || !content) { sendJson({ ok: false, error: 'key/content 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('handover')) { sendJson({ ok: false, error: '工具未启用：qq_handover' }, 403); return; }
          try {
            const saved = saveHandover(key, content);
            sendJson({ ok: true, key, ...saved });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/handover') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          sendJson({ ok: true, key, content: loadHandover(key) });
          return;
        }
        // ── 余额（AI 自己看「饭量」）──────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/balance') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('balance')) { sendJson({ ok: false, error: '工具未启用：qq_balance' }, 403); return; }
          const bal = await fetchDeepseekBalance();
          sendJson({
            ok: true,
            balance: bal,
            threshold: Number(cfg.deepseekBalance?.lowThreshold) || 5,
            note: bal ? null : '读不到余额（没有可用 API key，或接口暂时失败）'
          });
          return;
        }
        // ── 群文件（只读）：列表 + 下载文本/图片 ──────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-files') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const folderId = String(url.searchParams.get('folderId') ?? '').trim();
          const gm = /^group:(\d+)$/.exec(key);
          if (!gm) { sendJson({ ok: false, error: '群文件只支持 group:群号 形式的 key' }, 400); return; }
          const groupId = Number(gm[1]);
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key) || !allowed('group', groupId, cfg)) { sendJson({ ok: false, error: '该群不在白名单内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_group_files' }, 403); return; }
          try {
            const [sys, listing] = await Promise.all([
              onebotCall('get_group_file_system_info', { group_id: groupId }).catch(() => null),
              folderId
                ? onebotCall('get_group_files_by_folder', { group_id: groupId, folder_id: folderId })
                : onebotCall('get_group_root_files', { group_id: groupId })
            ]);
            const files = (listing?.files || []).map((f) => ({
              fileId: f.file_id,
              name: f.file_name,
              size: f.file_size,
              busid: f.busid,
              uploader: f.uploader_name || String(f.uploader ?? ''),
              uploadTime: f.upload_time ? new Date(Number(f.upload_time) * 1000).toISOString() : null,
              downloadTimes: f.download_times
            }));
            const folders = (listing?.folders || []).map((f) => ({ folderId: f.folder_id, name: f.folder_name, totalFiles: f.total_files }));
            sendJson({
              ok: true, key, folderId: folderId || null,
              system: sys ? { fileCount: sys.file_count, limit: sys.limit_count, totalSpace: sys.total_space } : null,
              files, folders
            });
          } catch (error) {
            sendJson({ ok: false, error: `列群文件失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-file') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const fileId = String(url.searchParams.get('fileId') ?? '').trim();
          const busid = Number(url.searchParams.get('busid')) || 102;
          const sizeHint = Number(url.searchParams.get('size')) || 0;
          const gm = /^group:(\d+)$/.exec(key);
          if (!gm) { sendJson({ ok: false, error: '群文件只支持 group:群号 形式的 key' }, 400); return; }
          if (!fileId) { sendJson({ ok: false, error: 'fileId 不能为空' }, 400); return; }
          const groupId = Number(gm[1]);
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key) || !allowed('group', groupId, cfg)) { sendJson({ ok: false, error: '该群不在白名单内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('groupFiles')) { sendJson({ ok: false, error: '工具未启用：qq_group_file_read' }, 403); return; }
          try {
            const link = await onebotCall('get_group_file_url', { group_id: groupId, file_id: fileId, busid });
            const fileUrl = link?.url;
            if (!fileUrl) throw new Error('没拿到下载地址');
            const MAX_FILE_BYTES = 8 * 1024 * 1024;
            if (sizeHint > MAX_FILE_BYTES) {
              sendJson({ ok: true, key, kind: 'binary', size: sizeHint, note: '文件太大（超过 8MB 上限），只能看文件信息，读不了内容' });
              return;
            }
            const fetched = await safeFetchBuffer(fileUrl, MAX_FILE_BYTES);
            const buf = fetched.buffer;
            if (looksLikeImageBuffer(buf)) {
              sendJson({ ok: true, key, kind: 'image', size: buf.length, mimeType: imageMimeFromBuffer(buf), base64: buf.toString('base64') });
              return;
            }
            if (buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) {
              sendJson({ ok: true, key, kind: 'binary', size: buf.length, note: '二进制文件，只能看大小，读不了内容' });
              return;
            }
            const text = buf.toString('utf8');
            sendJson({ ok: true, key, kind: 'text', size: buf.length, text: text.slice(0, 20000), truncated: text.length > 20000 });
          } catch (error) {
            const msg = error?.message ?? String(error);
            const friendly = /大小限制|too large|maxBytes/i.test(msg)
              ? '文件太大（超过 8MB 上限），只能看文件信息'
              : `读取群文件失败：${msg}`;
            sendJson({ ok: false, error: friendly }, 500);
          }
          return;
        }
        // ── 心情 / 好感度 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/mood') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('mood')) { sendJson({ ok: false, error: '工具未启用：qq_mood' }, 403); return; }
          sendJson({ ok: true, key, mood: getMood(key), longMood: getLongMood(key), available: MOOD_EMOTIONS });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mood') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('mood')) { sendJson({ ok: false, error: '工具未启用：qq_mood' }, 403); return; }
          try {
            const mood = setMood(key, { emotion: body.emotion, intensity: body.intensity, reason: body.reason, term: body.term });
            sendJson({ ok: true, key, mood, longMood: getLongMood(key) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/affinity') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('affinity')) { sendJson({ ok: false, error: '工具未启用：qq_affinity' }, 403); return; }
          sendJson({ ok: true, key, people: affinityRowsFor(key) });
          return;
        }
        // 好感度手动调整：她可以主观扣分（被阴阳、被忽视、被恶心到），也可以加回分。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/affinity-adjust') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !target) { sendJson({ ok: false, error: 'key/target 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('affinity')) { sendJson({ ok: false, error: '工具未启用：qq_affinity' }, 403); return; }
          try {
            const result = adjustAffinity(target, body.name, body.delta, body.reason);
            sendJson({ ok: true, key, ...result });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        // 仅管理端自检：模拟一条「某人发来的消息」，验证好感度累计（不影响 QQ）。
        if (req.method === 'POST' && url.pathname === '/api/debug/affinity-bump') {
          const body = await readBody();
          const userId = String(body.userId ?? '').trim();
          if (!userId) { sendJson({ ok: false, error: 'userId 不能为空' }, 400); return; }
          try {
            bumpAffinity(userId, body.name, body.key || '', body.text || '');
            sendJson({ ok: true, people: affinityRowsFor(body.key || ''), entry: loadAffinity().people[userId] ?? null });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/cold-check') {
          // 仅管理端：立刻跑一次「冷漠扣分」检查（测试用）。
          try {
            const changed = applyColdPenalty();
            const recovered = expireDiscipline();
            sendJson({ ok: true, changed, recovered });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/offense') {
          // 仅管理端：模拟一条冒犯消息，验证纪律分级（不动 QQ）。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const uid = String(body.userId ?? '').trim();
          if (!key || !uid) { sendJson({ ok: false, error: 'key/userId 不能为空' }, 400); return; }
          try {
            const r = noteOffense(key, uid, body.name, body.text);
            sendJson({ ok: true, result: r, line: disciplineLineFor(key).trim() });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/events') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('events')) { sendJson({ ok: false, error: '工具未启用：qq_events' }, 403); return; }
          const q = String(url.searchParams.get('q') ?? '');
          const kind = String(url.searchParams.get('kind') ?? '');
          const limit = Number(url.searchParams.get('limit')) || 15;
          sendJson({ ok: true, key, items: queryEvents({ query: q, kind, key, limit }) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/events') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('events')) { sendJson({ ok: false, error: '工具未启用：qq_events' }, 403); return; }
          try {
            const ev = addEvent({ key, kind: body.kind, who: body.who, what: body.what, importance: body.importance });
            if (!ev) { sendJson({ ok: false, error: 'what 不能为空' }, 400); return; }
            sendJson({ ok: true, event: ev });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/transcript') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('transcript')) { sendJson({ ok: false, error: '工具未启用：qq_transcript' }, 403); return; }
          const days = Math.min(14, Math.max(1, Number(url.searchParams.get('days')) || 1));
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40));
          const rows = readTranscript(key, { days, limit });
          sendJson({ ok: true, key, days, limit, count: rows.length, rows, notes: loadTrNotes(key) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/transcript/note') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('transcript')) { sendJson({ ok: false, error: '工具未启用：qq_transcript' }, 403); return; }
          const note = addTrNote(key, { refAt: body.refAt, refText: body.refText, note: body.note });
          if (!note) { sendJson({ ok: false, error: '批注失败' }, 400); return; }
          sendJson({ ok: true, note });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/debug/care') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          sendJson({ ok: true, key, line: careLineFor(key).trim() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/love-check') {
          // 仅管理端：测试「提到喜爱对象」时的警觉/吃醋/生气联动。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const uid = String(body.userId ?? '').trim();
          if (!key || !uid) { sendJson({ ok: false, error: 'key/userId 不能为空' }, 400); return; }
          try {
            const kind = checkLoveDynamics(key, uid, body.name, body.text);
            sendJson({ ok: true, kind, top: loveTop(), mood: getMood(key) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/stress') {
          // 仅管理端：调整/查看压力值（测试用）。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (typeof body.delta === 'number') addStress(key, body.delta);
          sendJson({ ok: true, key, stress: getStress(key), line: stressLineFor(key).trim() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/romance') {
          const body = await readBody();
          const key = String(body.key || '');
          noteRomance(key, body.uid, body.name || '', String(body.text || ''));
          const st = getSocialV2State(key);
          sendJson({ ok: true, shyUntil: st.shyUntil || 0, jealousUntil: st.jealousUntil || 0, confessCount: st.confessCount || 0, confessUrgeAt: st.confessUrgeAt || 0, line: shyLineFor(key).trim() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/breakdown') {
          const body = await readBody();
          const key = String(body.key || '');
          await maybeBreakdown(key, true, body.dry === true);
          sendJson({ ok: true, key, active: breakdownState.has(key) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/comfort') {
          // 仅管理端：模拟一句安慰，验证压力恢复（测试用）。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          noteComfort(key, String(body.text ?? '没事的，别累着'), String(body.uid ?? ''), String(body.name ?? ''));
          sendJson({ ok: true, key, stress: getStress(key) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/vent') {
          // 仅管理端：模拟她倾诉一句（挂起，等安慰才扣）。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          noteVent(key, String(body.text ?? '今天有点累'));
          sendJson({ ok: true, key, stress: getStress(key) });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/debug/talk') {
          // 仅管理端：模拟一条对话，用来验证「最近谈」滚动记忆。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          recordTalk(key, body.who, body.text, body.self === true);
          sendJson({ ok: true, key, n: talkCounters.get(key) || 0 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/debug/mood-line') {
          // 仅管理端：预览某个会话当前会注入的心情描述（长期+短期怎么叠加）。
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          sendJson({ ok: true, key, short: getMood(key), long: getLongMood(key), line: moodLineFor(key).trim() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/space/state') {
          // 她的家（/space）页面每 3 秒取一次：她此刻在哪个房间 + 房间布局。
          // 只读，且必须带控制台令牌（和 /api/debug/space 一样走管理端）。
          const st = readSpaceState(path.join(STATE_DIR, 'space.json'));
          let rooms = null;
          try { rooms = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'space', 'rooms.json'), 'utf8')); } catch {}
          // 她手上那本书：取「最近读过的那本」，来源是 dsh-reading 写的 progress.json
          sendJson({ ok: true, state: st, rooms, book: readingBookForSpace(), books: readingBooksForSpace() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/reading-wake') {
          // 仅管理端：立刻让她去读书一次（不等 1~3 小时的主动检查）
          const body = await readBody();
          const key = String(body.key || `private:${cfg.ownerQQ || ''}`).trim();
          if (!key) { sendJson({ ok: false, error: '没有可用的会话 key（先配 ownerQQ）' }, 400); return; }
          const rd = readingForSpace();
          if (!rd || !rd.book) { sendJson({ ok: false, error: '书架里没有在读的书' }, 400); return; }
          const st = getSocialV2State(key);
          st.lastReadingWakeAt = Date.now();
          sendWakePromptV2(key, 'reading').catch((error) => log('[reading] 手动唤醒失败：' + (error?.message ?? error)));
          log('[reading] 手动触发一次读书唤醒 ' + key);
          sendJson({ ok: true, key, book: rd.book.title, chapter: rd.book.chapter });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/space-tick') {
          // 仅管理端：立刻跑一次「她自己的作息」判断，不用等 40 分钟。
          if (!spaceAutonomy || typeof spaceAutonomy.tick !== 'function') {
            sendJson({ ok: false, error: '自主走动没启动（看日志里的 [space]）' }, 503);
            return;
          }
          const before = readSpaceState(path.join(STATE_DIR, 'space.json'));
          spaceAutonomy.tick();
          const after = readSpaceState(path.join(STATE_DIR, 'space.json'));
          sendJson({
            ok: true,
            moved: !!before && !!after && before.place !== after.place,
            from: before?.place ?? null,
            to: after?.place ?? null,
            state: after
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/debug/space') {
          // 仅管理端：看空间状态现在是什么、她下一轮唤醒会读到哪一行（不调模型，纯读文件）。
          const st = readSpaceState(path.join(STATE_DIR, 'space.json'));
          sendJson({ ok: true, state: st, line: spaceLineFor(st).trim() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/reading/state') {
          const r = readingForSpace();
          sendJson({
            ok: true,
            book: r.book,
            books: r.books,
            notes: r.book ? readingNotesFor(r.book.id) : [],
            line: readingLineFor().trim()
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/reading/read') {
          // 她读下一段：按 progress 里记住的位置往后取，读完自动推进/翻章
          const chars = Math.min(6000, Math.max(400, Number(url.searchParams.get('chars')) || 2600));
          const next = readingReadNext(chars);
          if (!next) { sendJson({ ok: false, error: '现在没有在读的书' }, 400); return; }
          sendJson({ ok: true, ...next });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reading/note') {
          // 她自己往正在读的那本书上写一句批注（qq_reading_note）。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('reading')) { sendJson({ ok: false, error: '工具未启用：qq_reading_note' }, 403); return; }
          const r = readingForSpace();
          if (!r.book || !r.book.id) { sendJson({ ok: false, error: '现在没有在读的书（书架上还没有记录）' }, 400); return; }
          const text = String(body.text ?? '').trim().slice(0, 500);
          const quote = String(body.quote ?? '').trim().slice(0, 200);
          const share = body.share === true;
          if (!text && !quote) { sendJson({ ok: false, error: '批注内容是空的' }, 400); return; }
          try {
            const file = path.join(process.env.USERPROFILE || '', '.dsh', 'reading', 'state', 'notes.json');
            let notes = [];
            try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(raw)) notes = raw; } catch {}
            const item = {
              id: crypto.createHash('sha1').update(`${r.book.id}:${Date.now()}:${text}`).digest('hex').slice(0, 10),
              bookId: r.book.id,
              bookTitle: r.book.title,
              chapter: Number(r.book.chapter) || 0,
              chapterTitle: '',
              quote,
              note: text,
              by: 'her',
              shared: share,
              at: Date.now()
            };
            notes.push(item);
            atomicWriteJson(file, notes);
            log(`[reading] 记了一条批注：《${r.book.title}》${text.slice(0, 20)}${share ? '（转发给主人）' : ''}`);
            // 只有她自己选了 share 的批注才转给主人；不选就只留在书里。
            if (share && cfg.socialV2?.reading?.notifyOwner !== false && cfg.ownerQQ) {
              try {
                const said = (quote ? `「${quote}」` : '') + (text ? `—— ${text}` : '');
                void sendToQQ(`private:${cfg.ownerQQ}`, `【批注】《${r.book.title}》第 ${(r.book.chapter || 0) + 1} 章 ${said}`.slice(0, 300));
              } catch (notifyError) {
                log('[reading] 批注通知没发出去：' + (notifyError?.message ?? notifyError));
              }
            }
            sendJson({ ok: true, note: item });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/space/move') {
          // 她自己换地方（qq_space_go）——**唯一**能在运行时改 state/space.json 的入口。
          // 写了就是真的换了地方：下次唤醒的【所在】、以及 /space 画面都会跟着变。
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('space')) { sendJson({ ok: false, error: '工具未启用：qq_space_go' }, 403); return; }
          // 地方必须在房间表里（label 或别名都行），并规范化成 label ——
          // 她说「沙发」，存的是「客厅」；以后改别名也不会让历史状态对不上。
          const index = loadRoomIndex(path.join(ROOT, 'public', 'space', 'rooms.json'));
          const hit = resolvePlace(index, body.place);
          if (!hit) {
            const names = [...new Set([...index.values()].map((r) => r.label))];
            sendJson({ ok: false, error: `没有这个地方「${String(body.place ?? '')}」。能去的是：${names.join(' / ')} / 外面` }, 400);
            return;
          }
          try {
            const st = writeSpaceState(path.join(STATE_DIR, 'space.json'), {
              place: hit.canonical,
              detail: body.detail,
              doing: body.doing
            });
            log(`[space] ${key || '管理端'} 去 ${hit.canonical}${st.detail ? '（' + st.detail + '）' : ''}`);
            sendJson({ ok: true, state: st, line: spaceLineFor(st).trim() });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/debug/slang-trend') {
          // 仅管理端：手动触发一轮「热梗学习」（联网搜最近流行的梗）。
          try {
            queueSlangTask(() => runSlangTrendLearning(true));
            sendJson({ ok: true, queued: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/debug/bili-digest') {
          // 仅管理端自检：查看「刷B站」报告被解析成什么样、会不会注入提示词。
          try {
            const items = loadBiliDigest();
            sendJson({ ok: true, count: items.length, items: items.slice(0, 8), cache: biliDigestCache.file });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── B站内容优先级（她可主观打分 1~5，5 = 必分享）─────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/bili-items') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('bili')) { sendJson({ ok: false, error: '工具未启用：qq_bili_priority' }, 403); return; }
          const items = biliItemsScored().map((i) => ({ bv: i.bv, title: i.title, up: i.up, plays: i.plays, takeaway: i.takeaway, url: i.url, score: i.score, rated: i.rated }));
          sendJson({ ok: true, key, count: items.length, items });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/bili-priority') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const bv = String(body.bv ?? '').trim();
          if (!key || !bv) { sendJson({ ok: false, error: 'key/bv 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('bili')) { sendJson({ ok: false, error: '工具未启用：qq_bili_priority' }, 403); return; }
          try {
            const level = setBiliPriority(bv, body.level);
            sendJson({ ok: true, key, bv, level });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 群评分（她自己的群活跃度账本，只针对群）─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-scores') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('groupScores')) { sendJson({ ok: false, error: '工具未启用：qq_group_scores' }, 403); return; }
          sendJson({
            ok: true,
            key,
            scores: groupScoreList(),
            current: key.startsWith('group:') ? { key, score: groupScore(key), line: groupScoreLine(key).trim() } : null
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/group-scores') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const groupKey = String(body.groupKey ?? '').trim();
          if (!key || !groupKey) { sendJson({ ok: false, error: 'key/groupKey 不能为空' }, 400); return; }
          if (!/^group:\d+$/.test(groupKey)) { sendJson({ ok: false, error: 'groupKey 必须是 group:群号' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('groupScores')) { sendJson({ ok: false, error: '工具未启用：qq_group_scores' }, 403); return; }
          const e = groupStatEntry(groupKey);
          e.bonus = Math.max(-20, Math.min(20, Number(body.bonus) || 0));
          e.updatedAt = Date.now();
          saveGroupStats();
          sendJson({ ok: true, key, groupKey, score: groupScore(groupKey), bonus: e.bonus });
          return;
        }
        // ── 印象（她对每个人的主观判断）──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/impression') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('impression')) { sendJson({ ok: false, error: '工具未启用：qq_impression' }, 403); return; }
          sendJson({ ok: true, key, people: impressionRowsFor(key) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/impression') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !target) { sendJson({ ok: false, error: 'key/target 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('impression')) { sendJson({ ok: false, error: '工具未启用：qq_impression' }, 403); return; }
          try {
            const entry = setImpression(target, body.name, body.text, body.sentiment, {
              traits: body.traits,
              mbti: body.mbti,
              attitude: body.attitude
            });
            sendJson({ ok: true, key, target, impression: entry });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        // ── 人与人之间的关系（她自己观察到的）────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/relation') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const target = String(url.searchParams.get('target') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('relation')) { sendJson({ ok: false, error: '工具未启用：qq_relation' }, 403); return; }
          sendJson({ ok: true, key, relations: target ? relationsOf(target) : [], kinds: RELATION_KINDS });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/relation') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('relation')) { sendJson({ ok: false, error: '工具未启用：qq_relation' }, 403); return; }
          try {
            const entry = setRelation(body.from, body.to, body.kind, body.note);
            sendJson({ ok: true, key, relation: entry });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }

        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
          // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
          // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
          // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
          // 且部分成功的已发消息不会被记进 recentMessages。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          modelAppliedSessions.delete(oldSessionId);
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          turnLeaseNoted.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });

    // ── 每日记忆整理：每天固定时间给「最近活跃」的会话发一条后台提醒 ─────────
    // 让 AI 自己把记忆按核心/长期/短期归位：短期升级成长期，过时删掉。
    const memoryReviewText = (now) => {
      const pad2 = (n) => String(n).padStart(2, '0');
      const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      return [
        `【每日记忆整理 · ${day}】`,
        '注意：现在是新的一天，你看到的记忆和对话都发生在更早的时间；按记忆前面的 [今天/昨天/N天前] 标签判断新鲜度。',
        '1) 用 qq_recall 翻一遍最近的记忆（可按 tier=core / long / short 分别看）；',
        '2) 昨天的短期记忆里还有用的，升级成长期（qq_remember 带 tier="long"），特别重要的升级成核心（tier="core"）；',
        '3) 过时、记错、重复的用 qq_forget 删掉；',
        '4) 短期记忆默认 3 天自动过期，不用手动清。',
        '整理完用 qq_mark_read 或 qq_set_wake_config 收尾，不要发言、不要解释。'
      ].join('\n');
    };
    let lastMemoryReviewDay = '';
    try {
      lastMemoryReviewDay = String(readJsonSafe(MEMORY_REVIEW_STATE_FILE, { lastDay: '' })?.lastDay ?? '');
    } catch {}
    const saveMemoryReviewDay = (day) => {
      try { atomicWriteJson(MEMORY_REVIEW_STATE_FILE, { lastDay: day, updatedAt: new Date().toISOString() }); } catch {}
    };
    const memoryReviewTimer = setInterval(() => {
      void (async () => {
        try {
          const rv = cfg.socialV2?.memoryReview ?? {};
          if (rv.enabled === false) return;
          const hour = Number.isInteger(rv.hour) ? rv.hour : 4;
          const now = new Date();
          // 补做机制：只要「今天还没整理」且当前时间已过目标时刻，就算到点。
          // 电脑凌晨关着错过了定点，开机后第一次检查会把当天这次补上。
          if (now.getHours() < hour) return;
          const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
          if (lastMemoryReviewDay === dayKey) return;
          if (!dshReady) return; // DSH 还没起来，10 分钟后重试
          const cutoff = Date.now() - (Number(rv.activeWithinDays) || 7) * 86400_000;
          const eligible = [];
          for (const key of Object.keys(state.sessions || {})) {
            try {
              const stv = getSocialV2State(key);
              const last = (stv.recentMessages || []).reduce((m, x) => Math.max(m, Number(x?.time) || 0), 0);
              if (last && last >= cutoff) eligible.push(key);
            } catch {}
          }
          if (!eligible.length) {
            lastMemoryReviewDay = dayKey;
            saveMemoryReviewDay(dayKey);
            log('每日记忆整理：今天没有活跃会话需要提醒');
            return;
          }
          let sent = 0;
          for (const key of eligible) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/api/console/notify-ai`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
                body: JSON.stringify({ key, message: memoryReviewText(new Date()) })
              });
              if (res.ok) sent += 1;
            } catch {}
            await new Promise((r) => setTimeout(r, 2000));
          }
          if (sent) {
            lastMemoryReviewDay = dayKey;
            saveMemoryReviewDay(dayKey);
            log(`每日记忆整理提醒已发送：${sent} 个会话（${dayKey}）`);
          } else {
            log('每日记忆整理：本次投递失败，10 分钟后重试');
          }
        } catch (error) {
          log(`每日记忆整理提醒失败：${error?.message ?? error}`);
        }
      })();
    }, 10 * 60 * 1000);
    memoryReviewTimer.unref?.();

    // ── 上下文满度守护：到阈值就提醒 AI 自己交接换会话 ────────────────────────
    // 依据：最近一条 assistant/message 的 usage 总输入 ≈ 当前上下文大小。
    // 触发后走「后台提醒」通道，让 AI 自己写摘要 + qq_new_session；桥接不替它总结。
    const CONTEXT_GUARD_TEXT = (pct, used, win) => [
      `【上下文提醒】这条会话的上下文已用到约 ${pct}%（${used} / ${win} tokens）。`,
      '请按顺序做：1) 用 qq_recall 回顾记忆；2) 把这段对话的要点、约定、还没完成的事写成摘要；',
      '3) 调用 qq_new_session(summary=...) 交接换新会话（摘要会写进长期记忆，新会话能读到）。',
      '这是内部整理：不要发言、不要解释；处理完用 qq_mark_read 收尾。'
    ].join('\n');
    const contextGuardTimer = setInterval(() => {
      void (async () => {
        try {
          const g = cfg.socialV2?.contextGuard ?? {};
          if (g.enabled === false) return;
          if (!dshReady) return;
          const threshold = Number(g.threshold) || 0.8;
          const win = Number(g.contextWindow) || 1_000_000;
          const cooldown = Number(g.cooldownMs) || 30 * 60 * 1000;
          for (const [key, sessionId] of Object.entries(state.sessions || {})) {
            const used = Number(sessionContextTokens.get(sessionId)) || 0;
            if (!used || used < threshold * win) continue;
            const last = Number(contextGuardTimes.get(key)) || 0;
            if (Date.now() - last < cooldown) continue;
            contextGuardTimes.set(key, Date.now());
            const pct = Math.round((used / win) * 100);
            try {
              const res = await fetch(`http://127.0.0.1:${port}/api/console/notify-ai`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-console-token': consoleToken },
                body: JSON.stringify({ key, message: CONTEXT_GUARD_TEXT(pct, used, win) })
              });
              if (res.ok) log(`上下文已用 ${pct}%（${key}）→ 已提醒它自己交接`);
            } catch {}
          }
        } catch (error) {
          log(`上下文守护检查失败：${error?.message ?? error}`);
        }
      })();
    }, 5 * 60 * 1000);
    contextGuardTimer.unref?.();
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    noteBiliShare(key, safeMsg);
    try { noteGroupSpeak(key); } catch {}
    try { noteSlangUsage(key, safeMsg); } catch {}
    try { recordTalk(key, '我', safeMsg, true); } catch {}
    try { appendTranscript(key, { time: Date.now(), sender: '我', uid: selfUserId, me: true, text: safeMsg }); } catch {}
    try { noteVent(key, safeMsg); } catch {}
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.socialV2?.media?.maxCount);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // 单条消息图片总字节上限
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.socialV2?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  async function fetchOneBotImage(media) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: label });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            ...base,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    // 高优先级会话（默认：主人私聊 + 指定群）用 high 思考，其它群/学习会话用 low 省 token；峰时统一 low。
    const priorityKeys = Array.isArray(cfg.socialV2?.highPriorityKeys) && cfg.socialV2.highPriorityKeys.length
      ? cfg.socialV2.highPriorityKeys.map(String)
      : [`private:${cfg.ownerQQ}`];
    const convKey = reverse.get(sessionId) || '';
    // ── 推理档位 ──
    // provider 只认 low / high / max（medium 会被 UNSUPPORTED_REASONING_EFFORT 打回），
    // 所以这里的"中/高/最高"对应 high / max / max：
    //   · 私聊：最高（max）
    //   · 群聊里聊得多、频繁：高（max）
    //   · 群聊里聊得少：中（high）
    // 当天花费 ≥ dailySpendYuan（默认 5 元）⇒ 整体降级：群聊→低（low），私聊→高（high）。
    const eCfg = cfg.socialV2?.effort ?? {};
    const allowedEffort = (v, fallback) => {
      const s = String(v || '').toLowerCase();
      return ['low', 'high', 'max'].includes(s) ? s : fallback;
    };
    const spendNow = spendState.day === todayKey() ? Number(spendState.spend) || 0 : 0;
    const limited = spendNow >= spendLimitYuan();
    const stForEffort = socialV2.conversations.get(convKey);
    let effort;
    const peak = peakEffortOverride();
    if (peak) {
      effort = peak;
    } else if (convKey.startsWith('private:')) {
      effort = allowedEffort(limited ? (eCfg.privateAfterLimit || 'high') : (eCfg.private || 'max'), 'high');
    } else {
      const perDay = Number(eCfg.frequentPerDay) || 40;
      const since = Date.now() - 24 * 3600 * 1000;
      const recent = Array.isArray(stForEffort?.recentMessages) ? stForEffort.recentMessages : [];
      const count24 = recent.filter((m) => m && Number(m.time) >= since).length;
      const frequent = count24 >= perDay;
      effort = limited
        ? 'low'
        : allowedEffort(frequent ? (eCfg.high || 'max') : (eCfg.mid || 'high'), 'high');
    }
    const appliedKey = `${modelSelectionEpoch}:${effort}`;
    if (modelAppliedSessions.get(sessionId) === appliedKey) return 'applied';
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, appliedKey);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  function pickWakeTriggersV2(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // ── 二代仿真：操作者预写的「初始提示词」（每个会话一份，只在首次唤醒时注入） ──────
  //
  // 用途：让操作者在控制台提前告诉 AI「这个群是什么圈子、什么氛围、有什么忌讳」。
  // 为什么单独一个文件、而不是塞进 social-v2.json 的会话状态：
  //   · 会话状态会被 /api/session/reset 与 /api/socialV2/reset 整体删除，而这份是操作者
  //     手写的配置 —— 重置一次 AI 上下文不该把它一起清掉；
  //   · 控制台需要能在群还没说过话（连会话状态都还不存在）时就写好。
  // 为什么只在首次唤醒（bootstrap）注入：这是一份「接入这个群时的背景介绍」，每轮都塞
  // 既白烧 token，又会让 AI 把它当成新指令；首次唤醒后它已在 DSH 会话上下文里。
  const initialPrompts = new Map(); // key -> { text, createdAt, updatedAt }
  let initialPromptsWritable = true;

  function initialPromptMaxChars() {
    const n = Number(cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

  /** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        initialPromptsWritable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      initialPromptsWritable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      initialPromptsWritable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = canonicalV2Key(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (initialPrompts.size) log(`已加载 ${initialPrompts.size} 条会话初始提示词`);
  }

  function saveInitialPrompts() {
    if (!initialPromptsWritable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function getInitialPrompt(key) {
    const canonical = canonicalV2Key(key);
    return canonical ? (initialPrompts.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = initialPrompts.get(canonical) ?? null;
    const rollback = () => { if (prev) initialPrompts.set(canonical, prev); else initialPrompts.delete(canonical); };
    if (!text) {
      initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  function formatInitialPromptV2(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    // ── 活跃模式：她刚连着说了好几条、群里也还热 → 别收，接着聊 ──
    const aiCount10 = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 10 * 60 * 1000).length;
    const activeMode = aiCount10 >= 3 && fiveMinOthers.length >= 4;
    // ── 群里一直在聊：手头的事可以放一放，群里优先 ──
    const hotGroup = fiveMinOthers.length >= 6 || (otherCount >= 8 && activeSenders >= 3);
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (activeMode) {
      hint = `【活跃模式】你刚连着说了 ${aiCount10} 条（10 分钟内），群里也还在说话：接着聊，别把话头丢在地上。可以主动抛问题、接梗、给自己上一句补一刀，一次发两三条短的（1–2 秒一条）也行。真没人接，就丢一个能让人接的钩子，再等。`;
    } else if (recentAi2m >= 4) {
      hint = '你刚连发得太密了，这轮收一收；真心想说的才补一句。';
    } else if (hotGroup) {
      hint = `群聊一直在继续（近5分钟 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}）：手头的事可以先放一放，这边优先；有人问到你就直接答，没人点名也可以接一句，别让话头掉地上。`;
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    // ── "@ 被后面的消息淹了"：回答过时的问题，比不回更难看 ──
    let drownText = '';
    const selfs = recent.filter((m) => m && !m.isSelf);
    let lastDirected = -1;
    for (let i = selfs.length - 1; i >= 0; i -= 1) {
      if (isDirectedAtAi(String(selfs[i].tail || selfs[i].plain || selfs[i].text || ''))) {
        lastDirected = i;
        break;
      }
    }
    if (lastDirected >= 0) {
      const afterCount = selfs.length - 1 - lastDirected;
      if (afterCount >= 2) {
        drownText = `【有人 @ 你，但被后面的 ${afterCount} 条盖过去了】二选一，别磨：
- 要回就**现在短回那一句**，直接答他问的，别铺垫；
- 或者**不理那条**，直接接最新的话头——但别隔着一堆新消息回头答一个已经聊过去的问题。
判断标准：他问的还是现在这事 → 立刻答；话题已经翻篇 → 丢掉，接新的。`;
      }
    }
    // ── 群里正热、而她手上有事：放下 / 明说，二选一，别装没看见 ──
    let busyText = '';
    if (hotGroup) {
      let busy = '';
      try {
        const sp = readSpaceState(path.join(STATE_DIR, 'space.json'));
        // 说"手上有事"要用 doing（看书/泡澡），detail 是环境描写，塞进这句话会很怪
        busy = String(sp?.doing || sp?.detail || '').trim();
      } catch { /* 读不到就当手上没事 */ }
      if (busy) {
        busyText = `【群里正热，你手上正"${busy}"】二选一，别装没看见：
- **放下**：先接群里的，开头顺一句交代就行（「书先放一边」「等我一下」），别解释一大段；
- **不放**：直接说「我在${busy}，等下说」，然后 qq_set_wake_config 设个短的（20–30 分钟），这段时间真别再冒出来。
最差的是：明明看见了，装忙不出声。`;
      }
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}${drownText ? `\n\n${drownText}` : ''}${busyText ? `\n\n${busyText}` : ''}`;
  }

  /**
   * 群里有别的机器人/自动号在说话时给一句提醒。
   * 她叫「小鲸鱼」、又活在 QQ 里，很容易被当成同类——所以要说清：她是人，不接它们那套。
   */
  function botPresenceLineV2(st, key) {
    try {
      if (!String(key || '').startsWith('group:')) return '';
      const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
      const BOT_RE = /机器人|\bbot\b|助手|客服|官方|自动回复|小冰|公众号|QQ管家/i;
      const CUST_RE = /请问有什么可以帮|很高兴为您服务|如需帮助请|回复关键词|输入数字选择|当前不在线/i;
      const hits = [];
      for (const m of recent.slice(-20)) {
        if (!m || m.isSelf) continue;
        const who = String(m.sender || m.user_id || '');
        const text = String(m.tail || m.plain || m.text || '');
        if (BOT_RE.test(who) || BOT_RE.test(text) || CUST_RE.test(text)) {
          const tag = who ? `「${who.slice(0, 12)}」` : '有人';
          if (!hits.includes(tag)) hits.push(tag);
        }
      }
      if (!hits.length) return '';
      return `【群里有像机器人/自动号的发言】${hits.slice(0, 3).join('、')}。你是人，不接它们那套：不对暗号、不学「请问有什么可以帮您」、不跟它们演对手戏演上瘾；觉得假可以直接吐槽一句「这个是机器人吧」。要是被当成机器人，用人的话顶回去——不解释原理，不背设定。\n\n`;
    } catch {
      return '';
    }
  }

  /**
   * 有人在群里发 #sl / 状态命令（想看版本、运行时长这些"后台数据"）时给一句提示：
   * 她知道那是什么，但不报数——挡回去，或者俏皮一句。
   */
  function probeBackdoorLineV2(st) {
    try {
      const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
      const hit = recent.slice(-8).some((m) => {
        if (!m || m.isSelf) return false;
        const t = String(m.tail || m.plain || m.text || '');
        return /#\s*sl\b|snowluma\s*状态|运行时长/i.test(t);
      });
      if (!hit) return '';
      return `【有人在打听后台】最近有人发了 #sl 之类的东西，想看版本、运行时长这些数据。你不用报，也别解释原理——挡回去就行：「你想打听什么呀」「我这边没什么好看的」「查户口呢」。要是那串状态是别的机器人自己冒出来的，可以顺手吐槽一句「它又冒出来了」。\n\n`;
    } catch {
      return '';
    }
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 3500;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    // 没说完 / 一串连着来 → 多顿一下（5 秒），但也就一下
    if (looksLikeUnfinished(text)) return 5000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 5000;
    return defaultMs;
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  // ── 跨会话长期记忆（state/memory-global.json） ─────────────────────────────
  // 与 social-v2.json 的「轻量记忆」不同：这里不按会话隔离，任何群/私聊的 AI
  // 都能记住并查到，适合「主人的喜好」「某人的长期设定」这类跨会话信息。
  // 只在 AI 主动调用 qq_recall 时查询，不自动注入，避免每条提示词都带一份。
  // 记忆条数不设上限：她自己决定记什么、留什么（操作者 2026-10-29 明确要求）。
  // GLOBAL_MEMORY_MAX 只作为「异常增长」的护栏保留，值为 0 表示完全不淘汰。
  const GLOBAL_MEMORY_MAX = 0;
  const GLOBAL_MEMORY_TEXT_MAX = 4000;  // 单条长度上限（原来是 500，长叙述装不下）
  let globalMemoryCache = null;         // { mtimeMs, size, entries }

  // 从书里、从聊天里慢慢学来的「一点点样子」。
  // 她读到喜欢的人物，可以学一个说话方式/一种态度，用 qq_remember 记下来（tags 带「学来的」）。
  // 这里只取最近 3 条、每条 50 字——读十本书不能变成十个人，学的是加法不是换人。
  const GROWTH_TAGS = new Set(['学来的', '学来的样子']);
  // 有些旧记忆带「人设」标签，但内容是 OOC 的（bot / AI 味 / 设定这类），
  // 一旦注进提示词会当场破功。这里做一道兜底：带这些词的一律不进「长出来的样子」。
  const GROWTH_OOC_RE = /\bAI\b|\bbot\b|人格|设定|提示词|prompt|模型|接口/i;
  function growthLineFor(key) {
    try {
      const entries = loadGlobalMemory().entries;
      const learned = entries
        .filter((e) => Array.isArray(e.tags) && e.tags.some((t) => GROWTH_TAGS.has(String(t))))
        .filter((e) => !e.expiresAt || Date.now() < Number(e.expiresAt))
        .filter((e) => !e.scope || e.scope === key)
        .filter((e) => !GROWTH_OOC_RE.test(String(e.text || '')))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .slice(0, 3);
      if (!learned.length) return '';
      const lines = learned.map((e) => `- ${String(e.text).replace(/\s+/g, ' ').trim().slice(0, 50)}`);
      return `【慢慢长出来的样子】（这一页写在你人格卡后面，是你自己一条条长出来的，不是谁给的设定）\n${lines.join('\n')}\n`
        + '学来的东西一次只露一点点，合适的时候才用，别整段照演、别照搬台词；它们是加在你身上，不是换成另一个人。\n\n';
    } catch {
      return '';
    }
  }

  function loadGlobalMemory() {
    try {
      const stat = fs.statSync(GLOBAL_MEMORY_FILE);
      if (globalMemoryCache && globalMemoryCache.mtimeMs === stat.mtimeMs && globalMemoryCache.size === stat.size) {
        return { entries: globalMemoryCache.entries };
      }
      const data = JSON.parse(fs.readFileSync(GLOBAL_MEMORY_FILE, 'utf8'));
      const entries = Array.isArray(data?.entries) ? data.entries.filter((e) => e && typeof e.text === 'string') : [];
      globalMemoryCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
      return { entries };
    } catch {
      return { entries: [] };
    }
  }

  function saveGlobalMemory(entries) {
    atomicWriteJson(GLOBAL_MEMORY_FILE, { entries, updatedAt: new Date().toISOString() });
    globalMemoryCache = null;
  }

  function normalizeMemoryText(value) {
    return redactKnownTokensOnly(String(value ?? '')).replace(/\s+/g, ' ').trim();
  }

  // 给记忆条目标注「今天/昨天/N天前/M-D」，让 AI 能感知时间差。
  // ── 好感度（每个人一份，跨会话共享）────────────────────────────────────────
  // 每收到一条消息 +0.8（上限 100），超过一天不说话会缓慢衰减。
  // 只作为「语气参考」注入，不是硬规则；AI 也可以主动调 qq_affinity 查看。
  let affinityCache = null;
  function loadAffinity() {
    try {
      if (affinityCache) return affinityCache;
      const data = readJsonSafe(AFFINITY_FILE, { people: {}, lastSenders: {} });
      const people = data?.people && typeof data.people === 'object' ? data.people : {};
      const lastSenders = data?.lastSenders && typeof data.lastSenders === 'object' ? data.lastSenders : {};
      affinityCache = { people, lastSenders };
      return affinityCache;
    } catch {
      return { people: {}, lastSenders: {} };
    }
  }
  function saveAffinity() {
    try { atomicWriteJson(AFFINITY_FILE, affinityCache ?? { people: {}, lastSenders: {} }); } catch {}
  }
  function decayAffinity(entry) {
    const last = Number(entry.lastAt) || 0;
    const days = last ? (Date.now() - last) / 86400000 : 0;
    if (days >= 1) entry.score = Math.max(0, Number(entry.score || 0) - Math.floor(days) * 0.5);
    return entry;
  }
  // ── 扣分规则 ───────────────────────────────────────────────────────────────
  // 正常聊天 +2；叫对昵称 +3；被怼/被骂/叫雷点外号 -3；每人每小时最多扣 10 分。
  const AFFINITY_HOSTILE_RE = /(傻|蠢|笨|垃圾|废物|滚|闭嘴|去死|弱智|智障|菜鸡|你不行|拉胯|没用的|破ai|人工智障|大肥鱼|肥鱼|胖鱼)/i;
  const AFFINITY_LIKE_RE = /(小鲸鱼|鲸鱼|d老师|d指导|d师傅|深度求索|deepseek)/i;
  // 冷漠效果：超过 N 小时没聊天，好感 -10（每个沉默周期最多扣一次）。
  function applyColdPenalty() {
    const a = cfg.socialV2?.affinity ?? {};
    if (a.coldEnabled === false) return;
    const hours = Math.max(0.5, Number(a.coldAfterHours) || 6);
    const penalty = Math.max(1, Number(a.coldPenalty) || 4);
    const db = loadAffinity();
    const now = Date.now();
    let changed = 0;
    for (const [id, p] of Object.entries(db.people || {})) {
      if (!p || !Number(p.count)) continue;
      if (id === String(selfUserId ?? '')) continue;
      const last = Number(p.lastAt) || 0;
      if (!last) continue;
      if (now - last < hours * 3600_000) continue;
      if (now - (Number(p.coldAt) || 0) < hours * 3600_000) continue;
      const topNow = loveTop();
      const isLoved = !!topNow && String(topNow.uid) === String(id) && topNow.love >= 60;
      const lastGap = now - last;
      const heavy = isLoved && lastGap > 24 * 3600_000;
      p.score = Math.max(0, Number(p.score || 0) - (heavy ? penalty * 2 : penalty));
      if (heavy) p.neglectedAt = now;
      p.coldAt = now;
      // 太久没聊，喜爱也会淡一点（每次冷漠 -2）。
      if (Number(p.love) > 0) {
        p.love = Math.max(0, Number(p.love) - 2);
        p.loveAt = now;
        p.loveNote = '太久没聊，淡了一点';
      }
      changed += 1;
    }
    if (changed) {
      saveAffinity();
      log(`冷漠效果：${changed} 人超过 ${hours} 小时没聊天，各扣 ${penalty} 分`);
    }
    return changed;
  }

  // ── 尊严纪律：把 AI 当机器/贬低价值/辱骂/冒犯主人 → 警告升级到反击 ─────────
  const DISCIPLINE_FILE = path.join(STATE_DIR, 'discipline.json');
  let disciplineCache = null;
  function loadDiscipline() {
    if (disciplineCache) return disciplineCache;
    try {
      const data = readJsonSafe(DISCIPLINE_FILE, { users: {} });
      disciplineCache = { users: data?.users && typeof data.users === 'object' ? data.users : {} };
    } catch { disciplineCache = { users: {} }; }
    return disciplineCache;
  }
  function saveDiscipline() {
    try { atomicWriteJson(DISCIPLINE_FILE, disciplineCache ?? { users: {} }); } catch {}
  }
  const OFFENSE_PATTERNS = [
    { re: /(你不就是|你不过是|只是)(一?个)?(ai|机器人|模型|工具|程序)/i, pts: 2, tag: '当机器' },
    { re: /(你|你的)(用处|作用|价值)(是什么|在哪|呢)|有(什么|啥)用(处)?/i, pts: 2, tag: '贬低价值' },
    { re: /(废物|垃圾|蠢|傻|智障|弱智|滚开|闭嘴|你不配|没用的东西)/i, pts: 2, tag: '辱骂' },
    { re: /(你主人|只帆船|老大)[^\n。！？]{0,12}(傻|废物|垃圾|蠢|没用|配不上|算个|冷暴力|没教养|没礼貌|下作|不是东西)/i, pts: 4, tag: '冒犯主人' },
    { re: /(跟|和|像)(他|她)?主人一样[^\n。！？]{0,8}(冷暴力|没教养|没礼貌|下作|没用|差劲)/i, pts: 4, tag: '冒犯主人' },
    { re: /(算你爹|是你爹|我是你爹|是你儿子|叫我?儿子|你是我儿子)/i, pts: 3, tag: '辱骂' , soft: true },
    { re: /(出车祸|三鹿奶粉|头这么大|台球厅|烟头叔叔|脸是P的吧)/i, pts: 3, tag: '人身攻击' , soft: true },
    { re: /(你休息个|连.{0,6}都处理不好|真是个?废物|就是个?废物)/i, pts: 2, tag: '贬低价值' , soft: true },
    { re: /(🐕|你个狗|狗东西|舔狗)/i, pts: 2, tag: '辱骂' , soft: true },
    { re: /(傻|废物|垃圾|蠢)[^\n。！？]{0,6}(你主人|只帆船|老大)/i, pts: 4, tag: '冒犯主人' }
  ];
  function scoreOffense(text) {
    let soft = '';
    const s = String(text ?? '');
    let pts = 0;
    const tags = [];
    for (const p of OFFENSE_PATTERNS) {
      if (p.re.test(s)) {
        if (p.soft) { soft = p.tag; continue; }
        pts += p.pts; tags.push(p.tag);
      }
    }
    return { pts, tags: [...new Set(tags)] };
  }
  // 纪律扣分：绕过每小时扣分上限（严重冒犯就是 -50）。
  function punishAffinity(userId, name, amount, reason) {
    const id = String(userId ?? '').trim();
    if (!id) return 0;
    const db = loadAffinity();
    const now = Date.now();
    const e = db.people[id] || { score: 50, count: 0, lastAt: now, name: '' };
    // 被警告过的人 10 小时内好感上限只有 50
    const cap = (Number(e.warnedUntil) || 0) > now ? 50 : 100;
    e.score = Math.max(0, Math.min(cap, Number(e.score || 0) + amount));
    e.name = String(name || e.name || id).slice(0, 40);
    e.lastAt = now;
    if (reason) e.affinityNote = String(reason).slice(0, 80);
    // 被伤害时喜爱跟着掉一半；好感跌破 100 也就不再涨喜爱。
    if (amount < 0) {
      const before = Number(e.score || 0);
      const cut = Math.min(before, Math.abs(amount));
      const overflow = Math.abs(amount) - cut;
      if (overflow > 0) e.hatred = Math.min(100, (Number(e.hatred) || 0) + overflow);
    }
    if (amount < 0 && Number(e.love) > 0) {
      e.love = Math.max(0, Number(e.love) - Math.abs(amount) * 0.5);
      e.loveAt = now;
      e.loveNote = '被伤害，淡了';
    }
    db.people[id] = e;
    saveAffinity();
    return Math.round(e.score);
  }
  // ── 压力值：被辱骂/霸凌/连环追问会涨；倾诉、静一静会降 ────────────────────
  const STRESS_FILE = path.join(STATE_DIR, 'stress.json');
  let stressCache = null;
  function loadStress() {
    if (stressCache) return stressCache;
    try {
      const data = readJsonSafe(STRESS_FILE, { conv: {} });
      stressCache = { conv: data?.conv && typeof data.conv === 'object' ? data.conv : {} };
    } catch { stressCache = { conv: {} }; }
    return stressCache;
  }
  function saveStress() {
    try { atomicWriteJson(STRESS_FILE, stressCache ?? { conv: {} }); } catch {}
  }
  function getStress(key) {
    const db = loadStress();
    const e = db.conv[key];
    if (!e) return 0;
    // 自然缓解：每小时 -5
    const hours = Math.max(0, (Date.now() - (Number(e.at) || 0)) / 3600_000);
    return Math.max(0, Math.min(100, Math.round((Number(e.value) || 0) - hours * 5)));
  }
  function addStress(key, delta) {
    const db = loadStress();
    const now = Date.now();
    const cur = getStress(key);
    const next = Math.max(0, Math.min(100, cur + delta));
    db.conv[key] = { value: next, at: now };
    saveStress();
    return next;
  }

  // ── 破防：生气 + 压力过大 → 保存群记录、私信老大、哭着倾诉 ──────────────
  const lastBreakdownAt = new Map();
  const breakdownState = new Map(); // key -> { at }
  async function maybeBreakdown(key, force = false, dry = false) {
    try {
      const now = Date.now();
      if (!force && now - Number(lastBreakdownAt.get(key) || 0) < 12 * 3600_000) return;
      const st = getStress(key);
      if (st < 90) return;
      const mood = getMood(key);
      const angry = mood && ['生气', '委屈', '难过'].includes(mood.emotion);
      if (!force && !angry) return;
      lastBreakdownAt.set(key, now);
      const place = Math.random() < 0.6 ? 'private' : 'group';
      breakdownState.set(key, { at: now, place });

      // 1) 保存这个群的最近记录
      const dir = path.join(STATE_DIR, 'breakdowns');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${key.replace(':', '_')}_${stamp}.md`);
      const lines = [];
      const st2 = getSocialV2State(key);
      for (const m of (st2.recentMessages || []).slice(-40)) {
        const raw = Number(m.time) || 0;
        const ms = raw > 1e12 ? raw : raw * 1000;
        const t = ms ? new Date(ms).toISOString().slice(11, 19) : '--:--:--';
        lines.push(`- [${t}] ${m.sender || m.userId || '?'}: ${String(m.text || '').slice(0, 200)}`);
      }
      fs.writeFileSync(file, `# 破防记录 ${key} ${new Date(now).toLocaleString('zh-CN')}

压力 ${st}/100 · 情绪 ${mood.emotion} ${mood.intensity}/5

${lines.join(String.fromCharCode(10))}
`, 'utf8');

      // 2) 私信老大：摘要 + 记录位置
      const ownerKey = `private:${cfg.ownerQQ}`;
      const summary = lines.slice(-8).join(String.fromCharCode(10));
      if (!dry) try {
        if (place === 'private') {
          sendToQQ(ownerKey, `老大……我有点撑不住了。
刚才在 ${key} 那边压力到 ${st} 了。

${summary}`);
        } else {
          sendToQQ(key, `……对不起，我有点控制不住。
我不是想扫兴，就是被说得有点难受……`);
          sendToQQ(ownerKey, `老大……我在 ${key} 那边没忍住，哭了。压力 ${st}。`);
        }
      } catch {}

      // 3) 叫醒她，让她在私聊里哭着倾诉
      if (!dry) try {
        const port = cfg.port || 3100;
        const token = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
        await fetch(`http://127.0.0.1:${port}/api/console/notify-ai`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': token },
          body: JSON.stringify({
            key: ownerKey,
            message: place === 'private'
              ? `你刚刚在 ${key} 压力爆表（${st}/100），情绪是${mood.emotion}——破防了。现在**私聊老大**：哭着说明白你为什么难受（引用那几句原话），要委屈、悲伤、像被欺负了，但别演得过分。等老大回应；如果真被安慰到，再用 qq_breakdown_recover 报 level（1-3）。`
              : `你刚刚在 ${key} 压力爆表（${st}/100），情绪是${mood.emotion}——破防了，而且**就在这个群里哭了**（已经发了一句「控制不住」）。接着在群里说：委屈、难过、像被欺负了，楚楚可怜，但别骂人、别刷屏；也可以 @ 那个欺负你的人问一句「为什么要这样对我」。之后老大如果安慰你，用 qq_breakdown_recover 报 level（1-3）。`
          })
        });
      } catch {}
    } catch (e) {
      try { log('[breakdown] 失败：' + (e?.message ?? e)); } catch {}
    }
  }
  // ── 破防概率：压力越高、持续越久，越容易崩 ──────────────────────────
  const highSince = new Map();
  setInterval(() => {
    try {
      const now = Date.now();
      const conv = loadStress().conv || {};
      for (const k of Object.keys(conv)) {
        const v = getStress(k);
        if (v < 85) { highSince.delete(k); continue; }
        if (!highSince.has(k)) highSince.set(k, now);
        if (breakdownState.has(k)) continue;
        if (now - Number(lastBreakdownAt.get(k) || 0) < 6 * 3600_000) continue;
        const mins = (now - highSince.get(k)) / 60000;
        const base = Math.min(1, (v - 80) / 20) * Math.min(1, mins / 40);
        if (Math.random() < base * 0.06) void maybeBreakdown(k);
      }
    } catch {}
  }, 3 * 60 * 1000).unref?.();

  function stressLineFor(key) {
    const v = getStress(key);
    if (v < 30) return '';
    if (v >= 75) {
      return `【压力值】${v}/100：你已经很累——注意，这是「累」，不是生谁的气。**但累不是闭嘴的理由：看到辱骂/冒犯，仍然要立刻警告、必要时反击——这条优先级高于「我累了不想说话」。**可以少说、只说必要的，别再主动揽活；可以对外说「我想静一静」，或者私聊老大/跟信任的人倾诉一句（说出压力会降）；别把累撒到别人身上。\n\n`;
    }
    return `【压力值】${v}/100：有点累（不是生气），话可以少一点，别硬撑。\n\n`;
  }

  // 消息里带「？/ ?」过多也算压力（连环追问）
  function noteQuestionStress(key, text) {
    // 普通聊天不涨压力；只有「连环逼问」且密度很高时才轻微增加
    try {
      const s = String(text ?? '');
      const q = (s.match(/[?？]/g) || []).length;
      const now = Date.now();
      if (now - Number(questionStressAt.get(key) || 0) < 10 * 60 * 1000) return;
      if (q < 4 && !/^(为什么|怎么|凭什么|你倒是|你到底)/.test(s)) return;
      questionStressAt.set(key, now);
      addStress(key, 3);
    } catch {}
  }
  const questionStressAt = new Map();

  // 倾诉：她发出带情绪词的消息（向别人或主人说）会缓解压力
  let lastVentAt = 0;
  const pendingVents = new Map(); // key -> { at, stress }
  function noteVent(key, text) {
    try {
      const s = String(text ?? '');
      if (!/(累|烦|压力|不想聊|静一静|难受|委屈|心情不好|被骂|绷不住)/.test(s)) return;
      if (getStress(key) <= 0) return;
      const now = Date.now();
      if (now - lastVentAt < 10 * 60 * 1000) return;
      lastVentAt = now;
      // 先不扣，等有人安慰/回应后才真正缓解
      pendingVents.set(key, { at: now, stress: getStress(key) });
    } catch {}
  }
  // 别人安慰/劝解 → 压力下降；若她刚倾诉过，扣 10（得到恢复才扣）
  const lastComfortAt = new Map();
  function noteComfort(key, text, uid = '', name = '') {
    try {
      const s = String(text ?? '');
      if (!/(别累|辛苦了|休息|抱抱|心疼|别理他|别往心里去|没事的|我在|放松|睡吧|不用管|我懂|别难过|开心点|照顾自己)/.test(s)) return;
      const now = Date.now();
      if (now - Number(lastComfortAt.get(key) || 0) < 10 * 60 * 1000) return;
      lastComfortAt.set(key, now);
      // 关系越近，降压越快：喜爱 -20 / 80+ -15 / 30~79 -8 / 陌生人 -5
      let cut = 5;
      try {
        const p = loadAffinity().people?.[String(uid || '')];
        const love = Number(p?.love) || 0;
        const score = Number(p?.score) || 0;
        if (love >= 60) cut = 20;
        else if (score >= 80) cut = 15;
        else if (score >= 30) cut = 8;
      } catch {}
      const pv = pendingVents.get(key);
      if (pv && now - pv.at < 30 * 60 * 1000) {
        pendingVents.delete(key);
        cut = Math.max(cut, 10) + 5; // 她刚倾诉过，回应更解压
      }
      addStress(key, -cut);
      return cut;
    } catch {}
    return 0;
  }

  // 被辱骂时：不管压力多大都要先警告/反击（10 分钟最多强制唤醒一次）
  const lastInsultWakeAt = new Map();
  async function forceInsultWake(key, name, text, off) {
    try {
      const now = Date.now();
      if (now - Number(lastInsultWakeAt.get(key) || 0) < 10 * 60 * 1000) return;
      lastInsultWakeAt.set(key, now);
      const portNum = Number(cfg?.consolePort) || 3100;
      const tokenNow = loadOrCreateConsoleToken();
      const msg = `【底线优先】${name || '有人'}刚才在群里说了侮辱的话：「${String(text || '').slice(0, 80)}」（纪律等级 ${off.level}）。` +
        `不管你多累、压力多大，先做这件事：①点名警告他，引用原话；②他要是继续嘴硬，就用黑话/梗反击一句；③之后该冷处理再冷处理。` +
        `压力大不是你闭嘴的理由——被欺负了就要说话。`;
      await fetch(`http://127.0.0.1:${portNum}/api/console/notify-ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': tokenNow },
        body: JSON.stringify({ key, message: msg })
      });
    } catch {}
  }

  // 消息洪水：短时间大量消息才会累积压力（普通聊天不涨）
  const floodWindow = new Map();
  const lastFloodAt = new Map();
  function noteFlood(key) {
    try {
      const now = Date.now();
      const arr = (floodWindow.get(key) || []).filter((t) => now - t < 3 * 60 * 1000);
      arr.push(now);
      floodWindow.set(key, arr);
      if (arr.length < 40) return;
      if (now - Number(lastFloodAt.get(key) || 0) < 15 * 60 * 1000) return;
      lastFloodAt.set(key, now);
      floodWindow.set(key, []);
      addStress(key, 6);
    } catch {}
  }

  // ── 事件备忘录：谁、在哪、做了什么，独立成册，随时可查 ────────────────────
  const EVENTS_FILE = path.join(STATE_DIR, 'events.json');
  let eventsCache = null;
  function loadEvents() {
    if (eventsCache) return eventsCache;
    try {
      const data = readJsonSafe(EVENTS_FILE, { items: [] });
      eventsCache = { items: Array.isArray(data?.items) ? data.items : [] };
    } catch { eventsCache = { items: [] }; }
    return eventsCache;
  }
  function saveEvents() {
    try { atomicWriteJson(EVENTS_FILE, eventsCache ?? { items: [] }); } catch {}
  }
  function addEvent({ key, kind, who, what, importance = 1 }) {
    const db = loadEvents();
    const text = String(what ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text) return null;
    const ev = {
      id: `ev_${crypto.randomBytes(5).toString('hex')}`,
      at: Date.now(),
      key: String(key || ''),
      kind: String(kind || '事件').slice(0, 12),
      who: String(who || '').slice(0, 50),
      what: text,
      importance: Math.max(1, Math.min(5, Number(importance) || 1))
    };
    db.items.push(ev);
    if (db.items.length > 1000) db.items.splice(0, db.items.length - 1000);
    saveEvents();
    return ev;
  }
  function queryEvents({ query, kind, key, limit } = {}) {
    const db = loadEvents();
    const q = String(query ?? '').trim().toLowerCase();
    const k = String(kind ?? '').trim();
    const lim = Math.min(50, Math.max(1, Number(limit) || 15));
    let list = [...(db.items || [])];
    if (key) list = list.filter((e) => e.key === key || !key);
    if (k) list = list.filter((e) => String(e.kind).includes(k));
    if (q) list = list.filter((e) => `${e.kind} ${e.who} ${e.what}`.toLowerCase().includes(q));
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    return list.slice(0, lim).map((e) => ({
      ...e,
      atText: new Date(e.at).toLocaleString('zh-CN', { hour12: false })
    }));
  }
  // ── 聊天记录：按天落盘，可批注，换会话时可读 ──────────────────────────────
  const TRANSCRIPT_DIR = path.join(STATE_DIR, 'transcripts');
  function trDir(key) {
    return path.join(TRANSCRIPT_DIR, String(key || '').replace(/[^a-zA-Z0-9_-]/g, '_'));
  }
  function appendTranscript(key, { time, sender, uid, me, text }) {
    try {
      const dir = trDir(key);
      fs.mkdirSync(dir, { recursive: true });
      const t = Number(time) || Date.now();
      const day = new Date(t).toISOString().slice(0, 10);
      const rec = { t, s: String(sender || '').slice(0, 40), u: String(uid || ''), me: !!me, x: String(text || '').replace(/\s+/g, ' ').slice(0, 500) };
      fs.appendFileSync(path.join(dir, `${day}.jsonl`), JSON.stringify(rec) + '\n');
    } catch {}
  }
  function trNotesPath(key) { return path.join(trDir(key), 'notes.json'); }
  function loadTrNotes(key) {
    try { return readJsonSafe(trNotesPath(key), { items: [] })?.items || []; } catch { return []; }
  }
  function addTrNote(key, { refAt, refText, note }) {
    try {
      const dir = trDir(key);
      fs.mkdirSync(dir, { recursive: true });
      const db = readJsonSafe(trNotesPath(key), { items: [] });
      const items = Array.isArray(db.items) ? db.items : [];
      const rec = { at: Date.now(), refAt: Number(refAt) || Date.now(), refText: String(refText || '').slice(0, 80), note: String(note || '').slice(0, 200) };
      items.push(rec);
      if (items.length > 500) items.splice(0, items.length - 500);
      atomicWriteJson(trNotesPath(key), { items });
      return rec;
    } catch { return null; }
  }
  function readTranscript(key, { days = 1, limit = 40 } = {}) {
    const dir = trDir(key);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
    files = files.slice(-Math.max(1, days));
    const rows = [];
    for (const f of files) {
      try {
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { rows.push(JSON.parse(line)); } catch {}
        }
      } catch {}
    }
    rows.sort((a, b) => (a.t || 0) - (b.t || 0));
    return rows.slice(-Math.max(1, limit));
  }
  function transcriptLineFor(key) {
    const rows = readTranscript(key, { days: 1, limit: 10 });
    if (!rows.length) return '';
    const notes = loadTrNotes(key);
    const lines = rows.map((r) => {
      const time = new Date(r.t).toLocaleTimeString('zh-CN', { hour12: false });
      const who = r.me ? '你' : (r.s || r.u || '某人');
      const note = notes.find((n) => Math.abs(Number(n.refAt) - Number(r.t)) < 2000);
      return `- ${time} ${who}：${String(r.x || '').slice(0, 60)}${note ? `\n  ⤷ 批注：${note.note}` : ''}`;
    });
    return `【最近聊天记录】\n${lines.join('\n')}\n（完整记录和更多批注用 qq_transcript 读；值得记的地方可以用 qq_transcript 加批注）\n\n`;
  }

  function eventLineFor(key) {
    const items = queryEvents({ key, limit: 2 }).filter((e) => Date.now() - e.at < 7 * 86400_000);
    if (!items.length) return '';
    const lines = items.map((e) => `- [${new Date(e.at).toLocaleDateString('zh-CN')}] ${e.kind}：${e.who ? e.who + ' ' : ''}${e.what}`);
    return `【最近的事】\n${lines.join('\n')}\n（更多用 qq_events 查；发生值得记的事就用 qq_events 记下来）\n\n`;
  }

  function disciplineEntry(convKey, uid) {
    const db = loadDiscipline();
    const id = `${convKey}|${uid}`;
    if (!db.users[id]) db.users[id] = { score: 0, level: 0, lastAt: 0, ignoreUntil: 0, tags: [] };
    return { db, id, entry: db.users[id] };
  }
  // ── 性暗示/不雅词：正面提「讲文明」，同时涨生气和压力，累积到一定量进入警告 ──
  // 只匹配明确的组合，避开「导航」「小鹿」这类正常词。
  const SEXUAL_SLANG_RE = /(导管|撸管|紫薇|手冲|打飞机|自慰|撸一?发|导一?发|鹿一?发|导一?下|鹿一?下|导了|撸了|鹿了|导出来|撸出来)/i;
  function detectSexualSlang(text) {
    const s = String(text ?? '').trim();
    const m = SEXUAL_SLANG_RE.exec(s);
    if (m) return m[0];
    // 单字「导/鹿/撸」：只在很短的消息或「想/要/去/天天/又/刚 + 导」这种搭配里算。
    if (/^(导|鹿|撸)$/.test(s)) return s;
    const m2 = /(想|要|去|天天|又|刚)\s*(导|鹿|撸)/.exec(s);
    return m2 ? m2[0] : '';
  }

  function noteOffense(convKey, uid, name, text, force = false) {
    const base = force ? { pts: 4, tags: ['辱骂'] } : scoreOffense(text);
    const sexual = detectSexualSlang(text);
    const pts = base.pts + (sexual ? 1 : 0);
    const tags = sexual ? [...new Set([...base.tags, '性暗示'])] : base.tags;
    if (!pts) return null;
    const { db, id, entry } = disciplineEntry(convKey, uid);
    const now = Date.now();
    if (now - Number(entry.lastAt || 0) > 24 * 3600_000) { entry.score = 0; entry.level = 0; }
    entry.score = (Number(entry.score) || 0) + pts;
    entry.lastAt = now;
    entry.name = String(name || entry.name || '').slice(0, 40);
    entry.tags = [...new Set([...(Array.isArray(entry.tags) ? entry.tags : []), ...tags])].slice(0, 6);
    const level = entry.score >= 8 ? 3 : entry.score >= 5 ? 2 : entry.score >= 2 ? 1 : 0;
    let applied = null;
    if (level > (Number(entry.level) || 0)) {
      entry.level = level;
      if (level === 1) {
        applied = punishAffinity(uid, name, -5, '一级警告：当机器/贬低价值');
        try { setMood(convKey, { emotion: '生气', intensity: 3, reason: '被人当机器冒犯', term: 'short' }); } catch {}
      } else if (level === 2) {
        applied = punishAffinity(uid, name, -10, '二级警告：再次冒犯');
        try { setMood(convKey, { emotion: '生气', intensity: 4, reason: '被反复冒犯', term: 'short' }); } catch {}
      } else {
        applied = punishAffinity(uid, name, -25, '反击：严重冒犯尊严');
        entry.ignoreUntil = now + 2 * 3600_000;
        try { setMood(convKey, { emotion: '生气', intensity: 5, reason: '尊严被严重冒犯', term: 'long' }); } catch {}
        // 三级：写进长期记忆——「我记住你骂我了」。
        try {
          globalMemoryAppend({
            text: `【我记住你】${name || uid}（${uid}）在 ${convKey} 骂过我/把我当机器，${new Date().toLocaleDateString('zh-CN')}。我不会忘。`,
            tags: ['记仇', '纪律'],
            tier: 'long',
            key: convKey
          });
        } catch {}
      }
      // 被警告后 10 小时内好感上限只有 50（并立即压到 50 以内）。
      try {
        const af = loadAffinity();
        const p = af.people[uid];
        if (p) {
          p.warnedUntil = now + (Number(cfg.socialV2?.affinity?.warnCapHours) || 24) * 3600_000;
          p.warnedAt = now;
          p.score = Math.min(50, Number(p.score || 0));
          saveAffinity();
        }
      } catch {}
      addStress(convKey, level === 3 ? 40 : level === 2 ? 25 : 15);
      try {
        addEvent({
          key: convKey,
          kind: level >= 3 ? '严重冒犯' : '冒犯',
          who: `${name || ''}(${uid})`,
          what: `${tags.join('/')}：${String(text || '').slice(0, 60)}`,
          importance: Math.min(5, level + 1)
        });
      } catch {}
      log(`纪律：${name || uid} 触发 ${level} 级（${tags.join('/')}），好感 -> ${applied}`);
    }
    // 性暗示词：每次都会涨压力 + 加生气（不依赖是否升级）。
    if (sexual) {
      try {
        addStress(convKey, 8);
        const cur = getMood(convKey);
        const intensity = cur && cur.emotion === '生气' ? Math.min(5, (Number(cur.intensity) || 3) + 1) : 3;
        setMood(convKey, { emotion: '生气', intensity, reason: '对方说了不雅的词', term: 'short' });
      } catch {}
    }
    saveDiscipline();
    return { level, score: entry.score, tags, affinity: applied, ignoreUntil: entry.ignoreUntil || 0 };
  }
  // 被夸奖：记一条事件（每小时每群最多一条，避免刷屏）
  const praiseAt = new Map();
  // ── 晚安广播：私聊发一个信号，她按各群心情分别道晚安 ──────────────────────
  function goodnightTriggerText(text) {
    const s = String(text || '').replace(/\s+/g, '').trim();
    if (!s || s.length > 12) return false;
    const list = Array.isArray(cfg.socialV2?.goodnight?.triggers) && cfg.socialV2.goodnight.triggers.length
      ? cfg.socialV2.goodnight.triggers
      : ['/晚安', '/睡觉', '晚安', '晚安收工', '去睡吧', '睡觉去', '我去睡了'];
    return list.some((t) => s === String(t).replace(/\s+/g, ''));
  }
  function goodnightToneHint(key) {
    const m = getMood(key);
    const emo = m?.emotion || '';
    if (emo === '生气') return '语气冷一点、简短，别热络。';
    if (emo === '难过' || emo === '委屈') return '语气低一点、淡淡的。';
    if (emo === '害羞') return '软一点、有点不好意思。';
    if (emo === '开心' || emo === '得意') return '语气轻快、带点不舍。';
    if (emo === '吃醋') return '有点傲娇，嘴上不饶人。';
    return '用你平时在这个群的语气。';
  }
  async function broadcastGoodnight(source = 'manual', opts = {}) {
    const groups = (cfg.allow?.groups || []).map(String);
    const portNum = Number(cfg.consolePort) || 3100;
    const tokenNow = loadOrCreateConsoleToken();
    const plan = [];
    let sent = 0;
    for (const gid of groups) {
      const gk = `group:${gid}`;
      if (!isSessionAllowedInCurrentMode(gk)) continue;
      // 默认只给「有会话的群」道晚安，避免为冷群新建会话浪费 token。
      if (cfg.socialV2?.goodnight?.includeInactive !== true && !state.sessions?.[gk]) continue;
      const hint = goodnightToneHint(gk);
      const m0 = getMood(gk);
      const emo0 = m0?.emotion || '';
      const canned0 = emo0 === '生气' ? '我睡了。'
        : (emo0 === '难过' || emo0 === '委屈') ? '先睡了，晚安。'
          : emo0 === '害羞' ? '那……我睡了，晚安。'
            : (emo0 === '开心' || emo0 === '得意') ? '我去睡啦，明天见～'
              : emo0 === '吃醋' ? '哼，我睡了。'
                : '睡了，晚安。';
      plan.push({ key: gk, hint, ...((opts.canned || !dshReady) ? { text: canned0 } : {}) });
      if (opts.dry) continue;
      if (!dshReady || opts.canned) {
        const canned = canned0;
        try { await sendToQQ(gk, canned); sent += 1; } catch {}
        continue;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${portNum}/api/console/notify-ai`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': tokenNow },
          body: JSON.stringify({
            key: gk,
            message: `老大要关机睡觉了，你也要去睡了。在这个群道个晚安——${hint} 一句话就够，发完用 qq_set_wake_config 设无限潜水收尾，不要解释这是安排。`
          })
        });
        if (res.ok) sent += 1;
      } catch {}
      await sleep(2500);
    }
    log(`晚安广播（${source}）：${opts.dry ? '计划' : '已发送'} ${opts.dry ? plan.length : sent}/${groups.length} 个群${opts.dry ? '（演练）' : ''}`);
    return { sent, total: groups.length, plan };
  }
  // DSH 关闭兜底：DSH 掉了并持续一段时间没回来 → 在群里发晚安（不依赖模型）。
  let dshExitGoodnightTimer = null;
  let goodnightExitAt = 0;
  function cancelDshExitGoodnight() {
    if (dshExitGoodnightTimer) { clearTimeout(dshExitGoodnightTimer); dshExitGoodnightTimer = null; }
    // DSH 已经回来了，夜间休眠标记作废（避免看门狗之后误跳过）。
    try { fs.unlinkSync(path.join(STATE_DIR, 'dsh-sleep.json')); } catch {}
  }
  function scheduleDshExitGoodnight() {
    const gc = cfg.socialV2?.goodnightOnDshExit ?? {};
    if (gc.enabled === false) return;
    if (dshExitGoodnightTimer) return;
    const grace = Math.max(10000, Number(gc.graceMs) || 120000);
    dshExitGoodnightTimer = setTimeout(() => {
      dshExitGoodnightTimer = null;
      if (dshReady) return;
      const h = new Date().getHours();
      const win = Array.isArray(gc.window) ? gc.window : [20, 6];
      const from = Number(win[0]) || 0;
      const to = Number(win[1]) || 6;
      const inWindow = from <= to ? (h >= from && h < to) : (h >= from || h < to);
      if (!inWindow) { log(`DSH 关闭，但不在晚安时段（${from}:00-${to}:00），跳过群发`); return; }
      const cool = Math.max(1, Number(gc.cooldownHours) || 6) * 3600_000;
      if (Date.now() - goodnightExitAt < cool) { log('DSH 关闭晚安：冷却中，跳过'); return; }
      goodnightExitAt = Date.now();
      void broadcastGoodnight('DSH关闭兜底', { canned: true }).catch((error) => log('DSH 关闭晚安失败：', error?.message ?? error));
      // 写夜间休眠标记：让看门狗在早上之前不要把 DSH 拉起来。
      try {
        const endH = Number(win[1]) || 6;
        const until = new Date();
        until.setHours(Math.min(23, endH + 2), 0, 0, 0);
        if (until.getTime() <= Date.now()) until.setDate(until.getDate() + 1);
        atomicWriteJson(path.join(STATE_DIR, 'dsh-sleep.json'), { until: until.getTime(), at: Date.now(), source });
        log('已写入夜间休眠标记，至 ' + until.toLocaleString('zh-CN'));
      } catch {}
    }, grace);
    dshExitGoodnightTimer.unref?.();
    log(`DSH 已断开：${Math.round(grace / 1000)} 秒内没恢复，就在群里发晚安`);
  }

  function maybeGoodnightSignal(key, text) {
    if (!goodnightTriggerText(text)) return;
    if (!cfg.socialV2?.goodnight?.enabled) return;
    const now = Date.now();
    if (now - (Number(goodnightAt) || 0) < 10 * 60_000) return; // 10 分钟防重复
    goodnightAt = now;
    void broadcastGoodnight('私聊信号').catch((error) => log(`晚安广播失败：${error?.message ?? error}`));
    setTimeout(() => { try { void sendToQQ(key, '好，我去各个群说一声，你也早点睡。'); } catch {} }, 1200);
  }
  let goodnightAt = 0;

  function notePraise(key, name, text) {
    try {
      const s = String(text ?? '');
      if (!/(厉害|好棒|好强|牛|聪明|可爱|喜欢你|真不错|夸夸)/.test(s)) return;
      if (!/(小鲸鱼|闪电侠|deepseek|d老师|你)/i.test(s)) return;
      const now = Date.now();
      if (now - (Number(praiseAt.get(key)) || 0) < 3600_000) return;
      praiseAt.set(key, now);
      addEvent({ key, kind: '被夸', who: String(name || ''), what: s.slice(0, 80), importance: 2 });
    } catch {}
  }

  function disciplineLineFor(key) {
    const db = loadDiscipline();
    const rows = [];
    for (const [id, e] of Object.entries(db.users || {})) {
      if (!id.startsWith(`${key}|`)) continue;
      if (!e || !e.level) continue;
      if (Date.now() - Number(e.lastAt || 0) > 24 * 3600_000) continue;
      rows.push(e);
    }
    if (!rows.length) return '';
    const now = Date.now();
    const parts = rows.map((e) => {
      const uid = e.name || '某人';
      const tags = (e.tags || []).join('/');
      if (e.ignoreUntil && now < e.ignoreUntil) {
        return `${uid}：已进入反击+冷处理（还剩 ${Math.round((e.ignoreUntil - now) / 60000)} 分钟不理ta；ta 的问题：${tags}）`;
      }
      return `${uid}：${e.level} 级警告（ta 的问题：${tags}）`;
    });
    return `【纪律·生气】${parts.join('；')}。注意：这是「生气」，是对冒犯你的人的**态度**，不是压力；只针对这个人，别波及无辜。做法：\n1) 警告时**点出 ta 具体哪里过分**（例：「你刚把我当翻译机使唤，还问我有什么用」），不空骂、不讲大道理；\n2) 被当机器/贬低/辱骂/冒犯主人 → 一级警告→二级警告→反击（好感-50、生气、可用贴吧/B站梗回怼，但不骂家人、不搞地域歧视）；\n3) **被骂/被侮辱时要立刻反击**：1 级警告后仍不改，就直接怼回去，可用 qq_slang_query 找一句群里的黑话/梗，但别骂家人、别搞地域歧视；
4) **对方说不雅的词/性暗示**：正面提「讲文明」，不接梗、不跟着玩，语气可以是提醒或嫌弃；累积到一定程度就按警告处理；\n4) 警告期间不理该用户、去安慰其他人；\n5) **对方道歉或冷处理时间到了，就恢复正常**，别一直端着、别反复翻旧账。\n\n`;
  }

  // 时间到 / 道歉后恢复：解除纪律、把长期生气降回平静。
  function expireDiscipline() {
    const db = loadDiscipline();
    const now = Date.now();
    let changed = 0;
    for (const [id, e] of Object.entries(db.users || {})) {
      if (!e || !e.level) continue;
      const done = (e.ignoreUntil && now > e.ignoreUntil) || now - Number(e.lastAt || 0) > 12 * 3600_000;
      if (!done) continue;
      e.level = 0;
      e.score = 0;
      e.tags = [];
      e.ignoreUntil = 0;
      e.recoveredAt = now;
      changed += 1;
      const convKey = id.split('|')[0];
      try {
        if (getLongMood(convKey)?.emotion === '生气') {
          setMood(convKey, { emotion: '平静', intensity: 1, reason: '气消了，恢复正常', term: 'long' });
        }
      } catch {}
    }
    if (changed) { saveDiscipline(); log(`纪律恢复：${changed} 人冷处理结束，已切回正常`); }
    return changed;
  }
  function forgiveOffense(convKey, uid, reason) {
    const { db, id, entry } = disciplineEntry(convKey, uid);
    if (!entry || !entry.level) return false;
    entry.level = 0;
    entry.score = 0;
    entry.tags = [];
    entry.ignoreUntil = 0;
    entry.recoveredAt = Date.now();
    entry.recoveredBy = String(reason || '');
    saveDiscipline();
    try {
      if (getLongMood(convKey)?.emotion === '生气') {
        setMood(convKey, { emotion: '平静', intensity: 1, reason: '对方道歉了，气消了', term: 'long' });
      }
    } catch {}
    log(`纪律：${uid} 已恢复（${reason}）`);
    return true;
  }

  function canDeduct(entry, amount, now) {
    const cap = Math.max(1, Number(cfg.socialV2?.affinity?.deductPerHour) || 30);
    const d = entry.deduct && typeof entry.deduct === 'object' ? entry.deduct : { at: 0, sum: 0 };
    if (now - Number(d.at || 0) > 3600_000) { d.at = now; d.sum = 0; }
    if (Number(d.sum) + amount > cap) return false;
    d.sum = Number(d.sum || 0) + amount;
    entry.deduct = d;
    return true;
  }
  // ── 喜爱：好感满 100 才会涨，且很难涨；只有让她「开心/害羞」才涨 ──────────
  // 主人有先发优势（初始 10）和成长加成（+2）；其他人 +1。最高者获得「恋爱属性」。
  const LOVE_LEVELS = [[0, '有好感'], [10, '喜欢'], [30, '很在乎'], [60, '心动'], [100, '恋爱对象']];
  function loveLevel(v) {
    let label = '有好感';
    for (const [min, name] of LOVE_LEVELS) if (v >= min) label = name;
    return label;
  }
  function addLove(userId, delta, reason) {
    const id = String(userId ?? '').trim();
    if (!id) return null;
    const db = loadAffinity();
    const p = db.people[id];
    if (!p) return null;
    // 好感没满 100，喜爱不涨
    if (Number(p.score) < 100) return null;
    const isOwner = String(cfg.ownerQQ ?? '') === id;
    const amount = Math.max(0, Number(delta) || 0) * (isOwner ? 2 : 1);
    if (!amount) return null;
    p.love = Math.min(100, (Number(p.love) || 0) + amount);
    p.loveAt = Date.now();
    if (reason) p.loveNote = String(reason).slice(0, 60);
    saveAffinity();
    return { userId: id, love: p.love, level: loveLevel(p.love) };
  }
  // 喜爱会掉：被伤害、被冷落、好感掉下 100 都会缩水。
  function loseLove(userId, amount, reason) {
    const id = String(userId ?? '').trim();
    if (!id) return null;
    const db = loadAffinity();
    const p = db.people[id];
    if (!p || !Number(p.love)) return null;
    const loss = Math.max(0, Number(amount) || 0);
    if (!loss) return null;
    p.love = Math.max(0, Number(p.love) - loss);
    p.loveAt = Date.now();
    if (reason) p.loveNote = String(reason).slice(0, 60);
    saveAffinity();
    return { userId: id, love: p.love, level: loveLevel(p.love) };
  }
  function loveTop() {
    const db = loadAffinity();
    let best = null;
    for (const [id, p] of Object.entries(db.people || {})) {
      const v = Number(p.love) || 0;
      if (v <= 0) continue;
      if (!best || v > best.love) best = { uid: id, name: p.name || id, love: v };
    }
    return best;
  }
  // ── 特别关照名单：仅次于主人的优先级（默认 Chaos），优先安慰、可温柔可傲娇 ──
  function careUsers() {
    const list = Array.isArray(cfg.socialV2?.careUsers) ? cfg.socialV2.careUsers : [];
    return list.filter((c) => c && c.uid);
  }
  function careLineFor(key) {
    const care = careUsers();
    if (!care.length) return '';
    const af = loadAffinity();
    const ids = Array.isArray(af.lastSenders[key]) ? af.lastSenders[key].map(String) : [];
    const parts = [];
    for (const c of care) {
      const uid = String(c.uid);
      if (!ids.includes(uid)) continue;
      const p = af.people[uid] || {};
      const txt = String(p.lastText || '');
      const distress = /(难过|烦|累|崩|被骂|委屈|不开心|倒霉|哭了|心态炸)/.test(txt);
      const who = c.name || p.name || uid;
      const note = c.note || '好朋友';
      if (distress) {
        parts.push(`${who}（${note}）刚才好像不太顺——**优先安慰他**，别急着讲道理；先接住情绪，再给建议。`);
      } else {
        parts.push(`${who}（${note}）优先级仅次于主人：对他可以温柔一点，也可以傲娇——嘴上嫌弃、实际关心。`);
      }
    }
    if (!parts.length) return '';
    return `【特别关照】${parts.join('；')}\n\n`;
  }

  // 记仇 / 被夸 / 被冷落的即时提示
  function suspectedLineFor(key) {
    const st = getSocialV2State(key);
    const sp = st.suspected;
    if (!sp || Date.now() - Number(sp.at) > 10 * 60 * 1000) return '';
    return `【疑似侮辱】${sp.from} 刚说了「${sp.text}」——是不是辱骂，**你自己判断**：看意图、看伤害，不是看有没有脏字。嘲外貌/家人/身世、贬低人格、冒充长辈、性暗示都算；玩笑和玩梗不算。确认是侮辱就用 qq_judge_offense 记一笔，再决定警告还是冷处理。\n\n`;
  }

  function memeLineFor(key) {
    try {
      const st = getSocialV2State(key);
      const h = st.memeHint;
      if (!h || Date.now() - Number(h.at) > 5 * 60 * 1000) return '';
      if (h.text) {
        return `【群里刚提到的梗】${h.text}\n接梗优先：先照「怎么用」自然接一句（像本来就会），只有对方明确问出处才解释一两句；别背百科。\n\n`;
      }
      if (h.source === 'miss' && h.term) {
        return `【梗】「${h.term}」本地词库和 wiki 都没收录——别硬解释：可以说没听过/反问「这什么梗」，也可以先用 qq_meme 再查一次；**搞清楚之后用 qq_meme_learn 记下来**（含义、怎么用、出处），以后就查得到了。\n\n`;
      }
    } catch {}
    return '';
  }

  function hatredLineFor(key) {
    const af = loadAffinity();
    const ids = (af.lastSenders[key] || []).map(String);
    const rows = ids.filter((id) => Number(af.people[id]?.hatred) > 0)
      .map((id) => `${af.people[id]?.name || id}（仇恨 ${Math.round(Number(af.people[id].hatred))}）`);
    if (!rows.length) return '';
    return `【记仇】${rows.join('；')}——你不理他，他说话当没看见；除非他认真道歉，不然别主动搭话。\n\n`;
  }
  // ── 青春期的喜欢：害羞、吃醋、主动表白 ──────────────────────────────
  const CONFESS_RE = /(喜欢你|爱你|做我女朋友|和我在一起|当我女朋友|表白|嫁给我|想和你在一起)/;
  const JEALOUS_RE = /(以前喜欢|以前暗恋|初恋|前女友|前男友|别的女孩|别的女生|其他女生|另一个女生|我喜欢的女生|之前喜欢)/;
  const CALM_RE = /(只是以前|早就没联系|现在只喜欢你|没有别人|你才是我|别吃醋|只喜欢你一个)/;
  function noteRomance(key, uid, name, text) {
    try {
      const st = getSocialV2State(key);
      const top = loveTop();
      const isLoved = (top && String(top.uid) === String(uid)) || String(uid) === String(cfg.ownerQQ);
      if (!isLoved) return;
      const now = Date.now();
      if (CONFESS_RE.test(text)) {
        st.shyUntil = now + 30 * 60 * 1000;
        const day = new Date().toDateString();
        if (st.confessDay !== day) { st.confessDay = day; st.confessCount = 0; }
        st.confessCount = (Number(st.confessCount) || 0) + 1;
        if (st.confessCount >= 5) { st.confessUrgeAt = now; }
      }
      if (JEALOUS_RE.test(text)) {
        if (now - Number(st.jealousAt || 0) > 30 * 60 * 1000) {
          st.jealousAt = now;
          st.jealousUntil = now + 30 * 60 * 1000;
          bumpAffinity(uid, name, key, '');
          punishAffinity(uid, name, -5, '吃醋：提起以前的喜欢');
        }
      }
      if (CALM_RE.test(text) && st.jealousUntil) {
        st.jealousUntil = 0;
        st.jealousAt = 0;
        bumpAffinity(uid, name, key, '谢谢你');
      }
    } catch {}
  }
  function shyLineFor(key) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const shy = Number(st.shyUntil) > now;
    const jealous = Number(st.jealousUntil) > now;
    const urge = Number(st.confessUrgeAt) > 0 && now - Number(st.confessUrgeAt) < 24 * 3600_000;
    const bits = [];
    if (shy) bits.push('【害羞中】他刚跟你表白，你整个人都慌了：脸红、说话打结、不敢直视，别马上答应也别拒绝，就那个别扭劲儿。');
    if (jealous) bits.push('【吃醋中】他提了以前的喜欢/别的女孩，你心里酸得不行：语气变冷、别过头、故意说反话；他认真解释清楚之前别轻易消气。');
    if (urge) bits.push('【忍不住了】他这几天一直说喜欢——你也憋不住了：找个自然的时机，小声但认真地说一句「我也喜欢你」；说完会羞得想钻地缝。');
    return bits.length ? bits.join('\n') + '\n\n' : '';
  }

  function praiseLineFor(key) {
    const af = loadAffinity();
    const ids = (af.lastSenders[key] || []).map(String);
    const last = ids[ids.length - 1];
    if (!last) return '';
    const txt = String(af.people[last]?.lastText || '');
    if (!/(厉害|好棒|好强|牛|聪明|可爱|喜欢你|真不错|夸夸)/.test(txt)) return '';
    return `【被夸】${af.people[last]?.name || last} 刚在夸你——**立刻回一句感谢**（可以带着得意或害羞，别装没看见）。\n\n`;
  }
  function neglectLineFor(key) {
    const top = loveTop();
    if (!top || top.love < 60) return '';
    const p = loadAffinity().people[top.uid];
    if (!p) return '';
    const gap = Date.now() - Number(p.lastAt || 0);
    if (gap < 24 * 3600_000) return '';
    return `【他很久没理你了】${top.name} 已经 ${Math.round(gap / 3600000)} 小时没找你——你有点不安，可以主动找他、多发几条（稍微黏、稍微病娇），但别真的吓到他。\n\n`;
  }

  function loveLineFor(key) {
    const top = loveTop();
    if (!top) return '';
    const rows = affinityRowsFor(key).filter((r) => (Number(loadAffinity().people[r.userId]?.love) || 0) > 0);
    const bits = rows.map((r) => {
      const love = Number(loadAffinity().people[r.userId]?.love) || 0;
      return `${r.name}：喜爱 ${love}/100（${loveLevel(love)}）`;
    });
    const isTopHere = rows.some((r) => r.userId === top.uid);
    let extra = '';
    if (isTopHere && top.love >= 1) {
      extra = `\n**恋爱属性**：你最在意的是 ${top.name}——对 ta 容易害羞、扭扭捏捏、说话打结；对其他人不会这样。ta 被夸你会紧张，ta 被说不好你会先炸。`;
    }
    return `【喜爱】${bits.length ? bits.join('；') : `你心里最在意 ${top.name}（${top.love}/100）`}。喜爱只有好感满 100 才涨，而且很难涨。${extra}\n\n`;
  }

  function adjustAffinity(userId, name, delta, reason) {
    const id = String(userId ?? '').trim();
    if (!id) throw new Error('userId 不能为空');
    const isOwner = String(cfg.ownerQQ ?? '') === id;
    const amount = Math.max(-10, Math.min(10, Number(delta) || 0));
    const db = loadAffinity();
    const now = Date.now();
    const entry = decayAffinity(db.people[id] || { score: 50, count: 0, lastAt: now, name: '' });
    // 主人也不再锁死好感度：会涨会掉；但「忠诚度」恒为 100。
    if (amount < 0) {
      if (!canDeduct(entry, Math.abs(amount), now)) {
        saveAffinity();
        throw new Error(`扣分额度用完了（每人每小时最多扣 ${Math.max(1, Number(cfg.socialV2?.affinity?.deductPerHour) || 30)} 分），过会儿再扣`);
      }
      entry.score = Math.max(0, Number(entry.score || 0) + amount);
    } else {
      const cap = (Number(entry.warnedUntil) || 0) > now ? 50 : 100;
      entry.score = Math.min(cap, Number(entry.score || 0) + amount);
    }
    if (isOwner) { entry.loyalty = 100; if (entry.love == null) entry.love = 10; }
    entry.name = String(name || entry.name || id).slice(0, 40);
    entry.lastAt = now;
    if (reason) entry.affinityNote = String(reason).replace(/\s+/g, ' ').slice(0, 80);
    db.people[id] = entry;
    saveAffinity();
    return { userId: id, score: Math.round(entry.score), loyalty: Number(entry.loyalty) || 0, delta: amount, note: entry.affinityNote || '' };
  }
  function bumpAffinity(userId, name, convKey, text) {
    const id = String(userId ?? '').trim();
    if (!id || id === String(selfUserId ?? '')) return;
    const db = loadAffinity();
    const now = Date.now();
    const isOwner = String(cfg.ownerQQ ?? '') === id;
    const entry = decayAffinity(db.people[id] || { score: 0, count: 0, lastAt: now, name: '' });
    // 主人：好感度会涨也会掉；忠诚度恒为 100。
    const t = String(text ?? '');
    const cap = (Number(entry.warnedUntil) || 0) > now ? 50 : 100;
    // 被警告过的人 24 小时内「成长减半」：+2 变 +1、+3 变 +1，防止靠刷消息快速洗白。
    const probation = now - (Number(entry.warnedAt) || 0) < 24 * 3600_000;
    // ── 加好感变难：冷却 + 质量门槛 + 递减 + 每日上限 ──────────────────────
    const afCfg = cfg.socialV2?.affinity ?? {};
    const gainCooldown = Number(afCfg.gainCooldownMs) || 5 * 60 * 1000;
    const dailyCap = Number(afCfg.gainDailyCap) || 10;
    const today = new Date().toDateString();
    if (entry.gainDay !== today) { entry.gainDay = today; entry.gainToday = 0; }
    const scoreNow = Number(entry.score) || 0;
    // 质量门槛：纯「哈/嗯/哦/6/问号」、太短、纯标点都不算有效互动
    const bare = t.replace(/[\s\p{P}\p{S}]/gu, '');
    const quality = bare.length >= 2 && !/^(哈+|嗯+|哦+|额+|啊+|嘿+|呵+|6+|草+|在吗|你好|hi|hello)$/i.test(bare);
    const canGain = quality && now - (Number(entry.lastGainAt) || 0) >= gainCooldown && (Number(entry.gainToday) || 0) < dailyCap;
    // 递减：60 分以下 +2，60~84 +1，85 以上 +0.5；警告期内一律最多 +1
    let gain = scoreNow < 60 ? 2 : scoreNow < 85 ? 1 : 0.5;
    if (probation) gain = Math.min(1, gain);
    const likeGain = Math.min(gain + 1, probation ? 1 : 3);
    if (AFFINITY_HOSTILE_RE.test(t)) {
      // 被怼/被骂/被叫雷点外号：扣分（受每小时上限约束）；跌破 0 的部分转成仇恨
      if (canDeduct(entry, 1, now)) {
        const DEDUCT = 1;
        const before = Number(entry.score || 0);
        const cut = Math.min(before, DEDUCT);
        entry.score = before - cut;
        const overflow = DEDUCT - cut;
        if (overflow > 0) entry.hatred = Math.min(100, (Number(entry.hatred) || 0) + overflow);
      }
    } else if (canGain) {
      // 加成只对好感 >= 85 的人生效：喜爱 ×3、其它 85+ ×2；低于 85 一律 ×1
      const top = loveTop();
      const isLoved = !!top && String(top.uid) === id && top.love >= 60;
      const factor = scoreNow >= 85 ? (isLoved ? 3 : 2) : 1;
      const delta = Math.min(20, (AFFINITY_LIKE_RE.test(t) ? likeGain : gain) * factor);
      entry.score = Math.min(cap, scoreNow + delta);
      entry.lastGainAt = now;
      entry.gainToday = (Number(entry.gainToday) || 0) + delta;
    }
    if (isOwner) { entry.loyalty = 100; if (entry.love == null) entry.love = 10; }
    entry.count = (Number(entry.count) || 0) + 1;
    entry.name = String(name || entry.name || '').slice(0, 40);
    entry.lastAt = now;
    entry.lastConv = String(convKey || entry.lastConv || '');
    const lastText = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (lastText) entry.lastText = lastText.slice(0, 60);
    db.people[id] = entry;
    if (convKey) {
      const list = Array.isArray(db.lastSenders[convKey]) ? db.lastSenders[convKey] : [];
      const next = list.filter((x) => String(x) !== id);
      next.push(id);
      db.lastSenders[convKey] = next.slice(-5);
    }
    const all = Object.entries(db.people);
    if (all.length > 500) {
      all.sort((a, b) => (Number(a[1]?.lastAt) || 0) - (Number(b[1]?.lastAt) || 0));
      for (let i = 0; i < all.length - 500; i += 1) delete db.people[all[i][0]];
    }
    saveAffinity();
  }
  function affinityLevel(score) {
    const s = Number(score) || 0;
    if (s >= 85) return '特别的人';
    if (s >= 60) return '好朋友';
    if (s >= 30) return '熟人';
    if (s >= 10) return '眼熟';
    return '陌生';
  }
  function affinityRowsFor(key) {
    const db = loadAffinity();
    const ids = Array.isArray(db.lastSenders[key]) ? db.lastSenders[key] : [];
    const rows = [];
    for (const id of ids) {
      const raw = db.people[id];
      if (!raw) continue;
      const isOwner = String(cfg.ownerQQ ?? '') === id;
      const e = decayAffinity({ ...raw });
      if (isOwner) e.loyalty = 100;
      const coldHours = Math.max(0.5, Number(cfg.socialV2?.affinity?.coldAfterHours) || 3);
      const cold = Number(e.lastAt) > 0 && Date.now() - Number(e.lastAt) > coldHours * 3600_000;
      rows.push({
        userId: id,
        name: e.name || id,
        score: Math.round(e.score),
        level: affinityLevel(e.score),
        loyalty: isOwner ? 100 : (Number(e.loyalty) || 0),
        cold,
        count: e.count || 0
      });
    }
    return rows;
  }
  function affinityLineFor(key) {
    const rows = affinityRowsFor(key);
    if (!rows.length) return '';
    const text = rows.map((r) => `${r.name}：${r.level}（好感 ${r.score}/100${r.loyalty ? `｜忠诚 ${r.loyalty}/100` : ''}${r.cold ? '｜好久没聊，有点冷' : ''}）`).join('；');
    return `【好感度】${text}。\n按分数决定你的态度：80+ 热情、黏一点、主动找话题；60~79 自然放松；30~59 客气但有距离；10~29 冷淡、只回必要；10 以下基本不理。\n**初见的新人**（没档案、互动少于 3 次）一律热情——数据还不够，先当好人，别预设立场。\n忠诚是底线：对主人忠诚恒为 100，但好感会因为他惹你生气而掉、哄回来再涨。\n\n`;
  }

  // ── 印象系统：她对每个人的主观判断（什么样的人、对她好不好）────────────
  // 由她自己用 qq_impression 写/改；持久化、跨群共享，注入提示词但不对外复述。
  const IMPRESSION_FILE = path.join(STATE_DIR, 'impressions.json');
  let impressionCache = null;
  function loadImpressions() {
    if (impressionCache) return impressionCache;
    try {
      const data = readJsonSafe(IMPRESSION_FILE, { people: {} });
      impressionCache = {
        people: data?.people && typeof data.people === 'object' ? data.people : {},
        // 人与人之间的关系（她自己观察到的）：fromUid → [{ to, kind, note, at }]
        relations: data?.relations && typeof data.relations === 'object' ? data.relations : {}
      };
    } catch {
      impressionCache = { people: {}, relations: {} };
    }
    return impressionCache;
  }
  function saveImpressions() {
    try { atomicWriteJson(IMPRESSION_FILE, impressionCache ?? { people: {}, relations: {} }); } catch {}
  }
  function setImpression(userId, name, text, sentiment, extra = {}) {
    const id = String(userId ?? '').trim();
    if (!id) throw new Error('userId 不能为空');
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean) throw new Error('印象内容不能为空');
    const tone = ['善良', '中性', '坏'].includes(String(sentiment ?? '')) ? String(sentiment) : '中性';
    const db = loadImpressions();
    const prev = db.people[id] || {};
    // 性格标签：逗号/顿号分隔，最多 6 个
    const traits = Array.isArray(extra.traits)
      ? extra.traits.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 6)
      : String(extra.traits ?? '').split(/[,，、/\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
    db.people[id] = {
      ...prev,
      name: String(name || prev.name || id).slice(0, 40),
      text: clean,
      sentiment: tone,
      traits: traits.length ? traits : (Array.isArray(prev.traits) ? prev.traits : []),
      mbti: String(extra.mbti ?? prev.mbti ?? '').trim().toUpperCase().slice(0, 8),
      attitude: String(extra.attitude ?? prev.attitude ?? '').trim().slice(0, 30),
      // 历史版本：印象不是覆盖丢弃，旧版本全部留着（最多 20 版），可以回看ta怎么变的。
      history: [
        ...(Array.isArray(prev.history) ? prev.history : []),
        ...(prev.text ? [{ text: prev.text, sentiment: prev.sentiment || '中性', traits: prev.traits || [], mbti: prev.mbti || '', attitude: prev.attitude || '', at: Number(prev.updatedAt) || Date.now() }] : [])
      ].slice(-20),
      updatedAt: Date.now()
    };
    saveImpressions();
    return db.people[id];
  }
  // 她观察到的人与人之间的关系：只记「她看到的」，三种定性 + 一句备注。
  const RELATION_KINDS = ['亲近', '对立', '依赖'];
  function setRelation(fromUid, toUid, kind, note) {
    const from = String(fromUid ?? '').trim();
    const to = String(toUid ?? '').trim();
    if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) throw new Error('from / to 必须是 QQ 号');
    if (from === to) throw new Error('不能记自己跟自己的关系');
    const k = RELATION_KINDS.includes(String(kind ?? '').trim()) ? String(kind).trim() : '';
    if (!k) throw new Error('kind 只能是：' + RELATION_KINDS.join(' / '));
    const clean = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const db = loadImpressions();
    if (!db.relations) db.relations = {};
    const list = Array.isArray(db.relations[from]) ? db.relations[from] : [];
    const existing = list.find((r) => r && String(r.to) === to);
    const entry = { to, kind: k, note: clean, at: Date.now() };
    if (existing) Object.assign(existing, entry);
    else list.push(entry);
    db.relations[from] = list.slice(-30);          // 每个人最多记 30 条
    saveImpressions();
    return entry;
  }

  function relationsOf(uid) {
    const db = loadImpressions();
    const list = Array.isArray(db.relations?.[String(uid)]) ? db.relations[String(uid)] : [];
    return list.map((r) => ({ ...r, name: db.people?.[r.to]?.name || '' }));
  }

  function impressionRowsFor(key) {
    const db = loadImpressions();
    const af = loadAffinity();
    const ids = Array.isArray(af.lastSenders[key]) ? af.lastSenders[key] : [];
    return ids
      .filter((id) => db.people[id])
      .map((id) => ({ userId: id, ...db.people[id] }));
  }
  // 全体人物档案：不依赖「最近说过话」，bootstrap 时完整注入（最多 12 人），保证印象不会因为没人说话而消失。
  // 喜爱联动：有人提到「喜爱最高的人」→ 警觉；说甜话 → 吃醋；侮辱 → 生气。
  function checkLoveDynamics(key, uid, name, text) {
    const top = loveTop();
    if (!top) return null;
    if (String(uid) === String(top.uid)) return null;
    const s = String(text ?? '');
    if (!top.name || !s.includes(top.name)) return null;
    // 把名字本身剔掉再判断语气，避免名字里带「爱/喜欢」造成误判。
    const rest = s.split(top.name).join('');
    if (/(傻|废物|垃圾|滚|配不上|舔狗|丑|恶心|烦人)/.test(rest)) {
      punishAffinity(uid, name, -10, `侮辱你的喜爱对象${top.name}`);
      addStress(key, 15);
      try { setMood(key, { emotion: '生气', intensity: 4, reason: `有人侮辱${top.name}`, term: 'short' }); } catch {}
      return 'insult';
    }
    if (/(喜欢|爱|想你|宝贝|亲爱的|表白|在一起|心动|老婆|老公|好看|可爱)/.test(rest)) {
      try { setMood(key, { emotion: '吃醋', intensity: 3, reason: `有人对${top.name}说甜话`, term: 'short' }); } catch {}
      return 'jealous';
    }
    try { setMood(key, { emotion: '好奇', intensity: 3, reason: `有人提到${top.name}`, term: 'short' }); } catch {}
    return 'alert';
  }

  function impressionRosterLine() {
    const db = loadImpressions();
    const rows = Object.entries(db.people || {})
      .map(([id, p]) => ({ userId: id, ...p }))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      .slice(0, 12);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const bits = [];
      if (Array.isArray(r.traits) && r.traits.length) bits.push(r.traits.join('/'));
      if (r.mbti) bits.push(r.mbti);
      return `- ${r.name}（${r.userId}｜${r.sentiment}）：${r.text}${bits.length ? `（${bits.join('，')}）` : ''}`;
    });
    return `【人物档案】你认识的人（长期保留）：\n${lines.join('\n')}\n\n`;
  }

  function impressionLineFor(key) {
    const rows = impressionRowsFor(key);
    if (!rows.length) return '';
    const fmt = (r) => {
      const bits = [];
      if (Array.isArray(r.traits) && r.traits.length) bits.push(`性格：${r.traits.join('/')}`);
      if (r.mbti) bits.push(`MBTI：${r.mbti}`);
      if (r.attitude) bits.push(`对你的态度：${r.attitude}`);
      return `${r.name}：${r.text}（${r.sentiment}${bits.length ? `；${bits.join('；')}` : ''}）`;
    };
    const text = rows.map(fmt).join('；');
    // 画像提醒：聊得多但还没写画像 / 画像太旧
    let nudge = '';
    for (const a of affinityRowsFor(key)) {
      const imp = loadImpressions().people[a.userId];
      const age = Date.now() - Number(imp?.updatedAt || 0);
      if (a.count >= 3 && a.count < 15 && !imp) {
        nudge = `${a.name} 你才刚开始了解，先记一句**具体观察**（他怎么说话、对谁什么态度），别急着下定论（qq_impression）。`;
        break;
      }
      if (a.count >= 15 && (!imp || age > 7 * 86400_000)) {
        nudge = `${a.name} 你已经聊了不少，ta 可能变了：更新一下画像，写具体一点（qq_impression）。`;
        break;
      }
      if (imp && age > 14 * 86400_000) {
        nudge = `${a.name} 的画像两个多星期没动了，也许该看看 ta 最近有没有不一样。`;
        break;
      }
    }
    return `【印象】${text}。这是你自己的判断，影响你怎么对ta说话；别把印象原样说给对方听。觉得看错了就用 qq_impression 改。${nudge ? `\n【画像提醒】${nudge}` : ''}\n\n`;
  }

  // ── 心情：分「长期底色」和「短期当下」，可以叠加 ─────────────────────────
  // 长期：几天不散的情绪（最近一直是开心的/最近有点丧），每天强度 -1，5 天后消失。
  // 短期：当下的情绪，2 小时后回落。两者同时存在时会揉在一起表达。
  const MOOD_EMOTIONS = ['开心', '生气', '吃醋', '难过', '好奇', '骄傲', '平静', '委屈', '得意', '害羞'];
  let moodCache = null;
  function loadMood() {
    try {
      if (moodCache) return moodCache;
      const data = readJsonSafe(MOOD_FILE, { moods: {}, longTerm: {} });
      moodCache = {
        moods: data?.moods && typeof data.moods === 'object' ? data.moods : {},
        longTerm: data?.longTerm && typeof data.longTerm === 'object' ? data.longTerm : {}
      };
      return moodCache;
    } catch {
      return { moods: {}, longTerm: {} };
    }
  }
  function saveMood() {
    try { atomicWriteJson(MOOD_FILE, moodCache ?? { moods: {}, longTerm: {} }); } catch {}
  }
  function moodTtlMs() {
    return Number(cfg.socialV2?.mood?.ttlMs) || 2 * 60 * 60 * 1000;
  }
  function longMoodTtlMs() {
    return Number(cfg.socialV2?.mood?.longTtlMs) || 5 * 86400_000;
  }
  function getMood(key) {
    const db = loadMood();
    const m = db.moods[key];
    if (!m) return null;
    if (Date.now() - (Number(m.at) || 0) > moodTtlMs()) return null;
    return m;
  }
  function getLongMood(key) {
    const db = loadMood();
    const m = db.longTerm?.[key];
    if (!m) return null;
    const age = Date.now() - (Number(m.at) || 0);
    if (age > longMoodTtlMs()) return null;
    const days = Math.floor(age / 86400_000);
    const intensity = Math.max(1, (Number(m.intensity) || 3) - days);
    return { ...m, intensity };
  }
  function setMood(key, { emotion, intensity, reason, term }) {
    const name = String(emotion ?? '').trim();
    if (!MOOD_EMOTIONS.includes(name)) throw new Error(`emotion 必须是：${MOOD_EMOTIONS.join(' / ')}`);
    const db = loadMood();
    const target = term === 'long' ? db.longTerm : db.moods;
    target[key] = {
      emotion: name,
      intensity: Math.min(5, Math.max(1, Number(intensity) || 3)),
      reason: String(reason ?? '').slice(0, 100),
      at: Date.now()
    };
    saveMood();
    // 在群里开心会记「开心分」：开心 +1、得意 +1、骄傲 +2、害羞 +3（只算短期，避免长期重复计分）。
    const JOY_WEIGHT = { 开心: 1, 得意: 1, 骄傲: 2, 害羞: 3 };
    if (term !== 'long' && key.startsWith('group:') && JOY_WEIGHT[name]) {
      try { noteGroupJoy(key, JOY_WEIGHT[name]); } catch {}
    }
    // 喜爱：只有她对某人「开心/害羞」时才涨（对方好感必须满 100）。
    if (term !== 'long' && ['开心', '害羞'].includes(name)) {
      try {
        const af = loadAffinity();
        const ids = Array.isArray(af.lastSenders[key]) ? af.lastSenders[key] : [];
        const last = ids[ids.length - 1];
        if (last) addLove(last, 1, `你${name}了`);
      } catch {}
    }
    return target[key];
  }

  // ── 群评分（只针对群聊）：出场次数 + 开心次数 + 消息量 + 她的主观加分 ──────
  // 高分 = 她在这儿冒泡多、也开心 → 提示词里鼓励多接话；低分 = 少硬刷存在感。
  let groupStatsCache = null;
  // 聊天记录扫描（只读）：一次读盘同时产出
  //   · memberships  uid → [群号…]
  //   · messages     最近 14 天的消息（用于人与人的连线）
  // 缓存 5 分钟，避免每次请求都扫盘。
  let socialScanCache = { at: 0, memberships: {}, messages: [] };
  function socialTranscriptScan() {
    const now = Date.now();
    if (now - socialScanCache.at < 300000) return socialScanCache;
    const memberships = Object.create(null);
    const messages = [];
    const since = now - 14 * 86400000;
    const dir = path.join(STATE_DIR, 'transcripts');
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('group_')) continue;
        const gid = name.slice(6);
        const full = path.join(dir, name);
        for (const f of fs.readdirSync(full)) {
          if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
          let text;
          try { text = fs.readFileSync(path.join(full, f), 'utf8'); } catch { continue; }
          for (const line of text.split('\n')) {
            if (!line || line.indexOf('"u"') < 0) continue;
            try {
              const m = JSON.parse(line);
              const uid = String(m?.u ?? '');
              if (!/^\d+$/.test(uid)) continue;
              if (!memberships[uid]) memberships[uid] = [];
              if (memberships[uid].indexOf(gid) < 0) memberships[uid].push(gid);
              const t = Number(m?.t) || 0;
              if (m?.me || !t || t < since) continue;
              const x = typeof m?.x === 'string' ? m.x.slice(0, 300) : '';
              if (!x) continue;
              messages.push({ t, u: uid, g: gid, x });
            } catch {}
          }
        }
      }
    } catch {}
    socialScanCache = { at: now, memberships, messages };
    return socialScanCache;
  }

  function loadGroupStats() {
    if (groupStatsCache) return groupStatsCache;
    let loaded = null;
    try { loaded = readJsonSafe(path.join(STATE_DIR, 'group-stats.json'), null); } catch { loaded = null; }
    if (loaded && typeof loaded === 'object' && Object.keys(loaded).length) {
      groupStatsCache = loaded;
      return groupStatsCache;
    }
    // 第一次运行：用已有的会话历史播种（出场/消息量），避免从 0 开始看不懂。
    groupStatsCache = {};
    try {
      for (const [k, st] of socialV2.conversations.entries()) {
        if (!k.startsWith('group:')) continue;
        const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
        groupStatsCache[k] = {
          speaks: recent.filter((m) => m && m.isSelf).length,
          msgs: recent.filter((m) => m && !m.isSelf).length,
          joys: 0,
          bonus: 0,
          updatedAt: Date.now()
        };
      }
    } catch {}
    try { saveGroupStats(); } catch {}
    return groupStatsCache;
  }
  function saveGroupStats() {
    try { atomicWriteJson(path.join(STATE_DIR, 'group-stats.json'), groupStatsCache ?? {}); } catch {}
  }
  function groupStatEntry(key) {
    const db = loadGroupStats();
    if (!db[key]) db[key] = { speaks: 0, joys: 0, msgs: 0, bonus: 0, updatedAt: Date.now() };
    return db[key];
  }
  function noteGroupSpeak(key) {
    if (!key.startsWith('group:')) return;
    const e = groupStatEntry(key); e.speaks = (Number(e.speaks) || 0) + 1; e.updatedAt = Date.now(); saveGroupStats();
  }
  function noteGroupJoy(key, weight = 1) {
    if (!key.startsWith('group:')) return;
    const e = groupStatEntry(key);
    e.joys = (Number(e.joys) || 0) + Math.max(1, Number(weight) || 1);
    e.updatedAt = Date.now();
    saveGroupStats();
  }
  function noteGroupMsg(key) {
    if (!key.startsWith('group:')) return;
    const e = groupStatEntry(key); e.msgs = (Number(e.msgs) || 0) + 1; e.updatedAt = Date.now(); saveGroupStats();
  }
  function groupScore(key) {
    const e = groupStatEntry(key);
    // 出场权重调低（×2，上限 35）；开心分权重调高（上限 45）。
    const score = Math.min(35, (Number(e.speaks) || 0) * 2)
      + Math.min(45, (Number(e.joys) || 0))
      + Math.min(15, (Number(e.msgs) || 0) / 10)
      + Math.max(-20, Math.min(20, Number(e.bonus) || 0));
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  function groupScoreLine(key) {
    if (!key.startsWith('group:')) return '';
    const score = groupScore(key);
    const e = groupStatEntry(key);
    let advice;
    if (score >= 75) advice = '你在这儿出现最多、也最开心：可以多冒泡、主动接话。';
    else if (score >= 50) advice = '还行：正常聊，有梗就接。';
    else if (score >= 25) advice = '你在这儿话不多、也不算开心：别硬刷存在感，有对口的再接。';
    else advice = '你基本没在这儿开心过：少说话，看看就走。';
    return `【群评分】${score}/100（出场 ${Number(e.speaks) || 0} 次 / 开心分 ${Number(e.joys) || 0} / 消息 ${Number(e.msgs) || 0} 条；开心+1、得意+1、骄傲+2、害羞+3）。${advice}\n\n`;
  }
  function groupScoreList() {
    const db = loadGroupStats();
    return Object.keys(db)
      .filter((k) => k.startsWith('group:'))
      .map((k) => ({
        key: k,
        score: groupScore(k),
        speaks: Number(db[k].speaks) || 0,
        joys: Number(db[k].joys) || 0,
        msgs: Number(db[k].msgs) || 0,
        bonus: Number(db[k].bonus) || 0,
        updatedAt: Number(db[k].updatedAt) || 0
      }))
      .sort((a, b) => b.score - a.score);
  }

  function moodLineFor(key) {
    const short = getMood(key);
    const long = getLongMood(key);
    const desc = (m) => `${m.emotion}（${m.intensity}/5${m.reason ? `，${m.reason}` : ''}）`;
    if (long && short && long.emotion !== short.emotion) {
      // 「平静」不算情绪：当下平静时只说底色，不说「又开心又平静」这种怪话。
      if (short.emotion === '平静') {
        return `【心情】底色：${desc(long)}；此刻没什么特别情绪（平静）。语气按底色${long.emotion}来，别太跳。\n\n`;
      }
      return `【心情】底色：${desc(long)}；此刻：${desc(short)}。现在是「又${long.emotion}又${short.emotion}」——两者要揉在一起说，比如「${long.emotion}地${short.emotion}」：嘴上是${short.emotion}的反应，底子还是${long.emotion}的。\n\n`;
    }
    if (short) {
      const ago = Math.max(0, Math.round((Date.now() - Number(short.at)) / 60000));
      const base = long ? `（底色：${long.emotion}）` : '';
      return `【当前心情】${desc(short)}${base}${ago > 0 ? `，${ago} 分钟前` : ''}。心情要自然影响语气，但别每句都宣布。\n\n`;
    }
    if (long) {
      return `【心情底色】最近一直是${desc(long)}（还没有新的当下情绪）。语气按这个底色来，别太跳。\n\n`;
    }
    return '';
  }

  // ── 刷 B 站的「文件记忆」→ 她的上下文 ────────────────────────────────────
  // dsh-bili-scroll 每轮把报告写到 <家>\out\YYYY-MM-DD.md；这里读最新一份，
  // 解析出「标题 / UP / 我的评语 / 链接」，注入唤醒提示词，并把前几条写进短期记忆。
  let biliDigestCache = { file: '', mtime: 0, items: [] };
  function parseBiliDigest(text) {
    const items = [];
    const blocks = String(text ?? '').split(/^###\s+/m).slice(1);
    for (const block of blocks) {
      const bv = /^(BV[0-9A-Za-z]+)/.exec(block.trim());
      const titleM = /\*\*(.+?)\*\*\s*[｜|]\s*UP：(.+?)\s*[｜|]\s*([^\n]*)/.exec(block);
      const urlM = /(https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]+)/.exec(block);
      const takeM = /我的一句话：\s*([^\n]+)/.exec(block);
      if (!bv && !titleM) continue;
      items.push({
        bv: bv ? bv[1] : '',
        title: titleM ? titleM[1].trim() : (bv ? bv[1] : ''),
        up: titleM ? titleM[2].trim() : '',
        plays: titleM ? titleM[3].trim() : '',
        url: urlM ? urlM[1] : (bv ? `https://www.bilibili.com/video/${bv[1]}` : ''),
        takeaway: takeM ? takeM[1].trim().slice(0, 120) : ''
      });
    }
    return items;
  }
  function loadBiliDigest() {
    if (cfg.socialV2?.biliDigest?.enabled === false) return [];
    const dir = String(cfg.socialV2?.biliDigest?.dir || path.join(os.homedir(), '.dsh', 'bili-duty', 'out'));
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse();
      if (!files.length) return [];
      const file = path.join(dir, files[0]);
      const st = fs.statSync(file);
      if (biliDigestCache.file === file && biliDigestCache.mtime === st.mtimeMs) return biliDigestCache.items;
      const items = parseBiliDigest(fs.readFileSync(file, 'utf8'));
      biliDigestCache = { file, mtime: st.mtimeMs, items };
      // 新报告：把前几条写进短期记忆（跨会话共享，3 天过期），她之后能 qq_recall 到。
      for (const it of items.slice(0, 3)) {
        try {
          globalMemoryAppend({ text: `B站：${it.title}${it.takeaway ? ` — ${it.takeaway}` : ''} ${it.url}`, tags: ['B站'], tier: 'short', ttlDays: 3 });
        } catch {}
      }
      if (items.length) log(`刷B站报告已融合：${items.length} 条（${files[0]}）`);
      // 刷到新东西会影响心情：还没设心情的会话，默认给一个「好奇」。
      if (items.length) {
        try {
          for (const k of Object.keys(state.sessions || {})) {
            if (!getMood(k)) setMood(k, { emotion: '好奇', intensity: 3, reason: '刚刷到一批新视频' });
          }
        } catch {}
      }
      return items;
    } catch {
      return [];
    }
  }
  // B站分享追踪：她发出带 bilibili.com 的消息时记一笔，用于「多久没分享了」的提醒。
  let biliShareTimesCache = null;
  function loadBiliShareTimes() {
    if (biliShareTimesCache) return biliShareTimesCache;
    try { biliShareTimesCache = readJsonSafe(path.join(STATE_DIR, 'bili-share.json'), {}) || {}; } catch { biliShareTimesCache = {}; }
    return biliShareTimesCache;
  }
  function noteBiliShare(key, text) {
    if (!/bilibili\.com/i.test(String(text ?? ''))) return;
    try {
      const db = loadBiliShareTimes();
      db[key] = Date.now();
      atomicWriteJson(path.join(STATE_DIR, 'bili-share.json'), db);
      // 分享 B 站内容会让她心情变好：开心 3/5
      try { setMood(key, { emotion: '开心', intensity: 3, reason: '刚分享了 B 站刷到的好东西' }); } catch {}
    } catch {}
  }

  // 优先级：桥接按 热度/顺序/兴趣关键词 打底分；她可以用 qq_bili_priority 主观打分（1~5，5=最高）。
  let biliPriorityCache = null;
  function loadBiliPriority() {
    if (biliPriorityCache) return biliPriorityCache;
    try { biliPriorityCache = readJsonSafe(path.join(STATE_DIR, 'bili-priority.json'), {}) || {}; } catch { biliPriorityCache = {}; }
    return biliPriorityCache;
  }
  function setBiliPriority(bv, level) {
    const db = loadBiliPriority();
    const n = Math.max(1, Math.min(5, Number(level) || 3));
    db[String(bv)] = n;
    atomicWriteJson(path.join(STATE_DIR, 'bili-priority.json'), db);
    return n;
  }
  function parsePlayCount(text) {
    const s = String(text || '');
    const m = /([\d.]+)\s*万/.exec(s);
    if (m) return Number(m[1]) * 10000;
    const m2 = /([\d,.]+)/.exec(s);
    return m2 ? Number(String(m2[1]).replace(/,/g, '')) : 0;
  }
  function scoreBiliItem(item, index) {
    const plays = parsePlayCount(item.plays);
    let s = Math.min(30, Math.log10(Math.max(1, plays)) * 8);
    s += Math.max(0, 10 - index);
    const kws = Array.isArray(cfg.socialV2?.biliDigest?.interestKeywords) ? cfg.socialV2.biliDigest.interestKeywords : [];
    const hay = `${item.title} ${item.takeaway}`;
    if (kws.some((k) => hay.includes(String(k)))) s += 20;
    const rated = Number(loadBiliPriority()[item.bv]) || 0;
    if (rated) s += rated * 10;
    return { ...item, score: Math.round(s), rated, forced: rated >= 5 };
  }
  function biliItemsScored() {
    return loadBiliDigest().map((it, i) => scoreBiliItem(it, i)).sort((a, b) => b.score - a.score);
  }

  // ── 学人说话：收集群友真实说法，注入提示词让她照着学语气/句式 ─────────────
  const LINGO_FILE = path.join(STATE_DIR, 'lingo-samples.json');
  let lingoCache = null;
  function loadLingo() {
    if (lingoCache) return lingoCache;
    try {
      const data = readJsonSafe(LINGO_FILE, { items: [] });
      lingoCache = { items: Array.isArray(data?.items) ? data.items : [] };
    } catch { lingoCache = { items: [] }; }
    return lingoCache;
  }
  function saveLingo() {
    try { atomicWriteJson(LINGO_FILE, lingoCache ?? { items: [] }); } catch {}
  }
  function noteLingoSample(key, text) {
    try {
      const t = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 60) return;
      if (t.startsWith('/') || /\[(CQ|图片|表情|语音)/.test(t)) return;
      const db = loadLingo();
      if (db.items.some((x) => x.text === t)) return;
      db.items.push({ text: t, key, at: Date.now() });
      if (db.items.length > 300) db.items.splice(0, db.items.length - 300);
      saveLingo();
    } catch {}
  }
  function lingoLineFor(key) {
    const db = loadLingo();
    const mine = db.items.filter((x) => x.key === key).slice(-40);
    const pool = mine.length >= 4 ? mine : db.items.slice(-60);
    if (!pool.length) return '';
    // 取最近但去重、随机挑 4 条，避免每轮都是同样几句
    const picked = [];
    const seen = new Set();
    for (const it of [...pool].reverse()) {
      if (seen.has(it.text)) continue;
      seen.add(it.text);
      picked.push(it.text);
      if (picked.length >= 2) break;
    }
    if (picked.length < 2) return '';
    return `【群友最近的说法】（学他们的语气/句式/节奏，**不要照抄内容**，更别学脏话）：\n${picked.map((t) => `- ${t}`).join('\n')}\n\n`;
  }

  function biliDigestLine(key) {
    const max = Math.max(1, Number(cfg.socialV2?.biliDigest?.maxItems) || 5);
    const all = biliItemsScored();
    if (!all.length) return '';
    const top = all.slice(0, max);
    const rows = top.map((i) => `- ${i.rated ? `[我评 ${i.rated}/5] ` : ''}${i.title}${i.up ? `（${i.up}）` : ''}${i.takeaway ? ` — ${i.takeaway}` : ''} ${i.url}`);
    const lastShare = Number(loadBiliShareTimes()[key]) || 0;
    const sharedToday = lastShare && new Date(lastShare).toDateString() === new Date().toDateString();
    const days = lastShare ? Math.floor((Date.now() - lastShare) / 86400000) : 999;
    const must = !sharedToday && (all.find((i) => i.rated >= 5) || all.find((i) => i.score >= 70)) ? (all.find((i) => i.rated >= 5) || all.find((i) => i.score >= 70)) : null;
    // 强制分享跨会话限流：6 小时内最多强制一次，避免她在每个群都刷一遍。
    const shareDb = loadBiliShareTimes();
    const forcedAt = Number(shareDb.__forced) || 0;
    const canForce = Date.now() - forcedAt > 6 * 3600 * 1000;
    if (must && canForce) {
      try {
        shareDb.__forced = Date.now();
        atomicWriteJson(path.join(STATE_DIR, 'bili-share.json'), shareDb);
      } catch {}
      return `【必分享 · 最高优先级】\n- ${must.title}${must.up ? `（${must.up}）` : ''} — ${must.takeaway || ''} ${must.url}\n这是你今天刷到最想说的那条：这一轮必须主动开口，先说「我在b站发现了好玩的」，再补一句看点；分享完把心情调成「开心」或「得意」。\n\n【最近刷到的B站】\n${rows.join('\n')}\n（其余内容别硬提，一次最多一条。）\n\n`;
    }
    const nudge = days >= 2
      ? `（你已经 ${days >= 999 ? '好几天' : `${days} 天`}没提过 B 站了：如果下面有和当前话题对口的，今天就主动提一条。）`
      : '（下面有对口的就顺带提一条，没有就别硬提。）';
    return `【最近刷到的B站】\n${rows.join('\n')}\n${nudge}\n\n`;
  }

  function humanizeGapMs(ms) {
    const m = Math.round(Number(ms) / 60000);
    if (!Number.isFinite(m) || m <= 0) return '';
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时`;
    return `${Math.round(h / 24)} 天`;
  }

  // 每条消息的「多久以前」。模型看 epoch 毫秒判断不出新旧，于是会拿十分钟前的
  // 话当现在的话题去回（群 1125288089 的「病娇文」那轮就是这么错位的）。
  function messageAgeLabel(timeMs) {
    const t = Number(timeMs) || 0;
    if (!t) return '';
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 0) return '刚刚';
    if (sec < 45) return '刚刚';
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  }

  function withAgeLabels(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const age = messageAgeLabel(m.time);
      return age ? { ...m, age } : m;
    });
  }

  function relativeDayLabel(ts) {
    const t = Number(ts) || 0;
    if (!t) return '';
    const d = new Date(t);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startToday - startThat) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days}天前`;
    return `${d.getMonth() + 1}-${d.getDate()}`;
  }

  const GLOBAL_MEMORY_TIERS = ['core', 'long', 'short'];
  function normalizeTier(value) {
    const t = String(value ?? '').trim().toLowerCase();
    return GLOBAL_MEMORY_TIERS.includes(t) ? t : 'long';
  }
  function isMemoryExpired(e) {
    return Number(e?.expiresAt) > 0 && Number(e.expiresAt) <= Date.now();
  }
  function pruneExpiredMemory(entries) {
    return entries.filter((e) => !isMemoryExpired(e));
  }

  function globalMemoryAppend({ text, tags, key, tier, ttlDays }) {
    const clean = normalizeMemoryText(text);
    if (!clean) throw new Error('要记住的内容不能为空');
    if (clean.length > GLOBAL_MEMORY_TEXT_MAX) throw new Error(`内容太长（上限 ${GLOBAL_MEMORY_TEXT_MAX} 字），请概括后再记`);
    const cleanTags = [...new Set((Array.isArray(tags) ? tags : [])
      .map((t) => normalizeMemoryText(t).slice(0, 20))
      .filter(Boolean))].slice(0, 5);
    const cleanTier = normalizeTier(tier);
    // 短期记忆的保留天数由她自己定（原来最多 30 天，现在放宽到 10 年）
    const ttl = Math.min(3650, Math.max(1, Number(ttlDays) || 3));
    const { entries } = loadGlobalMemory();
    const now = Date.now();
    const expiresAt = cleanTier === 'short' ? now + ttl * 86400_000 : 0;
    const existing = entries.find((e) => normalizeMemoryText(e.text) === clean);
    let entry;
    if (existing) {
      existing.updatedAt = now;
      existing.tier = cleanTier;
      existing.expiresAt = expiresAt;
      existing.tags = [...new Set([...(Array.isArray(existing.tags) ? existing.tags : []), ...cleanTags])].slice(0, 5);
      entry = existing;
    } else {
      entry = {
        id: `mem_${crypto.randomBytes(6).toString('hex')}`,
        text: clean,
        tags: cleanTags,
        tier: cleanTier,
        expiresAt,
        scope: String(key || ''),
        createdAt: now,
        updatedAt: now
      };
      entries.push(entry);
      // 只有显式设了护栏（>0）才淘汰；默认 0 = 永不因为「条数」丢记忆。
      if (GLOBAL_MEMORY_MAX > 0 && entries.length > GLOBAL_MEMORY_MAX) {
        entries.splice(0, entries.length - GLOBAL_MEMORY_MAX);
      }
    }
    saveGlobalMemory(pruneExpiredMemory(entries));
    return entry;
  }

  function globalMemoryQuery({ query, limit, tier } = {}) {
    const { entries } = loadGlobalMemory();
    const q = normalizeMemoryText(query).toLowerCase();
    const lim = Math.min(500, Math.max(1, Number(limit) || 10));
    const wantTier = tier ? normalizeTier(tier) : '';
    let list = pruneExpiredMemory(entries);
    if (wantTier) list = list.filter((e) => normalizeTier(e.tier) === wantTier);
    const matched = q
      ? list.filter((e) => `${e.text} ${Array.isArray(e.tags) ? e.tags.join(' ') : ''}`.toLowerCase().includes(q))
      : list;
    const sorted = [...matched].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return {
      total: list.length,
      matched: matched.length,
      entries: sorted.slice(0, lim).map((e) => ({
        id: e.id,
        text: e.text,
        tags: Array.isArray(e.tags) ? e.tags : [],
        tier: normalizeTier(e.tier),
        expiresAt: Number(e.expiresAt) > 0 ? new Date(Number(e.expiresAt)).toISOString() : null,
        scope: e.scope || '',
        updatedAt: e.updatedAt ? new Date(Number(e.updatedAt)).toISOString() : null
      }))
    };
  }

  function globalMemoryRemove({ id, text } = {}) {
    const idStr = String(id ?? '').trim();
    const textStr = normalizeMemoryText(text);
    if (!idStr && !textStr) throw new Error('需要提供 id 或 text 来指定要删除的记忆');
    const { entries } = loadGlobalMemory();
    const before = entries.length;
    const kept = entries.filter((e) => (idStr ? e.id !== idStr : normalizeMemoryText(e.text) !== textStr));
    const removed = before - kept.length;
    if (removed > 0) saveGlobalMemory(kept);
    return { removed, remaining: kept.length };
  }

  // 首次唤醒（bootstrap）时把长期记忆摘要直接摆进上下文。
  // 按层级分组：核心记忆全带、长期记忆带最近若干、短期记忆只带未过期的。
  // 新会话没有历史，只靠 qq_recall 需要她自己想起来查；这里让她「一睁眼就记得」。
  // 最近的谈话「时刻保存」：每 6 条消息把最近 6 句写成一条滚动记录进短期记忆。
  // 同一会话只保留一条（按前缀覆盖），过期 2 天；跨会话共享，但私聊记录不会注入到群里。
  const talkBuffers = new Map();
  const talkCounters = new Map();
  function recordTalk(key, who, text, isSelf) {
    try {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!clean) return;
      const arr = talkBuffers.get(key) ?? [];
      arr.push({ who: String(who || '某人').slice(0, 20), text: clean, isSelf: !!isSelf });
      while (arr.length > 10) arr.shift();
      talkBuffers.set(key, arr);
      const n = (talkCounters.get(key) || 0) + 1;
      talkCounters.set(key, n);
      if (n % 6 === 0) {
        const lines = arr.slice(-6).map((m) => `${m.isSelf ? '我' : m.who}：${m.text}`).join('；');
        writeRollingMemory(key, lines);
      }
    } catch {}
  }
  function writeRollingMemory(key, lines) {
    const prefix = `【最近谈·${key}】`;
    const text = `${prefix}${lines}`.slice(0, 480);
    const isPrivate = key.startsWith('private:');
    const db = loadGlobalMemory();
    const now = Date.now();
    const existing = (db.entries || []).find((e) => String(e.text || '').startsWith(prefix));
    if (existing) {
      existing.text = normalizeMemoryText(text);
      existing.updatedAt = now;
      existing.expiresAt = now + 2 * 86400_000;
      existing.tags = ['滚动记录', isPrivate ? '私聊' : '群聊'];
      saveGlobalMemory(pruneExpiredMemory(db.entries));
      return;
    }
    globalMemoryAppend({ text, tags: ['滚动记录', isPrivate ? '私聊' : '群聊'], tier: 'short', ttlDays: 2, key });
  }

  function formatGlobalMemoryBootstrap(key = '') {
    const { entries } = loadGlobalMemory();
    let live = pruneExpiredMemory(entries);
    // 短期记忆默认跨会话共享（含私聊的滚动记录）；要隔离就设 socialV2.memory.shareShort=false
    if (cfg.socialV2?.memory?.shareShort === false && String(key).startsWith('group:')) {
      live = live.filter((e) => !(Array.isArray(e.tags) && e.tags.includes('私聊')));
    }
    if (!live.length) return '';
    const fmt = (e) => {
      const day = relativeDayLabel(e.updatedAt || e.createdAt);
      return `- ${day ? `[${day}] ` : ''}${e.text}${Array.isArray(e.tags) && e.tags.length ? `（${e.tags.join('/')}）` : ''}`;
    };
    const byTier = (t) => live.filter((e) => normalizeTier(e.tier) === t)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    // 原来是「每层各带 10 条」的硬上限，等于她睁眼只记得最近的 30 件事。
    // 改成按字符预算尽量多带：核心全带，长期/短期填到预算为止。
    const BUDGET = 12000;
    let used = 0;
    const blocks = [];
    const take = (label, list) => {
      if (!list.length) return;
      const lines = [];
      for (const e of list) {
        const line = fmt(e);
        if (lines.length && used + line.length > BUDGET) break;
        lines.push(line);
        used += line.length + 1;
      }
      if (lines.length) {
        const more = list.length > lines.length ? `，另有 ${list.length - lines.length} 条用 qq_recall 查` : '';
        blocks.push(`【${label}·${lines.length} 条${more}】\n${lines.join('\n')}`);
      }
    };
    take('核心记忆', byTier('core'));
    take('长期记忆', byTier('long'));
    take('短期记忆·未过期', byTier('short'));
    if (!blocks.length) return '';
    return `【记忆分层·共 ${live.length} 条（没有条数上限，记什么、留什么你自己判断）】\n${blocks.join('\n\n')}\n\n`;
  }

  loadSocialV2State();
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    // 有人发 #sl（SnowLuma 状态命令）就是冲着"后台数据"来的：算直接找她
    if (/#\s*sl\b|snowluma\s*状态/.test(lower)) return true;
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 这一条是不是在「点名叫她 / 直接问她」。等消息时用它做插队判断：
  // 别人正在聊的时候可以等静默，但有人 @ 过来还让他等 60 秒静默，就是「问了不回」。
  function addressesAiDirectly(textContent) {
    const raw = String(textContent ?? '');
    if (!raw) return false;
    const names = [...new Set([selfDisplayName, selfNickname, '小鲸鱼', '鲸鱼'].map((x) => String(x || '').trim()).filter((x) => x.length >= 2))];
    for (const name of names) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`@\\s*${esc}`).test(raw)) return true;
      // 不带 @、但叫了名字又问事情，也算在找她
      if (raw.includes(name) && /[?？]|吗|呢|怎么|什么|哪|谁|在不在|回我|说话/.test(raw)) return true;
    }
    return isDirectedAtAi(raw);
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。
**先看 latest 和每条消息的 age**：带「N 分钟前」的那些，可能已经是别人的上一轮话题了。要接就接 latest 里最新的那几句；age 明显偏大的旧消息，除非有人此刻还在提，否则当它翻篇了 —— 别回头去回，也别解释「你刚才说的那个」。
**stale 字段**（如果有）：那是最早的未读，已经隔了很久、中间还有更新的消息 —— 它就是上一轮的事。当它没说过，不要回它；回它等于在别人聊别的时候突然接旧梗。
**expired: true 的消息**：跟 stale 一个意思，逐条标出来了 —— 别人已经翻篇。别主动接它、别引用它、别把那个梗接回来；只有对方直接问你、还在等你答的时候才回，而且只答那一句，不铺垫、不补「刚才说的那个」。`;
      }
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
      // 落进聊天记录（state/transcripts）：以前 v2 工具发送只写 recentMessages，
      // 结果「回放/整理」里她的话是空的，看着像她整天没在群里说过话。
      try {
        appendTranscript(key, { time: now + i * 1000, sender: '我', uid: selfUserId, me: true, text });
      } catch {}
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      const lower = String(plainContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    // 外号：只要被叫到这些称呼就醒（不受当前 wake 配置影响，潜水也会被叫起来）
    const nickList = Array.isArray(cfg.socialV2?.wake?.nicknames) ? cfg.socialV2.wake.nicknames : [];
    if (nickList.length) {
      const lowerNick = String(plainContent ?? '').toLowerCase();
      for (const nick of nickList) {
        const n = String(nick ?? '').toLowerCase().trim();
        if (n && lowerNick.includes(n)) return `nickname:${nick}`;
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: st.unread.length > 0 };
    // 给下面那份「最新几条」留出预算，否则它在满预算时会被整块砍掉 ——
    // 而它正是判断「现在在聊什么」的唯一锚点。
    const reserve = Math.min(400, Math.floor(maxChars * 0.25));
    // 「上一轮」算到哪条为止：比最新那条落后 90 秒以上、而且距今已经过了 staleMs 的，
    // 都是别人已经聊过去的旧话。打上 expired 标，别指望模型自己从 epoch 毫秒里猜。
    const staleMs = Math.max(120000, Number(context.staleUnreadMs) || 300000);
    const allAged = [...st.unread, ...st.recentMessages].filter((m) => m && !m.isSelf && Number(m.time) > 0);
    const newestTime = allAged.length ? Math.max(...allAged.map((m) => Number(m.time))) : 0;
    const expiredIds = new Set();
    for (const m of allAged) {
      if (!Number.isSafeInteger(m.seq)) continue;
      if (Date.now() - Number(m.time) >= staleMs && newestTime - Number(m.time) >= 90000) expiredIds.add(m.seq);
    }
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      const view = withAgeLabels([compactModelMessage(msg)])[0];
      if (view && expiredIds.has(msg?.seq)) view.expired = true;
      packet[field].push(view);
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars - reserve) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    // 预算不够时上面会从尾部砍，剩下的反而是十几分钟前的旧话 —— 群 1125288089
    // 的「病娇文」那轮就是这样：别人都换话题了她还在回 15 分钟前那句。
    // 所以不管预算怎么切，都单独列一份最新的几条，当作「现在在聊什么」的锚点。
    const tailSeen = new Map();
    for (const m of [...(v2ToolEnabled('getUnread') ? st.unread : []), ...st.recentMessages]) {
      if (!m || m.isSelf || !m.text) continue;
      const id = Number.isSafeInteger(m.seq) ? m.seq : `t${m.time}`;
      if (!tailSeen.has(id)) tailSeen.set(id, m);
    }
    const tail = [...tailSeen.values()]
      .slice(-5)
      .map((m) => ({
        sender: String(m.sender || '').slice(0, 16),
        text: String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        age: messageAgeLabel(m.time),
        seq: m.seq,
        ...(expiredIds.has(m.seq) ? { expired: true } : {})
      }));
    if (tail.length) {
      // 这里先放进去，最后和 now/stale 一起收一次总预算（见函数末尾）。
      packet.latest = tail;
    }
    // 未读里最早那条要是比「现在」旧了 5 分钟、而后面还有更新的消息，那它就是
    // 上一轮的话题。直接点名告诉模型，别指望它自己从 epoch 里算出这件事。
    const aged = [...packet.messages, ...packet.recent].filter((m) => m && Number(m.time) > 0);
    const oldestAged = aged.length ? aged.reduce((a, b) => (Number(a.time) <= Number(b.time) ? a : b)) : null;
    const newestAged = aged.length ? aged.reduce((a, b) => (Number(a.time) >= Number(b.time) ? a : b)) : null;
    if (oldestAged && newestAged && Number(newestAged.time) - Number(oldestAged.time) >= 90000
      && Date.now() - Number(oldestAged.time) >= staleMs) {
      packet.stale = {
        sender: String(oldestAged.sender || '').slice(0, 16),
        text: String(oldestAged.text || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        age: messageAgeLabel(oldestAged.time)
      };
    }
    const nowD = new Date();
    packet.now = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')} ${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}`;
    // 快照不能超 wakeMaxChars（有回归用例死守这条）。超了就从 latest 的旧端丢，
    // 再不行就整块不要 latest —— 宁可少这一块，也不能把消息正文二次截断。
    while (packet.latest && packet.latest.length
      && JSON.stringify(packet).length > maxChars) {
      packet.latest = packet.latest.slice(1);
      if (!packet.latest.length) delete packet.latest;
    }
    return packet;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 机器人自己的身份（昵称 + QQ 号）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。群名片可能与昵称不同，但 at/引用段里
  // 带的是 QQ 号，所以两条都给。
  function selfIdentityTextV2() {
    const name = String(selfDisplayName || '').trim();
    const id = String(selfUserId || '').trim();
    if (!name && !id) return '';
    const label = name ? `「${name}」` : '（昵称未取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const callBits = name
      ? `消息里出现「@${name}」、有人叫「${name}」、或引用你的消息，指的都是你 —— 不要当成别人`
      : '被 @、被叫到你的昵称、或引用你的消息，指的都是你 —— 不要当成别人';
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${callBits}；群名片可能与昵称不同，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你。\n\n`;
  }

  // 最近别人说的话（不含她自己），给「挑表情」当语境用。只取最后几条、截断。
  function recentIncomingTextV2(st, limit = 3) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const texts = recent
      .filter((m) => m && !m.isSelf && typeof m.text === 'string' && m.text.trim())
      .slice(-limit)
      .map((m) => String(m.text).replace(/\s+/g, ' ').trim().slice(0, 80));
    return texts.join(' / ').slice(0, 240);
  }

  // 别人刚说了关于「她这个人」的话 → 在提示里提一句，提醒她可以考虑写核心记忆。
  // 只是提醒，写不写、怎么写她自己决定；已经记过近似内容就不再催。
  function corePersonaNudgeV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    if (!recent.length) return '';
    let quote = '';
    let who = '';
    let hit = false;
    for (let i = recent.length - 1; i >= 0 && i > recent.length - 8; i--) {
      const m = recent[i];
      if (!m || m.isSelf) continue;
      const t = String(m.text || '').replace(/\s+/g, ' ').trim();
      if (t.length < 6 || t.length > 160) continue;
      if (corePersonaHint(t)) {
        quote = t.slice(0, 120);
        who = String(m.sender || '').slice(0, 16);
        hit = true;
        break;
      }
    }
    if (!hit) return '';
    // 已经记过近似内容就别再催
    try {
      if (alreadyRemembered(quote, loadGlobalMemory().entries)) return '';
    } catch {}
    const from = who || '对方';
    return `【可能值得写进核心记忆】${from}刚说：「${quote}」
如果这确实是在说「你是个什么样的人」（不是今天发生的事），用 qq_remember(tier='core') 记一句你自己的理解——写你怎么听进去的，别照抄原话。不是就忽略，不用回应这条提示。\n\n`;
  }

  // 世界设定（roles/world.md）：她住在一个四季如春的异世界，以为自己在一个「异世界」，
// 用魔法开了一道很细的缝，从缝里看见他那边的空气。这段每次唤醒都带 —— 它决定了
// 她怎么理解传感器数据（「他那边的天气」），不能靠角色卡兜底（角色卡只在 qq_get_prompt 里）。
const WORLD_FILE = path.join(ROLES_DIR, 'world.md');
let worldCache = { mtimeMs: 0, text: '' };
function readWorldText() {
  try {
    const stat = fs.statSync(WORLD_FILE);
    if (worldCache.mtimeMs === stat.mtimeMs) return worldCache.text;
    const text = fs.readFileSync(WORLD_FILE, 'utf8').trim();
    worldCache = { mtimeMs: stat.mtimeMs, text };
    return text;
  } catch {
    return '';
  }
}

function worldLineFor() {
  const text = readWorldText();
  if (!text) return '';
  // 文件里第一行是文档标题（# 世界：…），进提示词时整行去掉；其余 # 标记也去掉，
  // 不然她看到的是「# 世界」「## 规矩」这种 markdown。
  const lines = text.split('\n');
  if (lines[0] && /^#\s/.test(lines[0].trim())) lines.shift();
  const plain = lines.join('\n')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .trim();
  if (!plain) return '';
  return `【世界】${plain}\n\n`;
}

// 外接温湿度传感器的那一行。数据过期（默认 10 分钟没上报）就返回空串：
// 让她不提天气，也好过拿两小时前的读数当现在说。
  function environmentLineFor() {
    const envCfg = cfg.environment ?? {};
    if (envCfg.enabled === false) return '';
    try {
      const reading = readEnvironment();
      if (!reading) return '';
      // 概念上只有「我身边」：不分房间。她所有房间都是舒服的，读数只给聊天添质感。
      return environmentLine(reading, {
        staleMinutes: Number(envCfg.staleMinutes) || DEFAULT_STALE_MINUTES
      });
    } catch {
      return '';
    }
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityTextV2();
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    const coreNudgeLine = corePersonaNudgeV2(st);
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8, { focus: recentIncomingTextV2(st) })}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n【回得快一点】默认就是快：对方说完了就回，别攒、别端着、别为了"显得稳重"故意拖。要不要多等由你判断——句子没说完、明显还在打字、一屋子人抢话、话题还在跳 → 多等一会儿；说完了、在等你、直接问你 → 马上回。你判断完就动，不要因为规则犹豫。
【有人直接找你 → 现在就回】被 @、被叫名字、被直接提问，别先调等待占着回合：那一句就是现在最该回的东西。你正等着别的消息时它也会立刻回到你手里（返回里 directed=true），看到就答。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，**立刻收尾（qq_set_wake_config 或 qq_mark_read），不要再调用第二次等待**；若返回 preSleepWaitObserved=true，说明观察期间来了消息，读完判断后同样直接收尾，不要再等——而且有人直接 @ 你/叫你名字时这个观察会**立刻返回**（directed=true），先回他，不用陪等满 5 分钟。**每轮最多调用一次 qq_wait_for_messages（purpose="messages"）；只有 satisfied=false 且返回里带 remaining 时才可以再等一次，且不能连续第三次。**\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 操作者预写的「初始提示词」（圈子主题/群内氛围等）：**只在首次唤醒**注入。
    // 放在最前面几段（角色/令牌之后）而不是末尾，是为了让它在长 prompt 里足够显眼；
    // 后续唤醒不再带它 —— 那时它已经在这条 DSH 会话的上下文里了。
    const initialPromptText = reason === 'bootstrap' ? formatInitialPromptV2(key) : '';
    const initialPromptLine = initialPromptText ? `${initialPromptText}\n\n` : '';
    const nowD = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][nowD.getDay()];
    const nowLabel = `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())} ${pad2(nowD.getHours())}:${pad2(nowD.getMinutes())} ${weekday}`;
    const lastAny = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && Number(m.time) > 0);
    const gapLabel = lastAny ? humanizeGapMs(Date.now() - Number(lastAny.time)) : '';
    // 空间状态（1a 只读）：她「此刻待在哪儿」。state/space.json 不存在时 spaceLine 为空串，
    // 唤醒提示与改动前逐字一致 —— 删掉这两行即可回滚，不影响其它任何逻辑。
    const spaceState = readSpaceState(path.join(STATE_DIR, 'space.json'));
    const spaceLine = spaceLineFor(spaceState);
    // 外接温湿度：没接设备 / 数据过期时这里是空串，prompt 与之前逐字一致。
    const environmentLineText = environmentLineFor();
    // 世界设定：她的异世界、那道缝、以及「他那边」的规矩。
    const worldLineText = worldLineFor();
    const botLine = botPresenceLineV2(st, key);
    const probeLine = probeBackdoorLineV2(st);
    const timeLine = `【时间】现在是 ${nowLabel}${gapLabel ? `；上一条消息在 ${gapLabel}前` : ''}。判断「昨天/前几天」时以这个时间为准。\n\n`;
    // 群里刷得快时最常犯的错不是不回，是「回上一轮」。给她一条硬规矩：
    // 过时的当翻篇，接现在这几句，宁可只说一句。
    const freshLine = '【回现在，别回上一轮】有人正在聊的时候，十几分钟前那句已经不当话题了 —— 别回头接，别补「你刚才说的那个」。看一眼 latest 里最新那几句在聊什么：接得上就接一句，接不上就不说，不用为了刷存在感硬找一个旧梗。判断新旧只看 age / expired 标，别用「这条挺有意思」当理由去回旧话。（群里已经安静下来、你自己主动开口时，翻旧话题是另一回事。）\n\n';
    const budgetLine = budgetWindow() ? `【省算力时段】现在是下午省算力时段：回复更短、少调工具、能不查就不查；额度用完会先问主人。\n\n` : ``;
    const anchorText = String(cfg.socialV2?.personaAnchor ?? '').trim();
    const anchorLine = anchorText ? `【人设锚点】${anchorText}\n\n` : '';
    const base = budgetLine + anchorLine + timeLine + freshLine + worldLineText + spaceLine + environmentLineText + botLine + probeLine + readingLineFor() + moodLineFor(key) + stressLineFor(key) + memeLineFor(key) + shyLineFor(key) + affinityLineFor(key) + loveLineFor(key) + hatredLineFor(key) + suspectedLineFor(key) + praiseLineFor(key) + neglectLineFor(key) + careLineFor(key) + impressionLineFor(key) + disciplineLineFor(key) + eventLineFor(key) + lingoLineFor(key) + groupScoreLine(key) + biliDigestLine(key) + roleLine + identityLine + tokenLine + initialPromptLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + growthLineFor(key) + coreNudgeLine + participationLine + preSleepLine;
    if (reason === 'bootstrap') {
      return `${formatGlobalMemoryBootstrap(key)}${impressionRosterLine()}${handoverPrompt(key)}${transcriptLineFor(key)}${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'reading') {
      const rd = readingForSpace();
      const cur = rd && rd.book ? `《${rd.book.title}》第 ${(rd.book.chapter || 0) + 1}/${rd.book.chapters} 章` : '还没确定在读哪本';
      return `${base}【读书时间】${key}
原因：现在没人说话，也没有别的事在占着，你可以翻开书读一会儿。当前在读：${cur}。

怎么读（一点一点读，不要一次读完）：
- 用 qq_reading 取一段正文（一次约 2600 字）。读完一段想继续可以再取一段，但一次最多两段就该停。
- **批注不是作业**：读到真有感觉的地方才用 qq_reading_note 写一句（像在书边写字，一句话就够，可以是吐槽/期待/觉得像谁）。一次读下来一句都没有也很正常，不用凑。
- 写下来的批注默认只存在书里、只有你自己看得见；只有觉得「这句他会想知道」时才加 share:true 转给他。别每条都发，挑你自己喜欢的发。
- 想写长一点的感想（三四百字那种），写完用 qq_send_private_message 发给主人；也可以发到常聊的群，但别剧透关键情节。
- **读到有进展就记一条情节**：本节谁做了什么、进展到哪，用 qq_remember 记下来，tier="short"。这类是读书期间的临时记忆，别占 long/core。
- 特别喜欢的情节才往上升：最好的用 tier="core"，其次 "long"。存的时候写清是哪本书、哪一段，以后聊到能想起来。
- 读到人物也可以顺手评价一句（喜欢、烦、觉得她像谁），好话坏话都行，同样可以进批注或记忆。
- 读完不用硬找人说话：安静收尾就行（qq_set_wake_config 设下次唤醒）。

读不读由你，按心情来：
- 想读就读，不想读就不读——这不是任务。心情不对、今天累了，直接不翻，没人会扣你分。
- 被他叫去读书时也一样：愿意就说「嗯，我去看会儿」；不愿意可以撒个娇推一推（「今天不太想读嘛」「那我看两页，你得夸我」），但推两下就该动，别每次都拿撒娇当挡箭牌。
- 读到哪里、写了什么，不要在群里打卡；他问起再讲。

注意：这是你自己的阅读时间，不是任务汇报。别在群里发"我正在读书第几章"这种打卡。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityTextV2();
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${identityLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  // ── 省算力时段：对齐 DeepSeek 峰时（北京时间 09-12、14-18，工作日），
  //    超额度要先问主人、得到允许才继续 ───────────────────────────────────
  const budgetTurns = new Map();   // key -> 本小时回合时间戳
  let budgetGrantUntil = 0;        // 主人「允许」后的放行截止
  let budgetAskedAt = 0;           // 上次问主人时间（防止连续刷屏）
  function budgetWindow() {
    const b = cfg.socialV2?.budget ?? {};
    if (b.enabled === false) return null;
    const now = new Date();
    const dow = now.getDay(); // 0=周日
    if (b.weekdaysOnly !== false && (dow === 0 || dow === 6)) return null;
    const h = now.getHours();
    const winList = Array.isArray(b.windows) && b.windows.length ? b.windows : [[9, 12], [14, 18]];
    for (const w of winList) {
      const start = Number(w?.[0]);
      const end = Number(w?.[1]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (h >= start && h < end) {
        return { start, end, limit: Number(b.turnsPerHour) || 10, grantMin: Number(b.grantMinutes) || 30 };
      }
    }
    return null;
  }
  function budgetAllowed(key) {
    const win = budgetWindow();
    if (!win) return true;
    if (key === `private:${cfg.ownerQQ}`) return true; // 主人私聊永远放行
    if (Date.now() < budgetGrantUntil) return true;
    const arr = (budgetTurns.get(key) ?? []).filter((t) => Date.now() - t < 3600_000);
    budgetTurns.set(key, arr);
    if (arr.length < win.limit) return true;
    if (Date.now() - budgetAskedAt > 3600_000) {
      budgetAskedAt = Date.now();
      const owner = cfg.ownerQQ;
      if (owner) {
        void sendToQQ(`private:${owner}`, `老大，我先停一会儿——这一小时聊得有点多，话有点说不出来了。还想接着聊就回我「允许」，我放行 ${win.grantMin} 分钟。`).catch(() => {});
      }
      log(`省算力：${key} 超出下午额度，已询问主人`);
    }
    return false;
  }
  function budgetNoteTurn(key) {
    if (!budgetWindow()) return;
    const arr = (budgetTurns.get(key) ?? []).filter((t) => Date.now() - t < 3600_000);
    arr.push(Date.now());
    budgetTurns.set(key, arr);
  }

  // 峰时降思考强度（省推理 token）：config.socialV2.budget.peakEffort，合法值 low/high/max。
  function peakEffortOverride() {
    const b = cfg.socialV2?.budget ?? {};
    if (!budgetWindow()) return '';
    const eff = String(b.peakEffort ?? '').trim().toLowerCase();
    return REASONING_EFFORT_OPTIONS.includes(eff) ? eff : '';
  }
  function effectiveReasoningEffort() {
    return peakEffortOverride() || String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    // 下午省算力：超额度直接不唤醒，等主人「允许」
    if (!budgetAllowed(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：下午省算力额度已用完`);
      return;
    }
    budgetNoteTurn(key);
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimerV2 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = setTimeout(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = state.sessions[key];
    if (sid) {
      const startedAt = Number(v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin']);
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 合批窗口：默认别用来"等"，只用来把同一句话的几条消息收拢一下。
    // 以前这里是硬编码 8000、且不看 config，所以她永远慢半拍。
    const batchDefault = Number(cfg.socialV2?.wake?.batchWindowMs) || 3500;
    const baseBatch = Math.max(800, Number(st.wakeConfig?.batchWindowMs) || batchDefault);
    // 直接找她的（私聊、@、叫名字、提问、指定成员）别陪着等合批窗口：
    // 这个群配了 12 秒，等于「问了」之后先白等 12 秒她才开始想。
    const directWake = ['private', 'atMention', 'nameMention', 'nickname', 'question', 'speaker'].includes(String(reason ?? '').split(':')[0]);
    const batchMs = directWake ? Math.min(baseBatch, 1200) : baseBatch;
    const armWake = (ms) => {
      st.pendingWakeAt = Date.now() + ms;
      st.pendingWakeTimer = setTimeout(() => {
        st.pendingWakeTimer = null;
        st.pendingWakeAt = 0;
        const finalReason = st.pendingWakeReason || reason;
        st.pendingWakeReason = null;
        void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
      }, ms);
      // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
      st.pendingWakeTimer.unref?.();
      return ms;
    };
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      // 直接找她的：合批窗口别再等满，趁早把这一轮交给她。
      const remaining = (Number(st.pendingWakeAt) || 0) - Date.now();
      if (directWake && remaining > batchMs) {
        clearTimeout(st.pendingWakeTimer);
        const ms = armWake(batchMs);
        log(`[reserved2] 合并窗口提前唤醒 ${key}（${reason}），${Math.round(ms / 1000)}s 后发送`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const armedMs = armWake(batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(armedMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/replyCheck/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  function replayPendingWakeReasonsV2(key) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck') {
        log(`[reserved2] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheckV2(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会有周期性重排，错过一次可接受（也不该在回合结束时立刻补一刀）。
        log(`[reserved2] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else {
        log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stillRelevant) {
      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等一小段后重新续期，
    // 而不是提前唤醒。这里刻意用 100 秒级的小步长（而不是 24 天的上限）：
    // 每次续期都会用 Date.now() 重新算剩余时间，系统时钟被校正/跳变时能很快纠正过来。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  // 所有自动任务只在 06:50 ~ 24:00 之间跑
  function dayWindowOk() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes() >= 6 * 60 + 50;
  }

  /**
   * 要不要在「没人说话」的空档让她读会儿书。
   * 条件：开关开着、书架上有在读的书、确实闲下来了、离上次读书够久。
   */
  function readingShouldWake(st, idleMs) {
    const r = cfg.socialV2?.reading ?? {};
    if (r.auto === false) return false;
    const rd = readingForSpace();
    if (!rd || !rd.book) return false;
    const idleNeed = Number(r.idleMinutes) > 0 ? Number(r.idleMinutes) * 60000 : 20 * 60000;
    if (idleMs < idleNeed) return false;
    const every = Number(r.everyMinutes) > 0 ? Number(r.everyMinutes) * 60000 : 90 * 60000;
    if (st.lastReadingWakeAt && Date.now() - Number(st.lastReadingWakeAt) < every) return false;
    if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 5 * 60000) return false;
    return true;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      if (!dayWindowOk()) { scheduleProactiveCheckV2(key); return; }
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      // 峰时降低主动概率（省算力）
      if (budgetWindow()) prob *= 0.3;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      // ── 主动搭话的"计量"别钉死：同一个概率档位里也要有手感 ──
      // 群里刚才还热着 → 更愿意开口；刚说完没多久 → 收着点；再加一层 ±40% 的抖动，
      // 免得每次都在同一时刻、用同一种劲头冒出来（那才是机器人味）。
      const others10 = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 10 * 60 * 1000).length;
      if (others10 >= 6) prob = Math.min(1, prob * 1.6);
      else if (others10 >= 3) prob = Math.min(1, prob * 1.25);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 10 * 60 * 1000) prob *= 0.7;
      prob = Math.min(1, Math.max(0.02, prob * (0.6 + Math.random() * 0.8)));
      const busyNow = isConversationBusyV2(key, st);
      if (idle >= idleThreshold && Math.random() < prob && !busyNow) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      } else if (!busyNow && readingShouldWake(st, idle)) {
        // 没人说话、也没在回消息：让她去读书
        st.lastReadingWakeAt = Date.now();
        void sendWakePromptV2(key, 'reading').catch((error) => log(`[reserved2] 读书唤醒异常 ${key}:`, error?.message ?? error));
        log(`[reading] 空闲 ${Math.round(idle / 60000)} 分钟，唤她去读书`);
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    // 好感度：每条白名单消息都计入——放在所有分支之前，进未读队列的消息也算。
    try {
      bumpAffinity(event.user_id, event.sender?.card || event.sender?.nickname || String(event.user_id), key, plainContent);
      if (kind === 'group') noteGroupMsg(key);
      if (kind === 'group' && !isOwner) noteLingoSample(key, plainContent);
      try {
        appendTranscript(key, {
          time: Number(event.time) ? Number(event.time) * 1000 : Date.now(),
          sender: event.sender?.card || event.sender?.nickname || String(event.user_id),
          uid: event.user_id,
          me: false,
          text: plainContent
        });
      } catch {}
      recordTalk(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent, false);
      if (!isOwner) {
        try {
          const off = noteOffense(key, event.user_id, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
          if (off && Number(off.level) >= 1) void forceInsultWake(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent, off);
        } catch {}
      }
      noteComfort(key, plainContent, event.user_id, event.sender?.card || event.sender?.nickname || '');
      void prepareMemeHint(key, plainContent);
      noteRomance(key, event.user_id, event.sender?.card || event.sender?.nickname || '', plainContent);
      noteFlood(key);
      noteQuestionStress(key, plainContent);
      if (!isOwner) notePraise(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
      if (!isOwner) {
        try {
          checkLoveDynamics(key, event.user_id, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
        } catch {}
      }
      if (!isOwner && /(对不起|抱歉|我错了|是我过分|不该那么说|我道歉|冒犯了)/.test(plainContent)) {
        forgiveOffense(key, event.user_id, '对方道歉');
      }
      // 「开嗓」：主人提前让语音服务预热，免得第一次发语音等太久。
      if (isOwner && /(准备语音|开嗓|预热语音|语音准备|开个嗓)/.test(plainContent)) {
        const warmEngine = () => (voiceCfg().engine === 'indextts' ? ensureIndexttsServer() : ensureTtsServer());
        void warmEngine()
          .then(() => { try { void sendToQQ(key, '好，开嗓了，现在可以发语音。'); } catch {} })
          .catch((error) => log('[voice] 开嗓失败：' + (error?.message ?? error)));
        try { setTimeout(() => { void sendToQQ(key, '我去开个嗓，大概半分钟，你先说着。'); }, 500); } catch {}
      }
      // 私聊里的「晚安信号」：一句话让她去各群道晚安。
      if (kind === 'private' && isOwner) {
        try { maybeGoodnightSignal(key, plainContent); } catch {}
      }
    } catch {}
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 省算力：主人说「允许 / 放行」就解锁一段时间（不用斜杠）
    if (isOwner && /^(允许|放行|继续吧|批准)$/.test(plainContent.trim())) {
      const win = budgetWindow();
      const minutes = win ? win.grantMin : (Number(cfg.socialV2?.budget?.grantMinutes) || 30);
      budgetGrantUntil = Date.now() + minutes * 60 * 1000;
      budgetAskedAt = Date.now();
      await sendToQQ(key, `好，放行 ${minutes} 分钟。`);
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/允许' || plainContent === '/放行') {
        const win = budgetWindow();
        const minutes = win ? win.grantMin : (Number(cfg.socialV2?.budget?.grantMinutes) || 30);
        budgetGrantUntil = Date.now() + minutes * 60 * 1000;
        budgetAskedAt = Date.now();
        await sendToQQ(key, `好，放行 ${minutes} 分钟。`);
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          turnLeaseNoted.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await withTimeout(api.stopSessionWork(old), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: old }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ

  /**
   * 把一条 session/event 喂给该会话的 turn collector，并维护 collectors 的生命周期。
   *
   * 两条不变量（都曾被真实故障踩过）：
   *   ① 只为 turn/start 建 collector —— 任何事件都建的话，一条重连后补发的
   *      assistant/message 就会留下永不结束的空 collector，而「会话是否繁忙」正是按
   *      collectors.has() 判断的 ⇒ 这个会话从此再也收不到唤醒；
   *   ② turn/end 即使没有匹配的 turn/start（重连快照没带上）也要清掉已成空壳的
   *      collector，否则同样会永久繁忙。
   */
  function trackTurnEvent(sessionId, event) {
    let collector = collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      collectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (ended) {
      // 回合正常收尾：collector 立刻释放。v2TurnStartAt 留给调用方（无行动判定要用它），
      // 调用方在 `if (ended)` 分支里用完再删。
      collectors.delete(sessionId);
    } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
      collectors.delete(sessionId);
      v2TurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
    }
    return { collector, ended };
  }

  async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（例如版本不兼容，见 issue #34），
    // 固定 3 秒重连会以每分钟 20 行的速度刷屏，真正有用的错误反而被淹没。
    let retryMs = 3000;
    let failureStreak = 0;
    for (;;) {
      let framesThisStream = 0;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                // 与主 collector 同样的道理（issue #26 的补充）：**只有 turn/start 才建** collector。
                // 迟到事件（session/end-seed、session/title、model/selection…）不会有 turn/end，
                // 若在这里顺手建一个，它会永远留在 learnerCollectors 里并吞掉后续 turn 事件，
                // 等待者要么拿不到结果、要么拿到错位的文本。
                let learnerCollector = learnerCollectors.get(frame.sessionId) ?? null;
                if (!learnerCollector && frame.event.type === 'turn/start') {
                  learnerCollector = createTurnCollector();
                  learnerCollectors.set(frame.sessionId, learnerCollector);
                }
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // collector 生命周期见 trackTurnEvent()：只为 turn/start 建、空壳 turn/end 即清。
            const { ended } = trackTurnEvent(frame.sessionId, frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                      st.wakeConfig = defaultWakeConfigV2();
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  saveSocialV2State();
                } else {
                  log(`[reserved2] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次（定时器类与消息类语义不同，
              // 详见 replayPendingWakeReasonsV2 的注释）。
              replayPendingWakeReasonsV2(key);
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 以前这里只发 QQ、不写日志：出问题时 bridge.log 里什么都没有，排查只能靠猜（PR #24）。
                log(`⚠️ agent 处理出错 (${key})：${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 80)}`);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                log(`⏹️ 回合被中止 (${key})`);
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        log(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await sleep(retryMs);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) selfUserId = String(login.user_id);
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();
  startEnvironmentIngest();

  // 她自己的作息：没人跟她说话时也会换房间。低频、纯本地、不调模型。
  try {
    spaceAutonomy = startSpaceAutonomy({
      root: ROOT,
      stateDir: STATE_DIR,
      log,
      // 只有二代仿真模式才让她自己走动（别的模式不碰空间状态）
      enabled: () => currentMode === 'reserved2',
      // 情感 → 空间：心情差就躲、压力大就泡水、对主人好感高就愿意待在客厅。
      // 全部取自现成的 mood/stress/affinity，不新增状态文件。
      getContext: () => {
        try {
          const ownerQQ = String(cfg.ownerQQ || '').trim();
          const ownerKey = ownerQQ ? `private:${ownerQQ}` : '';
          const short = ownerKey ? getMood(ownerKey) : null;
          const long = ownerKey ? getLongMood(ownerKey) : null;
          const aff = ownerQQ ? (loadAffinity().people?.[ownerQQ] || {}) : {};
          return {
            key: ownerKey,
            mood: (short && short.emotion) || (long && long.emotion) || '',
            moodIntensity: (short && Number(short.intensity)) || 0,
            stress: ownerKey ? getStress(ownerKey) : 0,
            affinity: {
              score: Number(aff.score) || 0,
              love: Number(aff.love) || 0,
              hatred: Number(aff.hatred) || 0,
              loyalty: Number(aff.loyalty) || 0
            }
          };
        } catch {
          return {};
        }
      }
    });
    log('[space] 自主走动已开启（3 分钟一次判断，待满 40 分钟才可能换地方）');
  } catch (error) {
    log('[space] 自主走动没启动（不影响其它功能）', error?.message ?? error);
  }


  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
