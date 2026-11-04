// String.raw keeps the delivered browser code identical to the authored code.
export const dashboardScript = String.raw`
(function bootAnim(){
  const el=document.getElementById('boot'), splash=document.getElementById('bootsplash');
  const shell=document.getElementById('appShell'), skip=document.getElementById('bootskip');
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let finishTimer=0,hideTimer=0,restoreFocus=null;
  function enter(){document.body.classList.add('entered');if(shell) shell.inert=false;}
  function finish(){
    clearTimeout(finishTimer);clearTimeout(hideTimer);
    try{sessionStorage.setItem('whale-cinematic-seen','1');}catch(e){}
    el.classList.add('out');el.setAttribute('aria-hidden','true');el.inert=true;enter();
    hideTimer=setTimeout(function(){el.style.display='none';if(restoreFocus) restoreFocus.focus();},reduced?0:950);
  }
  window.replayBoot=function(){
    if(reduced){enter();return;}
    restoreFocus=document.activeElement;
    clearTimeout(finishTimer);clearTimeout(hideTimer);
    document.body.classList.remove('entered');shell.inert=true;
    el.style.display='grid';el.inert=false;el.setAttribute('aria-hidden','false');el.classList.remove('out');
    splash.classList.remove('on');void splash.offsetWidth;
    requestAnimationFrame(function(){splash.classList.add('on');skip.focus();});
    finishTimer=setTimeout(finish,13700);
  };
  if(skip) skip.addEventListener('click',finish);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!el.inert){e.preventDefault();finish();}});
  let seen=false;try{seen=sessionStorage.getItem('whale-cinematic-seen')==='1';}catch(e){}
  const params=new URLSearchParams(location.search);
  if(reduced || (params.get('intro')!=='1' && (params.get('auto')==='1'||seen))){el.style.display='none';el.inert=true;el.setAttribute('aria-hidden','true');enter();}
  else window.replayBoot();
  document.getElementById('replayBoot').addEventListener('click',window.replayBoot);
})();
// The overlay is a modal, not a new app window. Unload only after its exit tween.
var starUnloadTimer=0, starReturnFocus=null;
window.openStar = function(){
  var f=document.getElementById('starFrame'), l=document.getElementById('starLayer');
  if(!f || !l) return;
  clearTimeout(starUnloadTimer);starReturnFocus=document.activeElement;
  var params=new URLSearchParams(location.search);params.set('embed','1');params.delete('intro');
  f.src='/memory?'+params.toString();
  l.inert=false;l.setAttribute('aria-hidden','false');l.classList.add('on');
  document.body.classList.add('star-open');document.getElementById('appShell').inert=true;
  document.getElementById('starClose').focus();
};
window.closeStar = function(){
  var f=document.getElementById('starFrame'), l=document.getElementById('starLayer');
  if(!l) return;
  l.classList.remove('on');l.inert=true;l.setAttribute('aria-hidden','true');
  document.body.classList.remove('star-open');document.getElementById('appShell').inert=false;
  if(starReturnFocus) starReturnFocus.focus();
  starUnloadTimer=setTimeout(function(){if(f && !l.classList.contains('on')) f.src='about:blank';},720);
};
document.addEventListener('keydown', function(e){
  var l=document.getElementById('starLayer');
  if(e.key==='Escape' && l && l.classList.contains('on')){e.preventDefault();window.closeStar();}
  if(e.key==='Tab' && l && l.classList.contains('on')){
    const close=document.getElementById('starClose'), frame=document.getElementById('starFrame');
    if(e.shiftKey && document.activeElement===frame){e.preventDefault();close.focus();}
    else if(!e.shiftKey && document.activeElement===close){e.preventDefault();frame.focus();}
  }
});
(function starLayerWire(){
  var btn=document.getElementById('starClose'),layer=document.getElementById('starLayer');layer.inert=true;
  if(btn) btn.addEventListener('click', function(){window.closeStar();});
  window.addEventListener('message', function(e){
    var f=document.getElementById('starFrame');
    if(e && e.origin===location.origin && f && e.source===f.contentWindow && e.data==='close-star') window.closeStar();
  });
})();
function tick(){document.getElementById('clk').textContent=new Date().toLocaleString('zh-CN',{hour12:false});}
tick();setInterval(tick,1000);
// Native buttons, an animated CSS grid accordion and persisted reading position.
const panels=Array.from(document.querySelectorAll('main > section'));
let saved={};try{saved=JSON.parse(sessionStorage.getItem('whale-dashboard-layout')||'{}');}catch(e){}
function setPanel(sec,collapsed){
  sec.classList.toggle('collapsed',collapsed);
  sec.querySelector('.section-toggle').setAttribute('aria-expanded',String(!collapsed));
  const body=sec.querySelector('.section-body');body.inert=collapsed;
  saved[sec.dataset.panelId]=collapsed;
  try{sessionStorage.setItem('whale-dashboard-layout',JSON.stringify(saved));}catch(e){}
}
panels.forEach(function(sec,index){
  const h=sec.querySelector('h2');if(!h) return;
  sec.dataset.panelId='panel-'+index;sec.classList.add('collapsible','reveal');
  const title=h.textContent;h.textContent='';
  const button=document.createElement('button');button.type='button';button.className='section-toggle';
  const number=document.createElement('span');number.className='section-index';number.textContent=String(index+1).padStart(2,'0');number.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.textContent=title;
  const arrow=document.createElement('span');arrow.className='section-chevron';arrow.textContent='⌄';arrow.setAttribute('aria-hidden','true');
  button.append(number,label,arrow);h.append(button);
  const body=document.createElement('div'),content=document.createElement('div');
  body.className='section-body';body.id='panel-content-'+index;content.className='section-content';
  button.setAttribute('aria-controls',body.id);
  Array.from(sec.childNodes).forEach(function(node){if(node!==h) content.append(node);});
  body.append(content);sec.append(body);
  setPanel(sec,Boolean(saved[sec.dataset.panelId]));
  button.addEventListener('click',function(){setPanel(sec,!sec.classList.contains('collapsed'));});
});
document.getElementById('expAll').addEventListener('click',function(){panels.forEach(s=>setPanel(s,false));});
document.getElementById('colAll').addEventListener('click',function(){panels.forEach(s=>setPanel(s,true));});
// Reveal only in-view panels; no scroll handler or ever-growing active layer list.
if('IntersectionObserver' in window){
  document.body.classList.add('ui-ready');
  const observer=new IntersectionObserver(function(entries){
    entries.forEach(function(entry){if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target);}});
  },{threshold:.05,rootMargin:'0px 0px -20px 0px'});
  document.querySelectorAll('.reveal').forEach(function(el,index){el.style.setProperty('--reveal-delay',((index%2)*80)+'ms');observer.observe(el);});
}
// Authenticated existing actions; none are invoked during page construction.
document.querySelectorAll('[data-panel-action]').forEach(function(btn){
  btn.addEventListener('click',async function(){
    btn.disabled=true;
    try{const url=new URL(btn.dataset.panelAction,location.origin);url.searchParams.set('token',new URLSearchParams(location.search).get('token')||'');
      const r=await fetch(url,{cache:'no-store'});if(!r.ok) throw new Error('操作失败，请重试');
    }catch(e){alert(e.message);}finally{btn.disabled=false;}
  });
});
document.querySelectorAll('.mdel').forEach(function(btn){
  btn.addEventListener('click',async function(){
    const title=btn.dataset.title;if(!confirm('删除词条「'+title+'」？')) return;
    btn.disabled=true;
    try{const tk=new URLSearchParams(location.search).get('token')||'';
      const r=await fetch('/api/console/meme-user-delete',{method:'POST',headers:{'content-type':'application/json','x-console-token':tk},body:JSON.stringify({title})});
      const j=await r.json();if(!r.ok || !j.ok) throw new Error(j.error||'删除失败');btn.closest('.moment').remove();
    }catch(e){alert(e.message);}finally{btn.disabled=false;}
  });
});
try{const y=Number(sessionStorage.getItem('whale-dashboard-scroll')||0);if(y>0) requestAnimationFrame(()=>window.scrollTo(0,y));}catch(e){}
let lastInputAt=Date.now();['pointerdown','keydown','wheel'].forEach(name=>document.addEventListener(name,()=>lastInputAt=Date.now(),{passive:true}));
setInterval(function(){
  // Never tear down a star-map visit or an in-progress interaction.
  if(document.hidden || document.body.classList.contains('star-open') || !document.getElementById('boot').inert || Date.now()-lastInputAt<5000) return;
  try{sessionStorage.setItem('whale-dashboard-scroll',String(window.scrollY));const u=new URL(location.href);u.searchParams.set('auto','1');u.searchParams.delete('intro');location.replace(u.toString());}catch(e){location.reload();}
},60000);
`;
