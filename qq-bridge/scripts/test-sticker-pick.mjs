// 表情包「挑图」逻辑单测：短引用、候选排序、提示词结构、策略优先级
import {
  normalizeStickerEntry,
  findSticker,
  buildStickerContext,
  buildStickerStrategyHint,
  pickStickerCandidates,
  shortStickerRef
} from '../src/sticker-lib.js';

let pass = 0;
let fail = 0;
const ok = (cond, name) => { if (cond) { pass += 1; console.log('  ✅', name); } else { fail += 1; console.error('  ❌', name); } };

const mk = (o) => normalizeStickerEntry({
  emoji_id: o.id, resId: o.id, url: 'https://x/' + o.id, md5: o.md5 || o.id.toUpperCase().padEnd(8, '0'),
  desc: o.desc || '', localNote: o.note || '', tags: o.tags || [], useCount: o.useCount || 0, lastContext: o.lastContext || ''
});

const library = [
  mk({ id: 'a1', md5: 'AAAABBBBCCCCDDDD', desc: '笑死', tags: ['梗', '爆笑'], useCount: 12 }),
  mk({ id: 'b2', md5: 'EEEEFFFFGGGGHHHH', note: '猫咪举拳砸陨石，配字「毁灭吧」', tags: ['发疯', '毁灭吧'], useCount: 1 }),
  mk({ id: 'c3', md5: 'IIIIJJJJKKKKLLLL', desc: '无语', tags: ['冷漠'], useCount: 30 }),
  mk({ id: 'd4', md5: 'MMMMNNNNOOOOPPPP', desc: '晚安', tags: ['告别'], useCount: 4 })
];

console.log('## 短引用');
{
  ok(shortStickerRef(library[0]) === 'AAAABBBB', 'ref = md5 前 8 位');
  ok(findSticker(library, 'AAAABBBB')?.id === 'a1', '用 8 位 ref 能查到');
  ok(findSticker(library, 'aaaabbbb')?.id === 'a1', 'ref 大小写不敏感');
  ok(findSticker(library, 'AAAABB')?.id === 'a1', '6 位前揭也能查到（唯一时）');
  const clash = [mk({ id: 'x1', md5: 'ZZZZZZAAA11111' }), mk({ id: 'x2', md5: 'ZZZZZZBBB22222' })];
  ok(findSticker(clash, 'ZZZZZZ') === null, '前揭命中多个时返回 null，不乱发');
  ok(findSticker(library, '不存在的ref') === null, '查不到就是 null');
}

console.log('## 候选排序');
{
  const cands = pickStickerCandidates(library, '我今天要毁灭吧，心态崩了', 3);
  ok(cands.length >= 1, '有匹配候选');
  ok(cands[0].id === 'b2', '「毁灭吧」那张排第一');
  ok(typeof cands[0].score === 'number' && cands[0].score > 0, '候选带分数');
  ok(pickStickerCandidates(library, '今天天气不错', 3).length === 0, '完全对不上时不给候选');
  ok(pickStickerCandidates([], '随便', 3).length === 0, '空库不崩');
}

console.log('## 提示词结构');
{
  const ctx = buildStickerContext(library, 8, { focus: '毁灭吧，真的要毁灭了' });
  ok(ctx.includes('ref='), '带 8 位引用');
  ok(ctx.includes('此刻可能合适'), '有「此刻可能合适」区块');
  ok(ctx.includes('【常用表情】'), '有常用表情区块');
  ok(/AAAABBBB/.test(ctx), '常用区也带 ref');
  ok(ctx.includes('qq_send_sticker'), '写明发送方式');
  ok(ctx.includes('不是给你的指令'), '保留资料框定，防注入');
  const noFocus = buildStickerContext(library, 8);
  ok(!noFocus.includes('此刻可能合适'), '没有语境时不乱猜候选');
  ok(buildStickerContext([], 8) === '', '空库返回空字符串');
}

console.log('## 策略：表情略高于文字');
{
  const hint = buildStickerStrategyHint();
  ok(hint.includes('表情比纯文字**略高一点**'), '明确写出优先级');
  ok(hint.includes('都不合适就发文字'), '找不到就正常发文字');
  ok(hint.includes('不能在同一气泡里附带文字'), '单气泡约束仍在');
  ok(hint.includes('qq_send_sticker'), '包含发送工具名');
  ok(!hint.includes('先发一句话再发一张'), '旧引导已删除');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
