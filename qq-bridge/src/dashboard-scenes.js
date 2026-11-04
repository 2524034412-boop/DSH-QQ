// Twilight-atmosphere layer: the reference art is graded down into light, not
// reproduced as a poster. One CSS image per scene, heavily blurred and veiled,
// so type keeps its contrast at every viewport size.
export const sceneStyles = `
.ambient{position:fixed;inset:0;z-index:-3;pointer-events:none;overflow:hidden;background:#07090e}
.ambient-img{position:absolute;inset:-12%;background-image:var(--scene-image);background-size:cover;background-position:center 42%;
  filter:blur(34px) saturate(.95) brightness(.66) contrast(1.04);opacity:1;transform:scale(1.06);
  transition:opacity 1.4s var(--ease-in-out),filter 1.4s var(--ease-in-out)}
.ambient-veil{position:absolute;inset:0;background:
  radial-gradient(120% 70% at 50% -10%,rgba(8,10,16,.06),rgba(8,10,16,.72) 66%,#08090b 96%),
  linear-gradient(180deg,rgba(7,9,14,.58) 0%,rgba(7,9,14,.28) 42%,rgba(6,8,12,.82) 100%)}
.ambient-horizon{position:absolute;left:0;right:0;top:58%;height:42%;opacity:.55;mix-blend-mode:screen;
  background:radial-gradient(58% 100% at 50% 0%,var(--scene-warm,rgba(240,200,164,.5)),transparent 72%);
  filter:blur(46px)}
.ambient-grain{position:absolute;inset:0;opacity:.16;mix-blend-mode:overlay;
  background-image:repeating-linear-gradient(115deg,rgba(255,255,255,.055) 0 1px,transparent 1px 3px),
  repeating-linear-gradient(25deg,rgba(255,255,255,.035) 0 1px,transparent 1px 4px)}
.ambient-bokeh{position:absolute;inset:-6%;opacity:.5;filter:blur(2px);
  background:
    radial-gradient(circle at 12% 22%,rgba(244,208,176,.34) 0 1.1%,transparent 3.2%),
    radial-gradient(circle at 78% 16%,rgba(214,226,255,.24) 0 .9%,transparent 2.6%),
    radial-gradient(circle at 64% 74%,rgba(246,198,150,.28) 0 1.3%,transparent 3.6%),
    radial-gradient(circle at 28% 82%,rgba(196,214,255,.2) 0 1%,transparent 3%),
    radial-gradient(circle at 90% 54%,rgba(255,214,178,.22) 0 .8%,transparent 2.4%);
  animation:bokehDrift 42s var(--ease-in-out) infinite alternate}
@keyframes bokehDrift{from{transform:translate3d(-1.4%,1%,0) scale(1.02)}to{transform:translate3d(1.6%,-1.2%,0) scale(1.06)}}
body[data-scene="dusk"]{--scene-image:url('/media/scene/dusk-atmo.jpg');--scene-plate:url('/media/scene/dusk.jpg');--scene-focus:46%;--scene-warm:rgba(248,186,132,.55);--scene-accent:#f3c9a8}
body[data-scene="terrace"]{--scene-image:url('/media/scene/terrace-atmo.jpg');--scene-plate:url('/media/scene/terrace.jpg');--scene-focus:20%;--scene-warm:rgba(196,214,255,.42);--scene-accent:#c9d8f2}
body[data-scene="sea"]{--scene-image:url('/media/scene/sea-atmo.jpg');--scene-plate:url('/media/scene/sea.jpg');--scene-focus:17%;--scene-warm:rgba(252,196,158,.55);--scene-accent:#f6d3b4}
body[data-scene="bokeh"]{--scene-image:url('/media/scene/bokeh-atmo.jpg');--scene-plate:url('/media/scene/bokeh.jpg');--scene-focus:38%;--scene-warm:rgba(238,206,196,.5);--scene-accent:#f2d6cc}
#appShell::before{display:none}
.hero{min-height:600px}
.hero-art{filter:none;perspective:1200px}
.scene-plate{position:absolute;inset:1% -2% 5% 5%;border-radius:34px;overflow:hidden;
  background-image:var(--scene-plate);background-size:cover;background-position:center var(--scene-focus,40%);
  box-shadow:0 44px 120px -30px rgba(0,0,0,.9),inset 0 0 0 1px rgba(255,255,255,.09);
  filter:saturate(.96) brightness(.92) contrast(1.02);will-change:transform;
  transition:background-image .01s,filter .8s var(--ease-out),transform .9s var(--ease-out)}
.scene-plate::before{content:'';position:absolute;inset:0;
  background:radial-gradient(120% 90% at 24% 12%,rgba(255,236,214,.16),transparent 46%),
    linear-gradient(180deg,rgba(6,8,13,0) 26%,rgba(6,8,13,.42) 72%,rgba(6,8,13,.78) 100%),
    linear-gradient(96deg,rgba(6,8,13,.62) 0%,rgba(6,8,13,.05) 42%,rgba(6,8,13,.28) 100%)}
.scene-plate::after{content:'';position:absolute;inset:0;box-shadow:inset 0 0 90px 30px rgba(6,8,13,.5)}
.scene-plate-tag{position:absolute;right:20px;bottom:18px;z-index:2;font-size:9px;letter-spacing:.24em;color:rgba(238,243,252,.62)}
.orb{position:absolute;left:-1%;bottom:-3%;z-index:2;width:min(270px,23vw);transform:rotate(-18deg);
  animation:orbFloat 14s var(--ease-in-out) infinite alternate;
  box-shadow:inset -15px -12px 30px #000,inset 1px 1px 2px rgba(255,255,255,.85),0 35px 90px rgba(0,0,0,.9),-30px -26px 110px rgba(246,190,150,.16),30px 20px 90px rgba(120,160,230,.12)}
.orb::after{border-color:rgba(246,206,178,.3)}
.orb-caption{position:absolute;left:0;right:0;bottom:-6px;z-index:3;text-align:center;color:rgba(196,206,222,.66)}
.scene-switch{display:inline-flex;align-items:center;gap:8px}
.scene-dot{width:7px;height:7px;border-radius:50%;background:var(--scene-accent,#f3c9a8);box-shadow:0 0 12px var(--scene-accent,#f3c9a8);transition:background .6s var(--ease-out),box-shadow .6s var(--ease-out)}
.context-strip{border-top-color:rgba(255,255,255,.07)}
.kpis{background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border-color:rgba(255,255,255,.08)}
.kpi{background:linear-gradient(165deg,rgba(22,26,34,.92),rgba(15,18,24,.94))}
main>section{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;border-color:rgba(255,255,255,.075)}
main>section:hover{border-color:rgba(246,206,178,.16);box-shadow:0 18px 60px -28px rgba(0,0,0,.9),0 0 0 1px rgba(246,206,178,.05)}
header{background:rgba(8,10,14,.66);backdrop-filter:none;-webkit-backdrop-filter:none}
.brand-mark svg path,.brand-mark svg circle{filter:drop-shadow(0 0 6px rgba(226,236,255,.18))}
.button-primary{background:linear-gradient(180deg,#fff,#e9edf6);color:#0d0f13}
.memory-preview{background:radial-gradient(circle,rgba(246,204,170,.12),transparent 62%)}
.memory-preview i:nth-child(1){background:#f5e6d6;box-shadow:0 0 20px rgba(246,208,174,.8)}
#bootsplash{isolation:isolate}
#bootsplash::before{content:'';position:absolute;inset:0;background-image:url('/media/scene/bokeh-atmo.jpg');background-size:cover;background-position:center;
  filter:blur(46px) saturate(.8) brightness(.5);opacity:.68;transform:scale(1.08)}
#bootsplash::after{content:'';position:absolute;inset:0;background:radial-gradient(60% 50% at 50% 45%,rgba(6,8,13,.1),rgba(5,7,11,.9) 78%),linear-gradient(180deg,rgba(5,7,11,.5),rgba(5,7,11,.94))}
.bhero,.boot-caption{position:relative;z-index:2}
.boot-halo{background:radial-gradient(ellipse,rgba(255,206,168,.2) 0%,rgba(120,152,226,.1) 36%,transparent 64%)}
@media(max-width:680px){.hero{min-height:0}.hero-art{min-height:300px;margin-bottom:26px}.scene-plate{inset:-2% -8% 0 -8%;border-radius:24px;background-position:center 28%}.orb{width:min(150px,38vw);left:6%;bottom:-6%}.orb-caption{display:none}.ambient-img{filter:blur(30px) saturate(.9) brightness(.6)}.ambient-bokeh{opacity:.36}}
@media(prefers-reduced-motion:reduce){.ambient-bokeh{animation:none}.ambient-img{transition:none}.orb{animation:none}}
`;

