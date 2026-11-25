/**
 * ComfyUI 出图客户端（SDXL / Illustrious 系列）。
 *
 * 只做三件事：探活、提交一张图、把图拿回来。
 * 不碰提示词风格（那在桥接里拼），不碰文件落盘（桥接存进相册）。
 */
import { execFileSync } from 'node:child_process';

const DEFAULT_NEGATIVE = [
  'lowres', 'bad anatomy', 'bad hands', 'extra fingers', 'missing fingers',
  'text', 'watermark', 'signature', 'username', 'blurry', 'jpeg artifacts',
  'worst quality', 'low quality', 'normal quality', 'error'
].join(', ');

/** 统一风格前缀：Illustrious/SDXL 上比较稳的一组质量词 */
const STYLE_PREFIX = 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, anime illustration';

export function comfyDefaults(cfg) {
  const d = cfg?.socialV2?.draw ?? {};
  return {
    enabled: d.enabled !== false,
    baseUrl: String(d.baseUrl || 'http://127.0.0.1:8188'),
    checkpoint: String(d.checkpoint || 'Illustrious-XL-v0.1.safetensors'),
    width: Number(d.width) || 832,
    height: Number(d.height) || 1216,
    steps: Number(d.steps) || 22,
    cfgScale: Number(d.cfgScale) || 6.5,
    sampler: String(d.sampler || 'euler_ancestral'),
    scheduler: String(d.scheduler || 'normal'),
    timeoutMs: Number(d.timeoutMs) || 180000,
    maxPerHour: Number(d.maxPerHour) || 3,
    minFreeVramMb: Number(d.minFreeVramMb) || 2600,
    stylePrefix: String(d.stylePrefix || STYLE_PREFIX),
    negative: String(d.negative || DEFAULT_NEGATIVE)
  };
}

