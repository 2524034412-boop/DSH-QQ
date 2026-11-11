// 她的表情包 · 给主人用的备注页。
//
// 为什么单开一页：AI 自己看图写备注会看错（糊的、纯文字的、只有表情的），
// 主人一眼就知道那张图是什么梗。这页只做一件事：把收藏表情列出来，
// 每张底下能改「她读到的含义」——改完她下一次醒来就能用。
//
// 数据走已有的 /api/stickers（GET）和 /api/stickers/note（POST），
// 不新增写接口；页面本身不含任何服务端插值，token 从 URL 读。

const STYLES = `
:root{--bg:#0b1017;--card:#141d28;--card2:#1a2532;--line:#243244;--fg:#dbe7f5;--dim:#7f93ab;--accent:#6ea8fe;--ok:#4ecb8f;--warn:#e0a45c}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:radial-gradient(1200px 700px at 50% -10%,#16263a 0%,var(--bg) 60%);color:var(--fg);
  font:14px/1.55 "Microsoft YaHei","PingFang SC",system-ui,sans-serif;padding:26px 30px 60px}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:22px;margin:0;letter-spacing:.5px}
.sub{color:var(--dim);font-size:12.5px}
.tools{display:flex;gap:10px;align-items:center;margin:14px 0 18px;flex-wrap:wrap}
input,textarea{background:#0d151f;border:1px solid var(--line);color:var(--fg);border-radius:8px;
  padding:7px 9px;font:inherit;outline:none;width:100%}
input:focus,textarea:focus{border-color:#3a5680;box-shadow:0 0 0 2px rgba(110,168,254,.12)}
textarea{resize:vertical;min-height:56px;line-height:1.5}
button{background:#1d2b3c;border:1px solid var(--line);color:var(--fg);border-radius:8px;
  padding:7px 12px;font:inherit;cursor:pointer;transition:.15s}
button:hover{background:#243447;border-color:#3a5680}
button.primary{background:#20406b;border-color:#2f5d99}
button.primary:hover{background:#27507f}
button:disabled{opacity:.5;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);
  border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:9px}
.thumb{height:132px;background:#0a0f16;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.thumb img{max-width:100%;max-height:100%;object-fit:contain}
.thumb .non{color:#4d5f75;font-size:12px;text-align:center;padding:10px}
.meta{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dim)}
.meta b{color:#9db4cf;font-weight:600}
.row{display:flex;gap:8px}
.status{font-size:11.5px;color:var(--ok);min-height:16px}
.status.err{color:#e2725b}
.hint{background:#111a24;border:1px solid var(--line);border-left:3px solid var(--warn);
  border-radius:8px;padding:10px 12px;color:#b9c7d8;font-size:12.5px;margin-bottom:16px}
.hint b{color:#e8c08a}
.empty{color:var(--dim);text-align:center;padding:60px 0}
`;

const SCRIPT = String.raw`
const token = new URLSearchParams(location.search).get('token') || '';
const H = { 'x-console-token': token, 'content-type': 'application/json' };
const grid = document.getElementById('grid');
const stat = document.getElementById('stat');
let all = [];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function api(path, opts) {
  const res = await fetch(path, { ...(opts || {}), headers: H });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + res.status));
  return j;
}

function render(list) {
  grid.textContent = '';
  if (!list.length) { grid.append(el('div', 'empty', '收藏里还没有表情。先在 QQ 里收藏几张，再点上面「同步」。')); return; }
  for (const s of list) {
    const card = el('div', 'card');

    const thumb = el('div', 'thumb');
    if (s.url) {
      const img = el('img');
      img.src = s.url;
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.onerror = () => { img.remove(); thumb.append(el('div', 'non', '图片加载不出来（QQ 图床拦了 referer）——在 QQ 收藏里看原图')); };
      thumb.append(img);
    } else {
      thumb.append(el('div', 'non', '没有图片地址'));
    }
    card.append(thumb);

    const meta = el('div', 'meta');
    const left = el('span');
    left.append(el('b', '', s.desc ? '官方备注：' : '官方备注：'));
    left.append(document.createTextNode(s.desc || '（无）'));
    const right = el('span', '', '用过 ' + (s.useCount || 0) + ' 次');
    meta.append(left, right);
    card.append(meta);

    const note = el('textarea');
    note.placeholder = '她读到的含义：画面 + 什么时候用（例：猫举拳砸陨石，配字「毁灭吧」；自暴自弃/发疯时用）';
    note.value = s.localNote || '';
    note.maxLength = 200;
    card.append(note);

    const tags = el('input');
    tags.placeholder = '标签，逗号分隔（发疯,猫,无语）';
    tags.value = (s.tags || []).join(',');
    card.append(tags);

    const row = el('div', 'row');
    const save = el('button', 'primary', '保存');
    const st = el('div', 'status');
    row.append(save, st);
    card.append(row);

    save.onclick = async () => {
      save.disabled = true; st.className = 'status'; st.textContent = '保存中…';
      try {
        const list = tags.value.split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 20);
        const j = await api('/api/stickers/note', {
          method: 'POST',
          body: JSON.stringify({ stickerId: s.id, note: note.value.trim(), tags: list })
        });
        s.localNote = j.sticker?.localNote || note.value.trim();
        s.tags = j.sticker?.tags || list;
        st.textContent = '已保存，她下次醒来就按这个认';
        refreshStat();
      } catch (e) {
        st.className = 'status err';
        st.textContent = '失败：' + e.message;
      } finally {
        save.disabled = false;
      }
    };

    grid.append(card);
  }
}

function refreshStat() {
  const noted = all.filter(s => (s.localNote || '').trim()).length;
  stat.textContent = '收藏 ' + all.length + ' 个 · 有备注 ' + noted + ' 个 · 还差 ' + (all.length - noted) + ' 个';
}

async function load(syncFirst) {
  grid.textContent = '';
  grid.append(el('div', 'empty', syncFirst ? '正在从 QQ 同步收藏…' : '读取中…'));
  try {
    if (syncFirst) await api('/api/stickers/sync', { method: 'POST', body: '{}' });
    const j = await api('/api/stickers?count=500');
    all = (j.stickers || []).map(s => ({ ...s }));
    refreshStat();
    render(all);
  } catch (e) {
    grid.textContent = '';
    grid.append(el('div', 'empty', '读取失败：' + e.message));
  }
}

document.getElementById('q').oninput = (ev) => {
  const q = ev.target.value.trim().toLowerCase();
  if (!q) return render(all);
  render(all.filter(s => [s.desc, s.localNote, (s.tags || []).join(','), s.id].join(' ').toLowerCase().includes(q)));
};
document.getElementById('sync').onclick = () => load(true);
document.getElementById('reload').onclick = () => load(false);
load(false);
`;

export function renderStickerPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>她的表情包</title><style>${STYLES}</style></head>
<body>
<header>
  <h1>她的表情包</h1>
  <span class="sub" id="stat">读取中…</span>
</header>
<div class="hint">
  这里写的是<b>她对这个表情的理解</b>（画面 + 什么时候用），不是 QQ 的官方备注。没备注的表情她看不懂、就不敢发；
  你替她写一句，她下次醒来就能用。<code>官方备注</code>只读，改不了也不影响。
</div>
<div class="tools">
  <input id="q" placeholder="搜：备注 / 标签 / ref" style="flex:1;min-width:200px">
  <button id="sync">从 QQ 同步收藏</button>
  <button id="reload">刷新</button>
</div>
<div class="grid" id="grid"></div>
<script>${SCRIPT}</script>
</body></html>`;
}