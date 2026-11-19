// B站视频信息 + 热评：让"翻评论区"变成她的本能，而不是可选动作。
//
// 为什么放在桥接里而不是只给她一个工具：
//   1) 她经常懒得调工具，但"弹幕/热评当谈资"是这版的重点，所以要自动送进提示词；
//   2) 工具返回的是原始 JSON，热评动辄上百字，直接塞会挤爆上下文，这里先压成 3 行；
//   3) 走公开接口、8 秒超时、30 分钟缓存 —— 不登录、不刷接口、失败就当没有。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-bridge/bili-comments';
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 60 * 1000;

const cache = new Map(); // bvid -> { at, info, comments }

export function bvidOf(text) {
  const m = String(text ?? '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

/** b23.tv 短链 → 展开成完整链接（失败就返回原样） */
export async function expandShortLink(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA }, signal: controller.signal });
    clearTimeout(timer);
    return res.url || url;
  } catch {
    return url;
  }
}

async function getJson(url, { signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.code === 0 ? json.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 视频基本信息（标题/UP/播放/简介），失败返回 null */
export async function fetchVideoInfo(bvid) {
  if (!bvid) return null;
  const data = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (!data) return null;
  return {
    bvid,
    aid: data.aid,
    title: String(data.title ?? '').trim(),
    owner: String(data.owner?.name ?? ''),
    view: Number(data.stat?.view) || 0,
    like: Number(data.stat?.like) || 0,
    desc: String(data.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    tname: String(data.tname ?? '')
  };
}

/** 热评（按点赞），压成 {like, text, replies} */
export async function fetchTopComments(aid, { limit = 4 } = {}) {
  if (!aid) return [];
  const data = await getJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&sort=2&ps=${limit + 2}`);
  const list = Array.isArray(data?.replies) ? data.replies : [];
  return list
    .map((r) => ({
      like: Number(r.like) || 0,
      text: String(r.content?.message ?? '').replace(/\s+/g, ' ').trim(),
      replies: Number(r.rcount) || 0
    }))
    .filter((r) => r.text)
    .slice(0, limit);
}

/** 带缓存的一步到位 */
export async function videoWithComments(bvid, { comments = 4 } = {}) {
  if (!bvid) return null;
  const hit = cache.get(bvid);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const info = await fetchVideoInfo(bvid);
  if (!info) return null;
  const top = await fetchTopComments(info.aid, { limit: comments });
  const value = { at: Date.now(), info, comments: top };
  cache.set(bvid, value);
  return value;
}

const numCn = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));

/** 压成提示词里能用的几行 */
export function videoLine(v, { maxComments = 3 } = {}) {
  if (!v?.info) return '';
  const i = v.info;
  const head = `【这条视频】${i.title}｜UP：${i.owner || '未知'}｜播放 ${numCn(i.view)}｜赞 ${numCn(i.like)}${i.desc ? `｜简介：${i.desc}` : ''}`;
  const top = (v.comments ?? []).slice(0, maxComments);
  if (!top.length) return `${head}\n（评论没拉到，别硬编评论内容。）\n`;
  const lines = top.map((c, idx) => `${idx + 1}. ♥${numCn(c.like)}${c.replies ? `（${c.replies} 条回复）` : ''} ${c.text.slice(0, 70)}`);
  return `${head}\n【热评】${lines.join('；')}\n`
    + '聊这条的时候，从热评里挑一个点接话（梗、争议、共鸣都行），别整段复述评论，也别把评论当自己的观点。\n';
}