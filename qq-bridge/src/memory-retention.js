// 记忆遗忘曲线模型（Ebbinghaus 指数衰减），星图与面板共用，纯函数、无副作用。
//
//   R(t) = exp(-t / S)        t = 距离上次被强化（updatedAt）的天数，S = 稳定度（天）
//
// S 由真实数据决定，而不是随机装饰：
//   · 层级   core 近乎不衰减；long 基础 60 天；short 取其真实 TTL（到期时 R≈5%）
//     （60 天是 2026-11-01 调过的：原来 18 天，实测长期记忆 19 天就掉一半，
//      感觉像"刚说完就忘"。现在半衰期中位约 62 天、三个月才掉到 35%，更像长期记忆。）
//   · 强化   createdAt→updatedAt 跨度越长，说明被反复提起过，S 乘 1+0.6·ln(1+跨度天数)
//   · 关联   与更多记忆共享标签（联想越丰富）衰减越慢，S 乘 1+0.1·min(度数,8)
// 短期记忆在 expiresAt 之后会被桥接真实删除，所以那一刻之后视为「已遗忘」。
//
// 2026-11-11：短期那条线原来掉得太急——3 天 TTL 用纯指数算，半天就只剩 37%、
// 一天掉到 22%，看着像"上午说的下午就忘"。现在短期改用**拉伸指数**（形状 1.8）：
// 到期那一刻仍然是 ~5%，但前半程慢得多（3 天 TTL：1 天后 66%、1.5 天 47%、2.5 天 14%）。
// 实际 TTL 也从 3 天放宽到 7 天（bridge 的 socialV2.memory.shortTtlDays）。
export const DAY_MS = 86400000;
export const CORE_STABILITY_DAYS = 3650;
export const LONG_BASE_DAYS = 60;
export const FADING_BELOW = 0.35;
// 短期记忆的衰减形状：1 = 纯指数；>1 = 前段慢、临到期才塌下去。
export const SHORT_CURVE_SHAPE = 1.8;
const SHORT_DEFAULT_TTL_DAYS = 7;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function tierOf(entry) {
  const t = String(entry?.tier || '').toLowerCase();
  return t === 'core' || t === 'short' ? t : 'long';
}

/** 与星图连线规则一致：同标签且该标签成员不超过 10 才算有效联想。 */
export function associationDegrees(entries) {
  const byTag = new Map();
  entries.forEach((e, i) => {
    for (const tag of Array.isArray(e?.tags) ? e.tags : []) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(i);
    }
  });
  const peers = entries.map(() => new Set());
  for (const members of byTag.values()) {
    if (members.length > 10) continue;
    for (const a of members) for (const b of members) if (a !== b) peers[a].add(b);
  }
  return peers.map((set) => set.size);
}

/** 稳定度（天）。 */
export function stabilityDays(entry, degree = 0) {
  const tier = tierOf(entry);
  const updated = Number(entry?.updatedAt || entry?.createdAt) || 0;
  const created = Number(entry?.createdAt || entry?.updatedAt) || updated;
  const spanDays = Math.max(0, (updated - created) / DAY_MS);
  const reinforce = 1 + 0.6 * Math.log1p(spanDays);
  const assoc = 1 + 0.1 * clamp(degree, 0, 8);
  let base;
  if (tier === 'core') base = CORE_STABILITY_DAYS;
  else if (tier === 'short') {
    const expires = Number(entry?.expiresAt) || 0;
    const ttlDays = expires > updated ? (expires - updated) / DAY_MS : SHORT_DEFAULT_TTL_DAYS;
    base = Math.max(0.25, ttlDays / 3); // R(ttl) = e^-3 ≈ 5%
  } else base = LONG_BASE_DAYS;
  return base * (tier === 'short' ? 1 : reinforce) * assoc;
}

/**
 * 保持率 0..1；已过 expiresAt 的短期记忆为 0。
 * shape > 1 时短期用拉伸指数 R = exp(-3·(t/ttl)^shape)（ttl = 3·stability）：
 * 到期仍约 5%，但前期掉得慢，不会半天就"看起来忘了"。
 */
export function retention(stability, updatedAt, now, expiresAt = 0, shape = 1) {
  if (expiresAt > 0 && now >= expiresAt) return 0;
  const updated = Number(updatedAt) || now;
  const age = Math.max(0, (now - updated) / DAY_MS);
  const s = Math.max(0.05, stability);
  if (!(shape > 1) || !(expiresAt > 0)) return Math.exp(-age / s);
  const ttl = Math.max(0.25, (expiresAt - updated) / DAY_MS);
  return Math.exp(-3 * Math.pow(age / ttl, shape));
}

/** 从当前时刻起，保持率跌到 target 还要几天；已低于则为 0；核心级稳定度视为永不遗忘（Infinity）。 */
export function daysUntil(stability, updatedAt, now, target = 0.5, expiresAt = 0, shape = 1) {
  if (stability >= CORE_STABILITY_DAYS * 0.5 && !(expiresAt > 0)) return Infinity;
  const updated = Number(updatedAt) || now;
  const age = Math.max(0, (now - updated) / DAY_MS);
  const t = shape > 1 && expiresAt > 0
    ? Math.max(0.25, (expiresAt - updated) / DAY_MS) * Math.pow(Math.log(1 / clamp(target, 0.001, 0.999)) / 3, 1 / shape)
    : -Math.log(clamp(target, 0.001, 0.999)) * stability;
  let days = Math.max(0, t - age);
  if (expiresAt > 0) days = Math.min(days, Math.max(0, (expiresAt - now) / DAY_MS));
  return days;
}

/** 给每条记忆附上遗忘参数（顺序与输入一致）。 */
export function annotate(entries) {
  const degrees = associationDegrees(entries);
  return entries.map((e, i) => ({
    s: +stabilityDays(e, degrees[i]).toFixed(3),
    k: tierOf(e),
    dg: degrees[i],
    u: Number(e?.updatedAt || e?.createdAt) || 0,
    c: Number(e?.createdAt || e?.updatedAt) || 0,
    x: Number(e?.expiresAt) > 0 ? Number(e.expiresAt) : 0
  }));
}

/**
 * 整体概览：平均保持率、低于阈值的条数，以及各层级未来 horizon 天的平均保持率曲线。
 * 用于面板里的遗忘曲线卡片。
 */
export function summarize(entries, now = Date.now(), horizonDays = 60, steps = 30) {
  const meta = annotate(entries);
  const tiers = { core: [], long: [], short: [] };
  entries.forEach((e, i) => tiers[tierOf(e)].push(meta[i]));
  const rAt = (m, t) => retention(m.s, m.u, t, m.x, m.k === 'short' ? SHORT_CURVE_SHAPE : 1);
  const avgAt = (list, t) => (list.length ? list.reduce((sum, m) => sum + rAt(m, t), 0) / list.length : null);
  const series = {};
  for (const tier of Object.keys(tiers)) {
    series[tier] = Array.from({ length: steps + 1 }, (_, k) => avgAt(tiers[tier], now + (horizonDays * DAY_MS * k) / steps));
  }
  const all = meta.map((m) => rAt(m, now));
  const atHorizon = meta.map((m) => rAt(m, now + 7 * DAY_MS));
  return {
    total: entries.length,
    average: all.length ? all.reduce((a, b) => a + b, 0) / all.length : 1,
    fadingNow: all.filter((r) => r < FADING_BELOW).length,
    fadingIn7d: atHorizon.filter((r) => r < FADING_BELOW).length,
    horizonDays,
    series
  };
}