export async function comfyAlive(baseUrl, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/system_stats`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    const dev = Array.isArray(j?.devices) ? j.devices[0] : null;
    return {
      ok: true,
      version: j?.system?.comfyui_version ?? '',
      device: dev?.name ?? '',
      vramTotal: Number(dev?.vram_total) || 0,
      vramFree: Number(dev?.vram_free) || 0
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 生成一张图。返回 { ok:true, buffer, mime, seconds, promptId } 或 { ok:false, error }。
 */
export async function comfyGenerate({ cfg, prompt, negative, width, height, steps, seed }) {
  const d = comfyDefaults(cfg);
  const base = d.baseUrl;
  const w = Math.max(512, Math.min(1536, Number(width) || d.width));
  const h = Math.max(512, Math.min(1536, Number(height) || d.height));
  const useSeed = Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 1e12);

  const workflow = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: d.checkpoint } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: `${d.stylePrefix}, ${prompt}`, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: String(negative || d.negative), clip: ['4', 1] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed: useSeed, steps: Number(steps) || d.steps, cfg: d.cfgScale,
        sampler_name: d.sampler, scheduler: d.scheduler, denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
      }
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'her-draw', images: ['8', 0] } }
  };

  const t0 = Date.now();
  let promptId = '';
  try {
    const res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'qq-bridge' })
    });
    const j = await res.json().catch(() => null);
    if (!j?.prompt_id) {
      const detail = j?.error?.message || (j?.node_errors ? JSON.stringify(j.node_errors).slice(0, 200) : JSON.stringify(j).slice(0, 200));
      return { ok: false, error: `提交失败：${detail}` };
    }
    promptId = j.prompt_id;
  } catch (error) {
    return { ok: false, error: `连不上 ComfyUI：${String(error?.message ?? error)}` };
  }

  // 轮询结果
  const deadline = Date.now() + d.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let item = null;
    try {
      const h = await fetch(`${base}/history/${promptId}`).then((r) => r.json());
      item = h?.[promptId];
    } catch { continue; }
    if (!item) continue;
    if (item.status?.status_str === 'error') {
      return { ok: false, error: `生成出错：${JSON.stringify(item.status).slice(0, 200)}` };
    }
    const img = item.outputs?.['9']?.images?.[0];
    if (!img?.filename) continue;
    try {
      const url = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      if (!buf.length) return { ok: false, error: '拿到的图是空的' };
      return {
        ok: true,
        buffer: buf,
        mime: 'image/png',
        seconds: Math.round((Date.now() - t0) / 100) / 10,
        promptId,
        width: w,
        height: h,
        seed: useSeed,
        finalPrompt: `${d.stylePrefix}, ${prompt}`
      };
    } catch (error) {
      return { ok: false, error: `下载图片失败：${String(error?.message ?? error)}` };
    }
  }
  return { ok: false, error: `等太久了（超过 ${Math.round(d.timeoutMs / 1000)} 秒），这张不画了` };
}

/**
 * 图生图：拿一张参考图当底（她的形象），只改写场景，保住脸和衣服。
 * refName 必须是 ComfyUI input 目录里的文件名。
 */
export async function comfyGenerateFrom({ cfg, prompt, negative, refName, denoise, steps, seed }) {
  const d = comfyDefaults(cfg);
  const base = d.baseUrl;
  const useSeed = Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 1e12);
  const dn = Math.max(0.2, Math.min(0.9, Number(denoise) || 0.55));

  const workflow = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: d.checkpoint } },
    10: { class_type: 'LoadImage', inputs: { image: refName } },
    11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: `${d.stylePrefix}, ${prompt}`, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: String(negative || d.negative), clip: ['4', 1] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed: useSeed, steps: Number(steps) || d.steps, cfg: d.cfgScale,
        sampler_name: d.sampler, scheduler: d.scheduler, denoise: dn,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0]
      }
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'her-draw', images: ['8', 0] } }
  };

  return submitAndFetch({ base, workflow, timeoutMs: d.timeoutMs, meta: { denoise: dn, refName, seed: useSeed, prompt } });
}

/** 提交 + 轮询 + 下载（两个入口共用） */
async function submitAndFetch({ base, workflow, timeoutMs, meta }) {
  const t0 = Date.now();
  let promptId = '';
  try {
    const res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'qq-bridge' })
    });
    const j = await res.json().catch(() => null);
    if (!j?.prompt_id) {
      const detail = j?.error?.message || (j?.node_errors ? JSON.stringify(j.node_errors).slice(0, 200) : JSON.stringify(j).slice(0, 200));
      return { ok: false, error: `提交失败：${detail}` };
    }
    promptId = j.prompt_id;
  } catch (error) {
    return { ok: false, error: `连不上 ComfyUI：${String(error?.message ?? error)}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let item = null;
    try { const h = await fetch(`${base}/history/${promptId}`).then((r) => r.json()); item = h?.[promptId]; } catch { continue; }
    if (!item) continue;
    if (item.status?.status_str === 'error') return { ok: false, error: `生成出错：${JSON.stringify(item.status).slice(0, 200)}` };
    const img = item.outputs?.['9']?.images?.[0];
    if (!img?.filename) continue;
    try {
      const url = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type || 'output'}`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      if (!buf.length) return { ok: false, error: '拿到的图是空的' };
      return { ok: true, buffer: buf, mime: 'image/png', seconds: Math.round((Date.now() - t0) / 100) / 10, promptId, ...meta };
    } catch (error) {
      return { ok: false, error: `下载图片失败：${String(error?.message ?? error)}` };
    }
  }
  return { ok: false, error: `等太久了（超过 ${Math.round(timeoutMs / 1000)} 秒），这张不画了` };
}
/** 空闲显存（MB）：优先 nvidia-smi，失败返回 null */
export function gpuFreeMb() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
      windowsHide: true, timeout: 4000, encoding: 'utf8'
    });
    const n = Number(String(out).trim().split(/\r?\n/)[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}