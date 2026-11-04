// 「她眼中的社交圈」视图 · 3A 风格重制 v2（清晰度 + 运镜）。
// 只读：这里没有任何写数据的入口。对外约定与旧版一致：
//   导出 socialGraphHtml / socialGraphStyle / socialGraphScript；接口 /api/console/social-graph；
//   window.__sgShow / __sgHide；按钮 #viewStar / #viewSocial；容器 #socialWrap。
// v2 修了什么：
//   · 上一版把「像素/世界单位」直接当尺寸系数，光晕被放大到铺满画面；现在统一用相对于基准距离的比例 k，并夹在合理范围。
//   · 每个人都有名字标签（带描边、做了避让），打码 QQ 号只在卡片里出现。
//   · 增加编码图例；光晕改用预渲染精灵，逐帧只做 drawImage。
//   · 运镜：聚焦只平移+推近，不再转 yaw（以前会突然拧一下）；全部走临界阻尼，进出场与相机初值衔接。
export const socialGraphHtml = `
<div id="socialWrap" class="social-wrap" hidden>
  <canvas id="socialCanvas" role="img" aria-label="她眼中的社交圈：以她为中心的人物关系空间图"></canvas>
  <div class="sg-vignette" aria-hidden="true"></div>
  <div class="sg-title" aria-hidden="true"><span>Little Whale / Social Orbit</span><b>她眼中的社交圈</b></div>
  <ul class="sg-legend" aria-label="图例">
    <li><i class="d"></i>离中心越近 · 好感越高</li>
    <li><i class="g"></i>暖色光晕 · 喜爱</li>
    <li><i class="l"></i>连线越粗 · 忠诚越高</li>
    <li><i class="w"></i>琥珀圈 · 纪律警告</li>
  </ul>
  <div class="social-bar">
    <div class="sg-filter" id="sgFilter" role="group" aria-label="按群筛选"></div>
    <label class="sg-time">
      <span>时间流</span>
      <input id="sgTime" type="range" min="0" max="120" step="1" value="0" aria-label="时间流：拨到未来看谁先淡出">
      <b id="sgTimeVal">今天</b>
    </label>
  </div>
  <div id="sgCard" class="sg-card" role="dialog" aria-live="polite" aria-hidden="true"></div>
  <p id="sgHint" class="sg-hint">悬停查看 · 点击钉住并推近 · 拖动环绕 · 滚轮缩放 · Esc 退出 · ← → 切换人物</p>
</div>`;

