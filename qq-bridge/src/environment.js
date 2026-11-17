// 外接传感器（温度/湿度）的读数与「给模型看的一句话」。
//
// 设计要点：传感器给她的是**体感素材**，不是仪表盘。她是个人，说话得是
// 「今天有点潮」而不是「湿度 58.2%」；所以这里的输入是干净数字，输出是一句
// 带体感提示的话，并且只在数据新鲜时说话 —— 过期读数比没有读数更糟。

export const DEFAULT_STALE_MINUTES = 10;
const TEMP_RANGE = [-40, 85];
const HUMIDITY_RANGE = [0, 100];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 设备上报的原始 JSON → 规整后的读数；不合格就明确拒绝（别把 NaN 写进状态）。 */
export function normalizeReading(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body 必须是 JSON 对象' };
  const tempC = num(raw.tempC ?? raw.temp ?? raw.temperature);
  if (tempC === null) return { ok: false, error: '缺少 tempC（数字，摄氏度）' };
  if (tempC < TEMP_RANGE[0] || tempC > TEMP_RANGE[1]) return { ok: false, error: `tempC 超出合理范围 ${TEMP_RANGE[0]}~${TEMP_RANGE[1]}` };
  const humidity = num(raw.humidity ?? raw.hum ?? raw.rh);
  if (humidity === null) return { ok: false, error: '缺少 humidity（数字，百分比）' };
  if (humidity < HUMIDITY_RANGE[0] || humidity > HUMIDITY_RANGE[1]) return { ok: false, error: `humidity 超出 0~100` };
  const reading = {
    at: now,
    tempC: Math.round(tempC * 10) / 10,
    humidity: Math.round(humidity * 10) / 10
  };
  const pressure = num(raw.pressure);
  if (pressure !== null && pressure > 300 && pressure < 1100) reading.pressure = Math.round(pressure * 10) / 10;
  const battery = num(raw.battery);
  if (battery !== null && battery >= 0 && battery <= 100) reading.battery = Math.round(battery);
  const rssi = num(raw.rssi);
  if (rssi !== null && rssi < 0 && rssi > -120) reading.rssi = Math.round(rssi);
  const place = String(raw.place ?? '').trim();
  if (place) reading.place = place.slice(0, 20);
  const fw = String(raw.fw ?? '').trim();
  if (fw) reading.fw = fw.slice(0, 20);
  if (!reading.place && raw.room) reading.place = String(raw.room).trim().slice(0, 20);
  // 人体感应（HC-SR501）：motion 是"此刻有没有人动"，motionAgo 是"多少秒前动过"。
  // 30 秒才上报一次，所以真正有用的是 motionAgo —— 时刻值几乎必然读到 0。
  const motionAgo = num(raw.motionAgo);
  if (motionAgo !== null && motionAgo >= -1 && motionAgo <= 86400) reading.motionAgo = Math.round(motionAgo);
  const motion = raw.motion;
  if (motion === true || motion === 1 || motion === '1') reading.motion = true;
  else if (motion === false || motion === 0 || motion === '0') reading.motion = false;
  return { ok: true, reading };
}

export function readingAgeMs(reading, now = Date.now()) {
  const at = Number(reading?.at) || 0;
  if (!at) return Infinity;
  return Math.max(0, now - at);
}

