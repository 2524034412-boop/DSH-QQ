// 「她眼中的社交圈」：数据 → 图的纯函数。无副作用、不读写文件、不依赖时间戳以外的全局。
//
// 每个视觉维度都绑定真实字段（见 docs/社交圈-字段映射.md）：
//   好感 score   → 离中心的距离（越亲越近）
//   喜爱 love    → 光晕强度与暖色
//   忠诚 loyalty → 与中心连线的粗细
//   discipline   → 描边颜色（琥珀→红）；ignoreUntil 未到期 → 连线虚线
//   最近互动 lastAt + 稳定度 → 亮度，沿用 R(t)=e^(-t/S)
//   档位         → 节点大小
//
// 所有缺失字段都有兜底，绝不产生 NaN。

export const DAY_MS = 86400000;

export const BANDS = [
  { key: 'stranger', label: '陌生', min: 0, size: 3.2 },
  { key: 'familiar', label: '眼熟', min: 20, size: 4.2 },
  { key: 'known', label: '熟人', min: 40, size: 5.2 },
  { key: 'friend', label: '好朋友', min: 65, size: 6.4 },
  { key: 'special', label: '特别的人', min: 85, size: 8.0 }
];

// 距离映射：好感 0 → 最外圈，100 → 最内圈。指数让"亲近"在画面上更明显。
export const DIST_FAR = 1.0;
export const DIST_NEAR = 0.22;

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 好感分档（0~100）。 */
export function bandOf(score) {
  const s = clamp(num(score), 0, 100);
  let out = BANDS[0];
  for (const b of BANDS) if (s >= b.min) out = b;
  return out;
}

/** 好感 → 归一化半径（0 中心，1 最外）。单调不增。 */
export function distanceFor(score) {
  const s = clamp(num(score), 0, 100) / 100;
  const eased = Math.pow(1 - s, 0.85);       // 0 好感 → 1；100 好感 → 0
  return DIST_NEAR + (DIST_FAR - DIST_NEAR) * eased;
}

/**
 * 关系的「稳定度」（天）：聊得越多、越喜欢、越忠诚，越不容易忘记。
 * 这是关系图对遗忘曲线的类比 —— 星图里 S 由记忆层级与强化次数决定，
 * 这里由真实的 love / count / score 决定，公式与常数集中在下面这段。
 */
export function stabilityDays({ love = 0, count = 0, score = 0 } = {}) {
  const base = 2.0;
  const byLove = clamp(num(love), 0, 100) * 0.16;
  const byCount = Math.log1p(Math.max(0, num(count))) * 1.7;
  const byScore = clamp(num(score), 0, 100) * 0.02;
  return clamp(base + byLove + byCount + byScore, 1.5, 90);
}

/** 亮度（保持率 0..1）。与 memory-retention.js 的 retention() 同一公式。 */
export function retentionOf(lastAt, stability, now) {
  const last = num(lastAt);
  if (!last) return 0;
  const ageDays = Math.max(0, (num(now) - last) / DAY_MS);
  return Math.exp(-ageDays / Math.max(0.05, num(stability, 1)));
}

/** 纪律状态：等级 → 描边色；冷处理未到期 → 虚线。 */
export function warningOf(entry, now) {
  const level = clamp(num(entry?.level), 0, 3);
  const until = num(entry?.ignoreUntil);
  const cooling = until > 0 && until > num(now);
  const stroke = level >= 3 ? '#ff6b5e' : level === 2 ? '#ffa94d' : level === 1 ? '#ffd166' : '';
  return { level, cooling, stroke, until };
}

/** QQ 号打码：保留前 4 位与后 2 位。 */export function maskUid(uid) {
  const s = String(uid ?? '').replace(/\D/g, '');
  if (s.length <= 6) return s ? s[0] + '*'.repeat(Math.max(1, s.length - 1)) : '未知';
  return s.slice(0, 4) + '****' + s.slice(-2);
}

