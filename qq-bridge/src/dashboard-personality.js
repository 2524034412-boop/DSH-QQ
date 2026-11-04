// 面板的「个性层」：遗忘曲线卡片 + 光标辉光 + 数字计数 + 呼吸细节。
// 全部本地、无外链；动效统一走贝塞尔 token；尊重 prefers-reduced-motion。
export const personalityStyles = `
/* ── 卡片光标高光：跟着鼠标在卡片内游走的一圈暖光（只改 CSS 变量，合成层绘制）── */
main>section{--mx:50%;--my:0%;--glow:0;position:relative}
main>section::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:var(--glow);
  background:radial-gradient(360px circle at var(--mx) var(--my),rgba(246,206,178,.11),transparent 62%);
  transition:opacity .7s var(--ease-out)}
main>section>*{position:relative;z-index:1}

/* ── 光标辉光：整页一枚柔光，缓动跟随，不抢字 ── */
.cursor-glow{position:fixed;left:0;top:0;width:340px;height:340px;margin:-170px 0 0 -170px;border-radius:50%;pointer-events:none;z-index:2;
  background:radial-gradient(circle,rgba(246,206,178,.075),rgba(140,170,236,.04) 45%,transparent 70%);
  opacity:0;transition:opacity .8s var(--ease-out);will-change:transform}
body.pointer-live .cursor-glow{opacity:1}

/* ── 遗忘曲线卡片 ── */
.forget{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:34px;align-items:center}
.forget-copy h3{font-size:clamp(24px,3vw,38px);line-height:1.3;letter-spacing:-.05em;font-weight:550;margin:0 0 12px}
.forget-copy p{color:#9ca7b8;font-size:12px;line-height:1.9;margin:0 0 20px;max-width:470px}
.forget-figures{display:flex;gap:30px;flex-wrap:wrap}
.forget-figures div b{display:block;font-size:clamp(28px,3.2vw,44px);font-weight:500;letter-spacing:-.06em;line-height:1.1;font-variant-numeric:tabular-nums}
.forget-figures div span{display:block;margin-top:6px;font-size:10.5px;letter-spacing:.08em;color:#8b95a6}
.forget-figures .warm b{color:#f2d3b6}
.forget-chart{position:relative;width:100%;aspect-ratio:2/1;min-height:140px}
.forget-chart canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.forget-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:10px;letter-spacing:.06em;color:#8b95a6}
.forget-legend i{display:inline-block;width:14px;height:2px;border-radius:2px;margin-right:6px;vertical-align:middle}
.forget-note{margin-top:8px;font-size:10px;line-height:1.7;color:#6f7a8c}
@media(max-width:860px){.forget{grid-template-columns:minmax(0,1fr);gap:20px}}

/* ── 个性细节 ── */
.brand-mark{animation:whaleBreath 6.4s var(--ease-in-out) infinite}
@keyframes whaleBreath{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-1.5px) scale(1.045)}}
.live-indicator i{animation:livePulse 2.8s var(--ease-out) infinite}
@keyframes livePulse{0%{box-shadow:0 0 0 0 rgba(145,212,174,.5)}70%{box-shadow:0 0 0 8px rgba(145,212,174,0)}100%{box-shadow:0 0 0 0 rgba(145,212,174,0)}}
.kpi{transition:background .6s var(--ease-out),transform .6s var(--ease-out)}
.kpi:hover{background:linear-gradient(165deg,rgba(30,35,46,.96),rgba(18,21,28,.96));transform:translateY(-2px)}
.kpi b[data-count]{display:inline-block;min-width:1ch}
.kpi b .n{font-style:normal;display:inline-block;min-width:1ch}
.hero h1{background:linear-gradient(100deg,#fff 0%,#fff 45%,#f6dcc4 62%,#fff 78%);background-size:240% 100%;
  -webkit-background-clip:text;background-clip:text;color:transparent;animation:titleSheen 9s var(--ease-in-out) 1.8s infinite alternate}
.hero h1 span{-webkit-text-fill-color:#8f95a3;color:#8f95a3}
@keyframes titleSheen{from{background-position:100% 0}to{background-position:0 0}}
body.entered .hero-note::before{content:'';display:inline-block;width:6px;height:6px;margin-right:8px;border-radius:50%;background:#f3c9a8;
  box-shadow:0 0 12px #f3c9a8;vertical-align:middle;animation:livePulse 3.2s var(--ease-out) infinite}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(160,175,205,.22);border-radius:10px;border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:rgba(190,205,235,.38);background-clip:content-box;border:3px solid transparent}
.scroll-progress{position:fixed;left:0;top:0;height:2px;width:100%;transform-origin:left;transform:scaleX(0);z-index:30;pointer-events:none;
  background:linear-gradient(90deg,rgba(240,200,164,0),#f0c8a4 30%,#bfd3f5);opacity:.9}
@media(prefers-reduced-motion:reduce){.brand-mark,.live-indicator i,.hero h1,body.entered .hero-note::before{animation:none}
  .hero h1{background:none;color:#fff;-webkit-text-fill-color:#fff}.hero h1 span{-webkit-text-fill-color:#8f95a3}
  .cursor-glow{display:none}}
`;