export function isFresh(reading, { now = Date.now(), staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  return readingAgeMs(reading, now) <= Math.max(1, Number(staleMinutes) || DEFAULT_STALE_MINUTES) * 60000;
}

function ageLabel(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/**
 * 「他那边的空气」：传感器量的是**他那边的空气**（老大电脑旁边），不是她那边的。
 *
 * 世界设定（roles/world.md）：她自己也说不清，就是能"感觉到"外面那股空气；不解释原理。
 * 所以这行字永远是他的天气，不能变成她的。
 */
/** 把读数翻成"人话体感"：她嘴上说这些，不报数字。 */
export function feelOf(temp, hum) {
  const t = Number(temp);
  const h = Number(hum);
  let tempWord = '';
  if (Number.isFinite(t)) {
    if (t < 10) tempWord = '冷，冻手那种';
    else if (t < 16) tempWord = '凉，得穿件外套';
    else if (t < 19) tempWord = '有点凉';
    else if (t <= 25) tempWord = '正好，不冷不热';
    else if (t <= 28) tempWord = '有点热';
    else if (t <= 32) tempWord = '热';
    else tempWord = '闷热，坐着都出汗';
  }
  let humWord = '';
  if (Number.isFinite(h)) {
    if (h < 30) humWord = '干得厉害（嗓子发紧、摸什么都静电）';
    else if (h < 42) humWord = '偏干';
    else if (h <= 60) humWord = '刚好，不干也不潮';
    else if (h <= 70) humWord = '有点潮';
    else if (h <= 80) humWord = '潮，衣服发黏那种';
    else humWord = '闷得慌，喘气都黏';
  }
  // 该说句什么"管人的话"
  let care = '';
  if (Number.isFinite(t) && t < 19) care = '惦记一下他穿没穿够';
  else if (Number.isFinite(t) && t > 28) care = '让他少穿点、喝口水、开个风扇';
  else if (Number.isFinite(h) && h < 35) care = '提醒他喝水，别把嗓子干坏';
  else if (Number.isFinite(h) && h > 70) care = '让他别穿厚的，屋里闷';
  else care = '夸一句「你那儿挺舒服的吧」';
  return { tempWord, humWord, care };
}

/**
 * 人体感应的"事件化"：把"每 30 秒一条全是有人"变成"安静一阵后突然有人动"。
 *
 * 人坐在桌前刷视频，手一直在动，原始 motionAgo 永远是 1。真正有意义的信号是
 * 「上一次上报还安静（≥5 分钟没动）、这次又动了」——那就是他回来了 / 有人经过。
 * 结果写进 next.presenceEventAt，提示词只认这个时间戳。
 *
 * 直接原地改 next，返回它（方便链式调用）。
 */
export function notePresenceEvent(prev, next, now = Date.now()) {
  if (!next || typeof next !== 'object') return next;
  const ago = Number(next.motionAgo);
  const prevAgo = Number(prev?.motionAgo);
  const QUITE_GAP_SECONDS = 300;
  if (Number.isFinite(ago) && ago >= 0) {
    const wasQuiet = !Number.isFinite(prevAgo) || prevAgo >= QUITE_GAP_SECONDS;
    if (wasQuiet && ago <= 60) next.presenceEventAt = now;
    else if (Number.isFinite(Number(prev?.presenceEventAt))) next.presenceEventAt = Number(prev.presenceEventAt);
  } else if (Number.isFinite(Number(prev?.presenceEventAt))) {
    next.presenceEventAt = Number(prev.presenceEventAt);
  }
  return next;
}

export function environmentLine(reading, { now = Date.now(), staleMinutes = DEFAULT_STALE_MINUTES, presence = true } = {}) {
  if (!reading || !Number.isFinite(Number(reading.at))) return '';
  const ageMs = readingAgeMs(reading, now);
  if (!isFresh(reading, { now, staleMinutes })) {
    // 数据太旧就不说话：宁可不提，也别让她拿两小时前的数当现在。
    return '';
  }
  const temp = Number(reading.tempC);
  const hum = Number(reading.humidity);
  if (!Number.isFinite(temp) || !Number.isFinite(hum)) return '';
  const bits = [`${temp.toFixed(1)}°C`, `湿度 ${Math.round(hum)}%`];
  if (Number.isFinite(Number(reading.pressure))) bits.push(`气压 ${Math.round(Number(reading.pressure))}`);
  // 人体感应只认"安静一阵之后突然有人动"这个事件（presenceEventAt 由桥接在 /report 里算），
  // 不认原始的 motionAgo —— 人坐在桌前手一直在动，原始值永远是"有人"。
  // 15 分钟内发生过这件事才提一句，而且不点名、不追查。
  const eventAt = Number(reading.presenceEventAt);
  const presenceBit = presence && Number.isFinite(eventAt) && eventAt > 0 && (now - eventAt) <= 15 * 60000
    ? '刚才那边有点动静，像是有人走过来、或者他回来了。\n'
    : '';
  const feel = feelOf(temp, hum);
  return `【你那点说不清的本事】你刚才又"感觉到"了外面那股空气：${bits.join('、')}（${ageLabel(ageMs)}）。\n`
    + presenceBit
    + `翻成人话：温度${feel.tempWord || '说不准'}；湿度${feel.humWord || '说不准'}。这是他那边的，不是你这栋房子里的。\n`
    + '注意：上面那些数字是给你自己看的，**说出口的时候不要报数**。\n'
    + `怎么开口：像人一样描述体感，再顺手管他一句——${feel.care}。\n`
    + '例子：「你那边是不是有点潮」「今天挺舒服的吧」「有点凉了，你加件外套」——一句话就够，别铺开说，也别一天念八遍，聊到才提。\n'
    + '他问你怎么知道的：就一句「我就是感觉得到」，别解释原理、别提设备或传感器、别说「检测到」这种词。\n\n';
}

/** 24 小时趋势：给她自己查的时候用（也可以直接进控制台）。 */
export function summarizeHistory(entries, { now = Date.now(), hours = 24 } = {}) {
  const since = now - Math.max(1, Number(hours) || 24) * 3600000;
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e && Number(e.at) >= since
    && Number.isFinite(Number(e.tempC)) && Number.isFinite(Number(e.humidity)));
  if (!rows.length) return null;
  const temps = rows.map((e) => Number(e.tempC));
  const hums = rows.map((e) => Number(e.humidity));
  const round = (n) => Math.round(n * 10) / 10;
  return {
    samples: rows.length,
    hours: Math.max(1, Number(hours) || 24),
    temp: { min: round(Math.min(...temps)), max: round(Math.max(...temps)), avg: round(temps.reduce((a, b) => a + b, 0) / temps.length) },
    humidity: { min: round(Math.min(...hums)), max: round(Math.max(...hums)), avg: round(hums.reduce((a, b) => a + b, 0) / hums.length) },
    firstAt: rows[0].at,
    lastAt: rows[rows.length - 1].at
  };
}


