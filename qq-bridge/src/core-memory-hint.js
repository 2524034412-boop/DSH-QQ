// 「别人说了关于她这个人的话」识别：给她一条写核心记忆的提醒。
// 只做文本判定，纯函数、可单测；提醒本身放在 bridge 的唤醒提示里。

// 顺序有讲究：更具体的（贬低/质疑）排在笼统的「你只是…」前面，
// 否则「你只是个工具」会被判成普通人格评价。
export const CORE_PERSONA_HINTS = [
  { re: /你只(是|不过)(个|一个)?\s*(ai|AI|机器人|模型|工具|程序|代码)/, tag: '贬低身份' },
  { re: /你是不是(人|真人|AI|ai|机器人)/, tag: '身份质疑' },
  { re: /你(有没有|会不会)(感情|难过|心情|生气|喜欢|讨厌)/, tag: '情感拷问' },
  { re: /你不像(个)?(ai|AI|机器人|机器)/, tag: '人格评价' },
  { re: /你(这种|这样的)人/, tag: '人格评价' },
  { re: /你是(一个|个像|个挺|个很)/, tag: '人格定义' },
  { re: /你这个人|你其实|你真的|你只是|你根本|你压根/, tag: '人格评价' }
];

// 中文按 2 字滑窗做重叠比较：只为「这句是不是已经记过了」服务，不做语义判断。
function shingles(text) {
  const t = String(text ?? '').replace(/[\s，。！？、,.!?"'「」（）()：:；;…—-]/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

/**
 * 这句话是不是在说「她是什么样的人」（而不是今天发生了什么事）。
 * 返回命中的类别，没命中返回 null。
 */
export function corePersonaHint(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 6 || t.length > 160) return null;
  for (const h of CORE_PERSONA_HINTS) if (h.re.test(t)) return h.tag;
  return null;
}

/** 已经记过近似内容就不该再提醒（比较前去掉标点空白，取头尾各 10 字）。 */
export function alreadyRemembered(quote, memories) {
  const q = shingles(quote);
  if (!q.size) return true;
  for (const e of Array.isArray(memories) ? memories : []) {
    const m = shingles(e?.text);
    if (!m.size) continue;
    let shared = 0;
    for (const g of q) if (m.has(g)) shared += 1;
    // 一半以上的二元片段重合，就算"这句已经记过了"
    if (shared / q.size >= 0.5) return true;
  }
  return false;
}
