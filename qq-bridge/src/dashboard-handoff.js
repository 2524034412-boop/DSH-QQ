// 载入动画 → 主页的衔接 + 液态玻璃按钮。
// 1) 开场结束时，画面里那颗玻璃光球缩小、沿弧线飞到「控制终端」旁边，落定后变成常驻的实时装饰
//    （同一个着色器，小尺寸实时渲染：缓慢自转、光带掠过、呼吸）。
//    交接是无缝的：飞行起点用开场最后一帧的相机/材质参数，再缓动到常驻参数，所以看不到“换了一颗球”。
// 2) 主页按钮统一成液态玻璃：高光随指针游走、边缘虹彩、按下回弹。
// 全部本地；曲线用 cubic-bezier；prefers-reduced-motion 时不飞行、不循环动画；无 WebGL 时降级为 CSS 球。
export const handoffStyles = `
:root{--lg-e:cubic-bezier(.16,1,.3,1);--lg-spring:cubic-bezier(.34,1.56,.64,1);--lg-io:cubic-bezier(.65,0,.35,1)}

/* ── 液态玻璃 ── */
header .nav-actions button,.button-primary,.section-controls button{
  --lx:50%;--ly:0%;position:relative;isolation:isolate;overflow:hidden;cursor:pointer;color:#eaf2ff;
  border:1px solid rgba(255,255,255,.2);
  background:linear-gradient(180deg,rgba(255,255,255,.17),rgba(255,255,255,.055));
  -webkit-backdrop-filter:blur(16px) saturate(1.8);backdrop-filter:blur(16px) saturate(1.8);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 -1px 1px rgba(255,255,255,.1),inset 0 0 16px rgba(130,175,255,.14),0 8px 22px -10px rgba(0,0,0,.65);
  transition:transform .6s var(--lg-spring),background .45s var(--lg-e),box-shadow .55s var(--lg-e),border-color .45s var(--lg-e),color .3s var(--lg-e)}
header .nav-actions button::before,.button-primary::before,.section-controls button::before{
  content:'';position:absolute;inset:0;border-radius:inherit;z-index:-1;pointer-events:none;opacity:.55;transition:opacity .5s var(--lg-e);
  background:radial-gradient(90px circle at var(--lx) var(--ly),rgba(255,255,255,.44),rgba(190,220,255,.12) 46%,transparent 70%),linear-gradient(180deg,rgba(255,255,255,.26),rgba(255,255,255,0) 52%)}
header .nav-actions button::after,.button-primary::after,.section-controls button::after{
  content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;padding:1px;opacity:.85;
  background:linear-gradient(135deg,rgba(255,255,255,.75),rgba(160,200,255,.12) 38%,rgba(255,176,220,.14) 62%,rgba(255,255,255,.5));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
header .nav-actions button:hover,.button-primary:hover,.section-controls button:hover{
  transform:translateY(-1px) scale(1.035);color:#fff;border-color:rgba(255,255,255,.32);
  background:linear-gradient(180deg,rgba(255,255,255,.25),rgba(255,255,255,.085));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.7),inset 0 -1px 1px rgba(255,255,255,.14),inset 0 0 22px rgba(140,185,255,.22),0 14px 30px -12px rgba(60,110,255,.55)}
header .nav-actions button:hover::before,.button-primary:hover::before,.section-controls button:hover::before{opacity:1}
header .nav-actions button:active,.button-primary:active,.section-controls button:active{transform:scale(.95);transition-duration:.18s}
header .nav-actions button:focus-visible,.button-primary:focus-visible,.section-controls button:focus-visible{outline:2px solid rgba(200,225,255,.75);outline-offset:3px}
.button-primary,header .nav-actions .nav-primary{
  color:#fff;border-color:rgba(190,220,255,.42);
  background:linear-gradient(180deg,rgba(150,196,255,.52),rgba(70,120,255,.3));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.72),inset 0 -8px 16px -8px rgba(100,160,255,.55),0 10px 30px -10px rgba(60,110,255,.7)}
.button-primary:hover,header .nav-actions .nav-primary:hover{
  background:linear-gradient(180deg,rgba(176,214,255,.64),rgba(90,140,255,.4));color:#fff;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.85),inset 0 -8px 18px -8px rgba(120,180,255,.7),0 16px 38px -12px rgba(70,120,255,.85)}
.pill:not(.good):not(.bad){background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,.03));
  -webkit-backdrop-filter:blur(12px) saturate(1.6);backdrop-filter:blur(12px) saturate(1.6);box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
header{background:linear-gradient(180deg,rgba(14,20,34,.58),rgba(8,12,22,.5));
  -webkit-backdrop-filter:blur(30px) saturate(1.7);backdrop-filter:blur(30px) saturate(1.7);
  box-shadow:inset 0 -1px 0 rgba(255,255,255,.08),0 10px 40px -22px rgba(0,0,0,.75)}

/* ── 常驻的实时光球（控制终端旁）── */
.brand .brand-orb{display:block;flex:none;width:38px;height:38px;margin-left:4px}
.pf-mini{--d:38px;position:fixed;left:0;top:0;width:var(--d);height:var(--d);z-index:21;opacity:0;pointer-events:none;
  will-change:transform,opacity;transform:translate3d(-300px,-300px,0)}
.pf-mini.live{opacity:1;pointer-events:auto}
.pf-mini.flying{z-index:130;pointer-events:none}
.pf-mini-glow{position:absolute;inset:-70%;border-radius:50%;pointer-events:none;
  background:radial-gradient(closest-side,rgba(90,150,255,.5),rgba(80,110,255,.18) 55%,transparent 72%);animation:miniGlow 4.8s var(--lg-io) infinite}
@keyframes miniGlow{0%,100%{opacity:.62;transform:scale(.92)}50%{opacity:1;transform:scale(1.08)}}
.pf-mini-orb{position:absolute;inset:0;border-radius:50%;overflow:hidden;background:#06102e;transition:transform .8s var(--lg-spring);box-shadow:0 0 0 .5px rgba(180,215,255,.4)}
.pf-mini:hover .pf-mini-orb{transform:scale(1.16)}
.pf-mini-orb canvas{position:absolute;left:50%;top:50%;width:113.636%;height:113.636%;transform:translate(-50%,-50%);display:block}
.pf-mini-orb::after{content:'';position:absolute;inset:0;border-radius:50%;pointer-events:none;
  box-shadow:inset 0 0 0 1px rgba(210,230,255,.4),inset 0 -5px 9px -3px rgba(110,180,255,.55),inset 0 5px 8px -3px rgba(255,255,255,.55)}
.pf-mini-fb{display:none;position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 32% 28%,#fff,#9fd0ff 16%,#3d78ff 52%,#0a1a5a 90%)}
.pf-mini.nogl canvas{display:none}.pf-mini.nogl .pf-mini-fb{display:block}
@media(max-width:680px){.brand .brand-orb{width:28px;height:28px}}
@media(prefers-reduced-motion:reduce){.pf-mini-glow{animation:none}.pf-mini-orb{transition-duration:.01ms}}
`;

