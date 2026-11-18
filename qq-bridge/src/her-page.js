// 「她」的舞台页（/her）：Live2D 直接在面板里演，和桌面小窗是同一个模型、同一套表情。
// 三种出场方式：嵌在可视化面板的「她」页里（?embed=1）/ 单独浏览器标签 / 桌面小窗（交接过去）。
// 页面纯前端，每次从桥接读：/api/her/state 拿心情和桌面窗状态、/api/her/stickers 拿她发过的自拍历史。
export function renderHerPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>她</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--ease:cubic-bezier(.22,1,.36,1);--ease2:cubic-bezier(.65,0,.35,1);
    --ink:#f3f6ff;--ink2:#a9b4d2;--line:rgba(255,255,255,.14);--glass:rgba(26,31,52,.58);--acc:#ff9eb5;--acc2:#b79cff;color-scheme:dark}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;color:var(--ink);
    font:13px/1.6 "HarmonyOS Sans SC","MiSans","PingFang SC","Segoe UI","Microsoft YaHei",sans-serif;
    background:#0c0f1c}
  /* 背景：缓慢流动的柔光，跟心情换色 */
  #bg{position:fixed;inset:0;background:
    radial-gradient(60% 55% at 50% 42%,color-mix(in srgb,var(--mood,#7f9cff) 34%,transparent),transparent 70%),
    radial-gradient(90% 70% at 15% 100%,rgba(120,80,200,.28),transparent 65%),
    linear-gradient(#141a33,#0a0d1a);transition:background 1.2s var(--ease)}
  #bg::after{content:"";position:absolute;inset:-20%;background:
    radial-gradient(1.6px 1.6px at 12% 22%,#fff,transparent),radial-gradient(1.2px 1.2px at 78% 14%,#cfe0ff,transparent),
    radial-gradient(1.4px 1.4px at 66% 70%,#ffe9b8,transparent),radial-gradient(1.2px 1.2px at 30% 80%,#fff,transparent),
    radial-gradient(1.6px 1.6px at 90% 52%,#fff,transparent),radial-gradient(1.2px 1.2px at 44% 10%,#fff,transparent);
    opacity:.55;animation:drift 38s linear infinite}
  @keyframes drift{to{transform:translate3d(-4%,3%,0)}}
  #stage{position:fixed;inset:0}
  #stage canvas{display:block}

  /* 玻璃面板：独显上保留毛玻璃（面板高级感就靠这个）。
     —— 它盖在 Live2D 的 canvas 上面，每帧都要把下面重模糊一遍，核显扛不住，
        所以性能档把它换成偏实心的深色底（见 body.perf 那条）。 */
  .glass{background:var(--glass);border:1px solid var(--line);border-radius:18px;
    backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);box-shadow:0 12px 32px -14px rgba(0,0,0,.6)}
  body.perf .glass{background:rgba(15,19,33,.9);backdrop-filter:none;-webkit-backdrop-filter:none}
  /* 左上：心情徽章 + 状态 */
  #head{position:fixed;left:18px;top:16px;display:flex;align-items:center;gap:10px;padding:8px 16px 8px 12px;animation:rise .8s var(--ease) both}
  #head b{font-size:22px;font-weight:400}
  #head .nm{font-size:15px;font-weight:700;letter-spacing:.05em;line-height:1.2}
  #head .st{font-size:11.5px;color:var(--ink2)}
  #head .st i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:#6a7390;vertical-align:1px}
  #head .st.on i{background:#6fd6a0;box-shadow:0 0 0 3px rgba(111,214,160,.22)}

  /* 右侧：自拍历史（她发过的，点一下就能再发/复制） */
  #side{position:fixed;right:16px;top:16px;bottom:16px;width:236px;padding:12px;display:flex;flex-direction:column;gap:8px;
    transform:translateX(0);transition:transform .55s var(--ease),opacity .4s;animation:rise .8s .08s var(--ease) both}
  #side.hide{transform:translateX(calc(100% + 24px));opacity:0;pointer-events:none}
  #side h3{margin:0;font-size:12.5px;font-weight:700;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center}
  #side h3 small{font-weight:400;color:var(--ink2)}
  #hist{flex:1;overflow:auto;display:grid;grid-template-columns:repeat(2,1fr);gap:8px;align-content:start;padding:2px}
  #hist::-webkit-scrollbar{width:5px}#hist::-webkit-scrollbar-thumb{border-radius:3px;background:rgba(255,255,255,.2)}
  .card{position:relative;border-radius:14px;background:rgba(255,255,255,.06);padding:6px;cursor:pointer;
    transition:transform .3s var(--ease),background .25s;animation:pop .5s var(--ease) both}
  .card:hover{transform:translateY(-3px);background:rgba(255,255,255,.12)}
  .card img{display:block;width:100%;aspect-ratio:1/1.1;object-fit:contain}
  .card span{display:block;text-align:center;font-size:10.5px;color:var(--ink2);margin-top:2px}
  .card .n{position:absolute;right:6px;top:5px;font-size:10px;padding:0 6px;border-radius:99px;background:rgba(255,158,181,.85);color:#40202c}
  .empty{grid-column:1/-1;color:var(--ink2);font-size:12px;text-align:center;padding:30px 8px;line-height:1.8}

  /* 底部：工具条 */
  #dock{position:fixed;left:50%;bottom:16px;translate:-50% 0;display:flex;gap:3px;padding:6px;animation:rise .8s .16s var(--ease) both}
  #dock button{border:0;background:transparent;color:var(--ink);border-radius:14px;padding:7px 14px 5px;cursor:pointer;
    display:flex;flex-direction:column;align-items:center;gap:1px;font:inherit;transition:background .2s,transform .22s var(--ease)}
  #dock button i{font-style:normal;font-size:18px;line-height:1.2}
  #dock button span{font-size:10.5px;color:var(--ink2);letter-spacing:.05em}
  #dock button:hover{background:rgba(255,255,255,.12);transform:translateY(-2px)}
  #dock button:active{transform:scale(.93)}
  #dock button.on{background:rgba(255,158,181,.24)}
  #dock .div{width:1px;margin:6px 4px;background:var(--line)}
  #dock button.go{background:linear-gradient(120deg,rgba(255,158,181,.3),rgba(183,156,255,.3))}

  /* 表情面板 */
  #picker{position:fixed;left:50%;bottom:92px;translate:-50% 0;width:min(92vw,360px);padding:12px;opacity:0;transform:translateY(10px) scale(.97);pointer-events:none;
    transition:opacity .22s var(--ease),transform .3s var(--ease)}
  #picker.open{opacity:1;transform:none;pointer-events:auto}
  #picker h4{margin:0 0 8px;font-size:11px;font-weight:400;color:var(--ink2)}
  #picker .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:5px}
  #picker button{border:0;border-radius:11px;padding:6px 0 4px;background:rgba(255,255,255,.07);color:var(--ink);cursor:pointer;display:flex;flex-direction:column;align-items:center;transition:background .18s,transform .2s var(--ease)}
  #picker button:hover{background:rgba(255,255,255,.18);transform:translateY(-2px)}
  #picker button.cur{background:rgba(255,158,181,.34)}
  #picker button i{font-style:normal;font-size:18px}#picker button span{font-size:10px;color:var(--ink2)}

  #toast{position:fixed;left:50%;top:70px;translate:-50% 0;padding:8px 16px;border-radius:99px;background:rgba(255,158,181,.94);color:#44222f;font-size:12.5px;
    opacity:0;transform:translateY(-8px);pointer-events:none;transition:opacity .22s var(--ease),transform .3s var(--ease);white-space:nowrap;box-shadow:0 8px 20px -10px rgba(0,0,0,.5)}
  #toast.show{opacity:1;transform:none}
  #load{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none;color:var(--ink2);transition:opacity .6s}
  #load.gone{opacity:0}
  #load .ring{width:46px;height:46px;border-radius:50%;border:2px solid rgba(255,255,255,.14);border-top-color:var(--acc);animation:spin 1s linear infinite;margin:0 auto 12px}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes pop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}
  @media (max-width:760px){#side{display:none}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div id="bg"></div>
<div id="stage"></div>
<div id="load"><div><div class="ring"></div>她在换衣服…（第一次载入模型约 5 秒）</div></div>

<div id="head" class="glass"><b id="hEmo">😌</b><div><div class="nm" id="hName">平静</div><div class="st" id="hSt"><i></i><span id="hStT">舞台里</span></div></div></div>

<aside id="side" class="glass">
  <h3>她发过的自拍 <small id="hCount"></small></h3>
  <div id="hist"><div class="empty">还没有。<br>她在 QQ 里发自拍，或你点「拍照」，<br>都会存在这里，下次直接发。</div></div>
</aside>

<div id="picker" class="glass"><h4>点一个，她演给你看（几秒后回到当前心情）</h4><div class="grid" id="grid"></div></div>

<div id="dock" class="glass">
  <button id="bExpr"><i>🎭</i><span>表情</span></button>
  <button id="bSnap"><i>📸</i><span>拍照</span></button>
  <button id="bView"><i>🧍</i><span>全身</span></button>
  <button id="bFps" title="渲染帧率上限：点一下在 30 / 60 / 120 / 240 之间切换（会记住）"><i>⚡</i><span>60fps</span></button>
  <button id="bHist"><i>🗂️</i><span>历史</span></button>
  <span class="div"></span>
  <button id="bDesk" class="go" title="把她请到桌面上，这里的舞台就空出来了"><i>🖥️</i><span>去桌面</span></button>
</div>
<div id="toast"></div>

<script src="/media/her/vendor/pixi.min.js"></script>
<script src="/media/her/vendor/unsafe-eval.min.js"></script>
<script src="/media/her/vendor/live2dcubismcore.min.js"></script>
<script src="/media/her/vendor/live2d.min.js"></script>
<script>
(function(){
  var Q=new URLSearchParams(location.search), TOKEN=Q.get('token')||'', EMBED=Q.get('embed')==='1';
  function api(p,opt){ return fetch(p+(p.indexOf('?')<0?'?':'&')+'token='+encodeURIComponent(TOKEN),Object.assign({cache:'no-store'},opt||{})).then(function(r){return r.json();}); }
  var $=function(id){return document.getElementById(id);};

  var MOOD_EXPR={开心:'爱心眼',好奇:'圈圈眼',得意:'屑屑眼',害羞:'脸红',生气:'＞＜',吃醋:'黑脸',委屈:'流泪',难过:'流泪',害怕:'流冷汗',平静:''};
  var MOOD_EMO={开心:'😊',生气:'😠',害羞:'😳',吃醋:'😤',委屈:'🥺',难过:'😢',好奇:'🤔',得意:'😏',害怕:'😨',平静:'😌'};
  var MOOD_COL={开心:'#ffb86b',生气:'#ff6b6b',害羞:'#ff9eb5',吃醋:'#9a6bff',委屈:'#6fb7ff',难过:'#6f8cff',好奇:'#7fe0c4',得意:'#ffd36b',害怕:'#9aa7c7',平静:'#7f9cff'};
  var EMO_EXPRS=['脸红','爱心眼','屑屑眼','圈圈眼','流冷汗','流泪','黑脸','＞＜','兔牙'];
  var model=null,exprName='',moodExpr='',lastMood='',viewFraction=0.5,previewTimer=null;
  var look={x:0,y:0},lookT={x:0,y:0},mouth=0,toastTimer=0;

  function toast(t,ms){var e=$('toast');e.textContent=t;e.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(function(){e.classList.remove('show');},ms||2400);}

  // ── 画质 / 性能分档：先看这块 canvas 落在哪块 GPU 上 ──
  // 这模型 5 张贴图解码后接近 600MB。落在核显（共享内存）上就是灾难：显存不够就换页，
  // 一帧能拖到十几毫秒；落在独显上连 8GB 的一成都用不到，随便拉满。
  // 所以不写死参数，先问 GL 自己是谁：
  //   独显 → 全画质（1.5~2 倍像素、开抗锯齿、60fps、毛玻璃保留）
  //   核显 → 性能档（1 倍像素、关抗锯齿、30fps、毛玻璃换实心底）
  // 手动覆盖：?perf=1 / ?quality=1 / ?fpsmax=120
  function glInfo(){
    try{
      var c=document.createElement('canvas');
      var gl=c.getContext('webgl2')||c.getContext('webgl');
      if(!gl)return {name:'(没有 WebGL)',max:0};
      var e=gl.getExtension('WEBGL_debug_renderer_info');
      var name=e?String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)):'(读不出来)';
      return {name:name,max:Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))||0};
    }catch(e){return {name:'(读不出来)',max:0};}
  }
  var GPU=glInfo();
  var DISCRETE=/nvidia|geforce|rtx|gtx|quadro|radeon|\brx\s?\d{3,}|arc\s?a\d/i.test(GPU.name) && !/intel|uhd|iris/i.test(GPU.name);
  var PERF=Q.get('perf')==='1' || (!(Q.get('quality')==='1') && !DISCRETE);
  var FPSMAX=Math.max(15,Math.min(240,parseInt(Q.get('fpsmax')||'',10)||(PERF?30:60)));
  // 帧率档：底部工具条的 ⚡ 点一下在 30 → 60 → 120 → 240 之间循环，选择记在 localStorage。
  // 独显上 120/240 都吃得下，屏幕本身就是 240Hz，所以 240 是真能显示出来的；
  // 代价是 CPU 每帧都要跑一遍 Cubism 更新（物理 131 组），笔记本上会热、会费电。
  var FPS_STEPS=[30,60,120,240];
  try{
    var savedFps=parseInt(localStorage.getItem('her-fps')||'',10)||0;
    if(savedFps&&!Q.get('fpsmax'))FPSMAX=Math.max(15,Math.min(240,savedFps));
  }catch(e){}
  var app=new PIXI.Application({backgroundAlpha:0,resizeTo:window,antialias:!PERF,autoDensity:!PERF,
    resolution:PERF?1:Math.min(window.devicePixelRatio||1,2)});
  app.ticker.maxFPS=FPSMAX;
  if(PERF)document.body.classList.add('perf');
  $('stage').appendChild(app.view);
  function paintFps(){
    var b=$('bFps');if(!b)return;
    b.querySelector('span').textContent=FPSMAX+'fps';
    b.classList.toggle('on',FPSMAX>=120);
  }
  function setFps(v){
    FPSMAX=Math.max(15,Math.min(240,v));
    app.ticker.maxFPS=FPSMAX;
    try{localStorage.setItem('her-fps',String(FPSMAX));}catch(e){}
    paintFps();
  }
  // 看不见的时候别画：面板把她收起、浏览器标签切走、或者她去桌面了，都停掉 ticker。
  function tickStop(){ try{ app.ticker.stop(); }catch(e){} }
  function tickStart(){ try{ app.ticker.start(); }catch(e){} }
  document.addEventListener('visibilitychange',function(){ if(document.hidden)tickStop(); else tickStart(); });
  // ?fps=1：右下角显示帧率 / 上限 / 画质档 / 画布尺寸，第二行是这块 canvas 实际用的 GPU。
  // 想确认「是不是还在核显上跑」，看第二行那串 renderer 里有没有 NVIDIA。
  var fpsEl=null,fpsFrames=0;
  var gpuSafe=String(GPU.name).replace(/[&<>]/g,function(ch){return ch==='&'?'&amp;':ch==='<'?'&lt;':'&gt;';});
  if(Q.get('fps')==='1'){
    fpsEl=document.createElement('div');
    fpsEl.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9;font:12px/1.45 ui-monospace,monospace;color:#9fe6ff;background:rgba(0,0,0,.72);padding:6px 10px;border-radius:8px;pointer-events:none;max-width:min(92vw,560px)';
    fpsEl.innerHTML='<div id="fpsA">FPS —</div><div style="opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+gpuSafe+'</div>';
    document.body.appendChild(fpsEl);
    setInterval(function(){
      var a=document.getElementById('fpsA');
      if(!a)return;
      a.textContent='FPS '+(fpsFrames*2)+' / 上限 '+FPSMAX+' · '+(PERF?'性能档':'画质档')+' · '+app.renderer.width+'×'+app.renderer.height+' · '+(document.hidden?'hidden':'vis');
      fpsFrames=0;
    },500);
    app.ticker.add(function(){ fpsFrames++; });
  }

  function fit(){
    if(!model)return;
    var sw=app.screen.width, sh=app.screen.height;
    var bw=model.width/(model.scale.x||1), bh=model.height/(model.scale.y||1);
    if(!(bw>0&&bh>0))return;
    // 舞台里她在偏左，给右侧的历史栏留位置
    var s=sh/(bh*viewFraction)*0.94;
    model.scale.set(s);
    var reserve=($('side').classList.contains('hide')||innerWidth<760)?0:250;
    model.x=(sw-reserve-model.width)/2;
    model.y=sh*0.03;
  }
  addEventListener('resize',function(){app.renderer.resize(innerWidth,innerHeight);fit();});

  function setExpression(name){
    if(name===exprName||!model)return;
    exprName=name||'';
    try{ if(exprName)model.expression(exprName); else model.expression(); }catch(e){}
    var cur=document.querySelectorAll('#grid button');
    for(var i=0;i<cur.length;i++)cur[i].classList.toggle('cur',cur[i].dataset.expr===exprName&&!!exprName);
  }

  function boot(){
    PIXI.live2d.Live2DModel.from('/media/her/model/'+encodeURIComponent('大肥鱼.model3.json'),{autoInteract:false}).then(function(m){
      model=m;
      // 不再强制开 mipmap：这模型 5 张贴图解码后接近 600MB，再生成一遍 mip 链要额外
      // 三成显存和一次巨大的上传，换来的只是缩小时少一点闪烁。
      app.stage.addChild(m);m.autoUpdate=true;fit();tickStart();
      var core=m.internalModel.coreModel,orig=core.update.bind(core);
      core.update=function(){
        try{
          look.x+=(lookT.x-look.x)*0.14;look.y+=(lookT.y-look.y)*0.14;
          var t=performance.now()/1000;
          core.setParameterValueById('ParamMouthOpenY',mouth,1);
          core.setParameterValueById('ParamBreath',(Math.sin(t*1.1)+1)/2,1);
          core.setParameterValueById('ParamEyeBallX',look.x*0.95,1);core.setParameterValueById('ParamEyeBallY',look.y*0.85,1);
          core.setParameterValueById('ParamAngleX',look.x*24+Math.sin(t*0.31)*1.5,1);core.setParameterValueById('ParamAngleY',look.y*16,1);
          core.setParameterValueById('ParamAngleZ',look.x*5,1);core.setParameterValueById('ParamBodyAngleX',look.x*8,1);
        }catch(e){}
        orig();
      };
      $('load').classList.add('gone');
      scheduleIdle();
    }).catch(function(e){ $('load').innerHTML='<div style="color:#ffb4b4">模型没加载出来：'+(e&&e.message?e.message:e)+'</div>'; });
  }

  // 眼睛跟着鼠标走；鼠标不动就自己瞟一眼别处
  var lastMove=Date.now();
  addEventListener('pointermove',function(e){
    lastMove=Date.now();
    lookT.x=Math.max(-1,Math.min(1,(e.clientX/innerWidth-0.5)*2));
    lookT.y=Math.max(-1,Math.min(1,-(e.clientY/innerHeight-0.35)*1.6));
  });
  setInterval(function(){ if(Date.now()-lastMove<8000)return; lookT.x=(Math.random()*2-1)*0.7; lookT.y=(Math.random()*2-1)*0.4; },3400);
  function scheduleIdle(){
    setTimeout(function(){
      if(!model||moodExpr||exprName){scheduleIdle();return;}
      setExpression(EMO_EXPRS[Math.floor(Math.random()*EMO_EXPRS.length)]);
      setTimeout(function(){if(!moodExpr)setExpression('');scheduleIdle();},2600+Math.random()*3000);
    },12000+Math.random()*30000);
  }

  // ── 表情面板 ──
  var LIST=[['开心','😊'],['害羞','😳'],['生气','😠'],['吃醋','😤'],['委屈','🥺'],['难过','😢'],['好奇','🤔'],['得意','😏'],['害怕','😨'],['平静','😌'],['爱心眼','😍'],['圈圈眼','😵‍💫'],['流冷汗','😅'],['兔牙','🐰'],['默认','🙂']];
  LIST.forEach(function(it){
    var b=document.createElement('button'),n=it[0],isMood=MOOD_EXPR.hasOwnProperty(n);
    b.dataset.expr=isMood?(MOOD_EXPR[n]||''):(n==='默认'?'':n);b.title=n;b.innerHTML='<i>'+it[1]+'</i><span>'+n+'</span>';
    b.onclick=function(){
      if(!model)return;clearTimeout(previewTimer);moodExpr='';setExpression(b.dataset.expr);
      previewTimer=setTimeout(function(){moodExpr=MOOD_EXPR[lastMood]||'';setExpression(moodExpr);},4200);
    };
    $('grid').appendChild(b);
  });
  $('bExpr').onclick=function(){var o=$('picker').classList.toggle('open');$('bExpr').classList.toggle('on',o);};
  addEventListener('mousedown',function(e){var p=$('picker');if(!p.classList.contains('open'))return;if(e.target.closest&&e.target.closest('#picker,#bExpr'))return;p.classList.remove('open');$('bExpr').classList.remove('on');});

  $('bView').onclick=function(){
    viewFraction=viewFraction>0.72?0.5:1;
    $('bView').querySelector('i').textContent=viewFraction>0.72?'👤':'🧍';
    $('bView').querySelector('span').textContent=viewFraction>0.72?'半身':'全身';fit();
  };
  $('bHist').onclick=function(){var h=$('side').classList.toggle('hide');$('bHist').classList.toggle('on',!h);fit();};
  $('bHist').classList.add('on');
  // ⚡ 帧率档
  $('bFps').onclick=function(){
    var i=FPS_STEPS.indexOf(FPSMAX);
    setFps(FPS_STEPS[(i+1)%FPS_STEPS.length]);
    toast('渲染上限 '+FPSMAX+'fps · '+(PERF?'性能档':'画质档'),2000);
  };
  paintFps();

  // ── 拍照：直接在舞台里把 canvas 做成带描边的贴纸，下载并复制到剪贴板 ──
  function stickerFromCanvas(src){
    var w=src.width,h=src.height,c=document.createElement('canvas');c.width=w;c.height=h;var g=c.getContext('2d');g.drawImage(src,0,0);
    var d=g.getImageData(0,0,w,h).data,x0=w,y0=h,x1=-1,y1=-1;
    for(var y=0;y<h;y+=2)for(var x=0;x<w;x+=2){if(d[(y*w+x)*4+3]>12){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}}
    if(x1<0)return null;
    var bw=x1-x0+2,bh=y1-y0+2; if(viewFraction<=0.72&&bh>bw*1.3)bh=Math.round(Math.max(bw*1.2,bh*0.5));
    var sc=Math.min(1,380/Math.max(bw,bh)),W=Math.round(bw*sc),H=Math.round(bh*sc),P=18,o=document.createElement('canvas');o.width=W+P*2;o.height=H+P*2;
    var og=o.getContext('2d'),cut=document.createElement('canvas');cut.width=W;cut.height=H;cut.getContext('2d').drawImage(c,x0,y0,bw,bh,0,0,W,H);
    // 白描边：把剪影沿 16 个方向各偏移一圈，再盖上本体
    var white=document.createElement('canvas');white.width=W;white.height=H;var wg=white.getContext('2d');wg.drawImage(cut,0,0);wg.globalCompositeOperation='source-in';wg.fillStyle='#fff';wg.fillRect(0,0,W,H);
    og.shadowColor='rgba(40,40,80,.35)';og.shadowBlur=8;og.shadowOffsetY=3;
    for(var a=0;a<16;a++){og.drawImage(white,P+Math.cos(a/16*6.283)*6,P+Math.sin(a/16*6.283)*6);}
    og.shadowColor='transparent';og.drawImage(cut,P,P);return o;
  }
  var busy=false;
  $('bSnap').onclick=function(){
    if(busy||!model)return;busy=true;$('bSnap').classList.add('on');
    app.renderer.render(app.stage);
    var s=stickerFromCanvas(app.view);
    if(!s){toast('没拍到她（画面是空的）');busy=false;$('bSnap').classList.remove('on');return;}
    s.toBlob(function(blob){
      var done=function(ok){
        toast(ok?'📸 拍好了，已复制，直接粘贴就能发':'📸 拍好了（没能复制到剪贴板，已存进历史）',3000);
        api('/api/her/stickers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({png:s.toDataURL('image/png').split(',')[1],expression:exprName||lastMood||'默认'})}).then(loadHist).catch(function(){});
        busy=false;$('bSnap').classList.remove('on');
      };
      try{navigator.clipboard.write([new ClipboardItem({'image/png':blob})]).then(function(){done(true);},function(){done(false);});}catch(e){done(false);}
    },'image/png');
  };

  // ── 自拍历史：她发过的、你拍过的，都存着；点一下复制 ──
  function loadHist(){
    api('/api/her/stickers').then(function(j){
      var items=(j&&j.items)||[];$('hCount').textContent=items.length?items.length+' 张':'';
      if(!items.length)return;
      var host=$('hist');host.textContent='';
      items.forEach(function(it,i){
        var c=document.createElement('div');c.className='card';c.style.animationDelay=Math.min(i,10)*0.03+'s';c.title='点一下复制到剪贴板';
        c.innerHTML='<img loading="lazy" src="/api/her/sticker?name='+encodeURIComponent(it.name)+'&token='+encodeURIComponent(TOKEN)+'"><span>'+(it.expression||'自拍')+'</span>'+(it.sent?'<i class="n">发过 '+it.sent+'</i>':'');
        c.onclick=function(){
          fetch(c.querySelector('img').src).then(function(r){return r.blob();}).then(function(b){return navigator.clipboard.write([new ClipboardItem({'image/png':b})]);}).then(function(){toast('已复制这张：直接粘贴就能发');},function(){toast('复制不了，右键图片另存吧');});
        };
        host.appendChild(c);
      });
    }).catch(function(){});
  }

  // ── 心情 / 状态同步 ──
  function poll(){
    api('/api/her/state').then(function(j){
      if(!j||!j.ok)return;
      var emo=j.mood||'';
      if(emo!==lastMood){
        lastMood=emo;$('hEmo').textContent=MOOD_EMO[emo]||'😌';$('hName').textContent=emo||'平静';
        document.documentElement.style.setProperty('--mood',MOOD_COL[emo]||'#7f9cff');
        $('bg').style.setProperty('--mood',MOOD_COL[emo]||'#7f9cff');
        moodExpr=MOOD_EXPR[emo]||'';if(!previewTimer||true){setExpression(moodExpr);}
      }
      var onDesk=!!j.deskRunning;
      $('hSt').classList.toggle('on',true);
      $('hStT').textContent=onDesk?'桌面和这里同时开着':'在这个舞台里';
      $('bDesk').querySelector('span').textContent=onDesk?'收回来':'去桌面';
      $('bDesk').dataset.desk=onDesk?'1':'';
    }).catch(function(){});
  }
  // ── 舞台 ⇄ 桌面：交接。去桌面 = 这里淡出、桌面窗叫出来；收回来 = 桌面窗收起、这里重新淡入 ──
  $('bDesk').onclick=function(){
    var toDesk=$('bDesk').dataset.desk!=='1';
    $('bDesk').disabled=true;
    if(toDesk){
      $('stage').style.transition='opacity .7s cubic-bezier(.22,1,.36,1),transform .7s cubic-bezier(.22,1,.36,1)';
      $('stage').style.opacity='.0';$('stage').style.transform='translateX(30px) scale(.97)';
      toast('她走到桌面上去了 →',2600);
      setTimeout(tickStop,760); // 舞台空了就别画了，把显存留给桌面窗
    }
    api('/api/her/desk?action='+(toDesk?'open':'close'),{method:'POST'}).then(function(){
      setTimeout(function(){
        if(!toDesk){$('stage').style.opacity='1';$('stage').style.transform='none';toast('她回到这个舞台了');tickStart();}
        $('bDesk').disabled=false;poll();
      },toDesk?900:1300);
    }).catch(function(){$('bDesk').disabled=false;$('stage').style.opacity='1';$('stage').style.transform='none';});
  };

  if(EMBED){$('head').style.left='22px';}
  boot();loadHist();poll();setInterval(poll,4000);setInterval(loadHist,20000);
  window.addEventListener('message',function(e){
    var m=e&&e.data;
    if(m==='her-visible'||m==='her-show'){ fit(); tickStart(); }
    else if(m==='her-hide'){ tickStop(); }
  });
})();
</script>
</body></html>`;
}
