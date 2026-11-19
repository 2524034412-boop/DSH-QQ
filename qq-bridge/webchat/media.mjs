// 网页群的多媒体支持：
//  1. 假装成 OneBot 的 /send_group_msg，接住桥接发来的图片/语音（表情包、语音）
//  2. /api/upload：网页这边上传图片/表情
//  3. /media/<file>：把存下来的媒体发出去
// 只做"能看、能听、能发"，不做转码。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.silk': 'application/octet-stream', '.amr': 'audio/amr',
};

// 把拿到的音频转成浏览器能放的 mp3。转不了就原样留着（前端会退化成"下载"）。
function toMp3(inPath, outPath) {
  try {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inPath, '-codec:a', 'libmp3lame', '-q:a', '4', outPath], { windowsHide: true, timeout: 60000 });
    return r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 500;
  } catch { return false; }
}

function extOf(mime, fallback = '.bin') {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('gif')) return '.gif';
  if (m.includes('webp')) return '.webp';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  if (m.includes('ogg')) return '.ogg';
  return fallback;
}

export function makeMediaHandler({ DATA, token, pushMessage, broadcast, HER_NAME }) {
  const MEDIA = path.join(DATA, 'media');
  fs.mkdirSync(MEDIA, { recursive: true });

  function saveBuffer(buf, ext) {
    const id = crypto.randomBytes(10).toString('hex');
    const name = id + ext;
    fs.writeFileSync(path.join(MEDIA, name), buf);
    return { name, url: '/media/' + name };
  }

  function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  async function readAll(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // 从 OneBot 的 segment 里救出内容
  function segmentToMessage(seg) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    if (type === 'text') return { kind: 'text', text: String(data.text ?? '') };
    if (type === 'image') {
      const file = String(data.file ?? '');
      if (file.startsWith('base64://')) {
        const buf = Buffer.from(file.slice(9), 'base64');
        const saved = saveBuffer(buf, extOf(file, '.png'));
        return { kind: 'image', src: saved.url };
      }
      if (/^https?:\/\//.test(file) || /^data:/.test(file)) return { kind: 'image', src: file };
      if (/^file:\/\//.test(file)) {
        try {
          const p = decodeURIComponent(file.replace(/^file:\/\//, ''));
          const buf = fs.readFileSync(p);
          const saved = saveBuffer(buf, path.extname(p) || '.png');
          return { kind: 'image', src: saved.url };
        } catch { return { kind: 'text', text: '[表情]' }; }
      }
      return { kind: 'text', text: '[图片]' };
    }
    if (type === 'record') {
      const file = String(data.file ?? '');
      if (file.startsWith('base64://')) {
        const raw = Buffer.from(file.slice(9), 'base64');
        const tag = crypto.randomBytes(6).toString('hex');
        const tmp = path.join(MEDIA, 'tmp-' + tag + '.bin');
        fs.writeFileSync(tmp, raw);
        const out = tmp + '.mp3';
        if (toMp3(tmp, out)) {
          const name = crypto.randomBytes(10).toString('hex') + '.mp3';
          fs.copyFileSync(out, path.join(MEDIA, name));
          try { fs.unlinkSync(tmp); fs.unlinkSync(out); } catch {}
          return { kind: 'audio', src: '/media/' + name };
        }
        try { fs.unlinkSync(tmp); } catch {}
        const saved = saveBuffer(raw, '.silk');
        return { kind: 'audio', src: saved.url, silk: true };
      }
      if (/^https?:\/\//.test(file)) return { kind: 'audio', src: file };
      return { kind: 'text', text: '[语音]' };
    }
    if (type === 'reply' || type === 'at') return null;
    return null;
  }

  return async function handle(req, res, url) {
    // ── 假 OneBot ──────────────────────────────────────────────
    if (url.pathname.startsWith('/onebot/')) {
      const parts = url.pathname.split('/').filter(Boolean); // ['onebot', token, action]
      if (parts.length < 3) { json(res, 404, { status: 'failed', retcode: 404 }); return true; }
      if (parts[1] !== token) { json(res, 401, { status: 'failed', retcode: 401 }); return true; }
      const action = parts[2];
      let body = {};
      try { body = JSON.parse((await readAll(req, 64 * 1024 * 1024)).toString('utf8') || '{}'); } catch { body = {}; }

      if (action === 'send_group_msg' || action === 'send_private_msg') {
        const segs = Array.isArray(body.message) ? body.message : [{ type: 'text', data: { text: String(body.message ?? '') } }];
        const out = [];
        for (const s of segs) {
          const m = segmentToMessage(s);
          if (m) out.push(m);
        }
        let lastId = null;
        for (const m of out) {
          if (m.kind === 'text') {
            const text = m.text.trim();
            if (!text) continue;
            lastId = pushMessage({ role: 'her', nick: HER_NAME, text }).id;
          } else if (m.kind === 'image') {
            lastId = pushMessage({ role: 'her', nick: HER_NAME, kind: 'image', src: m.src, text: '' }).id;
          } else if (m.kind === 'audio') {
            lastId = pushMessage({ role: 'her', nick: HER_NAME, kind: 'audio', src: m.src, silk: !!m.silk, text: '' }).id;
          }
        }
        broadcast({ type: 'typing', on: false });
        json(res, 200, { status: 'ok', retcode: 0, data: { message_id: lastId ?? 0 } });
        return true;
      }

      if (action === 'send_poke') {
        pushMessage({ role: 'sys', kind: 'poke', text: HER_NAME + ' 拍了拍 ' + (body.user_id ?? '你') });
        json(res, 200, { status: 'ok', retcode: 0, data: {} });
        return true;
      }

      // 其余动作：接住，回一个成功，别让桥接报错
      json(res, 200, { status: 'ok', retcode: 0, data: {} });
      return true;
    }

    // ── 上传 ──────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      try {
        const buf = await readAll(req, 8 * 1024 * 1024);
        const mime = String(req.headers['content-type'] ?? '');
        const ext = extOf(mime, path.extname(String(req.headers['x-filename'] ?? '')) || '.bin');
        const saved = saveBuffer(buf, ext);
        json(res, 200, { ok: true, url: saved.url, kind: mime.startsWith('image/') ? 'image' : (mime.startsWith('audio/') ? 'audio' : 'file') });
      } catch (e) {
        json(res, 400, { ok: false, error: String(e.message) });
      }
      return true;
    }

    // ── 取媒体 ────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const name = path.basename(url.pathname.slice('/media/'.length));
      const p = path.join(MEDIA, name);
      if (!fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return true; }
      const ext = path.extname(name).toLowerCase();
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'public, max-age=86400' });
      fs.createReadStream(p).pipe(res);
      return true;
    }

    return false;
  };
}
