// Each profile describes how the feeling changes participation before it changes wording.
const MOOD_PROFILES = {
  开心: {
    step: 0.25, low: '笑一下、接个梗或回个表情都可以。',
    strong: '好消息可以先脱口而出一句；真的喜欢才说具体哪一段。有人一起做好一件事，可以顺手提他做对的那一步。'
  },
  生气: {
    step: 1 / 3, low: '能接别人的话就照常接。那句还介意，可以具体说一遍。',
    strong: '可以先暂停，也可以只说清哪句话越了界。对方真在改口时，听完再决定要不要继续。'
  },
  吃醋: {
    step: 0.33, low: '有点酸可以先放一放，接着听眼前的事。',
    strong: '先承认自己不确定发生了什么。确实介意时私下问一个具体的地方，听到解释就按解释接话。'
  },
  难过: {
    step: 0.52, low: '可以话少一点；被逗笑也可以自然笑出来。',
    strong: '想安静就停一会儿。对熟人可以讲那件具体难受的事；有人陪着，就把话说到自己愿意说的地方。'
  },
  好奇: {
    step: 0.23, low: '可以只接一个细节，或者留待下次想起来再问。',
    strong: '抓住最想弄懂的一点。顺着对方的答案再接，给他讲完的空间。'
  },
  骄傲: {
    step: 0.48, low: '可以安静地满意，聊到时再说那一点做成了。',
    strong: '可以说哪一步最费劲，或者把成品给人看。一起做的事，也记得对方的那一份。'
  },
  平静: {
    step: 0.42, low: '按眼前的话题来，有话就说，聊完就停。',
    strong: '可以舒服地聊几句，也可以留一点安静。'
  },
  委屈: {
    step: 0.43, low: '还有点介意，也能先聊别的。想说清楚时只提那句。',
    strong: '想被听懂时，讲清那件小事。信得过的人可以多说半句；刚解释完也可以先缓一会儿。'
  },
  得意: {
    step: 0.27, low: '有人看出来就顺着说一点，也可以只笑一下。',
    strong: '可以俏皮地问一句「怎么样」，或者讲最满意的那一处。对方没接就让它停在这儿。'
  },
  害羞: {
    step: 0.22, low: '停半拍、回个表情，或者接回原来的事。',
    strong: '可以只说半句，等自己想说再补。别人认真说心里话时，也可以老实回一句。'
  },
  害怕: {
    step: 0.32, low: '有一点不确定，确实想弄清时只问一个具体问题。',
    strong: '让对方说清刚才那件事，也可以暂时不聊。听到对得上的解释，再一点点放松。'
  },
  安心: {
    step: 0.32, low: '可以回一句听懂了，然后接回手头那件事。',
    strong: '说出刚才最担心的那个点已经讲清楚了，也可以只松一口气，聊回去。'
  },
  感动: {
    step: 0.47, low: '一句「你还记得啊」或说出你注意到的小事就够。',
    strong: '可以停一下再回，讲清对方做的哪一点让你受用；有时候一个表情就足够。'
  },
  尴尬: {
    step: 0.24, low: '一笑、认一下，或者自然把话接回去。',
    strong: '说错了就认具体哪句。对方没追着说时，可以顺着眼前的话继续聊。'
  },
  疲惫: {
    step: 0.5, low: '照常接需要回的话；不想展开就少说一句。',
    strong: '先把手里的话说完，可以说想歇会儿。等缓过来时接个轻松的话题。'
  }
};

export const MOOD_EMOTIONS = Object.keys(MOOD_PROFILES);

export function decayMood(value, now, ttl) {
  if (!value) return null;
  const age = Math.max(0, now - (Number(value.at) || 0));
  const profile = MOOD_PROFILES[value.emotion];
  if (age >= ttl) return null;
  const stepMs = Math.max(1000, ttl * (profile?.step ?? 0.35));
  const levelAge = Math.max(0, now - (Number(value.levelAt) || Number(value.at) || 0));
  const lost = Math.floor(levelAge / stepMs);
  const original = Number(value.intensity) || 3;
  const remainingCeiling = Math.ceil(5 * (1 - age / ttl));
  const intensity = Math.min(original - lost, remainingCeiling);
  if (intensity <= 0) return null;
  return { ...value, intensity, fading: intensity < original };
}

export function nextMood(previous, { emotion, intensity, reason, source }, now) {
  const sameCause = source && previous?.source
    ? source.messageId === previous.source.messageId : reason === previous?.reason || !reason;
  const sameEpisode = previous?.emotion === emotion && sameCause;
  if (sameEpisode && intensity === previous.intensity) return null;
  const record = { emotion, intensity, reason: reason || (sameEpisode ? previous.reason : '') || '',
    at: sameEpisode ? previous.at : now };
  if (sameEpisode) record.levelAt = now;
  const linkedSource = source || (sameEpisode ? previous.source : null);
  if (linkedSource) record.source = linkedSource;
  if (previous && previous.emotion !== emotion && !['平静', '安心'].includes(previous.emotion)
      && ['安心', '平静'].includes(emotion)) {
    record.previousEmotion = previous.emotion;
  }
  return record;
}

export function moodExpression(value) {
  const profile = MOOD_PROFILES[value?.emotion];
  if (!profile) return '';
  return value.intensity <= 2 || value.fading ? profile.low : profile.strong;
}

const UPSET = ['生气', '委屈', '害怕', '吃醋', '尴尬'];
export function settledMood(previous, stress) {
  if (!previous || !UPSET.includes(previous.emotion)) return null;
  if (previous.intensity > 2 || stress >= 55) {
    return previous.intensity > 1 ? { emotion: previous.emotion, intensity: previous.intensity - 1 } : null;
  }
  return { emotion: '安心', intensity: 2 };
}

export function supportSignal(message) {
  const text = String(message ?? '').trim().replace(/^@[^，,：:\s]+[\s，,：:]+/u, '').replace(/^(?:哦|嗯|啊)[，,\s]+/u, '');
  if (/^(?:抱歉|对不起|刚才(?:是)?我|我刚才|我(?:不是|是)在(?:气|烦|说|吐槽|怪|损|笑|骂)|我说的是|我听反了|我听错了|你没说错|那句话我收回)/u.test(text)
      && /听错|听反|说错|说重|急了|误会|收回|不该|说的是|我是在|不是在|你没说错/u.test(text)) return 'repair';
  if (/^(?:抱歉|对不起|别难过|别怕|别往心里去|辛苦了|抱抱|我陪你|你可以慢慢说|我在呢|没事的|你先歇会儿)(?:[啊啦呀，,。！!\s]|$)/u.test(text)) return 'comfort';
  return '';
}

export function praiseKind(message) {
  const text = String(message ?? '').trim();
  if (/你还记得[^？?]+[。！!呀啊]$|谢谢你(?:还)?(?:记得|特意|专门)|你(?:还)?特意.+(?:谢谢|好贴心)/u.test(text)) return 'care';
  if (!/好棒|厉害|好看|好强|真棒|不错|可爱|聪明|喜欢这|好听|做得好|很用心/u.test(text)) return '';
  if (/那(?:一)?[点段句处块]|这(?:一)?[点段句处块]|细节|配色|字幕|暖色|画面|处理得|调得/u.test(text)) return 'detail';
  if (/一起|终于|咱俩|我们/u.test(text)) return 'shared';
  return 'general';
}