export const socialGraphStyle = `
:root{--sg-e1:cubic-bezier(.16,1,.3,1);--sg-e2:cubic-bezier(.65,0,.35,1);--sg-e3:cubic-bezier(.22,.68,0,1)}
.social-wrap{position:fixed;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;background:#02040a;
  opacity:0;transform:scale(1.18);filter:blur(12px);pointer-events:none;
  transition:opacity 1s var(--sg-e1),transform 1.5s var(--sg-e1),filter 1.1s var(--sg-e1)}
.social-wrap[hidden]{display:none}
.social-wrap.live{opacity:1;transform:none;filter:none;pointer-events:auto}
.social-wrap.leaving{opacity:0;transform:scale(1.3);filter:blur(14px);transition:opacity .75s var(--sg-e2),transform 1s var(--sg-e2),filter .75s var(--sg-e2)}
#socialCanvas{width:100vw;height:100vh;display:block;cursor:grab;touch-action:none}
#socialCanvas.drag{cursor:grabbing}
.sg-vignette{position:fixed;inset:0;pointer-events:none;z-index:2;background:radial-gradient(125% 95% at 50% 47%,transparent 58%,rgba(1,3,10,.62) 100%)}
.sg-title{position:fixed;left:clamp(22px,4.5vw,76px);top:clamp(24px,4.6vh,58px);z-index:6;pointer-events:none;padding:0 0 0 18px;border-left:1px solid rgba(140,185,255,.3);opacity:0;transform:translateY(10px)}
.social-wrap.live .sg-title{opacity:1;transform:none;transition:opacity 1.2s var(--sg-e1) .5s,transform 1.2s var(--sg-e1) .5s}
.sg-title span{display:block;font-size:9.5px;letter-spacing:.34em;color:rgba(150,190,245,.78);text-transform:uppercase}
.sg-title b{display:block;margin-top:10px;font-size:clamp(26px,3.6vw,48px);font-weight:500;letter-spacing:-.04em;line-height:1.1;color:#f0f6ff;text-shadow:0 0 36px rgba(110,160,255,.35)}
.sg-legend{position:fixed;left:clamp(22px,4.5vw,76px);bottom:clamp(88px,12vh,118px);z-index:5;margin:0;padding:0;list-style:none;pointer-events:none;
  display:grid;gap:7px;font-size:10.5px;letter-spacing:.06em;color:rgba(170,196,230,.78);opacity:0}
.social-wrap.live .sg-legend{opacity:1;transition:opacity 1.2s var(--sg-e1) .8s}
.sg-legend li{display:flex;align-items:center;gap:9px}
.sg-legend i{display:inline-block;width:14px;height:14px;border-radius:50%;flex:none}
.sg-legend .d{border:1px solid rgba(170,210,255,.7);background:radial-gradient(circle,rgba(170,210,255,.5) 0 28%,transparent 30%)}
.sg-legend .g{background:radial-gradient(circle,#ffe6c4 0 32%,rgba(255,200,150,.45) 52%,transparent 72%)}
.sg-legend .l{border-radius:3px;height:3px;width:16px;background:linear-gradient(90deg,rgba(130,178,238,.3),#9fd0ff)}
.sg-legend .w{border:1.5px solid #ffd166;background:transparent}
.social-bar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(14px);z-index:6;opacity:0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:92vw}
.social-wrap.live .social-bar{opacity:1;transform:translateX(-50%);transition:opacity 1s var(--sg-e1) .6s,transform 1.1s var(--sg-e1) .6s}
.sg-filter{display:flex;gap:4px;flex-wrap:wrap;justify-content:center;padding:5px;border:1px solid rgba(140,180,240,.2);border-radius:16px;background:rgba(6,12,24,.82)}
.sg-filter button{background:transparent;border:1px solid transparent;color:#aac0e0;font:inherit;font-size:12px;padding:7px 13px;border-radius:11px;cursor:pointer;
  transition:color .35s var(--sg-e3),background .35s var(--sg-e3),border-color .35s var(--sg-e3),transform .35s var(--sg-e3)}
.sg-filter button:hover{color:#fff;background:rgba(140,180,240,.12);transform:translateY(-1px)}
.sg-filter button[aria-pressed="true"]{color:#fff;background:rgba(80,130,255,.3);border-color:rgba(150,195,255,.46);box-shadow:inset 0 0 18px rgba(110,160,255,.14)}
.sg-filter button:focus-visible,.sg-card .more:focus-visible{outline:2px solid rgba(200,225,255,.7);outline-offset:2px}
.sg-time{display:flex;align-items:center;gap:10px;font-size:11.5px;letter-spacing:.06em;color:#9bb3d4;background:rgba(6,12,24,.82);border:1px solid rgba(140,180,240,.2);border-radius:16px;padding:8px 16px}
.sg-time input{-webkit-appearance:none;appearance:none;width:140px;height:20px;background:transparent;cursor:pointer;--p:0%}
.sg-time input::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:linear-gradient(90deg,#8fc0ff var(--p),rgba(140,180,240,.24) var(--p))}
.sg-time input::-moz-range-track{height:3px;border-radius:3px;background:rgba(140,180,240,.24)}
.sg-time input::-moz-range-progress{height:3px;border-radius:3px;background:#8fc0ff}
.sg-time input::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;margin-top:-6px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 0 4px rgba(120,170,255,.2),0 0 18px rgba(130,180,255,.8);transition:transform .35s var(--sg-e3)}
.sg-time input:hover::-webkit-slider-thumb{transform:scale(1.2)}
.sg-time input::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 18px rgba(130,180,255,.8)}
.sg-time b{color:#e4efff;font-weight:600;min-width:46px;text-align:right;font-variant-numeric:tabular-nums}
.sg-card{position:fixed;left:0;top:0;width:292px;max-width:calc(100vw - 32px);z-index:7;overflow:hidden;
  background:linear-gradient(160deg,rgba(18,28,50,.98),rgba(8,14,28,.985) 58%,rgba(6,10,22,.99));
  border:1px solid rgba(140,180,245,.3);border-radius:18px;box-shadow:0 30px 90px -40px #000,inset 0 1px 0 rgba(220,236,255,.08);
  font-size:12.5px;line-height:1.65;color:#d0def0;pointer-events:none;opacity:0;transform:translate3d(-9999px,-9999px,0);
  transition:opacity .3s var(--sg-e3);will-change:transform,opacity;contain:layout paint}
.sg-card.on{opacity:1;pointer-events:auto}
.sg-card .sgb{padding:16px 18px 15px;transform:translate3d(0,12px,0) scale(.985);transition:transform .5s var(--sg-e1)}
.sg-card.on .sgb{transform:none}
.sg-card h4{margin:0;font-size:16px;color:#f5f9ff;font-weight:600;letter-spacing:-.01em}
.sg-card .band{display:inline-block;margin-top:6px;padding:2px 9px;border-radius:99px;font-size:10.5px;letter-spacing:.12em;color:#d6e8ff;border:1px solid rgba(150,195,255,.34);background:rgba(90,140,255,.16)}
.sg-card .uid{margin:8px 0 12px;font-size:11px;color:#7d95b8;letter-spacing:.1em;font-variant-numeric:tabular-nums}
.sg-card .meter{margin:8px 0}
.sg-card .meter div{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.1em;color:#9bb0cc}
.sg-card .meter b{color:#eef5ff;font-weight:600;font-variant-numeric:tabular-nums}
.sg-card .meter i{display:block;height:3px;margin-top:5px;border-radius:3px;background:rgba(140,180,240,.16);overflow:hidden}
.sg-card .meter i::after{content:'';display:block;height:100%;width:var(--v);border-radius:3px;transform-origin:left;background:linear-gradient(90deg,#4f87ff,#8fc7ff 70%,#d6ecff);animation:sgFill .9s var(--sg-e1) both}
.sg-card .meter.love i::after{background:linear-gradient(90deg,#ffb27a,#ffd6a8 70%,#fff0dc)}
@keyframes sgFill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.sg-card .kv{display:flex;justify-content:space-between;gap:10px;margin-top:8px;color:#9bb0cc;font-size:12px}
.sg-card .kv b{color:#e4eefc;font-weight:600;text-align:right}
.sg-card .imp{margin-top:8px;padding-top:8px;border-top:1px solid rgba(140,180,245,.18);color:#b4c7de;font-size:12px;max-height:0;overflow:hidden;transition:max-height .45s var(--sg-e1)}
.sg-card .imp.open{max-height:190px}
.sg-card .more{margin-top:10px;background:none;border:0;color:#9cc6ff;font:inherit;font-size:11.5px;cursor:pointer;padding:0;letter-spacing:.04em}
.sg-card .warn{margin-top:10px;font-size:11.5px;color:#ffc486}
.sg-hint{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);margin:0;z-index:5;font-size:10.5px;color:rgba(160,186,220,.58);letter-spacing:.06em;text-align:center;pointer-events:none}
@media (max-width:900px){.sg-legend{display:none}}
@media (max-width:640px){
  body.social-mode nav.hud.tr{top:12px;bottom:auto;left:12px;right:auto}
  .sg-title{top:62px}.social-bar{bottom:12px;max-width:calc(100vw - 24px);gap:8px}
  .sg-filter{max-height:132px;overflow:auto;scrollbar-width:none}.sg-filter::-webkit-scrollbar{display:none}
  .sg-time{white-space:nowrap}.sg-hint{display:none}.sg-time input{width:84px}
}
#sky{transition:transform 1.4s var(--sg-e1),filter 1.1s var(--sg-e1),opacity .9s var(--sg-e1)}
body.social-mode #sky{transform:scale(.8);filter:blur(14px) brightness(.45);opacity:.4;pointer-events:none}
body.social-mode .hud.tl,body.social-mode .hud.tw,body.social-mode .hud.bl,body.social-mode #detail{opacity:0;pointer-events:none;transition:opacity .6s var(--sg-e2)}
@media (prefers-reduced-motion:reduce){
  .social-wrap,.social-wrap.live,.social-wrap.leaving,.sg-card,.sg-card .sgb,#sky,.sg-title,.social-bar,.sg-legend{transition-duration:.01ms!important}
  .sg-card .meter i::after{animation:none}
}
`;