/** 把 discipline 的 "group:NNN|uid" 键拆开，并聚合成 uid → 最高等级。 */
export function collectDiscipline(users, now) {
  const byUid = new Map();
  for (const [key, entry] of Object.entries(users || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = String(key);
    const uid = raw.includes('|') ? raw.slice(raw.indexOf('|') + 1) : raw;
    if (!/^\d+$/.test(uid)) continue;
    const w = warningOf(entry, now);
    const prev = byUid.get(uid);
    if (!prev || w.level > prev.level || (w.level === prev.level && w.cooling && !prev.cooling)) {
      byUid.set(uid, w);
    }
  }
  return byUid;
}

/**
 * 构建关系图数据。
 * @param {object} input
 * @param {object} input.affinity   affinity.json 的 people
 * @param {object} input.impressions impressions.json 的 people
 * @param {object} input.discipline  discipline.json 的 users
 * @param {object} input.memberships uid → [群号…]（由聊天记录统计）
 * @param {string} input.ownerQQ
 * @param {string} input.selfUid     机器人自己的 QQ（要从"别人"里剔除）
 * @param {number} input.now
 */
export function buildSocialGraph(input = {}) {
  const now = num(input.now, Date.now());
  const ownerQQ = String(input.ownerQQ ?? '');
  const selfUid = String(input.selfUid ?? '');
  const affinity = input.affinity && typeof input.affinity === 'object' ? input.affinity : {};
  const impressions = input.impressions && typeof input.impressions === 'object' ? input.impressions : {};
  const memberships = input.memberships && typeof input.memberships === 'object' ? input.memberships : {};
  const discipline = collectDiscipline(input.discipline, now);

  const uids = new Set();
  for (const uid of Object.keys(affinity)) uids.add(uid);
  for (const uid of Object.keys(impressions)) uids.add(uid);
  for (const uid of discipline.keys()) uids.add(uid);

  // 她自己的 QQ 也会出现在 affinity 里（历史记录里 me 标记不可靠，见对话回放的同类处理），
  // 这里按昵称剔除：既认登录名，也认「deepseek…助手」这种形态。
  const selfNameNorm = String(input.selfName ?? '').replace(/\s+/g, '').toLowerCase();
  const looksLikeSelf = (name) => {
    const n = String(name || '').replace(/\s+/g, '').toLowerCase();
    if (!n) return false;
    if (selfNameNorm && n === selfNameNorm) return true;
    return n.includes('deepseek') && n.includes('助手');
  };

  const nodes = [];
  for (const uid of uids) {
    if (!/^\d+$/.test(uid)) continue;
    if (uid === selfUid) continue;              // 她自己不进图
    if (uid === ownerQQ) continue;              // 主人单独画

    const a = affinity[uid] || {};
    const imp = impressions[uid] || {};
    const warn = discipline.get(uid) || { level: 0, cooling: false, stroke: '', until: 0 };
    const score = clamp(num(a.score, 0), 0, 100);
    const love = clamp(num(a.love, 0), 0, 100);
    const loyalty = clamp(num(a.loyalty, 0), 0, 100);
    const lastAt = num(a.lastAt, 0);
    const groups = Array.isArray(memberships[uid]) ? memberships[uid].filter(Boolean) : [];
    const stability = stabilityDays({ love, count: num(a.count), score });
    const name = String(a.name || imp.name || '').slice(0, 24);
    if (looksLikeSelf(name)) continue;          // 昵称看着是她自己 → 不进"别人"

    // 群归属：优先聊天记录统计出的群，其次退回 affinity 记的 lastConv
    const fallbackGroup = String(a.lastConv || '').replace(/^group:/, '');
    const group = groups[0] || (/^\d+$/.test(fallbackGroup) ? fallbackGroup : '');

    nodes.push({
      uid,
      masked: maskUid(uid),
      name,
      score: +score.toFixed(1),
      love: +love.toFixed(1),
      loyalty: +loyalty.toFixed(1),
      count: num(a.count),
      lastAt,
      stability: +stability.toFixed(2),
      retention: +retentionOf(lastAt, stability, now).toFixed(4),
      band: bandOf(score).key,
      bandLabel: bandOf(score).label,
      size: bandOf(score).size,
      distance: +distanceFor(score).toFixed(4),
      warningLevel: warn.level,
      cooling: !!warn.cooling,
      stroke: warn.stroke,
      group,
      groups,
      sentiment: String(imp.sentiment || ''),
      impression: String(imp.text || '').slice(0, 200),
      traits: Array.isArray(imp.traits) ? imp.traits.slice(0, 6).map((t) => String(t).slice(0, 12)) : []
    });
  }

  // 主人：单独标识，固定在内圈
  const ownerA = affinity[ownerQQ] || {};
  const ownerImp = impressions[ownerQQ] || {};
  const ownerWarn = discipline.get(ownerQQ) || { level: 0, cooling: false, stroke: '', until: 0 };
  const ownerScore = clamp(num(ownerA.score, 0), 0, 100);
  const owner = ownerQQ ? {
    uid: ownerQQ,
    masked: maskUid(ownerQQ),
    name: String(ownerA.name || ownerImp.name || '老大').slice(0, 24),
    score: +ownerScore.toFixed(1),
    love: +clamp(num(ownerA.love, 0), 0, 100).toFixed(1),
    loyalty: 100,
    count: num(ownerA.count),
    lastAt: num(ownerA.lastAt),
    stability: +stabilityDays({ love: num(ownerA.love), count: num(ownerA.count), score: ownerScore }).toFixed(2),
    retention: +retentionOf(num(ownerA.lastAt), stabilityDays({ love: num(ownerA.love), count: num(ownerA.count), score: ownerScore }), now).toFixed(4),
    band: bandOf(ownerScore).key,
    bandLabel: bandOf(ownerScore).label,
    size: bandOf(ownerScore).size + 1.4,
    distance: 0.14,                      // 固定内圈，不参与半径竞争
    warningLevel: ownerWarn.level,
    cooling: !!ownerWarn.cooling,
    stroke: ownerWarn.stroke,
    impression: String(ownerImp.text || '').slice(0, 200),
    traits: Array.isArray(ownerImp.traits) ? ownerImp.traits.slice(0, 6).map((t) => String(t).slice(0, 12)) : []
  } : null;

  // 群：用 group-stats 的真实字段（speaks/msgs/joys/bonus）标注权重
  const groupStats = input.groupStats && typeof input.groupStats === 'object' ? input.groupStats : {};
  const groupIds = new Set();
  for (const n of nodes) for (const g of n.groups) groupIds.add(g);
  for (const k of Object.keys(groupStats)) {
    if (k.startsWith('group:')) groupIds.add(k.slice(6));
  }
  const groups = [...groupIds].map((id) => {
    const st = groupStats[`group:${id}`] || {};
    // 成员数按「有效归属」算（聊天记录优先，其次 lastConv），这样没出现在最近聊天记录里的人也能归组
    const members = nodes.filter((n) => n.group === id).length;
    return {
      id,
      label: String(id),
      members,
      speaks: num(st.speaks),
      msgs: num(st.msgs),
      joys: num(st.joys),
      bonus: num(st.bonus)
    };
  }).sort((a, b) => b.members - a.members || b.msgs - a.msgs);

  return {
    now,
    center: { name: '小鲸鱼' },
    owner,
    nodes,
    groups,
    stats: {
      people: nodes.length,
      groups: groups.length,
      special: nodes.filter((n) => n.band === 'special').length,
      warned: nodes.filter((n) => n.warningLevel > 0).length,
      fading: nodes.filter((n) => n.retention < 0.35).length
    }
  };
}

// ────────────────────────────────────────────────────────────────
// 人与人之间的连线
//
// 口径（2026-11-01 确认）：
//   · 接话：同一群里 A 发言后 windowMs 内 B 发言，且中间没有 A 自己接着说 → (A,B) 记一次
//   · @提及：消息正文出现 "@某人昵称"，且昵称能对上同群某个人 → (发言人, 被@者) 记 0.5 次
//
// 只统计「同一群里、两个不同的人、且都不是她自己」。计数对称化后取最强 topN 条。
// ────────────────────────────────────────────────────────────────

export const LINK_REPLY_WEIGHT = 1;export const LINK_MENTION_WEIGHT = 0.5;
export const LINK_WINDOW_MS = 5 * 60 * 1000;
export const LINK_TOP_N = 15;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} input
 * @param {Array<{t:number,u:string,g:string,x:string}>} input.messages
 * @param {Record<string,string>} input.names  uid → 昵称（用于识别 @）
 * @param {string} input.selfUid
 * @param {number} [input.windowMs]
 * @param {number} [input.topN]
 */
