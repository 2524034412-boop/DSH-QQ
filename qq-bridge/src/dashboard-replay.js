// 面板「对话回放」：样式 + 前端脚本。
// 和 dashboard-ui / dashboard-motion / dashboard-scenes 同样的形态：导出字符串，由 bridge 拼进页面。
// 数据来自 /api/console/replay（读 state/transcripts/*.jsonl）。

export const replayStyles = `
.rp-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.rp-bar select,.rp-bar button{
  appearance:none;background:rgba(255,255,255,.04);color:var(--txt);
  border:1px solid var(--line);border-radius:12px;padding:7px 12px;font:inherit;font-size:12.5px;
  cursor:pointer;transition:border-color .2s var(--ease-out),background .2s var(--ease-out);
  color-scheme:dark}
/* 下拉展开的那一层是系统绘制的：不给 option 上色，浅色主题下会是白底白字 */
.rp-bar select option{
  background-color:#141619;color:#eef2f8;padding:6px 8px;font-size:12.5px}
.rp-bar select option:checked{background-color:#26344d;color:#fff}
.rp-bar select:hover,.rp-bar button:hover{background:rgba(255,255,255,.07);border-color:rgba(166,202,255,.45)}
.rp-bar #rpInfo{color:var(--muted);font-size:11.5px;margin-left:2px}
.rp-list{
  max-height:560px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;
  padding:16px;border:1px solid var(--line);border-radius:20px;background:rgba(255,255,255,.02);
  scrollbar-width:thin}
.rp-msg{max-width:76%;padding:9px 13px;border-radius:16px;font-size:13px;line-height:1.65;
  background:rgba(255,255,255,.05);border:1px solid var(--line);align-self:flex-start;color:#dfe3ea}
/* 只给最后一屏的几条做入场动画：几百条一起动会让整页卡一下 */
.rp-msg.rp-in{animation:rpIn .34s var(--ease-out) both}
.rp-msg.me{align-self:flex-end;background:linear-gradient(160deg,rgba(90,130,220,.28),rgba(56,86,160,.18));
  border-color:rgba(166,202,255,.32);color:#eaf1ff}
.rp-meta{font-size:10.5px;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}
.rp-msg.me .rp-meta{text-align:right;color:rgba(166,202,255,.72)}
.rp-empty{color:var(--muted);font-size:12.5px;padding:22px 0;text-align:center}
@keyframes rpIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.rp-msg{animation:none}}
`;

export const replayScript = `
(function replayPad(){
  var conv=document.getElementById('rpConv'), daySel=document.getElementById('rpDay');
  var list=document.getElementById('rpList'), info=document.getElementById('rpInfo');
  var btn=document.getElementById('rpReload');
  if(!conv||!list) return;
  var token=new URLSearchParams(location.search).get('token')||'';
  var index=[];
  var started=false;      // 懒加载：滚到这一块才去拉数据
  var MAX=120;            // 一次最多渲染 120 条（原来 300）
  var ANIM_LAST=12;       // 只让最后一屏有入场动画

  function esc(t){ return String(t).replace(/[&<>]/g,function(c){ return c==='&'?'&amp;':(c==='<'?'&lt;':'&gt;'); }); }
  function hhmm(t){ try{ return new Date(t).toLocaleTimeString('zh-CN',{hour12:false}).slice(0,5); }catch(e){ return ''; } }
  function label(d){
    if(d.indexOf('group_')===0) return '群 ' + d.slice(6);
    if(d.indexOf('private_')===0) return '私聊 ' + d.slice(8);
    return d;
  }

  function loadIndex(){
    info.textContent='读取中…';
    fetch('/api/console/replay?token='+encodeURIComponent(token),{cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(!j||!j.ok||!j.dirs||!j.dirs.length){ list.innerHTML='<div class="rp-empty">还没有聊天记录。</div>'; info.textContent=''; return; }
        index=j.dirs;
        conv.innerHTML=index.map(function(d,i){ return '<option value="'+i+'">'+label(d.dir)+' · '+d.count+' 天</option>'; }).join('');
        fillDays(); loadDay();
      })
      .catch(function(){ list.innerHTML='<div class="rp-empty">读取失败。</div>'; info.textContent=''; });
  }
  function fillDays(){
    var d=index[conv.value|0]; if(!d) return;
    daySel.innerHTML=d.days.slice().reverse().map(function(x){ return '<option value="'+x+'">'+x+'</option>'; }).join('');
  }
  function loadDay(){
    var d=index[conv.value|0]; if(!d) return;
    var dayVal=daySel.value||d.days[d.days.length-1];
    info.textContent='读取中…';
    fetch('/api/console/replay?dir='+encodeURIComponent(d.dir)+'&day='+encodeURIComponent(dayVal)+'&limit=300&token='+encodeURIComponent(token),{cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(!j||!j.ok||!j.messages||!j.messages.length){ list.innerHTML='<div class="rp-empty">这一天没有记录。</div>'; info.textContent=''; return; }
        var msgs=j.messages.slice(-MAX);
        var startAt=Math.max(0, msgs.length-ANIM_LAST);
        list.innerHTML=msgs.map(function(m,i){
          return '<div class="rp-msg'+(m.me?' me':'')+(i>=startAt?' rp-in':'')+'">'+
            '<div class="rp-meta">'+esc(m.me?'我':(m.s||m.u))+' · '+hhmm(m.t)+'</div>'+esc(m.x)+'</div>';
        }).join('');
        list.scrollTop=list.scrollHeight;
        info.textContent=j.messages.length+' 条 · 当天共 '+j.total+' 条';
      })
      .catch(function(){ list.innerHTML='<div class="rp-empty">读取失败。</div>'; info.textContent=''; });
  }

  conv.addEventListener('change',function(){ fillDays(); loadDay(); });
  daySel.addEventListener('change',loadDay);
  if(btn) btn.addEventListener('click',function(){ started=true; loadIndex(); });

  // 面板每 60 秒会整页重载一次；如果每次都在启动时拉 300 条消息，
  // 就会看到周期性卡顿。改成：滚到这一块再加载，加载过就不再重复。
  function kick(){ if(started) return; started=true; loadIndex(); }
  var wrapEl=document.getElementById('rpList');
  if(wrapEl && typeof IntersectionObserver==='function'){
    var io2=new IntersectionObserver(function(entries){
      entries.forEach(function(en){ if(en.isIntersecting){ kick(); io2.disconnect(); } });
    },{rootMargin:'200px'});
    io2.observe(wrapEl);
  } else { kick(); }
})();
`;
