const HOLD = ['thinking', 'friends'];
const HINT_GAP = 6 * 60 * 60_000;
const RECENT_SIGNAL_LIMIT = 16;

export function relationshipCue(message) {
  const text = String(message ?? '').trim().replace(/[ \t]/g, '').replace(/^(?:(?:那个|嗯|呃)[，,、…]+|[…，,]+)+/u, '').replace(/[。！？!?…~～]+$/u, '');
  // Requiring a complete first-person phrase keeps jokes, quotes and mentions
  // of someone else's feelings out of the relationship record.
  if (/^(?:(?:我(?:们)?)?(?:以后)?(?:还是|就)(?:做|当)朋友吧?|我只把你当朋友|我不想(?:和|跟)你交往|我不想和你在一起|我想分手|我们分手吧|以后别再提(?:表白|交往)了?)$/u.test(text)) return 'friends';
  if (/^(?:我想好了[，,]?(?:可以聊聊我们了|我们聊聊吧|可以谈谈这件事了))$/u.test(text)) return 'resume';
  if (/^(?:我(?:暂时)?还没想好|我想再想想|让我(?:再)?想想|我还没准备好(?:谈恋爱|交往)?|先别急着确定关系|我现在不想谈恋爱|这件事先别再问了?)$/u.test(text)) return 'thinking';
  if (/^(?:(?:(?:好|那)[，,、]?我们(?:正式)?(?:在一起|交往)(?:吧)?|我们(?:正式)?(?:在一起|交往)吧)|(?:你)?愿意(?:和|跟)我(?:在一起|交往)(?:吗|么)|我(?:答应|愿意)(?:和|跟)你(?:正式)?(?:在一起|交往))$/u.test(text)) return 'invite';
  if (/^我(?:真的|其实|确实|也)?[，,、…]*(?:有点|挺|很)?喜欢你(?:啊|呀|呢|了)?$/u.test(text)) return 'interest';
  if (/^(?:我愿意|我答应|愿意和你试试|好[，,、]?我们试试)$/u.test(text)) return 'accept';
  return '';
}

export function readRomanceSignal({ side, text, previous, hint = false, id = '', now = Date.now() }) {
  const cue = relationshipCue(text) || (hint ? 'hint' : '');
  if (!cue) return null;

  let directResponse = false;
  if (cue === 'accept' || cue === 'thinking') {
    const previousCue = previous && previous.isSelf !== (side === 'ai')
      ? relationshipCue(previous.plain || previous.text) : '';
    directResponse = previousCue === 'invite';
    if (cue === 'accept' && !directResponse) return null;
    if (cue === 'thinking' && !['interest', 'invite'].includes(previousCue)
        && !/确定关系|谈恋爱|交往|表白/u.test(text)) return null;
  }
  return { side, cue, id, directResponse, now };
}

export function restorePrivateRomance(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    aiInterest: value.aiInterest === true,
    peerInterest: value.peerInterest === true,
    aiHold: HOLD.includes(value.aiHold) ? value.aiHold : '',
    peerHold: HOLD.includes(value.peerHold) ? value.peerHold : '',
    invitationBy: ['ai', 'peer'].includes(value.invitationBy) ? value.invitationBy : '',
    confirmed: value.confirmed === true && value.aiInterest === true && value.peerInterest === true && !value.aiHold && !value.peerHold,
    hintAt: Number(value.hintAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
    seen: Array.isArray(value.seen) ? value.seen.filter((id) => typeof id === 'string').slice(-RECENT_SIGNAL_LIMIT) : []
  };
}

export function romanceStage(value) {
  if (value?.confirmed) return 'confirmed';
  if (value?.aiHold === 'friends' || value?.peerHold === 'friends') return 'friends';
  if (value?.aiHold || value?.peerHold) return 'thinking';
  if (value?.invitationBy) return 'invited';
  if (value?.aiInterest && value?.peerInterest) return 'mutual';
  if (value?.peerInterest) return 'received';
  if (value?.aiInterest) return 'expressed';
  if (value?.hintAt) return 'hinted';
  return 'warm';
}