export function buildPersonLinks(input = {}) {
  const selfUid = String(input.selfUid ?? '');
  const windowMs = num(input.windowMs, LINK_WINDOW_MS) || LINK_WINDOW_MS;
  const topN = Math.max(1, Math.floor(num(input.topN, LINK_TOP_N) || LINK_TOP_N));

  // 昵称表：过滤掉空名、单字名（太容易误命中）
  const nameToUid = new Map();
  for (const [uid, name] of Object.entries(input.names || {})) {
    const n = String(name || '').trim();
    if (n.length < 2) continue;
    if (uid === selfUid) continue;
    if (!nameToUid.has(n)) nameToUid.set(n, uid);
  }
  const nameList = [...nameToUid.keys()].sort((a, b) => b.length - a.length);
  const mentionRe = nameList.length
    ? new RegExp('@(' + nameList.map(escapeRe).join('|') + ')', 'g')
    : null;

  const msgs = (Array.isArray(input.messages) ? input.messages : [])
    .map((m) => ({
      t: num(m?.t),
      u: String(m?.u ?? ''),
      g: String(m?.g ?? ''),
      x: String(m?.x ?? '')
    }))
    .filter((m) => m.u && m.g && /^\d+$/.test(m.u))
    .sort((a, b) => a.t - b.t);

  const pair = new Map(); // "a|b" (a<b) → {replies, mentions}
  const bump = (a, b, field) => {
    if (!a || !b || a === b) return;
    if (a === selfUid || b === selfUid) return;
    const key = a < b ? a + '|' + b : b + '|' + a;
    let e = pair.get(key);
    if (!e) { e = { a: a < b ? a : b, b: a < b ? b : a, replies: 0, mentions: 0 }; pair.set(key, e); }
    if (field === 'mentions') e.mentions += 1;
    else e.replies += 1;
  };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    // @ 提及
    if (mentionRe) {
      mentionRe.lastIndex = 0;
      let hit;
      while ((hit = mentionRe.exec(m.x))) {
        const target = nameToUid.get(hit[1]);
        if (target && target !== m.u) bump(m.u, target, 'mentions');
      }
    }

    // 接话：往后找第一条「不同人」的消息，中间若出现同一人连续发言则视为没接上
    for (let j = i + 1; j < msgs.length; j++) {
      const n = msgs[j];
      if (n.g !== m.g) break;
      if (n.t - m.t > windowMs) break;
      if (n.u === m.u) break;               // 自己接着说，不算接话
      bump(m.u, n.u, 'replies');
      break;
    }
  }

  const edges = [...pair.values()]
    .map((e) => ({
      a: e.a,
      b: e.b,
      replies: e.replies,
      mentions: e.mentions,
      weight: +(e.replies * LINK_REPLY_WEIGHT + e.mentions * LINK_MENTION_WEIGHT).toFixed(2)
    }))
    .filter((e) => e.weight > 0)
    .sort((x, y) => y.weight - x.weight);

  const max = edges.length ? edges[0].weight : 0;
  const top = edges.slice(0, topN).map((e) => ({
    ...e,
    strength: max > 0 ? +(e.weight / max).toFixed(3) : 0
  }));

  return { edges: top, total: edges.length, maxWeight: max };
}

