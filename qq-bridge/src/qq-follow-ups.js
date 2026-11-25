const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SOURCE_MAX_AGE = 2 * HOUR;
const MAX_REVIEW_MESSAGES = 30;
export const FOLLOW_UP_OFFER_MS = 5 * MINUTE;
export const FOLLOW_UP_QUIET_MS = 5 * MINUTE;

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

export function pendingFollowUps(items, now = Date.now()) {
  return (items ?? []).filter((item) => item.state === 'pending' && item.expiresAt > now);
}

export function restoreFollowUps(items, now = Date.now()) {
  return (Array.isArray(items) ? items : []).filter((item) => item && typeof item === 'object'
    && typeof item.id === 'string' && typeof item.text === 'string'
    && Number.isSafeInteger(item.sourceSeq) && item.sourceSeq > 0
    && Number.isFinite(item.dueAt) && item.expiresAt > now
    && ['pending', 'offered', 'dismissed', 'dispatching', 'sent'].includes(item.state));
}

export function addFollowUp(items, { key, source, text, due, id, topic, now = Date.now() }) {
  if (!/^private:[1-9]\d*$/.test(key)) fail('定时跟进只用于原来的私聊');
  if (!source || source.isSelf || !Number.isSafeInteger(source.seq) || source.seq <= 0
      || !Number.isFinite(source.time) || now - source.time > SOURCE_MAX_AGE
      || String(source.userId) !== key.slice('private:'.length) || source.kind === 'poke') {
    fail('请选择当前私聊里对方两小时内发来的一条原消息');
  }
  if (!text || text.length > 200) fail('定时跟进内容须为 1–200 字符');
  const dateTime = String(due ?? '');
  const dueAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime)
    ? Date.parse(dateTime) : NaN;
  if (!Number.isFinite(dueAt) || dueAt < now + MINUTE || dueAt > now + 7 * DAY) {
    fail('followUpAt 须为 1 分钟至 7 天内的时间，使用带时区的 ISO 8601 格式');
  }
  const retained = restoreFollowUps(items, now);
  const existing = retained.find((item) => item.sourceMessageId === String(source.messageId));
  if (existing) return { items, item: existing };
  if (pendingFollowUps(retained, now).length >= 3) fail('该私聊已有 3 条待跟进事项', 409);
  const item = {
    id, text, sourceMessageId: String(source.messageId), sourceSeq: source.seq,
    dueAt, expiresAt: dueAt + DAY, state: 'pending', ...(topic ? { topic } : {})
  };
  return { items: [...retained, item], item };
}

// Supply the complete bounded window after the source so an old result cannot
// quietly fall out of the prompt. Numbered inbound messages are contiguous.
export function followUpHistory(item, recent, latestSeq) {
  const count = latestSeq - item.sourceSeq;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_REVIEW_MESSAGES) return null;
  const incoming = (recent ?? []).filter((msg) => !msg.isSelf && msg.seq > item.sourceSeq);
  if (incoming.length !== count || incoming.some((msg, i) => msg.seq !== item.sourceSeq + i + 1)) return null;
  const sourceIndex = recent.findIndex((msg) => !msg.isSelf && msg.seq === item.sourceSeq);
  // Include the agent's intervening messages so it can tell whether it already asked.
  if (sourceIndex < 0 || recent.length - sourceIndex > 2 * MAX_REVIEW_MESSAGES + 1) return null;
  return recent.slice(sourceIndex);
}

export function followUpCanSend(item, offer, latestSeq, now = Date.now()) {
  return item?.state === 'offered' && offer?.id === item.id && offer.until > now
    && item.expiresAt > now && offer.seq === latestSeq;
}
