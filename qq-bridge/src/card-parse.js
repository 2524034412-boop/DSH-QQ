// QQ 分享卡片解析：把 OneBot 的 json/xml 卡片段变成"人能看懂的一行字"。
//
// 为什么需要：QQ 里发的链接大多是卡片（structmsg / miniapp / 音乐 / 小程序），
// OneBot 只给一段塞在 data.data 里的 JSON 字符串或 XML。桥接以前一律输出
// 「[卡片消息]」——她看不到标题、看不到链接，只能装瞎。
//
// 这里只做"读"，不联网：把 app 名、标题、描述、链接、来源抠出来，
// 让她知道对面发的是什么，再决定要不要用 web_fetch / bili_* 去看内容。

const APP_LABEL = [
  [/structmsg.*news|news/i, '链接卡片'],
  [/miniapp|mini_app|小程序/, '小程序'],
  [/music|qqmusic/i, '音乐'],
  [/video/i, '视频'],
  [/file/i, '文件'],
  [/live/i, '直播']
];

function labelOf(app) {
  const s = String(app ?? '');
  for (const [re, label] of APP_LABEL) if (re.test(s)) return label;
  if (/bilibili/i.test(s)) return 'B站';
  return '卡片';
}

/** 卡片链接落在哪些平台 —— 只是给人看，不发起请求 */
export function platformOf(url) {
  const u = String(url ?? '');
  if (/bilibili\.com|b23\.tv/i.test(u)) return 'B站';
  if (/youtube\.com|youtu\.be/i.test(u)) return 'YouTube';
  if (/zhihu\.com/i.test(u)) return '知乎';
  if (/weibo\.(com|cn)/i.test(u)) return '微博';
  if (/douyin\.com|iesdouyin/i.test(u)) return '抖音';
  if (/xiaohongshu\.com|xhslink/i.test(u)) return '小红书';
  if (/mp\.weixin\.qq\.com/i.test(u)) return '公众号';
  if (/github\.com/i.test(u)) return 'GitHub';
  if (/qq\.com\/.*music|y\.qq\.com/i.test(u)) return 'QQ音乐';
  if (/steam|store\.steampowered/i.test(u)) return 'Steam';
  if (/taobao|tmall|jd\.com|pinduoduo/i.test(u)) return '购物';
  return '';
}

/** B站链接里的 BV 号（她可以直接拿去 bili_* 工具） */
export function bvidOf(url) {
  const m = String(url ?? '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

function pickFirstUrl(obj) {
  const keys = ['jumpUrl', 'jump_url', 'qqdocurl', 'url', 'link', 'shareUrl', 'source_url'];
  for (const k of keys) if (typeof obj?.[k] === 'string' && obj[k]) return obj[k];
  return '';
}

function pickStr(obj, keys) {
  for (const k of keys) if (typeof obj?.[k] === 'string' && obj[k].trim()) return obj[k].trim();
  return '';
}

/** 深度找"像内容卡片"的那个对象（有 title 且有 url） */
function findContentNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  const title = pickStr(node, ['title', 'summary', 'desc', 'content']);
  const url = pickFirstUrl(node);
  if (title && url) return node;
  for (const v of Object.values(node)) {
    const hit = findContentNode(v, depth + 1);
    if (hit) return hit;
  }
  // 退一步：只有标题也收
  if (title) return node;
  return null;
}

/**
 * @param {string} raw OneBot json 段里的 data.data（一段 JSON 字符串）
 * @returns {{app:string,label:string,title:string,desc:string,url:string,platform:string,bvid:string|null}|null}
 */
export function parseShareCard(raw) {
  if (!raw) return null;
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return parseCardXml(raw); }
  }
  if (!data || typeof data !== 'object') return null;
  const app = String(data.app ?? data.appid ?? data.bizsrc ?? '');
  const node = findContentNode(data.meta ?? data) ?? {};
  const title = pickStr(node, ['title', 'summary', 'desc', 'content']);
  const desc = pickStr(node, ['desc', 'description', 'summary']);
  const url = pickFirstUrl(node) || pickFirstUrl(data);
  if (!title && !url) return null;
  return {
    app,
    label: labelOf(app),
    title,
    desc: desc && desc !== title ? desc : '',
    url,
    platform: platformOf(url),
    bvid: bvidOf(url)
  };
}

/** XML 卡片（老客户端/部分分享还是 XML） */
export function parseCardXml(xml) {
  const s = String(xml ?? '');
  const pick = (tag) => {
    const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  };
  const title = pick('title');
  const summary = pick('summary');
  const url = pick('url');
  if (!title && !url) return null;
  return {
    app: 'xml',
    label: '卡片',
    title,
    desc: summary && summary !== title ? summary : '',
    url,
    platform: platformOf(url),
    bvid: bvidOf(url)
  };
}

/** 压成一行可读文本，给提示词用 */
export function cardToText(card) {
  if (!card) return '[卡片消息]';
  const head = card.platform ? `分享·${card.platform}` : `分享·${card.label}`;
  const parts = [`[${head}]`];
  if (card.title) parts.push(`「${card.title}」`);
  if (card.desc) parts.push(card.desc.slice(0, 60));
  if (card.bvid) parts.push(`BV=${card.bvid}`);
  if (card.url) parts.push(card.url.slice(0, 200));
  return parts.join(' ');
}

/** 从纯文本里挑出链接（她可能需要去看） */
export function urlsInText(text) {
  const out = String(text ?? '').match(/https?:\/\/[^\s"'<>）)]+/g) ?? [];
  return [...new Set(out)].slice(0, 3);
}