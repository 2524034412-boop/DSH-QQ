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
 * 「缝那边」：传感器量的是**他那边的空气**（老大电脑旁边），不是她那边的。
 *
 * 世界设定（roles/world.md）：她住在一个四季如春的异世界，她用魔法开了一道很细的缝，
 * 从缝里能看见他那边的天。所以这行字永远是他的天气，不能变成她的。
 */
export function environmentLine(reading, { now = Date.now(), staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  if (!reading || !Number.isFinite(Number(reading.at))) return '';
  const ageMs = readingAgeMs(reading, now);
  if (!isFresh(reading, { now, staleMinutes })) {
    // 缝起了雾就不说话：宁可不提，也别让她拿两小时前的数当现在。
    return '';
  }
  const temp = Number(reading.tempC);
  const hum = Number(reading.humidity);
  if (!Number.isFinite(temp) || !Number.isFinite(hum)) return '';
  const bits = [`${temp.toFixed(1)}°C`, `湿度 ${Math.round(hum)}%`];
  if (Number.isFinite(Number(reading.pressure))) bits.push(`气压 ${Math.round(Number(reading.pressure))}`);
  return `【缝那边】你正从缝里看见他那边的空气：${bits.join('、')}（${ageLabel(ageMs)}）。\n`
    + '这是他身边的天，不是你这边的——你这边永远是舒服的，没什么可说的。要说就说他那边的：「你那边今天挺潮的」「你那边是不是有点凉」。\n'
    + '别把数字原样念出来（「湿度多少多少」那种），别解释魔法怎么运作；他问你怎么知道的，就说「从缝里看到的」。没聊到天气就别提，不用每句都带。\n\n';
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