export const handoffScript = String.raw`
(function pfHandoff(){
  var brand=document.querySelector('header .brand'), boot=document.getElementById('boot');
  if(!brand) return;
  var reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function mixv(a,b,e){ return a+(b-a)*e; }

  // ── 液态玻璃：高光跟着指针游走 ──
  var GLASS='header .nav-actions button,.button-primary,.section-controls button';
  document.addEventListener('pointermove',function(e){
    var t=e.target; if(!t||!t.closest) return; var b=t.closest(GLASS); if(!b) return;
    var r=b.getBoundingClientRect();
    b.style.setProperty('--lx',(e.clientX-r.left).toFixed(0)+'px'); b.style.setProperty('--ly',(e.clientY-r.top).toFixed(0)+'px');
  },{passive:true});

  // ── 常驻光球：槽位在品牌文字后面，真正的球是 fixed 元素（飞行时需要越过开场层）──
  var slot=document.createElement('span'); slot.className='brand-orb'; slot.setAttribute('aria-hidden','true'); brand.appendChild(slot);
  var mini=document.createElement('div'); mini.className='pf-mini'; mini.setAttribute('aria-hidden','true');
  mini.innerHTML='<i class="pf-mini-glow"></i><div class="pf-mini-orb"><canvas></canvas><b class="pf-mini-fb"></b></div>';
  document.body.appendChild(mini);
  var canvas=mini.querySelector('canvas');

  var gl=null, U={}, ok=false;
  try{
    if(typeof __PF_FRAG==='string'&&typeof __PF_VERT==='string'){
      gl=canvas.getContext('webgl',{antialias:false,alpha:false,powerPreference:'high-performance'});
      if(gl){
        var mk=function(type,src){ var s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s); return gl.getShaderParameter(s,gl.COMPILE_STATUS)?s:null; };
        var vs=mk(gl.VERTEX_SHADER,__PF_VERT), fs=mk(gl.FRAGMENT_SHADER,__PF_FRAG);
        if(vs&&fs){
          var pr=gl.createProgram(); gl.attachShader(pr,vs); gl.attachShader(pr,fs); gl.linkProgram(pr);
          if(gl.getProgramParameter(pr,gl.LINK_STATUS)){
            gl.useProgram(pr);
            var bf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,bf); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
            var lc=gl.getAttribLocation(pr,'a'); gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc,2,gl.FLOAT,false,0,0);
            ['uRes','uTime','uCam','uTarget','uBlob','uFocal','uScale','uMorph','uFlute','uExp','uSweep','uFlash','uRing','uRot','uRingOn','uBokeh'].forEach(function(n){ U[n]=gl.getUniformLocation(pr,n); });
            ok=true;
          }
        }
      }
    }
  }catch(e){ ok=false; }
  if(!ok) mini.classList.add('nogl');

  var D=38, X=0, Y=0, shown=false, flying=false, running=false, raf=0, last=0, launched=false, landTimer=0;
  // 渲染状态：常驻参数 + 从开场最后一帧缓动过来的偏移
  var T0=performance.now(), tBase=0, rotBase=0, sweepBase=.3, yawBase=0, off0=0, pitch0=.2, flStart=0, fl={exp:1.2,morph:.5,flute:.35};
  function initIdle(){ T0=performance.now(); tBase=0; rotBase=0; sweepBase=.3; yawBase=0; off0=0; pitch0=.2; flStart=0; fl={exp:1.2,morph:.5,flute:.35}; }

  function setSize(d){
    mini.style.setProperty('--d',d+'px');
    if(!ok) return;
    var px=Math.min(760,Math.max(16,Math.round(d/.88*Math.min(2,window.devicePixelRatio||1))));
    if(canvas.width!==px){ canvas.width=px; canvas.height=px; gl.viewport(0,0,px,px); }
  }
  function draw(now){
    if(!ok) return;
    var ts=(now-T0)/1000, tf=flStart?(now-flStart)/1000:99, s=clamp(tf/1.6,0,1), e=s*s*(3-2*s);
    var yaw=yawBase+ts*.28+off0*(1-e), pitch=mixv(pitch0,.2,e), cp=Math.cos(pitch), dist=3.8;
    gl.uniform2f(U.uRes,canvas.width,canvas.height); gl.uniform1f(U.uTime,tBase+ts);
    gl.uniform3f(U.uCam,dist*Math.sin(yaw)*cp,dist*Math.sin(pitch),dist*Math.cos(yaw)*cp);
    gl.uniform3f(U.uTarget,0,0,0); gl.uniform3f(U.uBlob,0,0,0);
    gl.uniform1f(U.uFocal,1.5); gl.uniform1f(U.uScale,1);
    gl.uniform1f(U.uMorph,mixv(fl.morph,.5,e)); gl.uniform1f(U.uFlute,mixv(fl.flute,.35,e)); gl.uniform1f(U.uExp,mixv(fl.exp,1.2,e));
    gl.uniform1f(U.uSweep,sweepBase+ts*.07); gl.uniform1f(U.uFlash,0); gl.uniform1f(U.uRing,0);
    gl.uniform1f(U.uRot,rotBase+ts*.18); gl.uniform1f(U.uRingOn,0); gl.uniform1f(U.uBokeh,0);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  function loop(now){ if(!running) return; raf=requestAnimationFrame(loop); if(!flying&&now-last<30) return; last=now; draw(now); }
  function startLoop(){ if(!ok||running||reduced) return; running=true; raf=requestAnimationFrame(loop); }
  function stopLoop(){ running=false; if(raf) cancelAnimationFrame(raf); raf=0; }
  document.addEventListener('visibilitychange',function(){ if(document.hidden) stopLoop(); else if(shown||flying) startLoop(); });

  function measure(){
    var r=slot.getBoundingClientRect(); if(r.width<1) return false;
    D=Math.round(r.width); X=r.left; Y=r.top; return true;
  }
  function place(){ mini.style.transform='translate3d('+X.toFixed(1)+'px,'+Y.toFixed(1)+'px,0)'; }
  function remember(){ try{ sessionStorage.setItem('pf-mini','1'); }catch(e){} }

  function dockInstant(){
    if(!measure()) return; initIdle(); setSize(D); place(); mini.classList.add('live'); shown=true; remember();
    if(reduced) draw(performance.now()); else startLoop();
  }
  function dockFade(){
    if(!measure()) return; initIdle(); setSize(D); place(); mini.classList.add('live'); shown=true; remember();
    var T='translate3d('+X.toFixed(1)+'px,'+Y.toFixed(1)+'px,0)';
    if(!reduced&&mini.animate){
      var a=mini.animate([{opacity:0,transform:T+' scale(.35)'},{opacity:1,transform:T+' scale(1)'}],{duration:1000,delay:350,easing:'cubic-bezier(.16,1,.3,1)',fill:'both'});
      a.onfinish=function(){ try{ a.cancel(); }catch(e){} }; startLoop();
    } else { draw(performance.now()); startLoop(); }
  }

  // 开场最后一帧的相机/材质 → 常驻球的起始状态，让交接看不出“换了一颗球”
  function fly(rect,S){
    if(!measure()) return;
    var startD=clamp(2*rect.r/.93,D,900);          // 以起飞时的屏幕直径渲染，保证起点和开场里的球一样清晰
    initIdle(); setSize(startD);
    var rdx=S.blob[0]-S.cam[0], rdy=S.blob[1]-S.cam[1], rdz=S.blob[2]-S.cam[2], rl=Math.sqrt(rdx*rdx+rdy*rdy+rdz*rdz)||1;
    rdx/=rl; rdy/=rl; rdz/=rl;
    var now=performance.now();
    T0=now; flStart=now; tBase=S.t; rotBase=S.t*.18; sweepBase=S.sweep;
    yawBase=Math.atan2(-rdx,-rdz); pitch0=Math.asin(clamp(-rdy,-1,1)); off0=6.2832;   // 落定时顺带转一整圈
    fl={exp:S.exp,morph:S.morph,flute:S.flute};
    var cx0=rect.cx, cy0=rect.cy, cx1=X+D/2, cy1=Y+D/2, dx=cx1-cx0, dy=cy1-cy0, len=Math.hypot(dx,dy)||1;
    var nx=-dy/len, ny=dx/len; if(ny<0){ nx=-nx; ny=-ny; }
    var ccx=(cx0+cx1)/2+nx*len*.22, ccy=(cy0+cy1)/2+ny*len*.22, kEnd=D/startD, frames=[], N=28;
    for(var i=0;i<=N;i++){
      var u=i/N, a=(1-u)*(1-u), b=2*(1-u)*u, c=u*u;
      var cx=a*cx0+b*ccx+c*cx1, cy=a*cy0+b*ccy+c*cy1;
      var k=Math.pow(kEnd,Math.pow(u,.85))*(1+.12*Math.sin(Math.PI*clamp((u-.78)/.22,0,1)));   // 末段轻微回弹
      frames.push({offset:u,transform:'translate3d('+(cx-startD/2).toFixed(1)+'px,'+(cy-startD/2).toFixed(1)+'px,0) scale('+k.toFixed(4)+')'});
    }
    mini.style.transform=frames[0].transform; mini.classList.add('live','flying'); flying=true; shown=true;
    if(ok){ draw(now); startLoop(); }
    function land(){
      if(!flying) return; flying=false; clearTimeout(landTimer);
      setSize(D); place(); mini.classList.remove('flying'); if(ok) draw(performance.now()); remember();
    }
    if(mini.animate){
      var an=mini.animate(frames,{duration:1500,easing:'cubic-bezier(.55,.04,.16,1)',fill:'forwards'});
      an.onfinish=function(){ land(); try{ an.cancel(); }catch(e){} };
      landTimer=setTimeout(function(){ land(); try{ an.cancel(); }catch(e){} },1750);
    } else { land(); }
  }
  function launch(){
    if(!measure()) return;
    var rect=window.__pfOrbRect&&window.__pfOrbRect(), S=window.__pfLast;
    if(reduced||!rect||!S) dockFade(); else fly(rect,S);
  }

  window.addEventListener('resize',function(){ if(!flying&&shown&&measure()){ setSize(D); place(); } });
  if(typeof ResizeObserver!=='undefined'){ try{ new ResizeObserver(function(){ if(!flying&&shown&&measure()){ setSize(D); place(); } }).observe(brand); }catch(e){} }
  if(document.fonts&&document.fonts.ready){ document.fonts.ready.then(function(){ if(!flying&&shown&&measure()){ setSize(D); place(); } }); }

  function bootPlaying(){ return !!boot&&boot.style.display!=='none'; }
  if(boot){
    try{
      new MutationObserver(function(){
        var out=boot.classList.contains('out');
        if(out&&!launched){ launched=true; launch(); }
        else if(!out&&bootPlaying()&&launched){ launched=false; }
      }).observe(boot,{attributes:true,attributeFilter:['class']});
    }catch(e){}
  }
  if(!bootPlaying()){
    var seen=false; try{ seen=sessionStorage.getItem('pf-mini')==='1'; }catch(e){}
    if(seen||reduced) dockInstant(); else dockFade();
  }
})();
`;
