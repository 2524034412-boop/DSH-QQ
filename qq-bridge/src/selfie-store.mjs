// 自拍历史：她发过的、你拍过的贴纸都落盘记下来，下次同一种表情直接复用，不用重新拍。
// 索引在 state/selfies/index.json：{ items: [{ name, expression, sent, at, lastSentAt }] }，图片同目录。
import fs from 'node:fs';
import path from 'node:path';

const MAX_ITEMS = 120;          // 历史上限：超了丢最旧、且发得最少的
const REUSE_WINDOW_MS = 0;      // 0 = 只要有同表情的存档就直接复用；想「每次都现拍」就设成 -1

export function createSelfieStore(stateDir) {
  const dir = path.join(stateDir, 'selfies');
  const indexFile = path.join(dir, 'index.json');

  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return Array.isArray(j.items) ? j.items : [];
    } catch {
      return [];
    }
  }
  function write(items) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify({ items }, null, 2), 'utf8');
  }
  function exists(name) {
    return /^[\w.\-]+\.png$/.test(name) && fs.existsSync(path.join(dir, name));
  }

  /** 登记一张新贴纸（文件已经在 dir 里）。同名不重复登记。 */
  function add(file, expression) {
    const name = path.basename(String(file));
    if (!exists(name)) return null;
    const items = read();
    let it = items.find((x) => x.name === name);
    if (!it) {
      it = { name, expression: String(expression || '默认'), sent: 0, at: Date.now(), lastSentAt: 0 };
      items.unshift(it);
    }
    // 控制数量：保留最近的和发得多的
    if (items.length > MAX_ITEMS) {
      items.sort((a, b) => (b.sent - a.sent) || (b.at - a.at));
      for (const gone of items.splice(MAX_ITEMS)) {
        try { fs.unlinkSync(path.join(dir, gone.name)); } catch {}
      }
      items.sort((a, b) => b.at - a.at);
    }
    write(items);
    return it;
  }

  /** 发出去之后记一笔：下次同表情就能直接找到它 */
  function markSent(name) {
    const items = read();
    const it = items.find((x) => x.name === path.basename(String(name)));
    if (!it) return null;
    it.sent = (it.sent || 0) + 1;
    it.lastSentAt = Date.now();
    write(items);
    return it;
  }

  /**
   * 同表情有存档就直接取（优先发得多的、再优先新的）；挑最近发过的会导致连发同一张，
   * 所以刚发过的那一张（lastSentAt 在 avoidMs 内）先让一让，没有别的才重复。
   */
  function pick(expression, avoidMs = 5 * 60 * 1000) {
    if (REUSE_WINDOW_MS < 0) return null;
    const want = String(expression || '默认');
    const now = Date.now();
    const pool = read().filter((x) => x.expression === want && exists(x.name));
    if (!pool.length) return null;
    const fresh = pool.filter((x) => now - (x.lastSentAt || 0) >= avoidMs);
    const use = fresh.length ? fresh : pool;
    use.sort((a, b) => (b.sent - a.sent) || (b.at - a.at));
    return { ...use[0], file: path.join(dir, use[0].name) };
  }

  /** 页面里的上传：data URL / base64 的 PNG。大小限制在 2MB，只认真 PNG。 */
  function saveUpload(base64, expression) {
    const buf = Buffer.from(String(base64 || ''), 'base64');
    if (buf.length < 100 || buf.length > 2 * 1024 * 1024) throw new Error('图片大小不对');
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'selfie-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-w' + Math.random().toString(36).slice(2, 6) + '.png';
    fs.writeFileSync(path.join(dir, name), buf);
    return add(path.join(dir, name), expression);
  }

  function list() {
    const items = read().filter((x) => exists(x.name));
    return items;
  }
  function fileOf(name) {
    const n = path.basename(String(name));
    return exists(n) ? path.join(dir, n) : null;
  }

  return { add, markSent, pick, saveUpload, list, fileOf, dir };
}
