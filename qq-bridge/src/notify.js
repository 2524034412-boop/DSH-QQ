// 手机推送：把桥接这边的事推到 iPhone。
//
// 支持两个免费通道（都不需要服务器、不需要开发者证书）：
//   · Bark   —— 国产、App Store 有、最稳；装好后 App 里给一串 key
//   · ntfy   —— 开源、连 topic 名就能收，不用注册
//
// 设计原则：推送是"锦上添花"，永远不能让主流程因为它卡住或报错。
// 所以：超时 8 秒、失败只记日志、不重试、不阻塞。

const TIMEOUT_MS = 8000;

function trim(s, max) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

export class Notifier {
  constructor({ config = {}, log = () => {} } = {}) {
    this.cfg = config || {};
    this.log = log;
    this.last = null;
  }

  get enabled() {
    if (this.cfg.enabled === false) return false;
    const provider = String(this.cfg.provider || 'bark');
    if (provider === 'bark') return !!String(this.cfg.barkKey || '').trim();
    if (provider === 'ntfy') return !!String(this.cfg.ntfyTopic || '').trim();
    return false;
  }

  /** 发一条通知。永不抛异常，返回 {ok, provider, status, error}。 */
  async send({ title = '小鲸鱼', body = '', group = '', sound = '', url = '', level = 'active' } = {}) {
    if (!this.enabled) {
      return { ok: false, provider: 'none', error: '没配置推送（config.json 的 notify 段）' };
    }
    const provider = String(this.cfg.provider || 'bark');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      if (provider === 'bark') {
        const key = String(this.cfg.barkKey || '').trim();
        const base = String(this.cfg.barkServer || 'https://api.day.app').replace(/\/+$/, '');
        const payload = {
          title: trim(title, 60),
          body: trim(body, 400),
          group: trim(group || this.cfg.group || '小鲸鱼', 30),
          level: level === 'timeSensitive' ? 'timeSensitive' : 'active'
        };
        if (sound) payload.sound = sound;
        if (url) payload.url = url;
        const res = await fetch(`${base}/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        const text = await res.text();
        const ok = res.ok && !/"code"\s*:\s*(4\d\d|5\d\d)/.test(text);
        this.last = { at: Date.now(), ok, provider, status: res.status };
        if (!ok) this.log(`推送失败(Bark ${res.status})：${text.slice(0, 120)}`);
        return { ok, provider, status: res.status, error: ok ? null : text.slice(0, 200) };
      }

      if (provider === 'ntfy') {
        const topic = String(this.cfg.ntfyTopic || '').trim();
        const base = String(this.cfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
        const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
          method: 'POST',
          headers: {
            Title: encodeURIComponent(trim(title, 60)),
            Priority: level === 'timeSensitive' ? 'high' : 'default',
            Tags: 'whale'
          },
          body: trim(body, 400),
          signal: controller.signal
        });
        const ok = res.ok;
        this.last = { at: Date.now(), ok, provider, status: res.status };
        if (!ok) this.log(`推送失败(ntfy ${res.status})`);
        return { ok, provider, status: res.status, error: ok ? null : `HTTP ${res.status}` };
      }

      return { ok: false, provider, error: `不认识的 provider：${provider}` };
    } catch (error) {
      const msg = String(error?.message ?? error);
      this.last = { at: Date.now(), ok: false, provider, status: 0, error: msg };
      this.log(`推送异常(${provider})：${msg}`);
      return { ok: false, provider, status: 0, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}