// ────────────────────────────────────────────────────────────────
// 语义关系（她自己观察后写下的，不是统计推断）
//
// 存法：impressions.json → relations[fromUid] = [{ to, kind, note, at }]
//   kind ∈ 亲近 / 对立 / 依赖
// 同一对人可能有两条（A 说 B、B 说 A），这里合并成一条：
//   · kind 冲突时按 对立 > 依赖 > 亲近 取一个代表
//   · mutual = 两个方向都有
// 只保留两端都在图里的人（否则画不出来）。
// ────────────────────────────────────────────────────────────────

export const RELATION_KINDS = ['亲近', '对立', '依赖'];
const KIND_PRIORITY = { 对立: 3, 依赖: 2, 亲近: 1 };

export function buildSemanticEdges(relations = {}, nodes = [], owner = null, selfUid = '') {
  const known = new Set((Array.isArray(nodes) ? nodes : []).map((n) => String(n?.uid ?? '')));
  if (owner) known.add(String(owner.uid ?? ''));
  const self = String(selfUid ?? '');

  const pairs = new Map();
  for (const [from, list] of Object.entries(relations || {})) {
    if (!Array.isArray(list)) continue;
    if (!/^\d+$/.test(from) || from === self) continue;
    for (const r of list) {
      const to = String(r?.to ?? '');
      const kind = RELATION_KINDS.includes(String(r?.kind ?? '')) ? String(r.kind) : '';
      if (!kind || !/^\d+$/.test(to) || to === from || to === self) continue;
      if (!known.has(from) || !known.has(to)) continue;
      const key = from < to ? from + '|' + to : to + '|' + from;
      let e = pairs.get(key);
      if (!e) { e = { a: from < to ? from : to, b: from < to ? to : from, kinds: new Set(), dirs: new Set(), notes: [] }; pairs.set(key, e); }
      e.kinds.add(kind);
      e.dirs.add(from + '>' + to);
      if (r?.note) e.notes.push({ kind, note: String(r.note).slice(0, 80), at: Number(r.at) || 0 });
    }
  }

  return [...pairs.values()].map((e) => {
    const kind = [...e.kinds].sort((x, y) => KIND_PRIORITY[y] - KIND_PRIORITY[x])[0];
    const note = e.notes.sort((x, y) => y.at - x.at)[0]?.note || '';
    const dir = [...e.dirs][0] || '';
    const [from, to] = dir ? dir.split('>') : [e.a, e.b];
    return {
      a: e.a,
      b: e.b,
      from,
      to,
      kind,
      kinds: [...e.kinds],
      mutual: e.dirs.size > 1,
      note
    };
  }).sort((x, y) => KIND_PRIORITY[y.kind] - KIND_PRIORITY[x.kind]);
}


