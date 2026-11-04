// 独立的「记忆星图」页面（/memory）：全窗口 canvas，单开一个窗口看记忆。
// 视觉方向：黄昏海面星空 —— 深蓝紫底色、低饱和暖金/雾蓝/青绿星色、极光、海面反光。
// 结构：预模拟布局只算一次；星云/海面/暗角/网格预渲染到离屏 canvas；之后每帧只做
//       相机（按时间的临界阻尼）、视差星尘、连线流点、节点光晕/瞄准环等轻量绘制。
// 遗忘曲线：每颗星带真实的稳定度 s，亮度/大小/光晕随保持率 R(t)=exp(-t/s) 实时变化，
//       「时间流」拨杆可以快进未来，看哪些记忆会先暗下去。公式在 memory-retention.js（纯函数、有单测），
//       浏览器脚本复刻同一公式。除此之外不 import 任何桥接内部模块，方便单独改样式。
import { socialGraphHtml, socialGraphStyle, socialGraphScript } from './social-graph-view.js';
import { annotate as annotateRetention, summarize as summarizeRetention } from './memory-retention.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeTier(t) {
  const v = String(t || '').toLowerCase();
  return v === 'core' || v === 'long' || v === 'short' ? v : 'long';
}

function buildGraph(entries, cap) {
  const list = (entries || []).slice(-(cap || 420));
  // 遗忘参数与节点一一对应：s=稳定度(天) dg=联想度 u=最近强化 c=创建 x=到期（0=不过期）
  const meta = annotateRetention(list);
  const nodes = list.map((e, i) => ({
    i,
    t: String(e.text || '').slice(0, 160),
    k: normalizeTier(e.tier),
    g: Array.isArray(e.tags) ? e.tags.slice(0, 4) : [],
    d: Number(e.updatedAt || e.createdAt) || 0,
    s: meta[i].s,
    dg: meta[i].dg,
    u: meta[i].u,
    c: meta[i].c,
    x: meta[i].x
  }));
  const links = [];
  const byTag = new Map();
  for (const n of nodes) {
    for (const tag of n.g) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(n.i);
    }
  }
  for (const arr of byTag.values()) {
    if (arr.length > 10) continue;
    for (let a = 0; a < arr.length; a += 1) {
      for (let b = a + 1; b < arr.length; b += 1) links.push([arr[a], arr[b], 0]);
    }
  }
  return { nodes, links };
}