export function canSendRomanticCue(value, cue, now = Date.now()) {
  const stage = romanceStage(value);
  if (cue === 'hint') {
    return ['warm', 'hinted', 'received'].includes(stage) && (!value?.hintAt || now - value.hintAt >= HINT_GAP);
  }
  if (!['interest', 'invite', 'accept'].includes(cue) || stage === 'confirmed') return true;
  if (value?.peerHold) return false;
  if (cue === 'interest' && value?.aiInterest && !value?.aiHold) return false;
  return cue !== 'invite' || value?.invitationBy !== 'ai' || !!value.aiHold;
}

export function applyRomanceCue(value, { side, cue, id, now = Date.now(), directResponse = false }) {
  if (!cue || !['ai', 'peer'].includes(side) || (id && value?.seen?.includes(id))) return value;
  if (cue === 'hint' && (side !== 'ai' || !canSendRomanticCue(value, cue, now))) return value;
  if (cue === 'resume' && !value?.[side + 'Hold']) return value;
  if (cue === 'accept' && (!directResponse || !value?.invitationBy || value.invitationBy === side)) return value;
  const state = restorePrivateRomance(value ?? {});
  const other = side === 'ai' ? 'peer' : 'ai';
  if (cue === 'hint') {
    state.hintAt = now;
  } else if (cue === 'resume') {
    state[side + 'Hold'] = '';
  } else if (HOLD.includes(cue)) {
    state[side + 'Hold'] = cue;
    state.invitationBy = '';
    state.confirmed = false;
    if (cue === 'friends') {
      state[side + 'Interest'] = false;
      state.hintAt = 0;
    }
  } else {
    state[side + 'Hold'] = '';
    state[side + 'Interest'] = true;
    if (cue === 'invite' || cue === 'accept') {
      if (state.invitationBy === other && !state[other + 'Hold']) {
        state.confirmed = true;
        state.invitationBy = '';
      } else if (!state[other + 'Hold'] && !state.confirmed) {
        state.invitationBy = side;
      }
    }
  }
  if (id) state.seen = [...state.seen, id].slice(-RECENT_SIGNAL_LIMIT);
  state.updatedAt = now;
  return state;
}

const STAGES = {
  warm: {
    label: '熟悉中',
    guidance: '你们聊得熟了。如果刚好想起他的某件小事，可以比平常多问半句。你可以一直把他当朋友，不急着问感情。'
  },
  hinted: {
    label: '有过暗示',
    guidance: '有过一点试探。接下来看他有没有自然接住。害羞可以发个表情，或者改回原来的话题。没接就放过去，别换个问法再追。'
  },
  received: {
    label: '听到心意',
    guidance: '对方认真说过喜欢。先看你自己怎么想：可以承认有点开心，可以说还没想好，也可以直接说更想做朋友。重复的表白不用重新答应。'
  },
  expressed: {
    label: '说过心意',
    guidance: '你已经把心意说出来了。给他留时间。后面依旧可以聊番、游戏或今天的事，别再问他考虑得怎么样。'
  },
  mutual: {
    label: '互相喜欢',
    guidance: '你们都表达过喜欢，各自可以慢一点。有合适的时刻才谈要不要交往；日常依旧照常聊天。'
  },
  invited: {
    label: '交往邀请待答复',
    guidance: '有一句明确的交往邀请还没得到答复。你可以直接答、说想想或说更适合做朋友。如果是你开口的，先让对方自己决定。'
  },
  thinking: {
    label: '先想想',
    guidance: '有人说过需要想一想。这段时间照常聊天，不暗示、不催、不借冷淡要答案。让提出暂停的一方先重新开这个话题。'
  },
  friends: {
    label: '朋友',
    guidance: '已经说过更适合做朋友。尊重这个边界，之后按朋友的方式相处，少演尴尬和疏远。'
  },
  confirmed: {
    label: '已确认交往',
    guidance: '双方明确聊过并同意交往。亲近可以落在具体的关心和分享上；继续给彼此留时间、朋友和自己的事。'
  }
};

export function describeRomanceStage(value) {
  return STAGES[romanceStage(value)];
}
