// 记忆整理：把重复/过期的记忆合并或丢掉。
//
// 背景：短期记忆会自然过期，但没人合并重复项。同一件事说过三次就是三条，
// 既占上下文又容易让她的说法前后矛盾。这里做三件事：
//   1. 文本高度相似的合并成一条（保留信息量大的那句，标签取并集，时间取最新）
//   2. 短期记忆如果和长期/核心重复，直接丢掉（长期那条已经足够）
//   3. 条目超过上限时，优先丢最旧的短期记忆（核心/长期不动）
//
// 纯函数，不碰文件系统：输入 entries，输出整理后的 entries + 报告。
// 单独跑：node scripts/consolidate-memory.mjs [--dry]

const TIER_RANK = { core: 0, long: 1, short: 2 };

export function normalizeTier(tier) {
  const t = String(tier ?? '').trim().toLowerCase();
  if (t === 'core') return 'core';
  if (t === 'long') return 'long';
  return 'short';
}

/** 去掉标点空白，取两字片段集合；中文用 bigram 比单字稳。 */
function bigrams(text) {
  const s = String(text ?? '').replace(/[\s，。！？…、~～,.!?:；;（）()【】\[\]"'“”‘’]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 相似度：交集 / 较短那侧的大小（一边是另一边的子集时也能认出来）。 */
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

function infoScore(entry) {
  const text = String(entry?.text ?? '');
  const tags = Array.isArray(entry?.tags) ? entry.tags.length : 0;
  return text.length + tags * 8;
}

/**
 * @param {Array} entries 原始记忆
 * @param {object} opts { now, maxEntries, similarThreshold, crossTierThreshold }
 * @returns {{ entries: Array, merged: Array, dropped: Array, before: number, after: number }}
 */
export function consolidateMemories(entries, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const maxEntries = Number(opts.maxEntries) || 400;
  const similarThreshold = Number(opts.similarThreshold) || 0.62;
  const crossTierThreshold = Number(opts.crossTierThreshold) || 0.72;

  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && String(e.text ?? '').trim());
  const before = list.length;

  // 新的排前面：合并时保留"更新 + 信息量"更大的那条
  const sorted = [...list].sort((a, b) => {
    const ta = Number(a.updatedAt ?? a.createdAt ?? 0);
    const tb = Number(b.updatedAt ?? b.createdAt ?? 0);
    if (tb !== ta) return tb - ta;
    return TIER_RANK[normalizeTier(a.tier)] - TIER_RANK[normalizeTier(b.tier)];
  });

  const kept = [];
  const merged = [];
  const dropped = [];

  for (const entry of sorted) {
    const tier = normalizeTier(entry.tier);
    let host = null;
    for (const k of kept) {
      const kTier = normalizeTier(k.tier);
      const sim = similarity(entry.text, k.text);
      const sameTier = kTier === tier;
      // 短期 vs 长期/核心：阈值更高，且只允许"短期被长期吸收"
      const crossOk = !sameTier && tier === 'short' && kTier !== 'short' && sim >= crossTierThreshold;
      if (sameTier && sim >= similarThreshold) { host = k; break; }
      if (crossOk) { host = k; break; }
    }

    if (!host) { kept.push({ ...entry, tier }); continue; }

    // 合并：文本取信息量大的那句，标签并集，时间取最新
    // 先把 id 抓下来：下面会原地改 host，改完两者就分不清谁是谁了（曾经导致 keep/absorb 同一个 id）。
    const hostId = host.id;
    const entryId = entry.id;
    const hostInfo = infoScore(host);
    const entryInfo = infoScore(entry);
    const winner = entryInfo > hostInfo ? entry : host;
    const loser = entryInfo > hostInfo ? host : entry;

    host.text = String(winner.text).trim();
    host.tags = Array.from(new Set([...(Array.isArray(host.tags) ? host.tags : []), ...(Array.isArray(entry.tags) ? entry.tags : [])]));
    host.updatedAt = Math.max(Number(host.updatedAt ?? 0), Number(entry.updatedAt ?? entry.createdAt ?? 0), now);
    host.hits = (Number(host.hits) || 0) + (Number(entry.hits) || 0);
    // 合并后按更高的层算：长期吸收短期后仍是长期；核心不降级
    const hostTier = normalizeTier(host.tier);
    host.tier = TIER_RANK[hostTier] <= TIER_RANK[tier] ? hostTier : tier;

    merged.push({ keep: hostId, absorb: entryId, sim: Number(similarity(entry.text, host.text).toFixed(2)) });
  }

  // 上限：先丢最旧的短期，再丢最旧的长期
  let final = kept;
  if (final.length > maxEntries) {
    const rank = (e) => TIER_RANK[normalizeTier(e.tier)] * 1e13 + Number(e.updatedAt ?? e.createdAt ?? 0);
    final = [...final].sort((a, b) => rank(a) - rank(b));
    const overflow = final.length - maxEntries;
    for (let i = 0; i < overflow; i += 1) dropped.push({ id: final[i].id, reason: 'overflow', tier: normalizeTier(final[i].tier) });
    final = final.slice(overflow);
  }

  return { entries: final, merged, dropped, before, after: final.length, now };
}