export function renderMemoryPage(entries) {
  const graph = buildGraph(entries, 420);
  const data = JSON.stringify(graph).replace(/</g, '\\u003c');
  const total = graph.nodes.length;
  const core = graph.nodes.filter((n) => n.k === 'core').length;
  const long = graph.nodes.filter((n) => n.k === 'long').length;
  const short = graph.nodes.filter((n) => n.k === 'short').length;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>记忆星图</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{
    --motion:cubic-bezier(.22,1,.36,1);
    --bg0:#060a14; --bg1:#0d1424;
    --gold:#f0c8a4; --fog:#9fb8da; --jade:#8fd0c4; --snow:#eaf1ff;
    --core:var(--gold); --long:var(--fog); --short:var(--jade);
    --ink:#eaf1ff; --dim:#8294ae; --line:rgba(159,184,218,.16);
    --glass:rgba(7,13,25,.62); --glass-strong:rgba(9,16,30,.82);
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;background:var(--bg0)}
  body{color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased}
  #sky{position:fixed;inset:0;display:block;width:100vw;height:100vh;z-index:1;
    touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;outline:none}
  #sky.drag{cursor:grabbing}

  .hud{position:fixed;z-index:5;pointer-events:none}
  .tl{left:clamp(22px,4.5vw,76px);top:clamp(24px,4.6vh,58px);max-width:min(560px,78vw);
    padding:22px 28px 20px 24px;border-left:1px solid rgba(159,184,218,.24);
    border-top:1px solid rgba(159,184,218,.12)}
  .tl .c{position:absolute;width:16px;height:16px;opacity:.75}
  .tl .c1{right:-1px;top:-1px;border-top:1px solid var(--fog);border-right:1px solid var(--fog)}
  .tl .c2{left:-1px;bottom:-1px;border-left:1px solid var(--fog);border-bottom:1px solid var(--fog)}
  .tl .grid{position:absolute;right:16px;top:16px;width:74px;height:44px;display:grid;
    grid-template-columns:repeat(6,1fr);grid-template-rows:repeat(3,1fr);opacity:.3}
  .tl .grid i{border-right:1px solid rgba(159,184,218,.24);border-bottom:1px solid rgba(159,184,218,.24)}
  .tl .eyebrow{display:flex;align-items:center;gap:10px;font-size:9.5px;font-weight:600;
    letter-spacing:.3em;color:rgba(159,184,218,.75);text-transform:uppercase}
  .tl .eyebrow::before{content:"";width:24px;height:1px;background:var(--gold);opacity:.75}
  .tl h1{margin:14px 0 0;font-size:clamp(30px,4.1vw,56px);line-height:1.08;font-weight:500;
    letter-spacing:-.045em;color:var(--snow);text-shadow:0 0 38px rgba(159,184,218,.22)}
  .tl p{margin:16px 0 0;font-size:11.5px;line-height:1.9;letter-spacing:.05em;color:var(--dim)}
  .tl b{font-weight:600;color:var(--snow)}
  .tl .sep{color:rgba(159,184,218,.3);margin:0 7px}

  .tr{left:clamp(16px,4.5vw,76px);right:clamp(16px,4.5vw,76px);bottom:clamp(16px,3vh,30px);top:auto;
    display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .toolgroup{display:flex;align-items:center;gap:4px;padding:5px;border:1px solid var(--line);
    border-radius:15px;background:var(--glass);backdrop-filter:blur(22px) saturate(130%);
    -webkit-backdrop-filter:blur(22px) saturate(130%);box-shadow:0 20px 60px -28px #000;
    pointer-events:auto}
  .chip{min-height:36px;padding:8px 14px;border:1px solid transparent;border-radius:11px;
    background:transparent;color:#a8b8ce;font:inherit;font-size:11.5px;letter-spacing:.02em;
    white-space:nowrap;cursor:pointer;
    transition:color .3s var(--motion),background .3s var(--motion),border-color .3s var(--motion),transform .3s var(--motion),box-shadow .3s var(--motion)}
  .chip:hover{color:var(--snow);background:rgba(159,184,218,.09);border-color:rgba(159,184,218,.22);
    transform:translateY(-1px)}
  .chip.on{color:var(--snow);background:rgba(159,184,218,.14);border-color:rgba(159,184,218,.28);
    box-shadow:inset 0 0 18px rgba(159,184,218,.08)}
  .chip:disabled{opacity:.4;cursor:default;transform:none}
  .chip.exit{color:#c6b5a5}

  /* ── 时间流 · 遗忘曲线：拨杆快进未来，星光按各自的稳定度依次暗下去 ── */
  .tw{right:clamp(16px,4.5vw,76px);top:clamp(24px,4.6vh,58px);width:min(284px,calc(100vw - 32px));
    padding:15px 16px 14px;border:1px solid var(--line);border-radius:18px;background:var(--glass);
    backdrop-filter:blur(22px) saturate(130%);-webkit-backdrop-filter:blur(22px) saturate(130%);
    box-shadow:0 24px 70px -30px #000,inset 0 1px 0 rgba(234,241,255,.05);pointer-events:auto;
    transition:opacity .5s var(--motion),transform .6s var(--motion)}
  .tw.hide{opacity:0;transform:translateY(-10px);pointer-events:none}
  .tw .cap{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
  .tw .cap b{font-size:9px;font-weight:600;letter-spacing:.26em;color:rgba(159,184,218,.78);text-transform:uppercase}
  .tw .cap em{font-style:normal;font-size:10.5px;letter-spacing:.04em;color:var(--gold);font-variant-numeric:tabular-nums}
  .tw canvas{display:block;width:100%;height:76px;margin:10px 0 2px}
  .tw .big{display:flex;align-items:baseline;gap:6px;margin-top:2px}
  .tw .big strong{font-size:30px;font-weight:500;letter-spacing:-.05em;color:var(--snow);font-variant-numeric:tabular-nums}
  .tw .big span{font-size:10px;letter-spacing:.08em;color:var(--dim)}
  .tw .stat{display:flex;gap:12px;margin-top:6px;font-size:10px;letter-spacing:.04em;color:var(--dim)}
  .tw .stat b{color:var(--snow);font-weight:600;font-variant-numeric:tabular-nums}
  .tw .stat .f{color:#d9a98c}
  .tw input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:22px;margin:10px 0 0;background:transparent;cursor:pointer;
    --p:0%}
  .tw input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:3px;
    background:linear-gradient(90deg,var(--gold) var(--p),rgba(159,184,218,.2) var(--p))}
  .tw input[type=range]::-moz-range-track{height:3px;border-radius:3px;background:rgba(159,184,218,.2)}
  .tw input[type=range]::-moz-range-progress{height:3px;border-radius:3px;background:var(--gold)}
  .tw input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6.5px;border-radius:50%;
    background:var(--snow);border:0;box-shadow:0 0 0 4px rgba(240,200,164,.16),0 0 18px rgba(240,200,164,.6);
    transition:transform .35s var(--motion),box-shadow .35s var(--motion)}
  .tw input[type=range]:hover::-webkit-slider-thumb,.tw input[type=range]:focus-visible::-webkit-slider-thumb{transform:scale(1.18);
    box-shadow:0 0 0 7px rgba(240,200,164,.14),0 0 24px rgba(240,200,164,.75)}
  .tw input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--snow);border:0;
    box-shadow:0 0 0 4px rgba(240,200,164,.16),0 0 18px rgba(240,200,164,.6)}
  .tw input[type=range]:focus-visible{outline:2px solid rgba(234,241,255,.6);outline-offset:3px;border-radius:6px}
  .tw .marks{display:flex;justify-content:space-between;font-size:8.5px;letter-spacing:.14em;color:rgba(159,184,218,.5);margin-top:1px}
  .tw .row{display:flex;gap:6px;margin-top:10px}
  .tw .row .chip{flex:1;min-height:30px;padding:5px 8px;font-size:10.5px;border-color:rgba(159,184,218,.14)}
  @media(max-width:900px){.tw{top:auto;bottom:calc(clamp(16px,3vh,30px) + 130px);right:12px;left:12px;width:auto}
    .tw canvas{height:56px}.tw .big strong{font-size:24px}}
  @media(max-width:600px){.tw{bottom:calc(12px + 168px)}}

  .bl{left:clamp(22px,4.5vw,76px);bottom:clamp(88px,12vh,118px);max-width:calc(100vw - 44px);
    font-size:10.5px;letter-spacing:.08em;color:rgba(159,184,218,.55)}
  .bl span{color:rgba(159,184,218,.26);margin:0 7px}

  .detail{position:fixed;left:0;top:0;z-index:6;width:360px;max-width:calc(100vw - 32px);
    border:1px solid rgba(159,184,218,.2);border-radius:16px;overflow:hidden;
    background:linear-gradient(158deg,rgba(21,31,50,.95),rgba(10,16,29,.965) 56%,rgba(8,13,24,.975));
    box-shadow:0 30px 90px -40px #000,inset 0 1px 0 rgba(234,241,255,.08);
    font-size:12.5px;line-height:1.85;color:#cddcef;
    opacity:0;pointer-events:none;transform:translate3d(-9999px,-9999px,0);
    transition:opacity .34s var(--motion),border-color .5s var(--motion),box-shadow .5s var(--motion);
    will-change:transform,opacity;contain:layout paint}
  .detail.on{opacity:1;pointer-events:auto}
  .detail-body{opacity:0;transform:translate3d(0,10px,0);
    transition:opacity .55s cubic-bezier(.22,.7,.2,1),transform .7s cubic-bezier(.22,.7,.2,1)}
  .detail.on .detail-body{opacity:1;transform:none}
  /* The card body animates, the card itself is reserved for the follow transform. */
  .detail-body{padding:22px 24px;max-height:calc(100dvh - 260px);overflow:auto;
    transform:translate3d(0,14px,0) scale(.986);transition:transform .46s var(--motion)}
  .detail.on .detail-body{transform:none}
  .detail.docked{left:16px;right:16px;width:auto;top:auto;bottom:126px;transform:none!important}
  .detail.docked .detail-body{max-height:calc(100dvh - 300px)}
  .detail.spot{border-color:rgba(240,200,164,.34);
    box-shadow:0 30px 90px -40px #000,0 0 44px -14px rgba(240,200,164,.35),inset 0 1px 0 rgba(234,241,255,.09)}
  .detail .k{display:flex;align-items:center;gap:8px;font-size:9px;font-weight:600;
    letter-spacing:.22em;text-transform:uppercase;color:rgba(159,184,218,.76)}
  .detail .k::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--gold);
    box-shadow:0 0 10px rgba(240,200,164,.8)}
  .detail .txt{margin-top:12px;color:var(--snow);font-size:13.5px;line-height:1.75;overflow-wrap:anywhere}
  .detail .tags{margin-top:14px;font-size:11px;color:var(--jade);overflow-wrap:anywhere;letter-spacing:.04em}
  .detail .when{margin-top:12px;font-size:10px;letter-spacing:.08em;color:rgba(159,184,218,.55)}
  .detail .mem{margin-top:16px;padding-top:14px;border-top:1px solid rgba(159,184,218,.12)}
  .detail .mrow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
    font-size:10px;letter-spacing:.12em;color:rgba(159,184,218,.7)}
  .detail .mrow b{font-size:20px;font-weight:500;letter-spacing:-.03em;color:var(--snow);font-variant-numeric:tabular-nums}
  .detail .mrow.s{margin-top:8px;font-size:10px;letter-spacing:.04em;color:var(--dim)}
  .detail .mbar{height:3px;margin-top:6px;border-radius:3px;background:rgba(159,184,218,.14);overflow:hidden}
  .detail .mbar i{display:block;height:100%;border-radius:3px;transform-origin:left;
    background:linear-gradient(90deg,#d9a98c,var(--gold) 40%,var(--jade));animation:memFill .9s var(--motion) both}
  @keyframes memFill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .detail .bar{height:1px;margin-top:16px;background:rgba(159,184,218,.14);overflow:hidden}
  .detail .bar i{display:block;height:100%;width:0;background:var(--gold);
    box-shadow:0 0 12px rgba(240,200,164,.7)}

  #tip{position:fixed;z-index:9;pointer-events:none;max-width:min(300px,calc(100vw - 32px));
    padding:8px 11px;border-radius:9px;background:rgba(7,13,25,.9);
    border:1px solid rgba(159,184,218,.24);color:#e2ecfa;font-size:11.5px;line-height:1.55;
    box-shadow:0 16px 40px -20px #000;opacity:0;transition:opacity .18s var(--motion)}

  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
    clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .fade{animation:fadein 1.1s var(--motion) both}
  @keyframes fadein{from{opacity:0}to{opacity:1}}
  button{font:inherit;-webkit-tap-highlight-color:transparent}
  button:focus-visible,canvas:focus-visible,.detail:focus-visible{
    outline:2px solid rgba(234,241,255,.7);outline-offset:4px}

  @media(max-width:900px){
    .tl{left:20px;top:22px;padding:18px 20px 16px;max-width:calc(100vw - 40px)}
    .tl .grid{display:none}
    .tr{bottom:18px;justify-content:flex-start;gap:8px}
    .bl{bottom:136px}
    .detail.docked{left:16px;right:16px;bottom:126px}
  }
  @media(max-width:600px){
    .tl{left:16px;top:18px;padding:16px 18px 14px}
    .tl h1{font-size:31px}
    .tr{left:12px;right:12px;bottom:12px}
    .toolgroup{padding:4px;border-radius:13px}
    .toolgroup.filters{width:100%;justify-content:space-between;order:-1}
    .chip{min-height:34px;padding:7px 10px;font-size:11px}
    .bl{left:16px;bottom:202px;font-size:9.5px;line-height:1.7}
    .detail.docked{left:12px;right:12px;bottom:190px}
    .detail.docked .detail-body{max-height:calc(100dvh - 380px);padding:18px}
  }
  @media(prefers-reduced-motion:reduce){
    :root{--motion:cubic-bezier(0,0,1,1)}
    .fade{animation-duration:.01ms}
    .chip,#tip,.detail,.tw{transition-duration:.01ms}.detail .mbar i{animation:none}.tw input[type=range]::-webkit-slider-thumb{transition-duration:.01ms}
    .chip:hover{transform:none}
    .detail{transform:none}
  }
${socialGraphStyle}
  body.social-mode #sky,
  body.social-mode .hud.tl,
  body.social-mode .hud.bl,
  body.social-mode .hud.tw,
  body.social-mode .detail,
  body.social-mode #tip{display:none!important}
  body.social-mode nav .toolgroup:not(.viewswitch){display:none}
</style></head><body class="fade">
<canvas id="sky" tabindex="0" role="region" aria-label="记忆星图：方向键旋转，加减键缩放，左右方括号浏览记忆，Enter 钉住，Escape 取消" aria-describedby="skyhelp"></canvas>

<div class="hud tl">
  <i class="c c1" aria-hidden="true"></i><i class="c c2" aria-hidden="true"></i>
  <div class="grid" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <span class="eyebrow">Little Whale / Memory Atlas</span>
  <h1>记忆，成为星辰。</h1>
  <p><b>${total}</b> 颗星<span class="sep">/</span>核心 <b style="color:var(--core)">${core}</b><span class="sep">/</span>长期 <b style="color:var(--long)">${long}</b><span class="sep">/</span>短期 <b style="color:var(--short)">${short}</b></p>
</div>

<nav class="hud tr" aria-label="星图工具">
  <div class="toolgroup viewswitch" role="group" aria-label="视图切换">
  <button class="chip on" id="viewStar" aria-pressed="true" title="记忆星图">星图</button>
  <button class="chip" id="viewSocial" aria-pressed="false" title="她眼中的社交圈">社交圈</button>
  </div>
  <div class="toolgroup" role="group" aria-label="场景与巡视">
  <button class="chip" id="bgchip" title="切换星图背景">背景 · 暮色海面</button>
  <button class="chip" id="autochip" aria-pressed="false" title="每隔几秒自动挑一颗星放大，并在旁边显示它的内容">自动巡视</button>
  </div><div class="toolgroup filters" role="group" aria-label="记忆层级筛选">
  <button class="chip on" data-k="all">全部</button>
  <button class="chip" data-k="core">核心</button>
  <button class="chip" data-k="long">长期</button>
  <button class="chip" data-k="short">短期</button>
  </div><div class="toolgroup" role="group" aria-label="窗口操作">
  <button class="chip" id="unfullchip" title="退出全屏（等价于 F11）">退出全屏</button>
  <button class="chip exit" id="closechip" title="关闭这个窗口">关闭</button>
  </div>
</nav>

<div class="hud bl">拖动旋转<span>·</span>滚轮缩放<span>·</span>悬停看内容<span>·</span>点击钉住<span>·</span>双击复位<span>·</span>拨动时间流看遗忘</div>
<section class="hud tw" id="tw" aria-label="遗忘曲线与时间流">
  <div class="cap"><b>Forgetting Curve</b><em id="twWhen">此刻</em></div>
  <canvas id="twChart" aria-hidden="true"></canvas>
  <div class="big"><strong id="twAvg">100</strong><span>% 平均保持率</span></div>
  <div class="stat"><span>将遗忘 <b class="f" id="twFading">0</b></span><span>已遗忘 <b class="f" id="twFaded">0</b></span><span>可见 <b id="twShown">0</b></span></div>
  <input type="range" id="twRange" min="0" max="60" step="0.5" value="0" aria-label="时间流：向未来推移的天数" aria-valuetext="此刻">
  <div class="marks" aria-hidden="true"><span>此刻</span><span>+15 天</span><span>+30 天</span><span>+60 天</span></div>
  <div class="row"><button class="chip" id="twPlay" aria-pressed="false" title="自动向未来流动，再回到此刻">播放时间流</button><button class="chip" id="twReset" title="回到此刻">回到此刻</button></div>
</section>
<div class="detail" id="detail" tabindex="-1" role="region" aria-label="记忆详情"></div>
<p class="sr-only" id="skyhelp">方向键旋转，加减键缩放，左右方括号浏览记忆，Enter 钉住，Escape 取消焦点或返回面板。</p>
<div class="sr-only" id="status" role="status" aria-live="polite"></div>
<div id="tip"></div>
${socialGraphHtml}
<script type="application/json" id="mg">${data}</script>
<script>
(function(){
  'use strict';
  var cv=document.getElementById('sky'), tip=document.getElementById('tip'), detail=document.getElementById('detail');
  var statusEl=document.getElementById('status');
  var progressEl=null, cardBox=null;
  // Follow state for the story card. Transform-only movement on its own layer,
  // converged with the analytic critically damped solution so the card glides
  // with the camera instead of stepping a few times per second.
  var cardX=0,cardY=0,cardOffX=0,cardOffV=0,cardW=360,cardH=150,cardSide=1,cardDocked=false,cardShown=false;
  var CARD_FOLLOW=17, CARD_GAP=58, CARD_MARGIN=18;
  var cardPending=null;   // {n,touring,at}：等镜头稳下来再淡入
  var raw=document.getElementById('mg');
  var data; try{ data=JSON.parse(raw.textContent||'{}'); }catch(e){ data={}; }
  var src=Array.isArray(data.nodes)?data.nodes:[];
  var motionQuery=window.matchMedia('(prefers-reduced-motion: reduce)');
  var reducedMotion=motionQuery.matches;
  var KN={core:'核心',long:'长期',short:'短期'};
  if(!src.length){
    var quiet=document.querySelector('.bl');
    if(quiet) quiet.textContent='这里还很安静。新的记忆，将在这里点亮。';
  }
  function announce(text){ if(statusEl) statusEl.textContent=text; }

  // ── 确定性随机 / 平滑噪声：刷新页面布局稳定，游走不会同步呼吸 ──────────
  function rng(seed){
    return function(){
      seed|=0; seed=seed+0x6D2B79F5|0;
      var t=Math.imul(seed^seed>>>15,1|seed);
      t=t+Math.imul(t^t>>>7,61|t)^t;
      return ((t^t>>>14)>>>0)/4294967296;
    };
  }
  var rand=rng(0x5EED51);
  function hash1(n){
    var x=Math.sin(n*127.1+311.7)*43758.5453;
    return x-Math.floor(x);
  }
  function noise1(x){
    var i=Math.floor(x), f=x-i, u=f*f*(3-2*f);
    return hash1(i)*(1-u)+hash1(i+1)*u;
  }

  // ── 节点：层级决定大小/颜色 ──────────────────────────────────────
  var COL={core:'#f0c8a4',long:'#9fb8da',short:'#8fd0c4'};
  var RGB={core:'240,200,164',long:'159,184,218',short:'143,208,196'};
  var R={core:10.5,long:7,short:4.6};
  var nodes=src.map(function(n){
    var k=(n.k==='core'||n.k==='long'||n.k==='short')?n.k:'long';
    return {
      i:0,t:String(n.t||''),k:k,g:Array.isArray(n.g)?n.g.map(String):[],d:n.d||0,
      s:Math.max(.05,Number(n.s)||18), dg:Number(n.dg)||0, u:Number(n.u)||0, c:Number(n.c)||0, exp:Number(n.x)||0,
      ret:1, retShown:1, born:0,
      phase:rand()*6.283,
      f1:0.12+rand()*0.10, f2:0.08+rand()*0.11, f3:0.05+rand()*0.08, seed:rand()*1000,
      r:R[k],x:0,y:0,z:0,vx:0,vy:0,vz:0,cx:0,cy:0,cz:0,bx:0,by:0,bz:0,
      px:0,py:0,ps:1,pz:0,hide:false
    };
  });
  for(var ni=0;ni<nodes.length;ni++) nodes[ni].i=ni;

  // ── 遗忘曲线：R(t)=exp(-(t-updatedAt)/s)，与 memory-retention.js 同一公式 ─────────
  // 「时间流」拨杆把观察时刻拨到未来：timeOffsetDays>0 时看到的是几天后的星空。
  var DAY=86400000;
  var FADING=0.35;
  var nowMs=Date.now();
  var timeOffsetDays=0, timeShown=0;
  function retentionOf(n,atMs){
    if(n.exp>0 && atMs>=n.exp) return 0;
    var upd=n.u||n.d||atMs;
    var age=Math.max(0,(atMs-upd)/DAY);
    return Math.exp(-age/n.s);
  }
  // 屏幕上的亮度不等于保持率本身：保持率低于 0.05 的星仍保留一点余烬，
  // 否则一拨到未来整片星空就黑了，看不出「谁先暗」。
  function glowOf(r){ return r<=0?.06:.14+.86*Math.pow(r,.7); }
  function refreshRetention(){
    var at=nowMs+timeShown*DAY, faded=0, fading=0, sum=0, shown=0;
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      n.ret=retentionOf(n,at);
      if(n.hide) continue;
      shown++; sum+=n.ret;
      if(n.ret<=0) faded++; else if(n.ret<FADING) fading++;
    }
    return {avg:shown?sum/shown:1,faded:faded,fading:fading,shown:shown};
  }
  var timeDirty=true, lastTimeUi=0;
  for(var ri=0;ri<nodes.length;ri++){ nodes[ri].ret=nodes[ri].retShown=retentionOf(nodes[ri],nowMs); }

  // ── 星团中心：按标签哈希固定方位 ────────────────────────────────
  function tagAngle(t){ var h=0; for(var i=0;i<t.length;i++) h=(h*31+t.charCodeAt(i))>>>0; return (h%360)*Math.PI/180; }
  var centers=new Map();
  nodes.forEach(function(n){
    var tag=(n.g&&n.g[0])||'杂项';
    if(!centers.has(tag)){
      var a=tagAngle(tag), rad=300+((tag.length*97)%220);
      var cp=Math.cos((tag.length%7)-3)*0.5;
      centers.set(tag,{x:Math.cos(a)*rad,y:Math.sin(a)*rad*0.78,z:Math.sin(cp)*rad*0.7,tag:tag});
    }
    var c=centers.get(tag);
    n.cx=c.x; n.cy=c.y; n.cz=c.z;
    n.x=c.x+(rand()-0.5)*150;
    n.y=c.y+(rand()-0.5)*150;
    n.z=c.z+(rand()-0.5)*190;
  });

  // ── 连线：同标签 + 层级流动 ──────────────────────────────────────
  var links=[];
  var byTag=new Map();
  nodes.forEach(function(n){ (n.g||[]).forEach(function(t){ if(!byTag.has(t)) byTag.set(t,[]); byTag.get(t).push(n); }); });
  byTag.forEach(function(arr){
    if(arr.length>10) return;
    for(var i=0;i<arr.length;i++) for(var j=i+1;j<arr.length;j++) links.push({a:arr[i],b:arr[j],t:0});
  });
  var tierOrder={core:0,long:1,short:2};
  var sorted=nodes.slice().sort(function(a,b){ return tierOrder[a.k]-tierOrder[b.k]; });
  for(var q=0;q<sorted.length-1;q++){
    var A=sorted[q], B=sorted[q+1];
    if(tierOrder[B.k]>=tierOrder[A.k] && (B.k!==A.k || rand()<0.35)) links.push({a:A,b:B,t:1});
  }

  // ── 一次性预模拟布局（之后不再跑物理，动效全靠相机 + 低频游走）──────────
  var BOUND=980;
  (function bake(){
    for(var it=0; it<230; it++){
      for(var i=0;i<nodes.length;i++){
        var a=nodes[i];
        for(var j=i+1;j<nodes.length;j++){
          var b=nodes[j];
          var dx=a.x-b.x, dy=a.y-b.y, dz=a.z-b.z;
          var d2=dx*dx+dy*dy+dz*dz+0.01;
          if(d2>160000) continue;
          var f=900/d2, dd=Math.sqrt(d2);
          a.vx+=dx/dd*f; a.vy+=dy/dd*f; a.vz+=dz/dd*f;
          b.vx-=dx/dd*f; b.vy-=dy/dd*f; b.vz-=dz/dd*f;
        }
        a.vx+=(a.cx-a.x)*0.004; a.vy+=(a.cy-a.y)*0.004; a.vz+=(a.cz-a.z)*0.004;
        a.vx-=a.x*0.0006; a.vy-=a.y*0.0006; a.vz-=a.z*0.0006;
      }
      for(var L=0;L<links.length;L++){
        var l=links[L], p=l.a, s=l.b;
        var dx2=s.x-p.x, dy2=s.y-p.y, dz2=s.z-p.z;
        var d3=Math.sqrt(dx2*dx2+dy2*dy2+dz2*dz2)+0.01;
        var f2=(d3-150)*0.006;
        p.vx+=dx2/d3*f2; p.vy+=dy2/d3*f2; p.vz+=dz2/d3*f2;
        s.vx-=dx2/d3*f2; s.vy-=dy2/d3*f2; s.vz-=dz2/d3*f2;
      }
      for(var m=0;m<nodes.length;m++){
        var n2=nodes[m];
        n2.vx*=0.86; n2.vy*=0.86; n2.vz*=0.86;
        n2.x+=n2.vx; n2.y+=n2.vy; n2.z+=n2.vz;
        var rr=Math.sqrt(n2.x*n2.x+n2.y*n2.y+n2.z*n2.z);
        if(rr>BOUND){ var sc=BOUND/rr; n2.x*=sc; n2.y*=sc; n2.z*=sc; }
      }
    }
    nodes.forEach(function(n){ n.bx=n.x; n.by=n.y; n.bz=n.z; n.vx=n.vy=n.vz=0; });
  })();

  var SPREAD=1.62;
  nodes.forEach(function(n){ n.bx*=SPREAD; n.by*=SPREAD; n.bz*=SPREAD; n.x=n.bx; n.y=n.by; n.z=n.bz; });
  var dense=nodes.length>300;
  var renderOrder=nodes.slice();

  // ── 节点光晕精灵：一次生成，逐帧缩放 drawImage（不再每帧建 radial）─────────
  var SPR={};
  function makeGlowSprite(rgb){
    var s=128, c=document.createElement('canvas'); c.width=s; c.height=s;
    var g=c.getContext('2d');
    var rg=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
    rg.addColorStop(0,'rgba(234,241,255,.95)');
    rg.addColorStop(0.10,'rgba('+rgb+',.86)');
    rg.addColorStop(0.30,'rgba('+rgb+',.30)');
    rg.addColorStop(0.66,'rgba('+rgb+',.075)');
    rg.addColorStop(1,'rgba('+rgb+',0)');
    g.fillStyle=rg; g.fillRect(0,0,s,s);
    return c;
  }
  ['core','long','short'].forEach(function(k){ SPR[k]=makeGlowSprite(RGB[k]); });

  // ── 背景方案 / 调色 ─────────────────────────────────────────────
  var BG_MODES=['city','dusk','nebula','aurora','deep'];
  var BG_NAMES={city:'城市黄昏',dusk:'暮色海面',nebula:'星云',aurora:'极光',deep:'深空'};
  // 图像背景：画进离屏场景画布，跟程序生成的那几种走同一条渲染管线
  var cityImg=new Image();
  cityImg.onload=function(){ sceneDirty=true; };
  cityImg.src='/media/bg-city.jpg?v=1';
  var PAL={
    city:{
      sky:'18,26,48', sea:0.0, auroraAlpha:0.30,
      blobs:[[0.30,0.40,0.60,'120,140,190',0.06],[0.74,0.52,0.55,'200,150,120',0.05]],
      aurora:['120,170,220','150,190,230','230,190,150']
    },
    dusk:{
      sky:'22,32,62', sea:0.55, auroraAlpha:0.5,
      blobs:[[0.30,0.34,0.52,'159,184,218',0.14],[0.73,0.54,0.56,'143,208,196',0.09],
             [0.48,0.18,0.60,'124,110,196',0.12],[0.52,0.68,0.42,'240,200,164',0.11]],
      aurora:['143,208,196','159,184,218','240,200,164']
    },
    nebula:{
      sky:'26,24,66', sea:0.42, auroraAlpha:0.62,
      blobs:[[0.24,0.38,0.55,'176,116,200',0.16],[0.74,0.32,0.52,'214,130,150',0.12],
             [0.52,0.62,0.60,'92,128,220',0.13],[0.46,0.20,0.44,'120,220,200',0.08]],
      aurora:['176,136,220','214,150,180','143,208,196']
    },
    aurora:{
      sky:'16,38,58', sea:0.48, auroraAlpha:0.95,
      blobs:[[0.34,0.28,0.58,'120,214,188',0.16],[0.68,0.44,0.54,'110,160,210',0.12],
             [0.50,0.66,0.48,'90,180,160',0.10],[0.18,0.60,0.40,'124,110,196',0.09]],
      aurora:['143,208,196','120,220,190','159,184,218']
    },
    deep:{
      sky:'16,24,48', sea:0.36, auroraAlpha:0.3,
      blobs:[[0.32,0.32,0.56,'120,150,210',0.10],[0.70,0.58,0.52,'100,120,190',0.09],
             [0.50,0.42,0.64,'80,100,180',0.08],[0.60,0.22,0.38,'240,200,164',0.05]],
      aurora:['143,208,196','159,184,218','124,110,196']
    }
  };
  var bgIdx=0;
  try {
    var savedBg=localStorage.getItem('memoryBg');
    if(savedBg && BG_MODES.indexOf(savedBg)>=0) bgIdx=BG_MODES.indexOf(savedBg);
  } catch(e){}

  // ── canvas / 相机 ───────────────────────────────────────────────
  var dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  var W=0,H=0,ctx=cv.getContext('2d');
  var scene=document.createElement('canvas'), sceneCtx=scene.getContext('2d');
  var auroraA=document.createElement('canvas'), auroraB=document.createElement('canvas');
  var sceneDirty=true;

  var yaw=0.25, pitch=-0.1;
  var cosYaw=Math.cos(yaw), sinYaw=Math.sin(yaw), cosPitch=Math.cos(pitch), sinPitch=Math.sin(pitch);
  var yawV=0, pitchV=0, dragging=false, lastX=0, lastY=0;
  var dragDistance=0, pointerId=null;
  var mx=0,my=0,parX=0,parY=0;
  var hover=null,pinned=null,filter='all';
  var cam={x:0,y:0,z:0,zoom:1,pan:0,tx:0,ty:0,tz:0,tzoom:1,tpan:0,
           vx:0,vy:0,vz:0,vzoom:0,vpan:0,dolly:0};
  var focusNode=null, spotAt=0;
  var autoTour=!reducedMotion && nodes.length>0;
  var tourAllowed=!reducedMotion && nodes.length>0;
  var lastTourAt=performance.now(), tourResumeAt=0;

  function focusPan(){ return W<640?0:-Math.min(300,W*.16); }

  function spring(obj,key,vkey,target,omega,dt){
    var x=obj[key]-target;
    var e=Math.exp(-omega*dt);
    var tmp=(obj[vkey]+omega*x)*dt;
    obj[key]=target+(x+tmp)*e;
    obj[vkey]=(obj[vkey]-omega*tmp)*e;
  }
  function updateCamera(dt){
    // 运镜：位置先走、缩放后到（推轨的层次感），dolly 给一个回撤再推进的弧度
    var om=reducedMotion?40:3.2;
    spring(cam,'x','vx',cam.tx,om,dt);
    spring(cam,'y','vy',cam.ty,om,dt);
    spring(cam,'z','vz',cam.tz,om,dt);
    spring(cam,'zoom','vzoom',cam.tzoom,reducedMotion?40:4.2,dt);
    spring(cam,'pan','vpan',cam.tpan,reducedMotion?40:4.0,dt);
    if(cam.dolly>0.0002) cam.dolly*=Math.exp(-1.9*dt); else cam.dolly=0;
    var tx=reducedMotion?0:mx*18, ty=reducedMotion?0:my*14;
    var k=1-Math.exp(-6*dt);
    parX+=(tx-parX)*k; parY+=(ty-parY)*k;
  }
  function glideTo(x,y,z,zm,pan){
    cam.tx=x; cam.ty=y; cam.tz=z;
    cam.tzoom=Math.max(.45,Math.min(5,zm));
    cam.tpan=pan||0;
    if(!reducedMotion) cam.dolly=Math.max(cam.dolly,0.16);
  }
  function settleCamera(){
    cam.tx=cam.x; cam.ty=cam.y; cam.tz=cam.z;
    cam.tzoom=cam.zoom; cam.tpan=cam.pan;
  }

  function projectNode(n){
    var px=n.x-cam.x, py=n.y-cam.y, pz=n.z-cam.z;
    var xr=px*cosYaw-pz*sinYaw;
    var zr=px*sinYaw+pz*cosYaw;
    var yr=py*cosPitch-zr*sinPitch;
    zr=py*sinPitch+zr*cosPitch;
    var denom=2250+zr; if(denom<140) denom=140;
    var s=1250/denom*cam.zoom*(1+cam.dolly);
    n.px=W/2+xr*s+parX+cam.pan;
    n.py=H/2+yr*s+parY;
    n.ps=s;
    n.pz=zr;
  }
  function projectPoint(x,y,z){
    var px=x-cam.x, py=y-cam.y, pz=z-cam.z;
    var xr=px*cosYaw-pz*sinYaw;
    var zr=px*sinYaw+pz*cosYaw;
    var yr=py*cosPitch-zr*sinPitch;
    zr=py*sinPitch+zr*cosPitch;
    var denom=2250+zr; if(denom<140) denom=140;
    var s=1250/denom*cam.zoom*(1+cam.dolly);
    return {sx:W/2+xr*s+parX+cam.pan,sy:H/2+yr*s+parY,s:s,z:zr};
  }

  // ── 静态场景预渲染：星云 / 网格 / 海面反光 / 暗角 ─────────────────
  function radialFill(g,x,y,r,color,alpha){
    if(r<=0) return;
    var rg=g.createRadialGradient(x,y,0,x,y,r);
    rg.addColorStop(0,'rgba('+color+','+alpha+')');
    rg.addColorStop(0.55,'rgba('+color+','+(alpha*0.32).toFixed(3)+')');
    rg.addColorStop(1,'rgba('+color+',0)');
    g.fillStyle=rg;
    g.fillRect(x-r,y-r,r*2,r*2);
  }
  function buildAurora(pal){
    var aw=Math.max(2,Math.floor(W*.9)), ah=Math.max(2,Math.floor(H*.62));
    var cols=pal.aurora;
    [[auroraA,31],[auroraB,57]].forEach(function(item){
      var c=item[0], seed=item[1];
      c.width=aw; c.height=ah;
      var g=c.getContext('2d');
      g.clearRect(0,0,aw,ah);
      var rr=rng(seed);
      for(var i=0;i<7;i++){
        var cx=aw*(.08+rr()*.84), cy=ah*(.18+rr()*.52);
        var rx=aw*(.16+rr()*.30), ry=ah*(.05+rr()*.13);
        g.save();
        g.translate(cx,cy);
        g.scale(1,ry/rx);
        var rg=g.createRadialGradient(0,0,0,0,0,rx);
        var col=cols[(i+seed)%cols.length];
        rg.addColorStop(0,'rgba('+col+','+(0.10+rr()*0.09).toFixed(3)+')');
        rg.addColorStop(.6,'rgba('+col+','+(0.03+rr()*0.03).toFixed(3)+')');
        rg.addColorStop(1,'rgba('+col+',0)');
        g.fillStyle=rg;
        g.beginPath(); g.arc(0,0,rx,0,6.283); g.fill();
        g.restore();
      }
    });
  }
  function buildScene(){
    var pal=PAL[BG_MODES[bgIdx]] || PAL.dusk;
    var sc=Math.min(1.6,Math.max(1,dpr));
    var sw=Math.max(2,Math.floor(W*sc)), sh=Math.max(2,Math.floor(H*sc));
    scene.width=sw; scene.height=sh;
    var g=sceneCtx;
    g.setTransform(sc,0,0,sc,0,0);
    g.clearRect(0,0,W,H);
    g.fillStyle='#060a14'; g.fillRect(0,0,W,H);

    // 图像背景：cover 铺满 + 两层压暗（上浅下深），保星星可读
    if(BG_MODES[bgIdx]==='city' && cityImg.complete && cityImg.naturalWidth>0){
      var csc=Math.max(W/cityImg.naturalWidth,H/cityImg.naturalHeight);
      var cw=cityImg.naturalWidth*csc, ch=cityImg.naturalHeight*csc;
      g.drawImage(cityImg,(W-cw)/2,(H-ch)/2,cw,ch);
      var cveil=g.createLinearGradient(0,0,0,H);
      cveil.addColorStop(0,'rgba(4,8,18,.68)');
      cveil.addColorStop(.45,'rgba(4,8,18,.52)');
      cveil.addColorStop(1,'rgba(3,6,14,.88)');
      g.fillStyle=cveil; g.fillRect(0,0,W,H);
      var cvg=g.createRadialGradient(W*.5,H*.44,Math.min(W,H)*.18,W*.5,H*.44,Math.max(W,H)*.8);
      cvg.addColorStop(0,'rgba(2,4,10,0)');
      cvg.addColorStop(.68,'rgba(2,4,10,.24)');
      cvg.addColorStop(1,'rgba(2,4,10,.74)');
      g.fillStyle=cvg; g.fillRect(0,0,W,H);
      buildAurora(pal);
      return;
    }

    radialFill(g,W*.5,H*.30,Math.max(W,H)*.90,pal.sky,.9);
    radialFill(g,W*.18,H*.12,Math.max(W,H)*.55,'13,24,48',.55);
    radialFill(g,W*.82,H*.20,Math.max(W,H)*.60,'22,18,48',.40);
    for(var i=0;i<pal.blobs.length;i++){
      var b=pal.blobs[i];
      radialFill(g,W*b[0],H*b[1],Math.max(W,H)*b[2],b[3],b[4]);
    }

    g.strokeStyle='rgba(159,184,218,.045)'; g.lineWidth=1;
    var gx,gy;
    for(gx=0;gx<=W;gx+=76){ g.beginPath(); g.moveTo(gx+.5,0); g.lineTo(gx+.5,H); g.stroke(); }
    for(gy=0;gy<=H;gy+=76){ g.beginPath(); g.moveTo(0,gy+.5); g.lineTo(W,gy+.5); g.stroke(); }

    var sr=rng(90210);
    for(i=0;i<260;i++){
      var sx=sr()*W, sy=sr()*H;
      var a=.12+sr()*.50;
      var sz=sr()<.07?1.7:0.9;
      g.fillStyle='rgba(234,241,255,'+a.toFixed(2)+')';
      g.fillRect(sx,sy,sz,sz);
    }

    var hy=H*.715;
    radialFill(g,W*.5,hy,Math.max(W,H)*.62,'240,200,164',.10*pal.sea);
    radialFill(g,W*.5,H*1.02,Math.max(W,H)*.62,'30,58,96',.55*pal.sea);
    g.fillStyle='rgba(240,200,164,'+(0.12*pal.sea).toFixed(3)+')';
    g.fillRect(0,hy,W,1);
    g.fillStyle='rgba(159,184,218,.05)';
    g.fillRect(0,hy+2,W,1);

    var rr=rng(713);
    for(i=0;i<38;i++){
      var ry=hy+rr()*(H-hy);
      var tt=(ry-hy)/Math.max(1,H-hy);
      var rw=(20+rr()*260)*(1-tt*.35);
      var rx=W*.5+(rr()-.5)*W*.92;
      var alpha=(.018+rr()*.055)*(1-tt*.25);
      var col=rr()<.52?'240,200,164':(rr()<.5?'143,208,196':'159,184,218');
      g.fillStyle='rgba('+col+','+alpha.toFixed(3)+')';
      g.fillRect(rx,ry,rw,1);
    }

    var vg=g.createRadialGradient(W*.5,H*.44,Math.min(W,H)*.18,W*.5,H*.44,Math.max(W,H)*.8);
    vg.addColorStop(0,'rgba(2,4,10,0)');
    vg.addColorStop(.68,'rgba(2,4,10,.22)');
    vg.addColorStop(1,'rgba(2,4,10,.72)');
    g.fillStyle=vg; g.fillRect(0,0,W,H);
    radialFill(g,0,0,Math.max(W,H)*.55,'2,4,10',.28);
    radialFill(g,W,H,Math.max(W,H)*.50,'2,4,10',.24);

    buildAurora(pal);
  }

  // ── 远近两层视差星尘 ────────────────────────────────────────────
  var dustFar=[], dustNear=[];
  function mkDust(rr,near){
    var warm=rr()<.24;
    return {
      x:rr(),y:rr(),
      r:near?1.1+rr()*1.2:.6+rr()*.8,
      p:rr()*6.283, v:.5+rr()*1.4,
      c:warm?'240,200,164':(rr()<.18?'143,208,196':'159,184,218')
    };
  }
  function buildDust(){
    var rr=rng(4242);
    dustFar=[]; dustNear=[];
    var nf=dense?46:96, nn=dense?30:58;
    for(var i=0;i<nf;i++) dustFar.push(mkDust(rr,false));
    for(i=0;i<nn;i++) dustNear.push(mkDust(rr,true));
  }
  function drawDust(sec){
    var flow=reducedMotion?0:sec;
    var i,d,dx,dy,a;
    for(i=0;i<dustFar.length;i++){
      d=dustFar[i];
      dx=(d.x*W+flow*d.v*2+parX*0.35)%W; if(dx<0) dx+=W;
      dy=(d.y*H+parY*0.3)%H; if(dy<0) dy+=H;
      a=.10+.20*(.5+.5*Math.sin(flow*.7+d.p));
      ctx.fillStyle='rgba('+d.c+','+a.toFixed(3)+')';
      ctx.fillRect(dx,dy,d.r,d.r);
    }
    for(i=0;i<dustNear.length;i++){
      d=dustNear[i];
      dx=(d.x*W+flow*d.v*4+parX*1.1)%W; if(dx<0) dx+=W;
      dy=(d.y*H+parY*0.9)%H; if(dy<0) dy+=H;
      a=.16+.30*(.5+.5*Math.sin(flow*.9+d.p));
      ctx.fillStyle='rgba('+d.c+','+a.toFixed(3)+')';
      ctx.fillRect(dx,dy,d.r,d.r);
    }
  }

  // ── 灵动背景：发光浮游生物 + 偶发流星 + 开场依次点亮 ─────────────────
  // 浮游生物：沿各自的曲线缓慢上浮（正弦摆动叠加低频噪声，不整齐），亮度随「呼吸」起伏，
  // 靠近光标会被轻轻推开——像真的在水里。数量上限很小，借用节点光晕精灵绘制，不新增渐变。
  var plankton=[], shooters=[], nextShooterAt=0;
  function buildPlankton(){
    var rr=rng(9091), n=dense?14:26;
    plankton=[];
    for(var i=0;i<n;i++){
      plankton.push({x:rr(),y:rr(),r:1.2+rr()*2.4,v:.006+rr()*.016,sw:8+rr()*26,f:.12+rr()*.28,p:rr()*6.283,
        k:rr()<.55?'long':(rr()<.6?'short':'core'),ox:0,oy:0});
    }
  }
  function drawPlankton(sec,dt){
    if(reducedMotion){ return; }
    ctx.globalCompositeOperation='lighter';
    var pull=1-Math.exp(-3.2*dt);
    for(var i=0;i<plankton.length;i++){
      var p=plankton[i];
      var rise=((p.y-sec*p.v)%1+1)%1;                       // 自下而上循环
      var bx=p.x*W+Math.sin(sec*p.f+p.p)*p.sw+(noise1(sec*.07+p.p*9)*2-1)*18;
      var by=rise*(H+60)-30;
      // 光标推开：只在近处生效，松开后按时间弹回，不会瞬移。
      var dx=bx-mxPx, dy=by-myPx, d2=dx*dx+dy*dy, tx=0, ty=0;
      if(d2<14400 && d2>1){ var d=Math.sqrt(d2), f=(1-d/120)*46; tx=dx/d*f; ty=dy/d*f; }
      p.ox+=(tx-p.ox)*pull; p.oy+=(ty-p.oy)*pull;
      var x=bx+p.ox+parX*.6, y=by+p.oy+parY*.6;
      var fadeEdge=Math.min(1,rise*6,(1-rise)*6);
      var breath=.5+.5*Math.sin(sec*(.5+p.f*2)+p.p*3);
      var a=(.10+.34*breath)*fadeEdge;
      if(a<.012) continue;
      var s=p.r*(5+breath*4);
      ctx.globalAlpha=a;
      ctx.drawImage(SPR[p.k],x-s,y-s,s*2,s*2);
    }
    ctx.globalAlpha=1;
    ctx.globalCompositeOperation='source-over';
  }
  // 流星：每 7~16 秒一颗，沿斜线划过；位置用 cubic-bezier(.16,1,.3,1) 的解析近似（先快后慢），
  // 尾迹是沿运动方向的渐隐线段，头部有一点亮。
  function easeOutQuint(t){ return 1-Math.pow(1-t,5); }
  function spawnShooter(now){
    var fromTop=rand()<.7;
    var sx=fromTop?W*(.25+rand()*.7):W*(.7+rand()*.3), sy=fromTop?-20:H*(.05+rand()*.25);
    var ang=Math.PI*(.62+rand()*.12), len=W*(.32+rand()*.22);
    shooters.push({at:now,dur:1100+rand()*700,sx:sx,sy:sy,dx:Math.cos(ang)*len,dy:Math.sin(ang)*len*.8});
    nextShooterAt=now+7000+rand()*9000;
  }
  function drawShooters(now){
    if(reducedMotion) return;
    if(now>nextShooterAt && shooters.length<2 && !document.hidden) spawnShooter(now);
    ctx.globalCompositeOperation='lighter';
    for(var i=shooters.length-1;i>=0;i--){
      var s=shooters[i], t=(now-s.at)/s.dur;
      if(t>=1){ shooters.splice(i,1); continue; }
      var e=easeOutQuint(t), e0=easeOutQuint(Math.max(0,t-.16));
      var hx=s.sx+s.dx*e, hy=s.sy+s.dy*e, tx=s.sx+s.dx*e0, ty=s.sy+s.dy*e0;
      var fade=t<.12?t/.12:(1-t)*1.12;
      var g=ctx.createLinearGradient(tx,ty,hx,hy);
      g.addColorStop(0,'rgba(159,184,218,0)'); g.addColorStop(1,'rgba(234,241,255,'+(.85*Math.max(0,fade)).toFixed(3)+')');
      ctx.strokeStyle=g; ctx.lineWidth=1.5; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(hx,hy); ctx.stroke();
      ctx.globalAlpha=Math.max(0,fade)*.9; ctx.fillStyle='#eaf1ff';
      ctx.beginPath(); ctx.arc(hx,hy,1.5,0,6.283); ctx.fill();
      ctx.globalAlpha=1;
    }
    ctx.lineCap='butt';
    ctx.globalCompositeOperation='source-over';
  }
  // 开场：星按到画面中心的距离依次点亮（每颗 ~0.9s 的缓出），整体约 2.4s 铺满。
  var introAt=0;
  function introGain(n,now){
    if(!introAt||reducedMotion) return 1;
    var dx=n.px-W/2, dy=n.py-H/2, dist=Math.sqrt(dx*dx+dy*dy)/Math.max(1,Math.hypot(W/2,H/2));
    var t=(now-introAt-dist*1500)/900;
    return t<=0?0:(t>=1?1:1-Math.pow(1-t,3));
  }
  var mxPx=-9999, myPx=-9999;
  window.addEventListener('pointermove',function(e){ mxPx=e.clientX; myPx=e.clientY; },{passive:true});
  window.addEventListener('pointerleave',function(){ mxPx=-9999; myPx=-9999; },{passive:true});

  function resize(){
    W=Math.max(1,window.innerWidth);
    H=Math.max(1,window.innerHeight);
    dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));
    cv.width=Math.floor(W*dpr);
    cv.height=Math.floor(H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    sceneDirty=true;
    buildDust();
    buildPlankton();
    cam.tpan=focusPan();
    if(cardShown){
      var spotNow=focusNode||pinned;
      if(spotNow){ cardDocked=false; detail.classList.remove('docked'); measureCard(); snapCard(spotNow); }
    }
  }
  window.addEventListener('resize',resize);

  // ── 卡片 ────────────────────────────────────────────────────────
  function fillCard(n, touring){
    if(!n){ detail.classList.remove('on','spot'); progressEl=null; cardBox=null; cardShown=false; return; }
    var when=n.d ? new Date(n.d).toLocaleString('zh-CN',{hour12:false}) : '';
    function eh(v){
      return String(v==null?'':v)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    // 遗忘信息：当前保持率、稳定度，以及保持率跌到 50% 还要多久（核心视为不遗忘）。
    function span(d){
      if(!isFinite(d)) return '不会遗忘';
      if(d<=0) return '已低于';
      if(d<1) return '约 '+Math.max(1,Math.round(d*24))+' 小时';
      return '约 '+Math.round(d)+' 天';
    }
    function daysTo(target){
      if(n.k==='core' && !(n.exp>0)) return Infinity;
      var age=Math.max(0,(nowMs-(n.u||n.d||nowMs))/DAY);
      var d=Math.max(0,-Math.log(target)*n.s-age);
      if(n.exp>0) d=Math.min(d,Math.max(0,(n.exp-nowMs)/DAY));
      return d;
    }
    var r0=retentionOf(n,nowMs);
    var memo='<div class="mem"><div class="mrow"><span>保持率</span><b>'+Math.round(r0*100)+'%</b></div>'+
      '<div class="mbar"><i style="width:'+(r0*100).toFixed(1)+'%"></i></div>'+
      '<div class="mrow s"><span>稳定度 '+(n.s>=1000?'∞':n.s.toFixed(1)+' 天')+(n.dg?' · 联想 '+n.dg:'')+'</span><span>'+
      (n.exp>0?'将在 '+new Date(n.exp).toLocaleDateString('zh-CN')+' 清除':'降到 50% '+span(daysTo(.5)))+'</span></div></div>';
    detail.innerHTML='<div class="detail-body">'+
      '<div class="k">'+(KN[n.k]||'记忆')+' 记忆'+(touring?' · 自动巡视':' · 已钉住')+'</div>'+
      '<div class="txt">'+eh(n.t)+'</div>'+
      (n.g.length?'<div class="tags">#'+n.g.map(eh).join('　#')+'</div>':'')+
      memo+
      (when?'<div class="when">最近强化 '+when+'</div>':'')+
      '<div class="bar"><i></i></div></div>';
    detail.tabIndex=touring?-1:0;
    if(!touring) announce('已钉住'+(KN[n.k]||'')+'记忆：'+n.t);
    progressEl=detail.querySelector('.bar i');
    measureCard();
    snapCard(n);
    detail.classList.add('on');
    if(touring) detail.classList.add('spot'); else detail.classList.remove('spot');
  }
  // Read layout only when the copy changed or the window resized — never per frame.
  function measureCard(){
    cardW=detail.offsetWidth||360;
    cardH=detail.offsetHeight||150;
  }
  function dockNow(){
    cardDocked=true;
    detail.classList.add('docked');
    var r=detail.getBoundingClientRect();
    cardX=r.left; cardY=r.top;
    cardBox={left:cardX,top:cardY,w:cardW,h:cardH};
  }
  function desiredOffset(vw,n){
    var fitsRight=n.px+CARD_GAP+cardW<=vw-CARD_MARGIN;
    var fitsLeft=n.px-CARD_GAP-cardW>=CARD_MARGIN;
    // Hysteresis: only swap sides when the current side really stops fitting.
    if(cardSide>0&&!fitsRight&&fitsLeft) cardSide=-1;
    else if(cardSide<0&&!fitsLeft&&fitsRight) cardSide=1;
    return cardSide>0?CARD_GAP:-(CARD_GAP+cardW);
  }
  // The star itself is already smooth (camera spring), so the card is placed
  // directly from its projected position — zero lag — and only the side-swap
  // offset is eased. That makes the follow feel welded to the star instead of
  // chasing it, while a side change still sweeps across instead of jumping.
  function applyCardAt(n){
    var vw=window.innerWidth, vh=window.innerHeight;
    var x=Math.max(CARD_MARGIN,Math.min(vw-cardW-CARD_MARGIN,n.px+cardOffX));
    var y=Math.max(CARD_MARGIN,Math.min(vh-cardH-150,n.py-cardH/2));
    writeCard(x,y);
    cardBox={left:x,top:y,w:cardW,h:cardH};
  }
  function writeCard(x,y){
    cardX=x; cardY=y;
    detail.style.transform='translate3d('+x.toFixed(2)+'px,'+y.toFixed(2)+'px,0)';
  }
  function snapCard(n){
    if(window.innerWidth<=900){ dockNow(); cardShown=true; return; }
    if(cardDocked){cardDocked=false;detail.classList.remove('docked');}
    cardOffX=desiredOffset(window.innerWidth,n); cardOffV=0;
    applyCardAt(n);
    cardShown=true;
  }
  function followCard(n,dt){
    if(window.innerWidth<=900){
      if(!cardDocked) dockNow(); else cardBox={left:cardX,top:cardY,w:cardW,h:cardH};
      return;
    }
    if(cardDocked){cardDocked=false;detail.classList.remove('docked');}
    var targetOff=desiredOffset(window.innerWidth,n);
    var w=CARD_FOLLOW, e=Math.exp(-w*dt), dx=cardOffX-targetOff, c=cardOffV+w*dx;
    cardOffX=targetOff+(dx+c*dt)*e;
    cardOffV=(c-w*(dx+c*dt))*e;
    applyCardAt(n);
  }

  function focusNext(){
    var pool=[];
    for(var i=0;i<nodes.length;i++){ if(!nodes[i].hide) pool.push(nodes[i]); }
    if(!pool.length) return;
    var pick, cores=pool.filter(function(n){ return n.k==='core'; });
    if(cores.length && rand()<0.42) pick=cores[(rand()*cores.length)|0];
    else pick=pool[(rand()*pool.length)|0];
    if(pick===focusNode && pool.length>1) pick=pool[(rand()*pool.length)|0];
    focusNode=pick;
    spotAt=performance.now();
    glideTo(pick.x,pick.y,pick.z,Math.max(3.4,cam.tzoom),focusPan());
    lastTourAt=performance.now();
    queueCard(pick,true);
  }
  // 换节点时的顺序：旧卡淡出 → 镜头飞过去 → 停稳了再淡入新内容。
  // 之前是「镜头还在动，字已经换好了」，观感上就是文字在跳。
  function queueCard(n, touring){
    if(!n) return;
    cardPending={ n:n, touring:!!touring, at:performance.now() };
    cardShown=false;
    cardBox=null; progressEl=null;
    detail.classList.remove('on','spot');
  }

  function clearFocus(keepZoom){
    focusNode=null;
    cardPending=null;
    glideTo(0,0,0,keepZoom?cam.tzoom:1,0);
    cardBox=null; cardShown=false;
    detail.tabIndex=-1;
    detail.classList.remove('spot');
  }

  var rafId=0, running=false, previousAt=performance.now();

  function drawReticle(n, now, sec){
    if(n.px<-120||n.px>W+120||n.py<-120||n.py>H+120) return;
    var rr=Math.max(7,n.r*n.ps*1.5);
    var base=rr+15;
    var rot=reducedMotion?0.6:sec*.22+n.phase;
    ctx.save();
    ctx.translate(n.px,n.py);
    ctx.rotate(rot);
    ctx.strokeStyle='rgba(234,241,255,.85)';
    ctx.lineWidth=1.1;
    ctx.beginPath(); ctx.arc(0,0,base,-Math.PI*.88,-Math.PI*.16); ctx.stroke();
    ctx.beginPath(); ctx.arc(0,0,base,Math.PI*.12,Math.PI*.84); ctx.stroke();
    ctx.globalAlpha=.55;
    ctx.strokeStyle='rgba(159,184,218,.9)';
    ctx.beginPath(); ctx.arc(0,0,base+6,-Math.PI*.70,-Math.PI*.30); ctx.stroke();
    ctx.beginPath(); ctx.arc(0,0,base+6,Math.PI*.30,Math.PI*.70); ctx.stroke();
    ctx.globalAlpha=1;
    for(var k=0;k<4;k++){
      var ang=k*Math.PI/2+Math.PI/4;
      var c=Math.cos(ang), s=Math.sin(ang);
      ctx.strokeStyle='rgba(234,241,255,.6)';
      ctx.beginPath();
      ctx.moveTo(c*(base+2),s*(base+2));
      ctx.lineTo(c*(base+8),s*(base+8));
      ctx.stroke();
    }
    ctx.restore();

    var gap=base+13, len=11;
    ctx.strokeStyle='rgba(234,241,255,.45)';
    ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(n.px-gap-len,n.py); ctx.lineTo(n.px-gap,n.py);
    ctx.moveTo(n.px+gap,n.py); ctx.lineTo(n.px+gap+len,n.py);
    ctx.moveTo(n.px,n.py-gap-len); ctx.lineTo(n.px,n.py-gap);
    ctx.moveTo(n.px,n.py+gap); ctx.lineTo(n.px,n.py+gap+len);
    ctx.stroke();

    if(!reducedMotion){
      var elapsed=Math.max(0,now-spotAt);
      for(var pi=0;pi<2;pi++){
        var p=((elapsed/2400)+pi*.5)%1;
        var pr=base+6+p*38;
        ctx.globalAlpha=(1-p)*.38;
        ctx.strokeStyle='rgba(143,208,196,.9)';
        ctx.lineWidth=1.2;
        ctx.beginPath(); ctx.arc(n.px,n.py,pr,0,6.283); ctx.stroke();
      }
      ctx.globalAlpha=1;
    }
    ctx.fillStyle='rgba(234,241,255,.85)';
    ctx.beginPath(); ctx.arc(n.px,n.py,1.4,0,6.283); ctx.fill();
  }

  function frameFn(now){
    if(!running) return;
    if(sceneDirty){ buildScene(); sceneDirty=false; }
    var dt=Math.min(0.05,Math.max(0.001,(now-previousAt)/1000));
    previousAt=now;
    var sec=now/1000;
    var pal=PAL[BG_MODES[bgIdx]] || PAL.dusk;

    if(!dragging && !reducedMotion){
      yaw+=0.010*dt;
      pitch+=pitchV*dt;
    }
    yawV*=Math.exp(-4.2*dt);
    pitchV*=Math.exp(-4.8*dt);
    cosYaw=Math.cos(yaw); sinYaw=Math.sin(yaw);
    cosPitch=Math.cos(pitch); sinPitch=Math.sin(pitch);
    updateCamera(dt);

    // 等运镜落位再换字：至少 420ms（让旧卡淡出完），且相机速度/距离都小下来；
    // 1.5s 兜底，避免极端情况下一直接不上。
    if(cardPending){
      var pEl=now-cardPending.at;
      var pSpd=Math.abs(cam.vx)+Math.abs(cam.vy)+Math.abs(cam.vz);
      var pDis=Math.abs(cam.x-cam.tx)+Math.abs(cam.y-cam.ty)+Math.abs(cam.z-cam.tz);
      // 运镜落位后先「停一拍」，再让文字浮上来——留白是节奏的一部分
      var pSettled = pEl>760 && (pSpd<10 || pDis<20);
      if(pSettled && !cardPending.readyAt) cardPending.readyAt=now+340;
      if((cardPending.readyAt && now>=cardPending.readyAt) || pEl>2400){
        fillCard(cardPending.n, cardPending.touring);
        cardPending=null;
      }
    }

    if(twTick) twTick(dt);

    // 时间流：拨杆目标 → 显示时刻按时间缓动，星光随之「流」过去；跨过熄灭线的星放一圈涟漪。
    if(Math.abs(timeOffsetDays-timeShown)>.0005){
      var prevShown=timeShown;
      timeShown+=(timeOffsetDays-timeShown)*(1-Math.exp(-4.2*dt));
      if(Math.abs(timeOffsetDays-timeShown)<.01) timeShown=timeOffsetDays;
      var atNow=nowMs+timeShown*DAY, atPrev=nowMs+prevShown*DAY;
      for(var ti=0;ti<nodes.length;ti++){
        var tn=nodes[ti];
        var rNow=retentionOf(tn,atNow), rPrev=retentionOf(tn,atPrev);
        tn.ret=rNow;
        if(!reducedMotion && !tn.hide){
          if(rPrev>=FADING*.5 && rNow<FADING*.5){ tn.born=now; tn.bornKind='fade'; }
          else if(rPrev<FADING*.5 && rNow>=FADING*.5){ tn.born=now; tn.bornKind='recall'; }
        }
      }
      timeDirty=true;
    }
    if(timeDirty && now-lastTimeUi>90){ lastTimeUi=now; timeDirty=false; paintTimeUi(); }

    if(!reducedMotion && nodes.length && !autoTour && !pinned && tourResumeAt && now>tourResumeAt){
      autoTour=true; tourResumeAt=0; lastTourAt=0; syncTourChip();
    }
    if(!reducedMotion && autoTour && !dragging && !pinned && now-lastTourAt>7600) focusNext();

    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    ctx.drawImage(scene,0,0,W,H);

    if(auroraA.width){
      var ax=reducedMotion?0:Math.sin(sec*.045)*W*.03;
      var ay=reducedMotion?0:Math.cos(sec*.036)*H*.014;
      ctx.globalCompositeOperation='lighter';
      ctx.globalAlpha=.50*pal.auroraAlpha;
      ctx.drawImage(auroraA,-W*.08+ax,H*.02+ay,W*1.16,H*.74);
      ctx.globalAlpha=.36*pal.auroraAlpha;
      ctx.drawImage(auroraB,-W*.10-ax*.7,H*.08-ay,W*1.16,H*.66);
      ctx.globalAlpha=1;
      ctx.globalCompositeOperation='source-over';
    }

    if(!reducedMotion){
      ctx.globalCompositeOperation='lighter';
      for(var si=0;si<6;si++){
        var sp=((sec*.035+si*.16)%1);
        var sy=H*.735+sp*H*.24;
        var sww=W*(.08+.20*(.5+.5*Math.sin(sec*.18+si*1.7)));
        var sx=W*.5+Math.sin(sec*.09+si*2.1)*W*.24-sww/2;
        ctx.fillStyle='rgba(240,200,164,'+((1-sp)*0.045).toFixed(3)+')';
        ctx.fillRect(sx,sy,sww,1);
      }
      ctx.globalCompositeOperation='source-over';
    }

    drawDust(sec);
    drawPlankton(sec,dt);
    drawShooters(now);

    var i,n;
    for(i=0;i<nodes.length;i++){
      n=nodes[i];
      if(reducedMotion){
        n.x=n.bx; n.y=n.by; n.z=n.bz;
      } else {
        var amp=4.5+(n.phase%1)*4.5;
        var a1=Math.sin(sec*n.f1+n.phase*3.1);
        var a2=Math.sin(sec*n.f2*1.3+n.phase*5.7+1.7);
        var a3=noise1(sec*n.f3+n.seed)*2-1;
        n.x=n.bx+(a1*.5+a3*.5)*amp;
        n.y=n.by+(a2*.55+a3*.45)*amp*.9;
        n.z=n.bz+(a1*.35+a2*.35+a3*.3)*amp*.7;
      }
      projectNode(n);
    }

    renderOrder.sort(function(a,b){ return b.pz-a.pz; });

    ctx.font='10px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.textBaseline='alphabetic';
    centers.forEach(function(c){
      var pr=projectPoint(c.x,c.y,c.z);
      if(pr.sx<-80||pr.sx>W+80||pr.sy<-40||pr.sy>H+40) return;
      var ca=Math.max(.08,Math.min(.50,1.15-pr.z/1500));
      ctx.fillStyle='rgba(159,184,218,'+(ca*.62).toFixed(3)+')';
      ctx.fillRect(pr.sx+3,pr.sy-11,3,3);
      ctx.fillStyle='rgba(159,184,218,'+(ca*.80).toFixed(3)+')';
      ctx.fillText(c.tag,pr.sx+11,pr.sy-8);
    });

    var spot=pinned||focusNode;
    var linkCount=links.length;

    for(i=0;i<linkCount;i++){
      var L=links[i], la=L.a, lb=L.b;
      if(la.hide||lb.hide) continue;
      if((la.px<-120&&lb.px<-120)||(la.px>W+120&&lb.px>W+120)||
         (la.py<-120&&lb.py<-120)||(la.py>H+120&&lb.py>H+120)) continue;
      var depth=((la.pz+lb.pz)*.5)/1800;
      if(depth<0) depth=0;
      var hot=(hover&&(hover===la||hover===lb))||(spot&&(spot===la||spot===lb));
      var base=L.t?0.085:0.15;
      var al=Math.max(0.012,base-depth*0.10);
      if(hot) al=Math.max(al,.48);
      // 线跟着两端的星一起亮起；遗忘中的星，连线也一起变淡（最暗的一端决定）。
      var linkGain=Math.min(introGain(la,now),introGain(lb,now))*(.35+.65*Math.min(la.retShown,lb.retShown));
      al*=linkGain;
      if(al<.004) continue;
      ctx.strokeStyle=hot?'rgba(234,241,255,'+Math.min(.9,al+.18).toFixed(3)+')'
        :(L.t?'rgba(159,184,218,'+al.toFixed(3)+')':'rgba(143,208,196,'+al.toFixed(3)+')');
      ctx.lineWidth=hot?1.5:(L.t?0.9:0.7);
      ctx.beginPath(); ctx.moveTo(la.px,la.py); ctx.lineTo(lb.px,lb.py); ctx.stroke();
    }

    if(!reducedMotion){
      ctx.globalCompositeOperation='lighter';
      var step=dense?10:6;
      for(i=0;i<linkCount;i+=step){
        var L2=links[i];
        if(!L2.t||L2.a.hide||L2.b.hide) continue;
        var fp=((sec*.09+i*.037)%1);
        if(i%2) fp=1-fp;
        var fdx=L2.b.px-L2.a.px, fdy=L2.b.py-L2.a.py;
        var fpx=L2.a.px+fdx*fp, fpy=L2.a.py+fdy*fp;
        var fsize=1.1+Math.max(0,Math.min(1,(1600-L2.a.pz)/2000))*1.2;
        ctx.globalAlpha=.55;
        ctx.fillStyle='#eaf1ff';
        ctx.beginPath(); ctx.arc(fpx,fpy,fsize,0,6.283); ctx.fill();
      }
      ctx.globalAlpha=1;
      ctx.globalCompositeOperation='source-over';
    }

    if(spot && !spot.hide){
      var scanned=0;
      for(i=0;i<linkCount && scanned<26;i++){
        var L3=links[i];
        if(L3.a!==spot&&L3.b!==spot) continue;
        if(L3.a.hide||L3.b.hide) continue;
        scanned++;
        var p2=reducedMotion?0.55:((sec*.32+scanned*.13)%1);
        var q2=Math.max(0,p2-.2);
        var ax2=L3.a.px, ay2=L3.a.py, bx2=L3.b.px, by2=L3.b.py;
        ctx.strokeStyle='rgba(234,241,255,.75)';
        ctx.lineWidth=1.6;
        ctx.beginPath();
        ctx.moveTo(ax2+(bx2-ax2)*q2,ay2+(by2-ay2)*q2);
        ctx.lineTo(ax2+(bx2-ax2)*p2,ay2+(by2-ay2)*p2);
        ctx.stroke();
        ctx.globalAlpha=.9;
        ctx.fillStyle='#eaf1ff';
        ctx.beginPath();
        ctx.arc(ax2+(bx2-ax2)*p2,ay2+(by2-ay2)*p2,1.7,0,6.283);
        ctx.fill();
        ctx.globalAlpha=1;
      }
    }

    var denseCut=dense?2:1;
    for(var oi=0;oi<renderOrder.length;oi++){
      var nd=renderOrder[oi];
      if(nd.hide) continue;
      if(nd.px<-100||nd.px>W+100||nd.py<-100||nd.py>H+100) continue;
      // 遗忘曲线：显示用保持率向目标缓动（按时间），所以拨动时间流时星光是「流」过去的，不是跳。
      var retK=1-Math.exp(-5.5*dt);
      nd.retShown+=(nd.ret-nd.retShown)*retK;
      var intro=introGain(nd,now);
      if(intro<=0.003) continue;
      var glow=glowOf(nd.retShown)*intro;
      // 将熄的星：保持率越低，亮度越不稳（两个不同频率叠加，避免整齐闪烁）。
      var flick=1;
      if(!reducedMotion && nd.retShown<FADING && nd.retShown>0){
        var fk=(FADING-nd.retShown)/FADING;
        flick=1-fk*.42*(.5+.5*Math.sin(sec*(3.1+nd.f1*9)+nd.phase*4)*Math.sin(sec*(1.3+nd.f2*5)+nd.seed));
      }
      var born=nd.born>0?Math.max(0,1-(now-nd.born)/1400):0;
      var near=Math.max(.35,Math.min(1,1.35-nd.pz/1100));
      var isSpot=nd===spot;
      var isHover=nd===hover;
      var dim=spot?(isSpot?1:(isHover?.82:.42)):1;
      var mag=(isSpot?1.5:1)*(isHover?1.14:1);
      var rr2=Math.max(1.1,nd.r*nd.ps*mag*(.62+.38*nd.retShown));
      var gd=rr2*7.4*(.55+.45*glow);
      ctx.globalCompositeOperation='lighter';
      ctx.globalAlpha=Math.min(1,near*dim*glow*flick*(isHover?.95:.74));
      ctx.drawImage(SPR[nd.k],nd.px-gd/2,nd.py-gd/2,gd,gd);
      ctx.globalCompositeOperation='source-over';
      ctx.globalAlpha=Math.min(1,near*dim*glow*flick*1.1);
      ctx.fillStyle=COL[nd.k];
      ctx.beginPath(); ctx.arc(nd.px,nd.py,rr2,0,6.283); ctx.fill();
      if(nd.k==='core'){
        ctx.fillStyle='rgba(255,247,238,.9)';
        ctx.beginPath(); ctx.arc(nd.px,nd.py,rr2*.36,0,6.283); ctx.fill();
      }
      if(nd.k==='core' && (nd.i%denseCut===0)){
        var ringAlpha=.18*near*dim*glow;
        if(ringAlpha>.01){
          ctx.save();
          ctx.translate(nd.px,nd.py);
          ctx.rotate(reducedMotion?nd.phase:(sec*.14+nd.phase));
          ctx.strokeStyle='rgba(240,200,164,'+ringAlpha.toFixed(3)+')';
          ctx.lineWidth=.9;
          ctx.beginPath(); ctx.arc(0,0,rr2*2.05,.35,Math.PI*1.45); ctx.stroke();
          ctx.beginPath(); ctx.arc(0,0,rr2*2.50,Math.PI*1.10,Math.PI*1.92); ctx.stroke();
          ctx.restore();
        }
      }
      // 刚被「想起」/刚熄灭的一圈涟漪：用 born 记录事件时刻，1.4 秒内扩散并淡出。
      if(born>0 && !reducedMotion){
        var rp=1-born;
        ctx.globalAlpha=born*.55*near;
        ctx.strokeStyle=nd.bornKind==='fade'?'rgba(159,184,218,.9)':'rgba(240,200,164,.95)';
        ctx.lineWidth=1.2;
        ctx.beginPath(); ctx.arc(nd.px,nd.py,rr2+4+rp*(nd.bornKind==='fade'?26:44),0,6.283); ctx.stroke();
      }
      if(isHover){
        ctx.globalAlpha=Math.min(1,near*.8);
        ctx.strokeStyle='rgba(234,241,255,.8)';
        ctx.lineWidth=1;
        ctx.beginPath(); ctx.arc(nd.px,nd.py,rr2+5,0,6.283); ctx.stroke();
      }
      if(pinned===nd){
        ctx.globalAlpha=1;
        ctx.strokeStyle='rgba(240,200,164,.9)';
        ctx.lineWidth=1.3;
        ctx.beginPath(); ctx.arc(nd.px,nd.py,rr2+8,0,6.283); ctx.stroke();
      }
      ctx.globalAlpha=1;
    }

    if(spot && !spot.hide) drawReticle(spot,now,sec);

    if(spot && cardBox){
      var cx3=cardBox.left>spot.px?cardBox.left:cardBox.left+cardBox.w;
      var cy3=Math.max(cardBox.top+14,Math.min(cardBox.top+cardBox.h-14,spot.py));
      ctx.globalAlpha=.45;
      ctx.strokeStyle='rgba(159,184,218,.8)';
      ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(spot.px,spot.py); ctx.lineTo(cx3,cy3); ctx.stroke();
      ctx.globalAlpha=.9;
      ctx.fillStyle='#eaf1ff';
      ctx.beginPath(); ctx.arc(cx3,cy3,2,0,6.283); ctx.fill();
      ctx.globalAlpha=1;
    }

    if(spot && cardShown) followCard(spot,dt);
    if(progressEl){
      var pct=autoTour?Math.max(0,Math.min(1,(now-lastTourAt)/7600)):0;
      progressEl.style.width=(pct*100).toFixed(1)+'%';
    }

    rafId=requestAnimationFrame(frameFn);
  }

  function startLoop(){
    if(running) return;
    running=true;
    previousAt=performance.now();
    rafId=requestAnimationFrame(frameFn);
  }
  function stopLoop(){
    if(!running) return;
    running=false;
    if(rafId) cancelAnimationFrame(rafId);
    rafId=0;
  }

  // ── 交互 ────────────────────────────────────────────────────────
  function nearest(x,y){
    var best=null, bd=26*26;
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      if(n.hide) continue;
      var dx=n.px-x, dy=n.py-y, d2=dx*dx+dy*dy;
      if(d2<bd){ bd=d2; best=n; }
    }
    return best;
  }

  function syncTourChip(){
    var c=document.getElementById('autochip');
    if(c){ c.classList.toggle('on',autoTour); c.setAttribute('aria-pressed',String(autoTour)); }
  }
  function stopTour(){
    autoTour=false;
    tourResumeAt=(tourAllowed && !reducedMotion)?performance.now()+20000:0;
    syncTourChip();
  }

  cv.addEventListener('pointerdown', function(e){
    if(e.button!==0) return;
    dragging=true; dragDistance=0; pointerId=e.pointerId;
    cv.setPointerCapture(e.pointerId); cv.focus({preventScroll:true});
    cv.classList.add('drag'); cv.style.cursor='grabbing';
    hover=null; tip.style.opacity='0';
    stopTour(); settleCamera();
    lastX=e.clientX; lastY=e.clientY; yawV=0; pitchV=0;
  });
  function endDrag(){
    dragging=false; pointerId=null;
    cv.classList.remove('drag'); cv.style.cursor='grab';
  }
  window.addEventListener('pointerup',endDrag);
  window.addEventListener('pointercancel',endDrag);
  cv.addEventListener('lostpointercapture',endDrag);
  window.addEventListener('pointermove', function(e){
    mx=(e.clientX/window.innerWidth-0.5)*2;
    my=(e.clientY/window.innerHeight-0.5)*2;
    if(dragging){
      if(e.pointerId!==pointerId) return;
      var dx=e.clientX-lastX, dy=e.clientY-lastY;
      dragDistance+=Math.abs(dx)+Math.abs(dy);
      yawV=dx*0.07; pitchV=dy*0.06;
      yaw+=dx*0.0055; pitch+=dy*0.0045;
      pitch=Math.max(-1.3,Math.min(1.3,pitch));
      lastX=e.clientX; lastY=e.clientY;
      return;
    }
    var hit=e.target===cv?nearest(e.clientX,e.clientY):null;
    if(hit){
      hover=hit;
      tip.textContent=hit.t;
      tip.style.left=Math.max(16,Math.min(window.innerWidth-(tip.offsetWidth||300)-16,e.clientX+16))+'px';
      tip.style.top=Math.max(16,Math.min(window.innerHeight-(tip.offsetHeight||60)-16,e.clientY+16))+'px';
      tip.style.opacity='1';
      cv.style.cursor='pointer';
    } else {
      hover=null; tip.style.opacity='0'; cv.style.cursor='grab';
    }
  });
  cv.addEventListener('wheel', function(e){
    e.preventDefault(); stopTour(); settleCamera();
    cam.tzoom=Math.max(.45,Math.min(5,cam.tzoom*(e.deltaY>0?.9:1.1)));
  }, {passive:false});
  cv.addEventListener('dblclick', function(){
    yaw=.25; pitch=-.1; yawV=0; pitchV=0;
    pinned=null; focusNode=null; spotAt=0;
    glideTo(0,0,0,1,0);
    detail.classList.remove('on');
    autoTour=tourAllowed && !reducedMotion;
    lastTourAt=performance.now(); tourResumeAt=0;
    syncTourChip();
  });

  cv.addEventListener('click', function(e){
    if(dragDistance>5){ dragDistance=0; return; }
    var hit=nearest(e.clientX,e.clientY);
    if(!hit){ pinned=null; clearFocus(false); detail.classList.remove('on'); return; }
    pinned=hit; focusNode=hit; spotAt=performance.now();
    glideTo(hit.x,hit.y,hit.z,Math.max(3.4,cam.tzoom),focusPan());
    stopTour();
    cardPending=null;
    fillCard(hit,false);
  });

  // 背景切换：暮色海面 → 星云 → 极光 → 深空（选择会记住）
  var bgChip=document.getElementById('bgchip');
  function paintBgChip(){
    if(bgChip) bgChip.textContent='背景 · '+(BG_NAMES[BG_MODES[bgIdx]]||'暮色海面');
  }
  if(bgChip){
    paintBgChip();
    bgChip.addEventListener('click', function(){
      bgIdx=(bgIdx+1)%BG_MODES.length;
      paintBgChip();
      sceneDirty=true;
      try { localStorage.setItem('memoryBg',BG_MODES[bgIdx]); } catch(e){}
    });
  }

  // 退出全屏 / 关闭：全屏窗口没有标题栏，靠这两个按钮收尾。
  // 被面板用 iframe 嵌进来时（embed=1 或 parent 存在），"关闭"改成通知父页面收起浮层。
  var embedded=false;
  try {
    embedded = (window.self !== window.top) || /[?&]embed=1/.test(location.search);
  } catch(e){ embedded=true; }

  var unfull=document.getElementById('unfullchip');
  if(unfull){
    if(embedded) unfull.style.display='none';
    else unfull.addEventListener('click', function(){ fetch('/panel-exit?star=1', { cache:'no-store' }); });
  }
  function returnToPanel(){
    if(embedded){ try{ window.parent.postMessage('close-star',location.origin); }catch(e){} }
  }
  document.addEventListener('keydown', function(e){
    if(embedded && e.key==='Escape'){ e.preventDefault(); returnToPanel(); }
  });
  var closeChip=document.getElementById('closechip');
  if(closeChip){
    if(embedded) closeChip.textContent='返回面板';
    closeChip.addEventListener('click', function(){
      if(embedded){ returnToPanel(); return; }
      fetch('/panel-close?star=1', { cache:'no-store' });
    });
  }

  // 自动巡视开关
  var autoChip=document.getElementById('autochip');
  if(autoChip){
    syncTourChip();
    autoChip.disabled=reducedMotion || !nodes.length;
    autoChip.title=reducedMotion?'系统已启用减少动态，自动巡视已暂停':'每隔几秒自动聚焦一颗记忆星';
    autoChip.addEventListener('click', function(){
      if(reducedMotion || !nodes.length) return;
      autoTour=!autoTour; tourAllowed=autoTour; tourResumeAt=0;
      syncTourChip();
      if(autoTour){
        pinned=null; lastTourAt=0;
      } else {
        clearFocus(false); detail.classList.remove('on');
      }
    });
  }

  // 层级筛选
  var chips=[].slice.call(document.querySelectorAll('.chip[data-k]'));
  chips.forEach(function(btn){
    btn.setAttribute('aria-pressed',String(btn.getAttribute('data-k')==='all'));
    btn.addEventListener('click', function(){
      chips.forEach(function(b){ b.classList.remove('on'); b.setAttribute('aria-pressed','false'); });
      btn.classList.add('on'); btn.setAttribute('aria-pressed','true');
      filter=btn.getAttribute('data-k');
      nodes.forEach(function(n){ n.hide=(filter!=='all' && n.k!==filter); });
      if(pinned && pinned.hide){ pinned=null; detail.classList.remove('on'); }
      if(focusNode && focusNode.hide){
        clearFocus(true);
        if(!pinned) detail.classList.remove('on');
      }
      lastTourAt=0;
      announce(btn.textContent+'：'+nodes.filter(function(n){ return !n.hide; }).length+' 颗记忆星');
      twCache=null; timeDirty=true;
    });
  });

  // ── 时间流 / 遗忘曲线面板 ───────────────────────────────────────
  // 图里三条线是各层级「真实记忆」在未来 horizon 天内的平均保持率（由每条记忆自己的稳定度算出），
  // 竖线是当前拨到的时刻；曲线与星光用同一个 retentionOf，所以图和星空永远对得上。
  var twEl=document.getElementById('tw'), twChart=document.getElementById('twChart');
  var twRange=document.getElementById('twRange'), twWhen=document.getElementById('twWhen');
  var twAvg=document.getElementById('twAvg'), twFading=document.getElementById('twFading');
  var twFaded=document.getElementById('twFaded'), twShown=document.getElementById('twShown');
  var twPlay=document.getElementById('twPlay'), twReset=document.getElementById('twReset');
  var HORIZON=60, twCtx=twChart?twChart.getContext('2d'):null, twCache=null, twPlaying=false, twDir=1, twTick=null;
  var TW_COL={core:'240,200,164',long:'159,184,218',short:'143,208,196'};
  function whenText(d){
    if(d<.25) return '此刻';
    if(d<1) return '+'+Math.round(d*24)+' 小时';
    return '+'+(Math.round(d*2)/2)+' 天';
  }
  // 各层级平均保持率曲线：只在筛选变化时重算，拨杆时只重画游标。
  function buildTwSeries(){
    var steps=60, out={core:[],long:[],short:[]}, cnt={core:0,long:0,short:0};
    nodes.forEach(function(n){ if(!n.hide) cnt[n.k]++; });
    ['core','long','short'].forEach(function(k){
      for(var s=0;s<=steps;s++){
        if(!cnt[k]){ out[k].push(null); continue; }
        var at=nowMs+HORIZON*DAY*s/steps, sum=0;
        for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!n.hide&&n.k===k) sum+=retentionOf(n,at); }
        out[k].push(sum/cnt[k]);
      }
    });
    return out;
  }
  function sizeTwChart(){
    if(!twChart) return;
    var w=twChart.clientWidth||250, h=twChart.clientHeight||76, d=Math.min(2,window.devicePixelRatio||1);
    twChart.width=Math.max(2,Math.floor(w*d)); twChart.height=Math.max(2,Math.floor(h*d));
    twCtx.setTransform(d,0,0,d,0,0);
    twCache=null;
  }
  function paintTimeUi(){
    if(!twEl||!twCtx) return;
    var stat=refreshRetention();
    twAvg.textContent=Math.round(stat.avg*100);
    twFading.textContent=stat.fading;
    twFaded.textContent=stat.faded;
    twShown.textContent=stat.shown;
    twWhen.textContent=whenText(timeShown);
    var pct=(timeOffsetDays/HORIZON*100).toFixed(1)+'%';
    twRange.style.setProperty('--p',pct);
    twRange.setAttribute('aria-valuetext',whenText(timeOffsetDays));
    if(!twCache) twCache=buildTwSeries();
    var w=twChart.clientWidth||250, h=twChart.clientHeight||76, pad=4;
    twCtx.clearRect(0,0,w,h);
    // 阈值线：低于它就算「快忘了」
    var ty=pad+(1-FADING)*(h-pad*2);
    twCtx.setLineDash([3,4]); twCtx.strokeStyle='rgba(217,169,140,.34)'; twCtx.lineWidth=1;
    twCtx.beginPath(); twCtx.moveTo(0,ty); twCtx.lineTo(w,ty); twCtx.stroke(); twCtx.setLineDash([]);
    ['short','long','core'].forEach(function(k){
      var arr=twCache[k], steps=arr.length-1, started=false;
      var grad=twCtx.createLinearGradient(0,0,0,h);
      grad.addColorStop(0,'rgba('+TW_COL[k]+',.20)'); grad.addColorStop(1,'rgba('+TW_COL[k]+',0)');
      twCtx.beginPath();
      var lastX=0, firstX=0;
      for(var s=0;s<=steps;s++){
        if(arr[s]==null) continue;
        var x=s/steps*w, y=pad+(1-arr[s])*(h-pad*2);
        if(!started){ twCtx.moveTo(x,y); firstX=x; started=true; } else twCtx.lineTo(x,y);
        lastX=x;
      }
      if(!started) return;
      twCtx.strokeStyle='rgba('+TW_COL[k]+',.95)'; twCtx.lineWidth=k==='core'?1.2:1.6; twCtx.stroke();
      if(k!=='core'){ twCtx.lineTo(lastX,h); twCtx.lineTo(firstX,h); twCtx.closePath(); twCtx.fillStyle=grad; twCtx.fill(); }
    });
    // 游标：当前显示时刻（缓动后的 timeShown，所以与星光同步）
    var cx=Math.max(0,Math.min(w,timeShown/HORIZON*w));
    twCtx.strokeStyle='rgba(234,241,255,.85)'; twCtx.lineWidth=1;
    twCtx.beginPath(); twCtx.moveTo(cx,0); twCtx.lineTo(cx,h); twCtx.stroke();
    twCtx.fillStyle='#eaf1ff';
    twCtx.beginPath(); twCtx.arc(cx,h-3,2.4,0,6.283); twCtx.fill();
  }
  function setTimeOffset(days){
    timeOffsetDays=Math.max(0,Math.min(HORIZON,days));
    if(twRange) twRange.value=String(timeOffsetDays);
    if(reducedMotion){ timeShown=timeOffsetDays; for(var i=0;i<nodes.length;i++) nodes[i].ret=nodes[i].retShown=retentionOf(nodes[i],nowMs+timeShown*DAY); }
    timeDirty=true;
  }
  if(twEl){
    if(!nodes.length) twEl.classList.add('hide');
    sizeTwChart();
    twRange.addEventListener('input',function(){ twPlaying=false; syncPlay(); setTimeOffset(Number(twRange.value)||0); });
    twReset.addEventListener('click',function(){ twPlaying=false; syncPlay(); setTimeOffset(0); });
    function syncPlay(){ twPlay.classList.toggle('on',twPlaying); twPlay.setAttribute('aria-pressed',String(twPlaying)); twPlay.textContent=twPlaying?'暂停':'播放时间流'; }
    twPlay.addEventListener('click',function(){
      if(reducedMotion){ setTimeOffset(timeOffsetDays>=HORIZON?0:HORIZON); return; }
      twPlaying=!twPlaying; if(twPlaying&&timeOffsetDays>=HORIZON) setTimeOffset(0); syncPlay();
    });
    window.addEventListener('resize',function(){ sizeTwChart(); timeDirty=true; });
    // 播放：匀速推进拨杆目标（帧循环里按 dt 推进），到头停一拍再自动回到此刻，形成呼吸式循环。
    twTick=function(dt){
      if(!twPlaying) return;
      var next=timeOffsetDays+dt*(HORIZON/22)*twDir;
      if(next>=HORIZON){ next=HORIZON; twPlaying=false; syncPlay(); setTimeout(function(){ if(!twPlaying) setTimeOffset(0); },1500); }
      setTimeOffset(next);
    };
  }

  var keyIndex=-1;
  cv.addEventListener('keydown',function(e){
    var key=e.key;
    if(key==='Escape'){
      if(!embedded){ e.preventDefault(); pinned=null; clearFocus(false); detail.classList.remove('on'); stopTour(); }
      return;
    }
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','[',']','Enter','Home'].indexOf(key)<0) return;
    e.preventDefault(); stopTour(); settleCamera(); yawV=0; pitchV=0;
    if(key==='ArrowLeft') yaw-=.12;
    if(key==='ArrowRight') yaw+=.12;
    if(key==='ArrowUp') pitch=Math.max(-1.3,pitch-.1);
    if(key==='ArrowDown') pitch=Math.min(1.3,pitch+.1);
    if(key==='+' || key==='=') cam.tzoom=Math.min(5,cam.tzoom*1.12);
    if(key==='-') cam.tzoom=Math.max(.45,cam.tzoom/1.12);
    if(key==='Home'){ yaw=.25; pitch=-.1; pinned=null; clearFocus(false); detail.classList.remove('on'); }
    if(key==='[' || key===']' || key==='Enter'){
      var pool=nodes.filter(function(n){ return !n.hide; });
      if(!pool.length) return;
      keyIndex=(keyIndex+(key==='['?-1:1)+pool.length)%pool.length;
      var n=key==='Enter' && hover && !hover.hide?hover:pool[keyIndex];
      pinned=n; focusNode=n; spotAt=performance.now();
      glideTo(n.x,n.y,n.z,Math.max(3.4,cam.tzoom),focusPan());
      fillCard(n,false);
    }
  });

  function motionChanged(event){
    reducedMotion=event.matches;
    if(reducedMotion){ autoTour=false; tourAllowed=false; tourResumeAt=0; yawV=0; pitchV=0; settleCamera(); }
    syncTourChip();
    if(autoChip){
      autoChip.disabled=reducedMotion || !nodes.length;
      autoChip.title=reducedMotion?'系统已启用减少动态，自动巡视已暂停':'每隔几秒自动聚焦一颗记忆星';
    }
  }
  if(motionQuery.addEventListener) motionQuery.addEventListener('change',motionChanged);
  else if(motionQuery.addListener) motionQuery.addListener(motionChanged);

  document.addEventListener('visibilitychange', function(){
    if(document.hidden) stopLoop(); else startLoop();
  });

  // 先绑定所有工具/返回逻辑，再启动帧循环（空星图也照常进入）。
  resize();
  buildScene();
  sceneDirty=false;
  paintTimeUi();
  // 从此刻起计时：布局预模拟的耗时不会吞掉开场；第一颗流星留到开场结束后。
  introAt=performance.now();
  nextShooterAt=introAt+3800;
  if(!document.hidden) startLoop();
})();
</script>
<script>${socialGraphScript}</script>
</body></html>`;
}
