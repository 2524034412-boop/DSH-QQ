// 空间状态（1a：只读版）—— 她「此刻待在哪儿、手边有什么」的唯一来源。
//
// 这个模块只做两件事：把 state/space.json 读成对象、把对象渲染成唤醒提示里的一行。
//
// **它不提供写入口。** 1a 阶段没有任何运行时代码会改这个文件，改它只有两种途径：
// `scripts/space-set.mjs` 或直接编辑 json。等验证过「这一行不会把她变成导航播报」
// 再开写入口（1b 的工具），那时回滚也只需要删掉调用点那一行。
//
// 文案原则（这一段比代码重要）：
//   指令式「你现在在书房看书」→ 她把这句复述出来，对话变成播报。
//   素材式「书房。手边有本没看完的书」→ 她拿它当背景，自己长出「我在看书」，
//   也可能根本不提 —— 后者才是生活。
// 所以 place 用名词短语，detail 用感官细节，doing 只在没有 detail 时兜底。
//
// 清洗是安全边界：将来（1b）Agent 能写这个文件，它就是 prompt injection 的入口。
// 现在就把【】/换行/控制字符挡住，免得日后补。

import fs from 'node:fs';
import path from 'node:path';

const MAX_PLACE = 24;
const MAX_DETAIL = 60;
const MAX_DOING = 24;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/** 去掉控制字符、换行与段落标记【】，压成一行并截断。 */
function clean(value, max) {
  return String(value ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/[【】[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 读取空间状态。
 * @param {string} file state/space.json 的绝对路径
 * @returns {object|null} 读不到 / 格式不对 / 不是对象 → null（此时唤醒提示里不多一行，净零影响）
 */
export function readSpaceState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 文件不存在是正常状态，不是错误
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null; // 手改坏了也不该让整轮唤醒失败
  }
}

/**
 * 渲染成唤醒提示里的一行。状态为空时返回空串。
 *
 * 标签用【所在】而不是【此刻】：提示词里已经有一个【此刻状态】（未读/最近一条），
 * 两个「此刻」会打架，模型容易把两段混成一段复述。
 * @param {object|null} state
 * @param {{hint?: boolean}} [options] hint=true 时末尾加一句「（不用特意提。）」
 * @returns {string} 形如 `【所在】书房。手边有本没看完的书。\n\n`
 */
export function spaceLineFor(state, options = {}) {
  // hint 默认关：hint 是「关于怎么说」的元指令，会给这段信息额外权重，反而更容易被复述。
  // 真测出播报再加——加回来是一行参数的事。
  const hint = options.hint === true;
  if (!state) return '';
  const place = clean(state.place, MAX_PLACE);
  if (!place) return ''; // 只有 place 是必填，其余都可不给

  const detail = clean(state.detail, MAX_DETAIL);
  const doing = clean(state.doing, MAX_DOING);
  const raw = detail || (doing ? (/^在/.test(doing) ? doing : `在${doing}`) : '');
  const scene = raw && !/[。！？…~～.!?]$/.test(raw) ? `${raw}。` : raw;

  const line = scene ? `【所在】${place}。${scene}` : `【所在】${place}。`;
  return `${line}${hint ? '（不用特意提。）' : ''}\n\n`;
}

/**
 * 读房间表并建「名字 → 房间」索引（label 和 aliases 都进）。
 * 房间表是资产，可能被手改坏；坏掉时返回空 Map，调用方按「不拦」处理。
 * @param {string} roomsFile public/space/rooms.json
 * @returns {Map<string, object>}
 */
export function loadRoomIndex(roomsFile) {
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(roomsFile, 'utf8'));
    for (const r of Array.isArray(j?.rooms) ? j.rooms : []) {
      if (!r || typeof r.label !== 'string') continue;
      map.set(r.label, r);
      for (const a of Array.isArray(r.aliases) ? r.aliases : []) map.set(a, r);
    }
  } catch { /* 读不到就当没有房间表 */ }
  return map;
}

/**
 * 把「她说的地方」解析成房间表里的规范名。
 * 为什么必须规范化：她说「沙发」，存的应该是「客厅」——否则以后换布局时
 * 「沙发」这个别名一改，历史 state 就对不上了。
 * @param {Map<string, object>} index loadRoomIndex() 的结果
 * @param {string} wanted 她说的名字（可能是别名）
 * @returns {{room: object, canonical: string}|null}
 */
export function resolvePlace(index, wanted) {
  const want = String(wanted ?? '').trim();
  if (!want || !index || index.size === 0) return null;
  const room = index.get(want);
  if (!room) return null;
  return { room, canonical: String(room.label) };
}

/**
 * 写空间状态（唯一写入口）。原子替换：先写临时文件再 rename，
 * 页面轮询时永远读不到半截 JSON。
 * @param {string} file state/space.json
 * @param {{place?: string, detail?: string, doing?: string}} patch 只覆盖给了的字段
 * @returns {object} 写入后的完整状态
 */
export function writeSpaceState(file, patch = {}) {
  let prev = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prev = parsed;
  } catch { /* 没有或坏了，从空开始 */ }

  const next = { ...prev, version: 1 };
  const now = Date.now();

  if (patch.place !== undefined) {
    const place = clean(patch.place, MAX_PLACE);
    if (!place) throw new Error('place 不能为空');
    if (place !== prev.place) next.since = now;   // 换了地方才重置「待了多久」
    next.place = place;
  }
  if (patch.detail !== undefined) next.detail = clean(patch.detail, MAX_DETAIL);
  if (patch.doing !== undefined) next.doing = clean(patch.doing, MAX_DOING);
  next.updatedAt = now;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return next;
}