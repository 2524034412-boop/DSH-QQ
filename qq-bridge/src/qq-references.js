export function conversationReferences(recent, message, segments) {
  const refs = {};
  const parts = Array.isArray(segments) ? segments : [];
  const quote = parts.find(part => part?.type === 'reply')?.data?.id;
  const mentions = parts.filter(part => part?.type === 'at' && part.data?.qq != null)
    .map(part => String(part.data.qq));
  if (mentions.length) refs.mentionedUsers = [...new Set(mentions)];
  const pictures = item => item?.media?.some(m => m.kind === 'image' || m.kind === 'sticker');
  if (quote != null) {
    refs.quotedMessageId = String(quote);
    const target = recent.findLast(item => item.messageId === String(quote));
    if (target?.userId) refs.quotedUserId = target.userId;
    if (pictures(target)) refs.imageSourceMessageId = String(quote);
    return refs;
  }
  if (pictures(message) || !message.userId || !/(这张|那张图|刚才的图|刚发的图|[左右][上下]角|图里|图中|上一张)/u.test(message.plain)) return refs;
  const candidates = recent.filter(item => !item.isSelf && item.userId === message.userId &&
    item.messageId && item.time <= message.time && message.time - item.time <= 120000 && pictures(item));
  if (candidates.length === 1) refs.imageSourceMessageId = candidates[0].messageId;
  return refs;
}