export const socialGraphScript = String.raw`
(function socialGraphView(){
  var wrap=document.getElementById('socialWrap');
  if(!wrap) return;
  var cv=document.getElementById('socialCanvas'), ctx=cv.getContext('2d');
  var card=document.getElementById('sgCard'), filterBox=document.getElementById('sgFilter');
  var timeSlider=document.getElementById('sgTime'), timeVal=document.getElementById('sgTimeVal');
  var token=new URLSearchParams(location.search).get('token')||'';
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FONT='"Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif';

  var data=null, loaded=false, nodes=[], owner=null;
  var hoverUid=null, pinnedUid=null, activeGroup='all', dayOffset=0, dayShown=0;
  var W=0,H=0,DPR=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  var running=false, rafId=0, lastAt=performance.now(), hideTimer=0;

  // ── 相机：全部「目标 + 临界阻尼」，拖动只改目标；聚焦只平移与推近，不转 yaw ──
  var BASE_DIST=3.2, BASE_PITCH=.82, FOC=1.5, REF=1;
  var cam={yaw:-.4,pitch:BASE_PITCH,dist:BASE_DIST,fx:0,fy:0,fz:0, tyaw:-.4,tpitch:BASE_PITCH,tdist:BASE_DIST,tfx:0,tfy:0,tfz:0,
           vyaw:0,vpitch:0,vdist:0,vfx:0,vfy:0,vfz:0, dolly:0};
  var autoYaw=!reduced, dragging=false, lx=0, ly=0, moved=0, idleAt=0;
  function spring(k,vk,tk,om,dt){ var x=cam[k]-cam[tk], e=Math.exp(-om*dt), tmp=(cam[vk]+om*x)*dt; cam[k]=cam[tk]+(x+tmp)*e; cam[vk]=(cam[vk]-om*tmp)*e; }
  function stepCam(dt){
    var om=reduced?40:3.4;
    spring('yaw','vyaw','tyaw',om*1.15,dt); spring('pitch','vpitch','tpitch',om,dt); spring('dist','vdist','tdist',om,dt);
    spring('fx','vfx','tfx',om,dt); spring('fy','vfy','tfy',om,dt); spring('fz','vfz','tfz',om,dt);
    if(cam.dolly>.0004) cam.dolly*=Math.exp(-2.4*dt); else cam.dolly=0;
  }

  // ── 3D：世界坐标 → 屏幕（透视）。盘面是 XZ 平面，Y 向上 ──
  var cy_,sy_,cp_,sp_,SCR=1;
  function updateTrig(){ cy_=Math.cos(cam.yaw); sy_=Math.sin(cam.yaw); cp_=Math.cos(cam.pitch); sp_=Math.sin(cam.pitch); }
  function proj(x,y,z,out){
    x-=cam.fx; y-=cam.fy; z-=cam.fz;
    var xr=x*cy_-z*sy_, zr=x*sy_+z*cy_;
    var yr=y*cp_-zr*sp_; zr=y*sp_+zr*cp_;
    var dz=cam.dist*(1-cam.dolly*.1)+zr; if(dz<.25) dz=.25;
    var s=FOC/dz*SCR;
    out.x=W/2+xr*s; out.y=H*.48-yr*s; out.s=s; out.z=zr; return out;
  }
  var P0={x:0,y:0,s:1,z:0}, P1={x:0,y:0,s:1,z:0};
  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function resize(){
    W=window.innerWidth; H=window.innerHeight;
    cv.width=Math.floor(W*DPR); cv.height=Math.floor(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0);
    SCR=Math.min(W*.6,H*.92)*.84; REF=FOC/BASE_DIST*SCR; backDirty=true; layout();
  }
  window.addEventListener('resize',resize);

  // ── 布局：群 → 扇区；好感 → 半径；高度 = 喜爱抬升 + 低频漂浮 ──
  function hashf(s){ var h=2166136261; s=String(s); for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return ((h>>>0)%10007)/10007; }
  function layout(){
    var byGroup={}; nodes.forEach(function(n){ (byGroup[n.group||'']=byGroup[n.group||'']||[]).push(n); });
    var gids=Object.keys(byGroup).sort(function(a,b){ return byGroup[b].length-byGroup[a].length; });
    var ng=Math.max(1,gids.length);
    gids.forEach(function(g,gi){
      var base=-Math.PI/2+gi*(Math.PI*2/ng), list=byGroup[g];
      list.sort(function(a,b){ return b.score-a.score; });
      var span=Math.min(Math.PI*2/ng*.82,.34*Math.max(1,list.length));
      list.forEach(function(n,i){
        var t=list.length===1?0:(i/(list.length-1)-.5), a=base+t*span;
        var r=.26+n.distance*.72+(i%2?.035:-.02);          // 相邻两人错开半径，标签不叠
        n.wx=Math.cos(a)*r; n.wz=Math.sin(a)*r;
        n.wy0=((Number(n.love)||0)/100)*.14-.02+(hashf(n.uid)-.5)*.08;
        n.ph=hashf(n.uid+'p')*6.283; n.fr=.25+hashf(n.uid+'f')*.4; n.vis=visible(n);
      });
    });
    if(owner){ owner.wx=0; owner.wz=-.12; owner.wy0=.1; owner.vis=true; owner.ph=0; owner.fr=.3; }
    nodes.forEach(function(n){ if(n.vis===undefined) n.vis=visible(n); });
  }
  function visible(n){ return activeGroup==='all'||(n.groups||[]).indexOf(activeGroup)>=0; }
  function retentionAt(n,nowMs){ var last=Number(n.lastAt)||0; if(!last) return 0; return Math.exp(-Math.max(0,(nowMs-last)/86400000)/Math.max(.05,Number(n.stability)||1)); }

  // ── 预渲染：背景 + 光晕精灵（逐帧只 drawImage）──
  var back=document.createElement('canvas'), bctx=back.getContext('2d'), backDirty=true, dust=[];
  function buildBack(){
    back.width=Math.max(2,Math.floor(W*DPR*.5)); back.height=Math.max(2,Math.floor(H*DPR*.5));
    bctx.setTransform(DPR*.5,0,0,DPR*.5,0,0);
    var g=bctx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#04070f'); g.addColorStop(.55,'#050b1a'); g.addColorStop(1,'#02040a'); bctx.fillStyle=g; bctx.fillRect(0,0,W,H);
    [[.3,.36,.55,'60,130,255',.18],[.72,.5,.5,'110,200,255',.12],[.5,.8,.6,'84,100,255',.16]].forEach(function(b){
      var rg=bctx.createRadialGradient(W*b[0],H*b[1],0,W*b[0],H*b[1],Math.max(W,H)*b[2]); rg.addColorStop(0,'rgba('+b[3]+','+b[4]+')'); rg.addColorStop(1,'rgba('+b[3]+',0)'); bctx.fillStyle=rg; bctx.fillRect(0,0,W,H); });
    dust=[]; var n=Math.min(130,Math.floor(W*H/9500));
    for(var i=0;i<n;i++) dust.push({x:hashf('dx'+i),y:hashf('dy'+i),r:.5+hashf('dr'+i)*1.1,p:hashf('dp'+i)*6.283,z:.25+hashf('dz'+i)*.75});
    backDirty=false;
  }
  function sprite(stops){ var s=96,c=document.createElement('canvas'); c.width=c.height=s; var g=c.getContext('2d'), rg=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
    stops.forEach(function(p){ rg.addColorStop(p[0],p[1]); }); g.fillStyle=rg; g.fillRect(0,0,s,s); return c; }
  var SPR_WARM=sprite([[0,'rgba(255,232,196,.95)'],[.22,'rgba(255,206,152,.5)'],[.6,'rgba(255,190,140,.13)'],[1,'rgba(255,190,140,0)']]);
  var SPR_COOL=sprite([[0,'rgba(200,226,255,.95)'],[.22,'rgba(140,190,255,.48)'],[.6,'rgba(110,160,240,.13)'],[1,'rgba(110,160,240,0)']]);
  var SPR_CORE=sprite([[0,'rgba(220,240,255,1)'],[.14,'rgba(150,200,255,.62)'],[.45,'rgba(80,130,255,.2)'],[1,'rgba(60,110,255,0)']]);

  // ── 标签：贪心避让；聚焦 / 主人 / 悬停优先，其余按好感排序 ──
  function labelText(n){ return n.name||n.masked||'?'; }
  function drawLabels(list,focusUid,nowMs){
    ctx.font='500 12.5px '+FONT; ctx.textBaseline='middle'; ctx.lineJoin='round';
    var placed=[], items=list.slice().sort(function(a,b){
      function pr(n){ return (n.uid===focusUid?1e4:0)+(owner&&n===owner?9e3:0)+(Number(n.score)||0); } return pr(b)-pr(a); });
    items.forEach(function(n){
      var text=labelText(n), isOwner=owner&&n===owner, isFocus=n.uid===focusUid;
      if(isOwner) text='老大 · '+text;
      var w=ctx.measureText(text).width, h=15, off=(n._br||8)+9;
      var tries=[[n.sx+off,n.sy-h/2],[n.sx-off-w,n.sy-h/2],[n.sx-w/2,n.sy+(n._br||8)+7],[n.sx-w/2,n.sy-(n._br||8)-h-6]];
      var spot=null;
      for(var i=0;i<tries.length;i++){
        var x=tries[i][0], y=tries[i][1];
        if(x<8||x+w>W-8||y<8||y+h>H-8) continue;
        var clash=false; for(var j=0;j<placed.length;j++){ var p=placed[j]; if(x<p.x+p.w+4&&x+w>p.x-4&&y<p.y+p.h+2&&y+h>p.y-2){ clash=true; break; } }
        if(!clash){ spot=[x,y]; break; }
      }
      if(!spot){ if(!isFocus&&!isOwner) return; spot=tries[0]; }
      placed.push({x:spot[0],y:spot[1],w:w,h:h});
      var ret=isOwner?1:retentionAt(n,nowMs), a=clamp(.55+.45*ret,.55,1)*(focusUid&&!isFocus&&!isOwner?.62:1)*(n._depthA||1);
      ctx.lineWidth=3.2; ctx.strokeStyle='rgba(2,5,14,'+(.9*a).toFixed(3)+')'; ctx.strokeText(text,spot[0],spot[1]+h/2+.5);
      ctx.fillStyle=isOwner?'rgba(255,232,196,'+a.toFixed(3)+')':(isFocus?'rgba(255,255,255,1)':'rgba(222,236,255,'+a.toFixed(3)+')');
      ctx.fillText(text,spot[0],spot[1]+h/2+.5);
    });
    ctx.textBaseline='alphabetic';
  }

  function draw(now){
    var t=now/1000, nowMs=Date.now()+dayShown*86400000, focusUid=pinnedUid||hoverUid;
    if(backDirty) buildBack();
    ctx.setTransform(DPR,0,0,DPR,0,0); ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
    ctx.drawImage(back,0,0,W,H);
    for(var i=0;i<dust.length;i++){
      var d=dust[i], dx=((d.x+cam.yaw*.05*d.z+(reduced?0:t*.004*d.z))%1+1)%1, dy=((d.y+(reduced?0:Math.sin(t*.05+d.p)*.003))%1+1)%1;
      ctx.globalAlpha=(.14+.36*(.5+.5*Math.sin(t*.7+d.p)))*d.z; ctx.fillStyle='#c4dcff'; ctx.fillRect(dx*W,dy*H,d.r*d.z*1.6,d.r*d.z*1.6);
    }
    ctx.globalAlpha=1; updateTrig();

    // 盘面：同心轨道（比上一版更亮）+ 旋转刻度 + 流动光点
    var rot=reduced?0:t*.05;
    for(var ring=1;ring<=5;ring++){
      var rr=ring/5; ctx.beginPath();
      for(var k=0;k<=96;k++){ var a=k/96*6.2832; proj(Math.cos(a)*rr,0,Math.sin(a)*rr,P0); if(k) ctx.lineTo(P0.x,P0.y); else ctx.moveTo(P0.x,P0.y); }
      ctx.strokeStyle='rgba(130,180,250,'+(.34-ring*.045).toFixed(3)+')'; ctx.lineWidth=ring===5?1.4:1; ctx.stroke();
    }
    ctx.strokeStyle='rgba(170,210,255,.42)'; ctx.lineWidth=1; ctx.beginPath();
    for(var m=0;m<96;m++){ var am=rot+m/96*6.2832, r0=1.04, r1=r0+(m%8===0?.05:.024);
      proj(Math.cos(am)*r0,0,Math.sin(am)*r0,P0); proj(Math.cos(am)*r1,0,Math.sin(am)*r1,P1); ctx.moveTo(P0.x,P0.y); ctx.lineTo(P1.x,P1.y); }
    ctx.stroke();
    if(!reduced){
      ctx.globalCompositeOperation='lighter';
      for(var q=0;q<3;q++){ var qa=t*(.16+q*.05)+q*2.1; proj(Math.cos(qa),0,Math.sin(qa),P0); ctx.globalAlpha=.8; ctx.drawImage(SPR_COOL,P0.x-13,P0.y-13,26,26); }
      ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
    }

    // 节点屏幕位置（含漂浮）与相对尺度 k（相对基准距离，不再用绝对像素/单位）
    var all=[]; nodes.forEach(function(n){ if(n.vis) all.push(n); }); if(owner) all.push(owner);
    all.forEach(function(n){
      n.cwy=n.wy0+(reduced?0:Math.sin(t*n.fr+n.ph)*.012);
      proj(n.wx,n.cwy,n.wz,P0); n.sx=P0.x; n.sy=P0.y; n.sz=P0.z; n.k=clamp(P0.s/REF,.6,2.4);
      n._depthA=clamp(1.08-n.sz*.5,.62,1);
    });
    var byUid={}; all.forEach(function(n){ byUid[n.uid]=n; });
    var cx=proj(0,0,0,{x:0,y:0,s:1,z:0}), kc=clamp(cx.s/REF,.7,2.2);

    function arcLine(a,b,bow,lift){ var mx=(a.wx+b.wx)/2, mz=(a.wz+b.wz)/2, ml=Math.hypot(mx,mz)||1, my=(a.cwy+b.cwy)/2+lift; proj(mx+mx/ml*bow,my,mz+mz/ml*bow,P0); return {x:P0.x,y:P0.y}; }
    if(data&&data.links&&data.links.length){
      data.links.forEach(function(e){
        var a=byUid[e.a], b=byUid[e.b]; if(!a||!b) return;
        var touches=focusUid&&(e.a===focusUid||e.b===focusUid), dim=focusUid&&!touches;
        var s=clamp(Number(e.strength)||0,0,1), withOwner=owner&&(e.a===owner.uid||e.b===owner.uid);
        var c=arcLine(a,b,touches?.22:.16,.05+s*.08), rgb=withOwner?'255,212,160':'150,198,255';
        var alpha=dim?.06:(touches?.78:(withOwner?.22+s*.22:.3+s*.32));
        ctx.save(); ctx.strokeStyle='rgba('+rgb+','+alpha.toFixed(3)+')'; ctx.lineWidth=(touches?1.8+s*1.6:(withOwner?.9+s*1.1:1.1+s*1.5))*clamp(kc,.9,1.3);
        if(touches&&s>.4){ ctx.shadowColor='rgba(170,210,255,.8)'; ctx.shadowBlur=12; }
        ctx.beginPath(); ctx.moveTo(a.sx,a.sy); ctx.quadraticCurveTo(c.x,c.y,b.sx,b.sy); ctx.stroke(); ctx.restore();
        if(!reduced&&!dim){ var u=((t*.16+hashf(e.a+e.b)*3)%1), ix=(1-u)*(1-u)*a.sx+2*(1-u)*u*c.x+u*u*b.sx, iy=(1-u)*(1-u)*a.sy+2*(1-u)*u*c.y+u*u*b.sy;
          ctx.globalCompositeOperation='lighter'; ctx.fillStyle='rgba('+rgb+','+(touches?.95:.6)+')'; ctx.beginPath(); ctx.arc(ix,iy,touches?2.3:1.6,0,6.283); ctx.fill(); ctx.globalCompositeOperation='source-over'; }
      });
    }
    if(data&&data.semantic&&data.semantic.length){
      data.semantic.forEach(function(e){
        var a=byUid[e.a], b=byUid[e.b]; if(!a||!b) return;
        var touches=focusUid&&(e.a===focusUid||e.b===focusUid), dim=focusUid&&!touches;
        var c=arcLine(a,b,.1,.12), color=e.kind==='对立'?'255,150,96':(e.kind==='依赖'?'195,225,255':'255,232,205');
        ctx.save(); ctx.setLineDash(e.kind==='对立'?[4,4]:(e.kind==='依赖'?[2,3]:[]));
        ctx.strokeStyle='rgba('+color+','+(dim?.06:(touches?.82:.42)).toFixed(3)+')'; ctx.lineWidth=touches?2:1.4;
        ctx.beginPath(); ctx.moveTo(a.sx,a.sy); ctx.quadraticCurveTo(c.x,c.y,b.sx,b.sy); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
      });
    }
    // 到中心的连线
    nodes.forEach(function(n){
      if(!n.vis) return;
      var ret=retentionAt(n,nowMs), w=1+(Number(n.loyalty)||0)/100*3, alpha=.12+ret*.3; if(focusUid&&n.uid!==focusUid) alpha*=.4;
      ctx.save(); if(n.cooling) ctx.setLineDash([4,6]);
      ctx.strokeStyle='rgba('+(n.warningLevel>0?'255,156,96':'140,186,242')+','+alpha.toFixed(3)+')'; ctx.lineWidth=w*clamp(kc,.85,1.3);
      ctx.beginPath(); ctx.moveTo(cx.x,cx.y); ctx.lineTo(n.sx,n.sy); ctx.stroke(); ctx.restore();
    });

    // 中心核：尺寸只由 kc 控制（上一版的 bug 在这里）
    var pulse=reduced?1:1+.05*Math.sin(t*1.6), coreR=13*kc*pulse;
    ctx.globalCompositeOperation='lighter'; ctx.drawImage(SPR_CORE,cx.x-coreR*5,cx.y-coreR*5,coreR*10,coreR*10); ctx.globalCompositeOperation='source-over';
    ctx.fillStyle='#f4faff'; ctx.beginPath(); ctx.arc(cx.x,cx.y,coreR*.5,0,6.283); ctx.fill();
    ctx.strokeStyle='rgba(200,228,255,.62)'; ctx.lineWidth=1.1; ctx.beginPath(); ctx.arc(cx.x,cx.y,coreR*1.3,t*.4,t*.4+4.2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx.x,cx.y,coreR*1.7,-t*.3,-t*.3+3.6); ctx.stroke();
    ctx.font='600 13px '+FONT; ctx.textAlign='center'; ctx.lineJoin='round'; ctx.lineWidth=3.4; ctx.strokeStyle='rgba(2,5,14,.9)'; ctx.strokeText('小鲸鱼',cx.x,cx.y+coreR*2.9+4);
    ctx.fillStyle='rgba(232,244,255,.96)'; ctx.fillText('小鲸鱼',cx.x,cx.y+coreR*2.9+4); ctx.textAlign='start';

    // 人物星：从远到近
    all.sort(function(a,b){ return b.sz-a.sz; });
    all.forEach(function(n){
      var isOwner=owner&&n===owner, ret=isOwner?1:retentionAt(n,nowMs), big=n.uid===focusUid;
      var dim=(.5+.5*ret)*n._depthA*(focusUid&&!big&&!isOwner?.6:1);
      var love=clamp((Number(n.love)||0)/100,0,1), warm=love>.02||isOwner;
      var base=(7+(Number(n.size)||4)*1.5)*n.k*(big?1.28:1); n._br=base*.55+2;
      var glowR=base*(2.3+love*1.5);
      ctx.globalCompositeOperation='lighter'; ctx.globalAlpha=clamp(dim*(.55+love*.4),0,1);
      ctx.drawImage(warm?SPR_WARM:SPR_COOL,n.sx-glowR,n.sy-glowR,glowR*2,glowR*2); ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
      proj(n.wx,0,n.wz,P1);                                  // 盘面投影：悬浮感
      ctx.fillStyle='rgba(90,140,230,'+(.2*dim).toFixed(3)+')'; ctx.beginPath(); ctx.ellipse(P1.x,P1.y,base*.62,base*.22,0,0,6.283); ctx.fill();
      ctx.strokeStyle='rgba(140,190,250,'+(.16*dim).toFixed(3)+')'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(n.sx,n.sy); ctx.lineTo(P1.x,P1.y); ctx.stroke();
      if(isOwner){
        var s2=base*.9; ctx.save(); ctx.translate(n.sx,n.sy); ctx.rotate(Math.PI/4);
        ctx.fillStyle='rgba(255,238,200,.98)'; ctx.fillRect(-s2/2,-s2/2,s2,s2); ctx.strokeStyle='rgba(255,214,156,.78)'; ctx.lineWidth=1.3; ctx.strokeRect(-s2/2-4,-s2/2-4,s2+8,s2+8); ctx.restore();
        n._br=s2*.9+4; return;
      }
      ctx.globalAlpha=clamp(dim+.1,0,1); ctx.fillStyle=n.band==='special'?'#f6faff':(warm?'#ffe9cc':'#d8e8ff'); ctx.beginPath(); ctx.arc(n.sx,n.sy,base*.42,0,6.283); ctx.fill(); ctx.globalAlpha=1;
      ctx.strokeStyle='rgba(255,255,255,'+(.5*dim).toFixed(3)+')'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(n.sx,n.sy,base*.42,0,6.283); ctx.stroke();
      if(n.warningLevel>0){ ctx.strokeStyle=n.stroke||'#ffd166'; ctx.lineWidth=1.8; ctx.beginPath(); ctx.arc(n.sx,n.sy,base*.42+3.4,0,6.283); ctx.stroke(); n._br+=4; }
      if(big){
        ctx.save(); ctx.translate(n.sx,n.sy); var rb=base*.42+11, ra=reduced?0:t*.9;
        ctx.strokeStyle='rgba(238,246,255,.95)'; ctx.lineWidth=1.4;
        ctx.beginPath(); ctx.arc(0,0,rb,ra,ra+2.1); ctx.stroke(); ctx.beginPath(); ctx.arc(0,0,rb,ra+3.14,ra+5.24); ctx.stroke();
        ctx.strokeStyle='rgba(170,208,252,.55)'; ctx.beginPath(); ctx.arc(0,0,rb+6,-ra*.6,-ra*.6+1.6); ctx.stroke();
        for(var kk=0;kk<4;kk++){ var ka=kk*1.5708+.785; ctx.beginPath(); ctx.moveTo(Math.cos(ka)*(rb+9),Math.sin(ka)*(rb+9)); ctx.lineTo(Math.cos(ka)*(rb+14),Math.sin(ka)*(rb+14)); ctx.stroke(); }
        ctx.restore(); n._br=rb+10;
      }
    });
    drawLabels(all,focusUid,nowMs);
  }

  function hoverNode(){ for(var i=0;i<nodes.length;i++){ if(nodes[i].uid===hoverUid) return nodes[i]; } return null; }
  function hitTest(x,y){
    var best=null, bd=0;
    for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!n.vis||n.sx==null) continue; var r=Math.max(20,(n._br||8)+8), dx=n.sx-x, dy=n.sy-y, d=dx*dx+dy*dy;
      if(d<r*r&&(!best||d<bd)){ bd=d; best=n; } }
    return best;
  }
  function partnersOf(uid){ if(!data||!data.links||!data.links.length) return []; var by={}; nodes.forEach(function(n){ by[n.uid]=n; }); if(owner) by[owner.uid]=owner;
    var out=[]; data.links.forEach(function(e){ if(e.a!==uid&&e.b!==uid) return; var o=by[e.a===uid?e.b:e.a]; if(o) out.push({name:o.name||o.masked,weight:e.weight}); });
    out.sort(function(a,b){ return b.weight-a.weight; }); return out.slice(0,2); }
  function semanticOf(uid){ if(!data||!data.semantic||!data.semantic.length) return []; var map={}; nodes.forEach(function(n){ map[n.uid]=n; }); if(owner) map[owner.uid]=owner;
    var out=[]; data.semantic.forEach(function(e){ if(e.a!==uid&&e.b!==uid) return; var o=map[e.a===uid?e.b:e.a]; out.push({name:o?(o.name||o.masked):'?',kind:e.kind,note:e.note||''}); }); return out.slice(0,2); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  // ── 卡片：transform 跟随；位置焊在星上，仅换边时缓动 ──
  var cardOff=0,cardOffV=0,cardSide=1,cardTarget=null;
  function showCard(n,full){
    if(!n){ card.classList.remove('on'); card.setAttribute('aria-hidden','true'); return; }
    var imp=n.impression||'', ps=partnersOf(n.uid), rels=semanticOf(n.uid);
    var score=clamp(Number(n.score)||0,0,100), love=clamp(Number(n.love)||0,0,100), loy=clamp(Number(n.loyalty)||0,0,100);
    card.innerHTML='<div class="sgb"><h4>'+esc(n.name||'未命名')+'</h4><span class="band">'+esc(n.bandLabel||'')+'</span>'+
      '<div class="uid">'+esc(full?n.uid:n.masked)+'</div>'+
      '<div class="meter"><div><span>好感</span><b>'+score+'</b></div><i style="--v:'+score+'%"></i></div>'+
      '<div class="meter love"><div><span>喜爱</span><b>'+love+'</b></div><i style="--v:'+love+'%"></i></div>'+
      '<div class="meter"><div><span>忠诚</span><b>'+loy+'</b></div><i style="--v:'+loy+'%"></i></div>'+
      (ps.length?'<div class="kv"><span>常聊</span><b>'+ps.map(function(p){ return esc(p.name)+' · '+p.weight; }).join(' / ')+'</b></div>':'')+
      (rels.length?'<div class="kv"><span>她记的</span><b>'+rels.map(function(r){ return esc(r.name)+' · '+esc(r.kind)+(r.note?'（'+esc(r.note)+'）':''); }).join(' / ')+'</b></div>':'')+
      (n.warningLevel>0?'<div class="warn">纪律 '+n.warningLevel+' 级'+(n.cooling?' · 冷处理中':'')+'</div>':'')+
      (imp?'<button class="more" type="button" id="sgMore">展开印象</button><div class="imp" id="sgImp">'+esc(imp)+'</div>':'')+'</div>';
    card.classList.add('on'); card.setAttribute('aria-hidden','false');
    var m=card.querySelector('#sgMore'), box=card.querySelector('#sgImp');
    if(m&&box) m.addEventListener('click',function(){ box.classList.toggle('open'); m.textContent=box.classList.contains('open')?'收起印象':'展开印象'; });
    placeCard(n,true);
  }
  function placeCard(n,snap){
    var w=card.offsetWidth||292, h=card.offsetHeight||210, pad=18, gap=(n._br||12)+26;
    var fitsR=n.sx+gap+w<=window.innerWidth-pad, fitsL=n.sx-gap-w>=pad;
    if(cardSide>0&&!fitsR&&fitsL) cardSide=-1; else if(cardSide<0&&!fitsL&&fitsR) cardSide=1;
    cardTarget=cardSide>0?gap:-(gap+w); if(snap){ cardOff=cardTarget; cardOffV=0; }
    var x=clamp(n.sx+cardOff,pad,window.innerWidth-w-pad), y=clamp(n.sy-h/2,pad,window.innerHeight-h-pad);
    card.style.transform='translate3d('+x.toFixed(1)+'px,'+y.toFixed(1)+'px,0)';
  }
  function stepCard(dt){ if(cardTarget==null) return; var w=15, e=Math.exp(-w*dt), d=cardOff-cardTarget, c=cardOffV+w*d; cardOff=cardTarget+(d+c*dt)*e; cardOffV=(c-w*(d+c*dt))*e; }

  function focusOn(n){
    pinnedUid=n.uid; autoYaw=false; idleAt=performance.now()+7000;
    cam.tfx=n.wx*.8; cam.tfy=(n.cwy||n.wy0)*.8; cam.tfz=n.wz*.8;     // 只平移 + 推近；不转 yaw，所以不会拧一下
    cam.tdist=BASE_DIST*.6; cam.tpitch=Math.min(cam.tpitch,.7); cam.dolly=Math.max(cam.dolly,.55);
    showCard(n,true);
  }
  function release(){
    pinnedUid=null; cam.tfx=0; cam.tfy=0; cam.tfz=0; cam.tdist=BASE_DIST; cam.tpitch=BASE_PITCH; showCard(null); idleAt=performance.now()+3000;
  }

  function frame(now){
    var dt=Math.min(.05,Math.max(.001,(now-lastAt)/1000)); lastAt=now;
    if(autoYaw&&!dragging&&!pinnedUid&&!reduced) cam.tyaw+=.035*dt;
    else if(!autoYaw&&!reduced&&!pinnedUid&&!dragging&&idleAt&&now>idleAt){ autoYaw=true; idleAt=0; }
    dayShown=Math.abs(dayOffset-dayShown)>.01?dayShown+(dayOffset-dayShown)*(1-Math.exp(-5*dt)):dayOffset;
    stepCam(dt); draw(now); stepCard(dt);
    var n=hoverNode()||nodes.filter(function(x){return x.uid===pinnedUid;})[0];
    if(n&&card.classList.contains('on')) placeCard(n,false);
    if(running) rafId=requestAnimationFrame(frame);
  }
  function start(){ if(running) return; running=true; lastAt=performance.now(); rafId=requestAnimationFrame(frame); }
  function stop(){ running=false; if(rafId) cancelAnimationFrame(rafId); rafId=0; }
  document.addEventListener('visibilitychange',function(){ if(document.hidden) stop(); else if(!wrap.hidden) start(); });

  function load(){
    return fetch('/api/console/social-graph?token='+encodeURIComponent(token),{cache:'no-store'}).then(function(r){ return r.json(); })
      .then(function(j){ if(!j||!j.ok) throw new Error('接口返回异常');
        data=j.graph; nodes=data.nodes||[]; owner=data.owner||null;
        nodes.forEach(function(n){ n.distance=Number(n.distance)||.8; n.size=Number(n.size)||4; });
        buildFilter(); layout(); loaded=true; start(); })
      .catch(function(e){ var h=document.getElementById('sgHint'); if(h) h.textContent='关系图加载失败：'+((e&&e.message)||'未知错误'); });
  }
  function buildFilter(){
    if(!filterBox) return; var gs=(data&&data.groups)||[];
    var html='<button type="button" data-g="all" aria-pressed="'+(activeGroup==='all')+'">全部 '+nodes.length+'</button>';
    gs.slice(0,8).forEach(function(g){ html+='<button type="button" data-g="'+esc(g.id)+'" aria-pressed="'+(activeGroup===String(g.id))+'">群 '+esc(g.label)+' · '+g.members+'</button>'; });
    filterBox.innerHTML=html;
    [].forEach.call(filterBox.querySelectorAll('button'),function(b){ b.addEventListener('click',function(){
      activeGroup=b.getAttribute('data-g'); [].forEach.call(filterBox.querySelectorAll('button'),function(x){ x.setAttribute('aria-pressed',String(x===b)); });
      if(pinnedUid) release(); layout(); }); });
  }

  cv.addEventListener('pointerdown',function(e){ dragging=true; moved=0; lx=e.clientX; ly=e.clientY; autoYaw=false; cv.classList.add('drag'); try{cv.setPointerCapture(e.pointerId);}catch(_){} });
  cv.addEventListener('pointermove',function(e){
    if(dragging){ var dx=e.clientX-lx, dy=e.clientY-ly; moved+=Math.abs(dx)+Math.abs(dy); lx=e.clientX; ly=e.clientY;
      cam.tyaw-=dx*.005; cam.tpitch=clamp(cam.tpitch+dy*.0035,.25,1.3); return; }
    var n=hitTest(e.clientX,e.clientY);
    if(n!==null||hoverUid!==null){ hoverUid=n?n.uid:null; cv.style.cursor=n?'pointer':'grab';
      if(n&&!pinnedUid) showCard(n,false); else if(!n&&!pinnedUid) showCard(null); }
  });
  function endDrag(e){ if(!dragging) return; dragging=false; cv.classList.remove('drag'); idleAt=performance.now()+5000; try{cv.releasePointerCapture(e.pointerId);}catch(_){} }
  cv.addEventListener('pointerup',function(e){ var wasDrag=moved>5; endDrag(e); if(wasDrag) return; var n=hitTest(e.clientX,e.clientY); if(!n){ if(pinnedUid) release(); return; } focusOn(n); });
  cv.addEventListener('pointercancel',endDrag);
  cv.addEventListener('pointerleave',function(){ hoverUid=null; if(!pinnedUid) showCard(null); });
  cv.addEventListener('wheel',function(e){ e.preventDefault(); autoYaw=false; idleAt=performance.now()+5000;
    BASE_DIST=clamp(BASE_DIST*(e.deltaY>0?1.07:.93),2.2,5.2); REF=FOC/BASE_DIST*SCR; if(!pinnedUid) cam.tdist=BASE_DIST; },{passive:false});
  window.addEventListener('keydown',function(e){
    if(wrap.hidden||!wrap.classList.contains('live')) return;
    if(e.key==='Escape'){ if(pinnedUid){ release(); e.stopPropagation(); } return; }
    if(e.key==='ArrowRight'||e.key==='ArrowLeft'){ var list=nodes.filter(function(n){return n.vis;}); if(!list.length) return;
      var idx=list.findIndex(function(n){return n.uid===pinnedUid;}); idx=(idx+(e.key==='ArrowRight'?1:-1)+list.length)%list.length; focusOn(list[idx]); e.preventDefault(); }
  });
  if(timeSlider) timeSlider.addEventListener('input',function(){
    dayOffset=Number(timeSlider.value)||0; timeVal.textContent=dayOffset===0?'今天':(dayOffset+' 天后'); timeSlider.style.setProperty('--p',(dayOffset/120*100).toFixed(1)+'%'); });

  // ── 视图切换：星图 ⇄ 社交圈（前后推拉）。相机初值与 CSS 入场衔接，避免两段动画打架 ──
  window.__sgShow=function(){
    clearTimeout(hideTimer); wrap.hidden=false; wrap.classList.remove('leaving','live');
    cam.tdist=BASE_DIST; cam.dist=BASE_DIST*.72; cam.vdist=0; cam.tyaw=cam.yaw; cam.dolly=.6; cam.tpitch=BASE_PITCH; cam.pitch=BASE_PITCH-.14;
    backDirty=true; if(!loaded) load(); else { layout(); start(); }
    void wrap.offsetWidth; requestAnimationFrame(function(){ wrap.classList.add('live'); });
  };
  window.__sgHide=function(){
    if(wrap.hidden) return; wrap.classList.remove('live'); wrap.classList.add('leaving'); showCard(null); pinnedUid=null;
    cam.tfx=0; cam.tfy=0; cam.tfz=0; cam.tdist=BASE_DIST*.8;
    hideTimer=setTimeout(function(){ wrap.hidden=true; wrap.classList.remove('leaving'); stop(); },reduced?10:1000);
  };
  var bStar=document.getElementById('viewStar'), bSocial=document.getElementById('viewSocial');
  function setView(which){ var social=which==='social'; document.body.classList.toggle('social-mode',social);
    if(bStar){ bStar.setAttribute('aria-pressed',String(!social)); bStar.classList.toggle('on',!social); }
    if(bSocial){ bSocial.setAttribute('aria-pressed',String(social)); bSocial.classList.toggle('on',social); }
    if(social) window.__sgShow(); else window.__sgHide(); }
  if(bStar) bStar.addEventListener('click',function(){ setView('star'); });
  if(bSocial) bSocial.addEventListener('click',function(){ setView('social'); });

  resize();
})();
`;
