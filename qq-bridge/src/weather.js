// 室外天气：拉 wttr.in 的 JSON，压成"她能用来说话"的样子。
//
// 为什么是 wttr.in：免费、不用 API key、国内网络能通（Open-Meteo 在这台机器上超时）。
// 数据每 15 分钟刷新一次，落盘 state/weather.json，失败就退回上一次的快照。

import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

const WEATHER_CN = [
  [/sunny|clear/i, '晴'],
  [/partly cloudy/i, '多云'],
  [/cloudy|overcast/i, '阴'],
  [/mist|fog/i, '有雾'],
  [/light drizzle|drizzle/i, '毛毛雨'],
  [/light rain|patchy rain/i, '小雨'],
  [/moderate rain|heavy rain/i, '雨'],
  [/thunder/i, '雷阵雨'],
  [/light snow|snow/i, '下雪'],
  [/sleet|ice/i, '雨夹雪']
];

function windCn(dir) {
  const map = { N: '北', NNE: '东北偏北', NE: '东北', ENE: '东北偏东', E: '东', ESE: '东南偏东', SE: '东南', SSE: '东南偏南', S: '南', SSW: '西南偏南', SW: '西南', WSW: '西南偏西', W: '西', WNW: '西北偏西', NW: '西北', NNW: '西北偏北' };
  return map[String(dir || '').toUpperCase()] || String(dir || '');
}

function descCn(text) {
  const raw = String(text ?? '').trim();
  for (const [re, cn] of WEATHER_CN) if (re.test(raw)) return cn;
  return raw || '未知';
}

export class WeatherService {
  constructor({ file, place = 'Nanjing', log = () => {} } = {}) {
    this.file = file;
    this.place = place;
    this.log = log;
    this.cache = null;
    this.fetching = null;
    this.lastError = '';
    this.loadDisk();
  }

  loadDisk() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && saved.now && Number(saved.updatedAt)) this.cache = saved;
    } catch {}
  }

  saveDisk(data) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }

  /** 缓存是否还新鲜 */
  fresh(now = Date.now()) {
    return !!this.cache && now - Number(this.cache.updatedAt) < CACHE_TTL_MS;
  }

  /** 拿一份天气：新鲜就用缓存，否则去拉；拉失败退回旧快照。 */
  async get({ force = false } = {}) {
    if (!force && this.fresh()) return this.cache;
    if (this.fetching) return this.fetching;
    this.fetching = this.fetchNow()
      .then((data) => {
        this.cache = data;
        this.saveDisk(data);
        this.lastError = '';
        return data;
      })
      .catch((error) => {
        this.lastError = String(error?.message ?? error);
        this.log(`天气拉取失败：${this.lastError}`);
        return this.cache; // 退回旧快照（可能为 null）
      })
      .finally(() => {
        this.fetching = null;
      });
    return this.fetching;
  }

  async fetchNow() {
    const url = `https://wttr.in/${encodeURIComponent(this.place)}?format=j1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let json;
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-qq-bridge/weather' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const cur = json?.current_condition?.[0] ?? {};
    const day0 = json?.weather?.[0] ?? {};
    const day1 = json?.weather?.[1] ?? {};
    const hourly = Array.isArray(day0.hourly) ? day0.hourly : [];
    const rainChance = hourly.reduce((max, h) => Math.max(max, Number(h.chanceofrain) || 0), 0);
    const rainSum = hourly.reduce((sum, h) => sum + (Number(h.precipMM) || 0), 0);
    const area = json?.nearest_area?.[0]?.areaName?.[0]?.value || this.place;

    return {
      updatedAt: Date.now(),
      place: area,
      now: {
        tempC: Number(cur.temp_C),
        feelsC: Number(cur.FeelsLikeC),
        humidity: Number(cur.humidity),
        desc: descCn(cur.weatherDesc?.[0]?.value),
        windKmph: Number(cur.windspeedKmph),
        windDir: String(cur.winddir16Point || ''),
        precipMM: Number(cur.precipMM) || 0
      },
      today: {
        maxC: Number(day0.maxtempC),
        minC: Number(day0.mintempC),
        desc: descCn(day0.hourly?.[4]?.weatherDesc?.[0]?.value || cur.weatherDesc?.[0]?.value),
        rainChance,
        rainSum: Math.round(rainSum * 10) / 10
      },
      tomorrow: day1.date
        ? { maxC: Number(day1.maxtempC), minC: Number(day1.mintempC), rainChance: Math.max(...(day1.hourly || []).map((h) => Number(h.chanceofrain) || 0)) }
        : null
    };
  }
}

/** 穿衣建议：按体感温度 + 风 + 雨，给一句人话。 */
export function dressAdvice(w) {
  if (!w || !w.now) return '';
  const feels = Number(w.now.feelsC);
  const wind = Number(w.now.windKmph) || 0;
  const rain = Number(w.today?.rainChance) || 0;
  const parts = [];
  if (feels <= 0) parts.push('羽绒服、厚裤子，别露脚脖子');
  else if (feels <= 8) parts.push('厚外套 + 毛衣，里面穿暖');
  else if (feels <= 14) parts.push('外套 + 长袖，早晚凉');
  else if (feels <= 20) parts.push('薄外套或针织，单穿一件会凉');
  else if (feels <= 26) parts.push('长袖或短袖都行');
  else if (feels <= 31) parts.push('短袖，别穿厚的');
  else parts.push('尽量穿薄的、透气的');
  if (wind >= 30) parts.push('风大，外套选防风的');
  if (rain >= 50) parts.push('大概率下雨，带伞');
  else if (rain >= 30) parts.push('可能有雨，包里塞把折叠伞');
  return parts.join('；');
}

/** 室内外对比 + 穿衣建议，压成两三句给她用。 */
export function outdoorLine(w, indoor) {
  if (!w || !w.now) return '';
  const n = w.now;
  const bits = [`外面 ${Math.round(n.tempC)}°C（体感 ${Math.round(n.feelsC)}°C）、${n.desc}`];
  if (n.windKmph >= 15) bits.push(`${windCn(n.windDir)}风 ${Math.round(n.windKmph)}km/h`);
  if (w.today) bits.push(`今天 ${Math.round(w.today.minC)}~${Math.round(w.today.maxC)}°C`);
  let diff = '';
  const indoorT = Number(indoor?.tempC);
  if (Number.isFinite(indoorT)) {
    const d = indoorT - Number(n.tempC);
    if (Math.abs(d) >= 2) diff = `外面比屋里${d > 0 ? '低' : '高'} ${Math.abs(Math.round(d))} 度`;
    else diff = '跟屋里差不多';
  }
  const advice = dressAdvice(w);
  return `【外面】${bits.join('，')}。${diff ? `${diff}。` : ''}${advice ? `出门：${advice}。` : ''}\n`;
}