export const personalityScript = String.raw`
(function personality(){
  var calm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine=window.matchMedia('(hover:hover) and (pointer:fine)').matches;
  // 贝塞尔缓出：cubic-bezier(.16,1,.3,1) 的数值解（牛顿法解 x(t)=p），数字滚动与 CSS 缓动同一条曲线。
  function bez(x1,y1,x2,y2){
    return function(p){
      if(p<=0) return 0; if(p>=1) return 1;
      var t=p;
      for(var i=0;i<8;i++){
        var cx=3*x1, bx=3*(x2-x1)-cx, ax=1-cx-bx;
        var x=((ax*t+bx)*t+cx)*t-p;
        var d=(3*ax*t+2*bx)*t+cx;
        if(Math.abs(x)<1e-5||Math.abs(d)<1e-6) break;
        t-=x/d;
      }
      var cy=3*y1, by=3*(y2-y1)-cy, ay=1-cy-by;
      return ((ay*t+by)*t+cy)*t;
    };
  }
  var easeOut=bez(.16,1,.3,1);

  // 1) 数字滚动：KPI 与遗忘卡片里的大数字，首次进入视野时从 0 缓出到目标值。
  var counters=[].slice.call(document.querySelectorAll('[data-count]'));
  function runCounter(el){
    if(el.dataset.done) return; el.dataset.done='1';
    var raw=el.getAttribute('data-count'), target=parseFloat(raw);
    if(!isFinite(target)) return;
    var suffix=el.getAttribute('data-suffix')||'', decimals=(raw.split('.')[1]||'').length;
    if(calm){ el.textContent=target.toFixed(decimals)+suffix; return; }
    var dur=1500, t0=performance.now();
    (function step(now){
      var p=Math.min(1,(now-t0)/dur), v=target*easeOut(p);
      el.textContent=v.toFixed(decimals)+suffix;
      if(p<1) requestAnimationFrame(step); else el.textContent=target.toFixed(decimals)+suffix;
    })(t0);
  }
  if('IntersectionObserver' in window && !calm){
    counters.forEach(function(el){ var raw=el.getAttribute('data-count'); el.textContent=(0).toFixed((raw.split('.')[1]||'').length)+(el.getAttribute('data-suffix')||''); });
    var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ runCounter(e.target); io.unobserve(e.target); } }); },{threshold:.4});
    counters.forEach(function(el){ io.observe(el); });
  } else counters.forEach(runCounter);

  // 2) 卡片高光 + 页面光标辉光：只写 CSS 变量/transform，rAF 合并，不触发布局。
  if(fine && !calm){
    var glow=document.createElement('div'); glow.className='cursor-glow'; glow.setAttribute('aria-hidden','true'); document.body.appendChild(glow);
    var gx=-999,gy=-999,tx=-999,ty=-999,raf=0,last=performance.now();
    function loop(now){
      var dt=Math.min(.05,(now-last)/1000); last=now;
      var k=1-Math.exp(-9*dt);
      gx+=(tx-gx)*k; gy+=(ty-gy)*k;
      glow.style.transform='translate3d('+gx.toFixed(1)+'px,'+gy.toFixed(1)+'px,0)';
      if(Math.abs(tx-gx)>.5||Math.abs(ty-gy)>.5) raf=requestAnimationFrame(loop); else raf=0;
    }
    document.addEventListener('pointermove',function(e){
      tx=e.clientX; ty=e.clientY;
      if(gx<-900){ gx=tx; gy=ty; }
      if(!document.body.classList.contains('pointer-live')) document.body.classList.add('pointer-live');
      if(!raf){ last=performance.now(); raf=requestAnimationFrame(loop); }
    },{passive:true});
    document.addEventListener('pointerleave',function(){ document.body.classList.remove('pointer-live'); });

    // 卡片光晕：移动只记录坐标，下一帧统一写一次变量；不在 pointermove 里读布局。
    var secs=Array.prototype.slice.call(document.querySelectorAll('main>section'));
    var rects=new Map(), spot=null, sraf=0;
    var ro=new ResizeObserver(function(es){ es.forEach(function(e){ rects.set(e.target,e.target.getBoundingClientRect()); }); });
    secs.forEach(function(sec){ ro.observe(sec); rects.set(sec,sec.getBoundingClientRect()); });
    window.addEventListener('scroll',function(){ secs.forEach(function(s){ rects.set(s,s.getBoundingClientRect()); }); },{passive:true});
    function paintSpot(){
      sraf=0; if(!spot) return;
      var r=rects.get(spot.sec); if(!r) return;
      spot.sec.style.setProperty('--mx',(spot.x-r.left).toFixed(0)+'px');
      spot.sec.style.setProperty('--my',(spot.y-r.top).toFixed(0)+'px');
    }
    secs.forEach(function(sec){
      sec.addEventListener('pointerenter',function(){ sec.style.setProperty('--glow','1'); },{passive:true});
      sec.addEventListener('pointermove',function(e){
        spot={sec:sec,x:e.clientX,y:e.clientY};
        if(!sraf) sraf=requestAnimationFrame(paintSpot);
      },{passive:true});
      sec.addEventListener('pointerleave',function(){ sec.style.setProperty('--glow','0'); });
    });
  }

  // 3) 阅读进度线：顶部一条随滚动伸长的细线（transform，不改布局）。
  var bar=document.createElement('div'); bar.className='scroll-progress'; bar.setAttribute('aria-hidden','true'); document.body.appendChild(bar);
  var sraf=0;
  function paintScroll(){ sraf=0; var h=document.documentElement.scrollHeight-window.innerHeight; bar.style.transform='scaleX('+(h>0?Math.min(1,window.scrollY/h):0).toFixed(4)+')'; }
  window.addEventListener('scroll',function(){ if(!sraf) sraf=requestAnimationFrame(paintScroll); },{passive:true});
  paintScroll();

  // 4) 遗忘曲线卡片：数据由服务端算好随页面下发（同一个 memory-retention 模型），这里只负责画。
  var holder=document.getElementById('forgetData'), canvas=document.getElementById('forgetChart');
  if(holder && canvas){
    var data; try{ data=JSON.parse(holder.textContent||'{}'); }catch(e){ data=null; }
    if(data && data.series){
      var ctx=canvas.getContext('2d'), COL={core:'240,200,164',long:'159,184,218',short:'143,208,196'};
      var drawn=0, started=0, hoverX=-1;
      function size(){
        var r=canvas.getBoundingClientRect(), d=Math.min(2,window.devicePixelRatio||1);
        canvas.width=Math.max(2,Math.floor(r.width*d)); canvas.height=Math.max(2,Math.floor(r.height*d));
        ctx.setTransform(d,0,0,d,0,0);
      }
      function paint(progress){
        var w=canvas.clientWidth, h=canvas.clientHeight, pad=8; ctx.clearRect(0,0,w,h);
        var fy=pad+(1-data.fading)*(h-pad*2);
        ctx.setLineDash([3,5]); ctx.strokeStyle='rgba(217,169,140,.32)'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(0,fy); ctx.lineTo(w,fy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle='rgba(217,169,140,.55)'; ctx.font='10px ui-monospace,Menlo,monospace'; ctx.fillText('快忘了 '+Math.round(data.fading*100)+'%',6,fy-5);
        // 横轴刻度：此刻 / +15 / +30 / +60 天
        ctx.strokeStyle='rgba(160,175,205,.14)'; ctx.fillStyle='rgba(160,175,205,.5)';
        [0,.25,.5,1].forEach(function(f,i){ var x=Math.min(w-1,Math.max(0,f*w)); ctx.beginPath(); ctx.moveTo(x,h-14); ctx.lineTo(x,h-8); ctx.stroke();
          ctx.textAlign=f===0?'left':(f===1?'right':'center'); ctx.fillText(['此刻','+15 天','+30 天','+'+data.horizon+' 天'][i],x,h-1); });
        ctx.textAlign='left';
        ['short','long','core'].forEach(function(k){
          var arr=data.series[k]; if(!arr||!arr.some(function(v){return v!=null;})) return;
          var n=arr.length-1, reveal=Math.max(0,Math.min(n,progress*n)), pts=[];
          for(var s=0;s<=n;s++){ if(arr[s]==null) continue;
            var x=s/n*w, y=pad+(1-arr[s])*(h-pad*2-14);
            if(s<=Math.floor(reveal)) pts.push([x,y]);
            else if(s===Math.floor(reveal)+1&&pts.length){ var f=reveal-Math.floor(reveal), p=pts[pts.length-1]; pts.push([p[0]+(x-p[0])*f,p[1]+(y-p[1])*f]); } }
          if(pts.length<2) return;
          var g=ctx.createLinearGradient(0,0,0,h); g.addColorStop(0,'rgba('+COL[k]+',.24)'); g.addColorStop(1,'rgba('+COL[k]+',0)');
          ctx.beginPath(); pts.forEach(function(p,i){ i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]); });
          ctx.strokeStyle='rgba('+COL[k]+',.95)'; ctx.lineWidth=k==='core'?1.3:1.8; ctx.lineJoin='round'; ctx.stroke();
          if(k!=='core'){ ctx.lineTo(pts[pts.length-1][0],h-14); ctx.lineTo(pts[0][0],h-14); ctx.closePath(); ctx.fillStyle=g; ctx.fill(); }
          var tip=pts[pts.length-1]; ctx.fillStyle='rgba('+COL[k]+',1)'; ctx.beginPath(); ctx.arc(tip[0],tip[1],2.6,0,6.283); ctx.fill();
        });
        if(hoverX>=0 && progress>=1){
          var f2=Math.max(0,Math.min(1,hoverX/w)); ctx.strokeStyle='rgba(234,241,255,.5)'; ctx.beginPath(); ctx.moveTo(hoverX,0); ctx.lineTo(hoverX,h-14); ctx.stroke();
          var day=Math.round(f2*data.horizon*2)/2, lines=[ '+'+day+' 天' ];
          ['core','long','short'].forEach(function(k){ var arr=data.series[k]; if(!arr||arr[0]==null) return; var idx=Math.round(f2*(arr.length-1)); lines.push({core:'核心',long:'长期',short:'短期'}[k]+' '+Math.round((arr[idx]||0)*100)+'%'); });
          var bw=92, bh=14*lines.length+10, bx=Math.min(w-bw-2,Math.max(2,hoverX+10)), by=8;
          ctx.fillStyle='rgba(8,12,22,.92)'; ctx.strokeStyle='rgba(160,175,205,.25)'; ctx.beginPath(); ctx.roundRect?ctx.roundRect(bx,by,bw,bh,8):ctx.rect(bx,by,bw,bh); ctx.fill(); ctx.stroke();
          ctx.fillStyle='#eaf1ff'; lines.forEach(function(t,i){ ctx.fillText(t,bx+8,by+17+i*14); });
        }
      }
      function frame(now){
        if(!started) started=now;
        var p=calm?1:easeOut(Math.min(1,(now-started)/2200));
        paint(p); drawn=p;
        if(p<1) requestAnimationFrame(frame);
      }
      size();
      if('IntersectionObserver' in window && !calm){
        var io2=new IntersectionObserver(function(es){ if(es[0].isIntersecting){ io2.disconnect(); requestAnimationFrame(frame); } },{threshold:.3}); io2.observe(canvas);
      } else paint(1);
      window.addEventListener('resize',function(){ size(); paint(drawn||1); });
      canvas.addEventListener('pointermove',function(e){ var r=canvas.getBoundingClientRect(); hoverX=e.clientX-r.left; paint(drawn||1); },{passive:true});
      canvas.addEventListener('pointerleave',function(){ hoverX=-1; paint(drawn||1); });
    }
  }
})();
`;
