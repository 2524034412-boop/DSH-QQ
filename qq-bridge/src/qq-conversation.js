const STOP = /^(?:小鲸鱼[，,、：:\s]*)?(?:等一下|等下|等等|等会儿|等我说完|停一下|先别(?:发|说|回|讲)|别(?:继续|发了|说了)|打断一下|不是[，,、：:\s]|不是这个|不是那个|不对(?:[，,、：:\s]|$)|我说的是|我的意思是|我说错了|我改一下|我还没说完|先听我说|wait\b|hold on\b)/iu;
const PREF_KEYS = ['workFollowUps', 'casualLinks', 'quietAtNight'];

export function interruptsBurst(message, { privateChat, peerId, addressed }) {
  if (!message || message.isSelf) return false;
  const text = String(message.plain || message.text || '').trim().replace(/^@\S+[\s，,、：:]+/u, '');
  return STOP.test(text) && (privateChat || addressed || (peerId != null && String(message.userId) === peerId));
}

export function chatPreferencePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !PREF_KEYS.includes(key) || typeof value[key] !== 'boolean')) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

export function isWorkFollowUp(text) {
  return /工作|入职|离职|转正|晋升|加班|面试|投简历|绩效|述职|求职|同事|领导|客户|上班|下班|job|interview|résumé|coworker/iu.test(String(text ?? ''));
}

export function preferenceQuietNow(preferences, date = new Date()) {
  const hour = date.getHours();
  return preferences?.quietAtNight === true && (hour >= 23 || hour < 8);
}

export function normalizeBiliVideo(value) {
  const text = String(value ?? '').trim();
  const videoId = '(?:BV[0-9A-Za-z]{10}|av[1-9][0-9]*)';
  if (new RegExp('^' + videoId + '$').test(text)) {
    return { id: text, url: 'https://www.bilibili.com/video/' + text };
  }
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (url.hostname === 'b23.tv' && /^\/[0-9A-Za-z]+\/?$/.test(url.pathname)) {
    const code = url.pathname.split('/')[1];
    return { id: 'b23:' + code, url: 'https://b23.tv/' + code };
  }
  if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return null;
  const match = new RegExp('^/video/(' + videoId + ')/?$').exec(url.pathname);
  if (!match) return null;
  const safeQuery = new URLSearchParams();
  for (const key of ['p', 't']) {
    const value = url.searchParams.get(key);
    if (value && /^\d{1,9}$/.test(value)) safeQuery.set(key, value);
  }
  const query = safeQuery.toString();
  return { id: match[1], url: 'https://www.bilibili.com/video/' + match[1] + (query ? '?' + query : '') };
}

export function recentBiliShares(shares, now = Date.now()) {
  return Object.fromEntries(Object.entries(shares ?? {})
    .filter(([id, stamp]) => /^(?:BV[0-9A-Za-z]{10}|av[1-9][0-9]*|b23:[0-9A-Za-z]+)$/.test(id)
      && Number.isFinite(stamp) && stamp > now - 7 * 24 * 60 * 60_000)
    .sort((a, b) => b[1] - a[1]).slice(0, 50));
}
