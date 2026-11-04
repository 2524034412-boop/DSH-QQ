// 伪 Live2D 绑定引擎（/avatar 预览页 + 面板挂件共用）
// 不依赖任何外部库：canvas2d 画分层部件，参数驱动位移/旋转/缩放/透明度。
// 部件缺失时自动退回"占位人形"，方便在美术素材到位前先验收动作节奏。

export function renderAvatarPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>她的形象 · 绑定预览</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:radial-gradient(circle at 50% 38%,#141a26,#080a0f 72%);
    font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#e6ecf6;overflow:hidden}
  #stage{position:fixed;inset:0;display:grid;place-items:center}
  canvas{display:block;max-height:100vh;max-width:100vw}
  .hud{position:fixed;left:20px;top:18px;font-size:12px;color:#7c90ab;letter-spacing:.3px;pointer-events:none}
  .hud b{color:#cfe0ff;font-weight:600}
  .hud .k{color:#5f708c}
  .bar{position:fixed;left:20px;bottom:18px;display:flex;gap:8px;flex-wrap:wrap}
  .bar button{background:rgba(255,255,255,.05);border:1px solid rgba(140,170,220,.28);color:#c7d6ea;
    border-radius:10px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;transition:.2s}
  .bar button:hover{background:rgba(120,170,255,.16);border-color:rgba(140,180,255,.5);color:#eaf2ff}
  .bar button.on{background:rgba(90,130,220,.28);border-color:rgba(150,190,255,.55);color:#fff}
  .note{position:fixed;right:20px;bottom:18px;font-size:11.5px;color:#5f708c;max-width:320px;text-align:right}
</style></head><body>
<div id="stage"><canvas id="av"></canvas></div>
<div class="hud">
  <div><b>绑定预览</b> · <span id="src">占位人形</span></div>
  <div><span class="k">角度</span> <span id="pAngle">0</span>° ·
       <span class="k">睁眼</span> <span id="pEye">1.00</span> ·
       <span class="k">口型</span> <span id="pMouth">0.00</span> ·
       <span class="k">摆动</span> <span id="pTail">0.00</span></div>
</div>
<div class="bar">
  <button id="bIdle" class="on">待机</button>
  <button id="bTalk">说话</button>
  <button id="bHappy">开心</button>
  <button id="bShy">害羞</button>
  <button id="bAngry">生气</button>
  <button id="bBlink">眨一下</button>
</div>
<div class="note">鼠标在画面里移动，她会转头看你</div>
<script>
(function(){
  var cv=document.getElementById('av'), ctx=cv.getContext('2d');
  var stage=document.getElementById('stage');
  var DPR=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  var W=900, H=1200;           // 逻辑坐标（跟素材画布同比例 2:3）
  var parts=[], manifest=null, loaded=false;

  // ── 参数（全部 0~1 或角度）────────────────────────────────────────
  var P={ angleX:0, angleY:0, eyeOpen:1, mouthOpen:0, mouthForm:0,
          blush:0, bodyLean:0, breath:0, tailSway:0, browRaise:0 };
  var target={ angleX:0, angleY:0 };
  var talk=false, expr='idle';
  var blinkAt=0, nextBlink=performance.now()+2600;

  function lerp(a,b,k){ return a+(b-a)*k; }

  // ── 素材加载 ────────────────────────────────────────────────────
  function loadManifest(){
    fetch('/media/avatar/manifest.json?t='+Date.now(),{cache:'no-store'})
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(m){
        if(!m||!m.parts||!m.parts.length) return;      // 没有素材 → 占位
        manifest=m;
        if(m.canvas && m.canvas.w>0 && m.canvas.h>0){ W=m.canvas.w; H=m.canvas.h; }
        var pending=m.parts.length;
        m.parts.forEach(function(p){
          var img=new Image();
          img.onload=function(){ p.img=img; if(--pending===0){ parts=m.parts.slice(); loaded=true; resize(); document.getElementById('src').textContent='素材模式（'+parts.length+' 件）'; } };
          img.onerror=function(){ if(--pending===0) resize(); };
          img.src='/media/avatar/'+p.file+'?t='+Date.now();
        });
      })
      .catch(function(){});
  }

  function resize(){
    var maxH=window.innerHeight*0.96, maxW=window.innerWidth*0.96;
    var scale=Math.min(maxH/H, maxW/W);
    cv.width=Math.floor(W*scale*DPR); cv.height=Math.floor(H*scale*DPR);
    cv.style.width=(W*scale)+'px'; cv.style.height=(H*scale)+'px';
    ctx.setTransform(scale*DPR,0,0,scale*DPR,0,0);
  }
  window.addEventListener('resize',resize);

  // ── 占位人形：素材没到位时用，验证动作节奏 ─────────────────────────
  function drawPlaceholder(t){
    var cx=W*0.5, cy=H*0.42, headR=W*0.17;
    var breathe=1+P.breath*0.008;
    var lean=P.bodyLean*0.06 + P.angleX*0.004;

    ctx.save();
    ctx.translate(cx, cy*1.9); ctx.rotate(lean); ctx.scale(breathe,breathe); ctx.translate(-cx, -cy*1.9);

    // 身体
    ctx.fillStyle='#22304a';
    ctx.beginPath(); ctx.ellipse(cx, cy+headR*2.5, W*0.22, H*0.24, 0, 0, 6.283); ctx.fill();
    // 尾巴（弹簧链）
    ctx.strokeStyle='rgba(120,170,235,.85)'; ctx.lineWidth=W*0.035; ctx.lineCap='round';
    ctx.beginPath();
    var tx=cx+W*0.16, ty=cy+headR*2.4;
    ctx.moveTo(tx,ty);
    for(var i=0;i<5;i++){
      var sway=Math.sin(t*0.0016 - i*0.32)*P.tailSway*W*0.03;
      tx+=W*0.075; ty+=H*0.035*0.9;
      ctx.quadraticCurveTo(tx-sway, ty-H*0.02, tx+sway, ty);
    }
    ctx.stroke();

    // 头
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(P.angleX*0.004);
    ctx.scale(1-Math.abs(P.angleX)*0.0022, 1);
    ctx.fillStyle='#2a3a58';
    ctx.beginPath(); ctx.arc(0,0,headR,0,6.283); ctx.fill();
    // 头发
    ctx.fillStyle='#1b2740';
    ctx.beginPath(); ctx.arc(0,-headR*0.18,headR*1.04,Math.PI*1.05,Math.PI*1.95); ctx.fill();
    // 眼睛
    var eyeY=-headR*0.05, eyeDX=headR*0.42, eyeR=headR*0.16;
    [-1,1].forEach(function(s){
      var px=s*eyeDX + P.angleX*0.9;
      ctx.fillStyle='#dce9ff';
      ctx.beginPath(); ctx.ellipse(px, eyeY, eyeR, eyeR*P.eyeOpen, 0,0,6.283); ctx.fill();
      if(P.eyeOpen>0.18){
        ctx.fillStyle='#3f6fb5';
        ctx.beginPath(); ctx.arc(px+P.angleX*0.5, eyeY, eyeR*0.55*Math.min(1,P.eyeOpen*1.5), 0,6.283); ctx.fill();
      }
    });
    // 腮红
    if(P.blush>0.01){
      ctx.globalAlpha=P.blush*0.55; ctx.fillStyle='#ff8fa8';
      [-1,1].forEach(function(s){ ctx.beginPath(); ctx.ellipse(s*headR*0.62, headR*0.24, headR*0.22, headR*0.13,0,0,6.283); ctx.fill(); });
      ctx.globalAlpha=1;
    }
    // 嘴
    ctx.fillStyle='#a34a5c';
    var mw=headR*0.30*(0.5+P.mouthForm*0.5), mh=headR*(0.06+P.mouthOpen*0.22);
    ctx.beginPath(); ctx.ellipse(0, headR*0.34, mw, mh, 0,0,6.283); ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  // ── 素材模式：分层绘制（按 depth 从后到前）──────────────────────────
  function drawParts(t){
    var sorted=parts.slice().sort(function(a,b){ return (a.depth||0)-(b.depth||0); });
    var cx=W*0.5, cy=H*0.45;
    var breathe=1+P.breath*0.008;

    ctx.save();
    ctx.translate(cx, H*0.62); ctx.scale(breathe,breathe); ctx.translate(-cx, -H*0.62);

    for(var i=0;i<sorted.length;i++){
      var p=sorted[i], img=p.img; if(!img) continue;
      var depth=p.depth||0;
      var px=(p.pivot&&p.pivot[0]!=null)?p.pivot[0]*W:cx;
      var py=(p.pivot&&p.pivot[1]!=null)?p.pivot[1]*H:H*0.45;

      ctx.save();
      // 头部组：整体倾斜 + 按 depth 视差偏移（越靠后偏得越少）
      if(p.group==='head'){
        var par=depth*P.angleX*1.7;
        ctx.translate(cx+par, py); ctx.rotate(P.angleX*0.0038 + P.angleY*0.0016);
        ctx.scale(1-Math.abs(P.angleX)*0.0018, 1);
        ctx.translate(-px, -py);
      } else if(p.group==='tail'){
        var seg=(p.seg||0);
        var sway=Math.sin(t*0.0016 - seg*0.34)*P.tailSway;
        ctx.translate(px, py); ctx.rotate(sway*(0.05+seg*0.02)); ctx.translate(-px,-py);
      } else {
        ctx.translate(cx, py); ctx.rotate(P.bodyLean*0.02); ctx.translate(-px,-py);
      }

      // 眼睑：按 eyeOpen 下移覆盖
      if(p.group==='lid'){
        var lidDrop=(1-P.eyeOpen)*(img.height*0.62);
        ctx.translate(0, -lidDrop*0.4);
        ctx.globalAlpha=Math.min(1,1.2-P.eyeOpen*0.9);
      }
      // 腮红：透明度驱动
      if(p.id==='blush') ctx.globalAlpha=P.blush*0.85;
      // 口型：三态交叉
      if(p.group==='mouth'){
        var w=0;
        if(p.id==='mouth_closed') w=1-P.mouthOpen;
        else if(p.id==='mouth_o') w=P.mouthOpen*Math.max(0,P.mouthForm);
        else if(p.id==='mouth_a') w=P.mouthOpen*(1-Math.max(0,P.mouthForm));
        if(w<=0.01){ ctx.restore(); continue; }
        ctx.globalAlpha=w;
      }
      ctx.drawImage(img,0,0,img.naturalWidth,img.naturalHeight,0,0,W,H);
      ctx.restore();
    }
    ctx.restore();
  }

  // ── 主循环 ──────────────────────────────────────────────────────
  var last=performance.now();
  function frame(now){
    var dt=Math.min(0.05,(now-last)/1000); last=now;
    var t=now;

    // 呼吸 / 尾巴（低频）
    P.breath=Math.sin(t*0.0018);
    P.tailSway=0.5+0.5*Math.sin(t*0.00035) + (expr==='happy'?0.35:0) + (expr==='angry'?0.25:0);

    // 转头：向目标缓动（带一点惯性）
    P.angleX=lerp(P.angleX, target.angleX, 1-Math.exp(-6*dt));
    P.angleY=lerp(P.angleY, target.angleY, 1-Math.exp(-6*dt));

    // 眨眼
    if(now>nextBlink){ blinkAt=now; nextBlink=now+2800+Math.random()*3600; }
    var bp=(now-blinkAt)/220;
    P.eyeOpen = bp<1 ? Math.abs(Math.cos(bp*Math.PI)) : 1;

    // 说话：口型随语音节奏抖动
    if(talk){
      P.mouthOpen=0.35+0.65*Math.abs(Math.sin(t*0.018)+Math.sin(t*0.011))*0.5;
      P.mouthForm=(Math.sin(t*0.0037)+1)/2;
    } else {
      P.mouthOpen=lerp(P.mouthOpen,0,1-Math.exp(-10*dt));
      P.mouthForm=lerp(P.mouthForm,0,1-Math.exp(-6*dt));
    }

    // 表情权重（腮红/眉毛）
    var wantBlush = expr==='shy'?1:0;
    P.blush=lerp(P.blush,wantBlush,1-Math.exp(-5*dt));
    P.browRaise=expr==='angry'?-0.6:(expr==='happy'?0.4:0);

    // 绘制
    ctx.clearRect(0,0,W,H);
    if(loaded) drawParts(t); else drawPlaceholder(t);

    // HUD
    document.getElementById('pAngle').textContent=P.angleX.toFixed(0);
    document.getElementById('pEye').textContent=P.eyeOpen.toFixed(2);
    document.getElementById('pMouth').textContent=P.mouthOpen.toFixed(2);
    document.getElementById('pTail').textContent=P.tailSway.toFixed(2);

    requestAnimationFrame(frame);
  }

  // ── 交互 ────────────────────────────────────────────────────────
  stage.addEventListener('pointermove',function(e){
    var r=cv.getBoundingClientRect();
    target.angleX=((e.clientX-r.left)/r.width-0.5)*32;
    target.angleY=((e.clientY-r.top)/r.height-0.5)*22;
  });
  stage.addEventListener('pointerleave',function(){ target.angleX=0; target.angleY=0; });

  function setExpr(x){
    expr=x;
    ['idle','talk','happy','shy','angry'].forEach(function(k){
      var b=document.getElementById('b'+k.charAt(0).toUpperCase()+k.slice(1));
      if(b) b.classList.toggle('on', k===x || (x==='talk'&&k==='talk'));
    });
    talk = x==='talk';
  }
  document.getElementById('bIdle').onclick=function(){ setExpr('idle'); };
  document.getElementById('bTalk').onclick=function(){ setExpr('talk'); };
  document.getElementById('bHappy').onclick=function(){ setExpr('happy'); };
  document.getElementById('bShy').onclick=function(){ setExpr('shy'); };
  document.getElementById('bAngry').onclick=function(){ setExpr('angry'); };
  document.getElementById('bBlink').onclick=function(){ blinkAt=performance.now()-260; };

  resize(); loadManifest(); requestAnimationFrame(frame);
})();
</script>
</body></html>`;
}