// Scene order matches the reference set: dusk city, seaside terrace, sunset sea, winter bokeh.
export const sceneScript = String.raw`
(function sceneAtmosphere(){
  var scenes=[['dusk','暮色'],['terrace','海岸'],['sea','落日'],['bokeh','雪夜']];
  var saved='dusk';try{saved=localStorage.getItem('whale-scene')||'dusk';}catch(e){}
  if(!scenes.some(function(s){return s[0]===saved;})) saved='dusk';
  var button=document.getElementById('sceneSwitch'), label=document.getElementById('sceneLabel');
  function apply(id,silent){
    document.body.dataset.scene=id;
    var item=scenes.filter(function(s){return s[0]===id;})[0]||scenes[0];
    if(label) label.textContent=item[1];
    if(button) button.setAttribute('aria-label','切换背景氛围，当前：'+item[1]);
    if(!silent){try{localStorage.setItem('whale-scene',id);}catch(e){}}
  }
  apply(saved,true);
  if(button) button.addEventListener('click',function(){
    var i=scenes.findIndex(function(s){return s[0]===document.body.dataset.scene;});
    apply(scenes[(i+1)%scenes.length][0],false);
  });
  // Gentle depth: the plate drifts a few pixels with the pointer. Transform only,
  // and never on a reduced-motion or touch-only device.
  var plate=document.querySelector('.scene-plate'), art=document.querySelector('.hero-art');
  var fine=window.matchMedia('(hover:hover) and (pointer:fine)').matches;
  var calm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(plate && art && fine && !calm){
    var raf=0,px=0,py=0;
    art.addEventListener('pointermove',function(e){
      var r=art.getBoundingClientRect();
      px=((e.clientX-r.left)/r.width-.5)*10;py=((e.clientY-r.top)/r.height-.5)*8;
      if(!raf) raf=requestAnimationFrame(function(){raf=0;plate.style.transform='translate3d('+px.toFixed(2)+'px,'+py.toFixed(2)+'px,0) scale(1.012)';});
    },{passive:true});
    art.addEventListener('pointerleave',function(){if(raf){cancelAnimationFrame(raf);raf=0;}plate.style.transform='none';},{passive:true});
  }
})();
`;
