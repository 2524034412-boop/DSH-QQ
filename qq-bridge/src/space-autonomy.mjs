// 她自己的作息：没人跟她说话时，也会换房间。
//
// 为什么放在桥接进程里而不是页面里：页面关掉她就不动了，那不叫生活。
// 这里只做**低频**判断（默认 3 分钟一次），不调模型、不烧 token，纯本地规则。
//
// 三条设计原则：
//   1. 待够久才动 —— 刚坐下就站起来像抽搐
//   2. 有概率才动 —— 每次都动会变成秒表
//   3. 夜里回卧室 —— 作息先立住，别的慢慢加

import fs from 'node:fs';
import path from 'node:path';

const TICK_MS = 3 * 60 * 1000;      // 3 分钟看一次
const MIN_STAY_MS = 40 * 60 * 1000; // 同一处至少待 40 分钟
const MOVE_CHANCE = 0.35;           // 到点也只有 35% 会动，避免机械

// 去处的权重：她最常待在书房和泳池（鲸鱼），客厅次之
const PLACES = [
  {
    place: '书房', weight: 3,
    details: [
      '书桌上摊着一本没看完的书',
      '椅子往后挪了半米，像是刚坐下又站起来',
      '台灯开着，窗外的海把光映在墙上'
    ]
  },
  {
    place: '泳池', weight: 3,
    details: [
      '水面还在晃，像刚有人下去过',
      '池边石台上留着水痕'
    ]
  },
  {
    place: '客厅', weight: 2,
    details: [
      '茶几上放着半杯凉了的水',
      '沙发靠垫被压出一个窝',
      '电视没开，落地窗那边亮着'
    ]
  },
  {
    place: '厨房', weight: 1.5,
    details: ['水槽里泡着一只杯子', '台面上有切了一半的水果']
  },
  {
    place: '厕所', weight: 1,
    details: ['浴缸的水还没放干净', '镜子上有雾气']
  },
  {
    place: '花园', weight: 1.5,
    details: ['草地上有刚踩过的痕迹', '花丛边有水珠']
  },
  {
    place: '卧室', weight: 1,
    details: ['床铺得整整齐齐', '窗帘半拉着']
  }
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

function weightedPick(items, rnd) {
  const total = items.reduce((n, i) => n + i.weight, 0);
  let r = rnd() * total;
  for (const i of items) { r -= i.weight; if (r <= 0) return i; }
  return items[items.length - 1];
}

// 常在什么时间做什么：夜里睡觉，早上往厨房/浴室去
function timeOfDayRule(hour) {
  if (hour >= 23 || hour < 6) return { place: '卧室', detail: '灯关了，被子掀了一半' };
  if (hour >= 6 && hour < 9) return { place: pick(['厨房', '厕所'], Math.random), detail: '早上该起来了' };
  return null;
}

// ── 情感 → 去哪儿 ────────────────────────────────────────────────────
// 她不是随机游走的 NPC：心情差就躲，压力大就泡水，对主人好感高就更愿意待在客厅。
// 这里返回的是**权重倍数**，0.3 = 明显不愿意去，3 = 特别想去。
const LOW_MOOD = ['难过', '委屈', '生气', '吃醋', '害羞'];
const HIGH_MOOD = ['开心', '好奇', '骄傲', '得意'];

function moodMultiplier(place, ctx) {
  let m = 1;
  const mood = String(ctx.mood || '');
  const stress = Number(ctx.stress) || 0;
  const score = Number(ctx.affinity?.score ?? 50);
  const love = Number(ctx.affinity?.love) || 0;

  // 压力大：泡水是最直接的解法（她是鲸鱼）
  if (stress > 55) {
    if (place === '泳池' || place === '厕所') m *= 2.6;
    if (place === '客厅') m *= 0.45;
    if (place === '花园') m *= 0.7;
  }

  // 情绪低落：躲进卧室，减少在公共空间
  if (LOW_MOOD.includes(mood)) {
    if (place === '卧室') m *= 3.2;
    if (place === '客厅') m *= 0.3;
    if (place === '花园') m *= 0.6;
  }
  // 情绪好：愿意待在能看见东西的地方
  if (HIGH_MOOD.includes(mood)) {
    if (place === '客厅' || place === '花园') m *= 1.9;
    if (place === '泳池') m *= 1.4;
  }
  if (mood === '好奇' && place === '书房') m *= 2.2;
  if (mood === '生气' && place === '客厅') m *= 0.2;

  // 对主人：好感高就更愿意待在「会被看见」的地方
  if (score >= 80) {
    if (place === '客厅') m *= 1.6;
    if (place === '花园') m *= 1.3;
  } else if (score < 20) {
    if (place === '卧室') m *= 2.2;
    if (place === '客厅') m *= 0.6;
  }
  // 爱意淡了：不主动往热闹处凑
  if (love === 0 && place === '客厅') m *= 0.75;

  return Math.max(0.1, m);
}

function pickWeightedByMood(items, ctx, rnd) {
  const weighted = items.map((i) => ({ ...i, weight: i.weight * moodMultiplier(i.place, ctx) }));
  const total = weighted.reduce((n, i) => n + i.weight, 0);
  if (total <= 0) return items[Math.floor(rnd() * items.length)];
  let r = rnd() * total;
  for (const i of weighted) { r -= i.weight; if (r <= 0) return i; }
  return weighted[weighted.length - 1];
}

/**
 * 启动自主走动。
 * @param {{root: string, stateDir: string, log: (msg: string) => void, enabled?: () => boolean}} opts
 */
export function startSpaceAutonomy(opts) {
  const { root, stateDir, log, enabled, getContext } = opts;
  const spaceFile = path.join(stateDir, 'space.json');
  const roomsFile = path.join(root, 'public', 'space', 'rooms.json');

  let timer = null;

  function tick() {
    try {
      if (typeof enabled === 'function' && !enabled()) return;
      const rooms = readJson(roomsFile, null);
      if (!rooms || !Array.isArray(rooms.rooms)) return;

      const state = readJson(spaceFile, null);
      if (!state || !state.place) return;   // 还没初始化过，交给页面/命令去建

      const now = Date.now();
      const since = Number(state.since) || Number(state.updatedAt) || now;
      const stayMs = now - since;
      const hour = new Date().getHours();
      const ctx = typeof getContext === 'function' ? (getContext() || {}) : {};

      // 夜里先回卧室（不看停留时长，到点就该睡）
      const rule = timeOfDayRule(hour);
      if (rule && state.place !== rule.place) {
        const next = { ...state, place: rule.place, detail: rule.detail, since: now, updatedAt: now };
        writeJsonAtomic(spaceFile, next);
        log(`[space] 作息：${state.place} → ${rule.place}（${hour}点）`);
        return;
      }

      if (stayMs < MIN_STAY_MS) return;
      if (Math.random() > MOVE_CHANCE) return;

      // 换个地方
      const candidates = PLACES.filter((p) => p.place !== state.place);
      const known = new Set(rooms.rooms.map((r) => r.label));
      const usable = candidates.filter((p) => known.has(p.place));
      if (!usable.length) return;

      const dest = pickWeightedByMood(usable, ctx, Math.random);
      const next = {
        ...state,
        place: dest.place,
        detail: pick(dest.details, Math.random),
        since: now,
        updatedAt: now
      };
      writeJsonAtomic(spaceFile, next);
      // 把「为什么去那儿」也记下来，不然以后没法判断是规则错了还是运气
      const why = [];
      if (Number(ctx.stress) > 55) why.push(`压力 ${ctx.stress}`);
      if (ctx.mood) why.push(`心情 ${ctx.mood}`);
      if (ctx.affinity?.score != null) why.push(`好感 ${ctx.affinity.score}`);
      log(`[space] 她自己走开了：${state.place} → ${dest.place}（待了 ${Math.round(stayMs / 60000)} 分钟${why.length ? '；' + why.join('，') : ''}）`);
    } catch (error) {
      log(`[space] 自主走动出错（不影响主流程）：${error?.message ?? error}`);
    }
  }

  // 启动后先等一会儿，别和页面刚建好的状态打架
  timer = setTimeout(() => {
    tick();
    timer = setInterval(tick, TICK_MS);
    if (timer.unref) timer.unref();
  }, 60 * 1000);
  if (timer.unref) timer.unref();

  // 返回 tick 是为了让调试端点能立刻触发一次（不然要等 40 分钟才看得到效果）
  return {
    tick,
    stop() { if (timer) { clearTimeout(timer); clearInterval(timer); } }
  };
}