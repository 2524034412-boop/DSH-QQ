// 载入动画 · 产品发布片版（WebGL 液态玻璃 + 蒙太奇转场）。
// 只负责 #boot 内部；#boot / #bootsplash(.on) / #bootskip 与 dashboard-motion.js 保持一致。
// 镜头（自 .on 起，单位秒）：
//   0.0–3.9  A 远景：黑场里光带掠过，玻璃形体从暗处显形，镜头缓推 + 微环绕
//   3.75–4.3 蒙太奇 1：甩镜（whip pan）+ 动态模糊，连续运动切入微距
//   4.3–6.1  B 微距：镜头贴近表面，竖条凹槽玻璃的折射纹理清晰可见，光带在纹理上滑过
//   6.1–6.6  蒙太奇 2：推进穿过玻璃，光圈扩张、闪白（遮住机位切换）
//   6.55–10  C 广角：形体退到右侧，黑边收起，「欢迎回来，老大」被光揭示
// 全部本地、无外链、无图片素材；时间曲线用 cubic-bezier 数值解；prefers-reduced-motion 时整段隐藏；
// WebGL 不可用时降级为静态蓝色光球版。
const FRAG = String.raw`
precision highp float;
uniform vec2 uRes; uniform float uTime;
uniform vec3 uCam; uniform vec3 uTarget; uniform vec3 uBlob;
uniform float uFocal, uScale, uMorph, uFlute, uExp, uSweep, uFlash, uRing, uRot, uRingOn, uBokeh;

mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }
float hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
vec3 toLocal(vec3 p){ p-=uBlob; p.xz=rot(uRot)*p.xz; return p; }
float sdTorus(vec3 p, vec2 t){ vec2 q=vec2(length(p.xz)-t.x,p.y); return length(q)-t.y; }

vec2 map(vec3 wp){
  vec3 p=toLocal(wp);
  float d=length(p)-uScale;
  d+=uMorph*(0.085*sin(2.6*p.x+uTime*0.55)*sin(2.4*p.y+uTime*0.47)*sin(2.8*p.z+uTime*0.41)
           +0.030*sin(6.0*p.x-uTime*0.80)*sin(5.4*p.y+uTime*0.70)*sin(6.2*p.z));
  d*=0.8;
  if(uRingOn>0.001){
    vec3 q=p; q.yz=rot(0.9)*q.yz; q.xy=rot(0.35)*q.xy;
    float r=sdTorus(q, vec2(uScale*1.62, 0.013));
    if(r<d) return vec2(r,1.0);
  }
  return vec2(d,0.0);
}
vec3 calcN(vec3 p){
  vec2 e=vec2(0.0014,-0.0014);
  return normalize(e.xyy*map(p+e.xyy).x+e.yyx*map(p+e.yyx).x+e.yxy*map(p+e.yxy).x+e.xxx*map(p+e.xxx).x);
}
float azd(float az,float c){ return abs(mod(az-c+3.14159,6.28318)-3.14159); }

// 摄影棚环境：深海军蓝底 + 移动的冷白柔光箱 + 一条淡紫窄光 + 极细的暖色边光
vec3 env(vec3 d){
  float y=clamp(d.y*.5+.5,0.,1.);
  vec3 col=mix(vec3(.004,.010,.032),vec3(.018,.060,.170),y*y);
  float az=atan(d.x,d.z);
  float sa=uSweep*6.28318-2.2;
  float strip=smoothstep(.34,.0,azd(az,sa))*smoothstep(1.15,.35,abs(d.y-.05));
  col+=vec3(1.55,2.05,3.1)*strip*1.25;
  col+=vec3(1.05,.95,2.4)*smoothstep(.15,.0,azd(az,sa+2.3))*smoothstep(1.0,.3,abs(d.y))*.9;
  col+=vec3(.5,.9,1.8)*smoothstep(.55,1.,d.y)*.8;
  col+=vec3(2.2,1.2,.9)*smoothstep(.07,.0,azd(az,-2.35))*smoothstep(.9,.2,abs(d.y-.1))*.5;
  col+=vec3(.03,.10,.28)*smoothstep(-.2,-1.,d.y)*.8;
  return col*uExp;
}

void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/uRes.y;
  vec3 fw=normalize(uTarget-uCam);
  vec3 rt=normalize(cross(fw,vec3(0.,1.,0.)));
  vec3 up=cross(rt,fw);
  vec3 rd=normalize(uv.x*rt+uv.y*up+fw*uFocal);
  vec3 ro=uCam;

  // 背景：近黑的海军蓝渐变 + 形体背后的柔和逆光
  vec3 bg=mix(vec3(.005,.010,.030),vec3(.012,.036,.100),smoothstep(-.5,.9,uv.y));
  float tc=dot(uBlob-ro,rd); vec3 cl=ro+rd*max(tc,0.); float dc=length(cl-uBlob);
  bg+=vec3(.05,.20,.62)*exp(-dc*dc*.55)*.55+vec3(.02,.07,.22)*exp(-dc*dc*.12)*.6;
  vec3 col=bg*uExp;

  float t=0.; vec2 h=vec2(1.,0.); bool hit=false;
  for(int i=0;i<84;i++){
    h=map(ro+rd*t);
    if(h.x<.0008*t+.0002){ hit=true; break; }
    t+=h.x;
    if(t>16.) break;
  }
  if(hit){
    vec3 p=ro+rd*t; vec3 N=calcN(p);
    if(h.y<.5 && uFlute>.001){
      // 竖条凹槽（fluted glass）：折射纹理在微距里清晰可辨
      vec3 op=toLocal(p);
      vec2 tx=rot(-uRot)*vec2(1.,0.);
      vec3 T=vec3(tx.x,0.,tx.y); T-=N*dot(N,T); T=normalize(T);
      N=normalize(N+uFlute*.34*cos(op.x*27.)*T);
    }
    float cosv=max(dot(N,-rd),0.);
    float F=.04+.96*pow(1.-cosv,5.);
    vec3 R=reflect(rd,N);
    vec3 refl=env(R);
    if(h.y>.5){
      col=vec3(.55,.85,1.7)*(.55+F)*uExp;
    } else {
      vec3 iors=vec3(1.40,1.45,1.50);
      vec3 rg=refract(rd,N,1./iors.y);
      vec3 pi=p-N*.01+rg*.02; float tt=0.;
      for(int i=0;i<18;i++){ float d=-map(pi).x; if(d<.002) break; pi+=rg*d; tt+=d; }
      vec3 Nin=-calcN(pi);
      vec3 rr=refract(rd,N,1./iors.x), rb=refract(rd,N,1./iors.z);
      vec3 dR=refract(rr,Nin,iors.x), dG=refract(rg,Nin,iors.y), dB=refract(rb,Nin,iors.z);
      if(dot(dR,dR)<.001) dR=reflect(rr,Nin);
      if(dot(dG,dG)<.001) dG=reflect(rg,Nin);
      if(dot(dB,dB)<.001) dB=reflect(rb,Nin);
      vec3 absorb=exp(-tt*vec3(.55,.24,.06)*1.4);
      vec3 refr=vec3(env(dR).r,env(dG).g,env(dB).b)*absorb;
      refr+=vec3(.02,.12,.36)*exp(-tt*.6)*.55*uExp;      // 幽蓝：玻璃内部的冷色辉光
      col=mix(refr,refl,F);
      vec3 L=normalize(vec3(.5,.8,.6));
      col+=pow(max(dot(R,L),0.),190.)*2.4*vec3(.8,.9,1.)*uExp;
    }
  }

  // 景深里的柔焦光斑：淡蓝与一点点樱粉，极低对比，给画面一点少女的柔软
  vec3 bk=vec3(0.);
  for(int i=0;i<9;i++){
    float fi=float(i);
    vec2 c=vec2((hash21(vec2(fi,1.3))-.5)*1.9,fract(hash21(vec2(fi,9.1))+uTime*.010*(.5+hash21(vec2(fi,3.3))))-.5);
    c.x+=sin(uTime*.07+fi*2.1)*.04;
    float r=.025+.05*hash21(vec2(fi,5.5));
    float m=smoothstep(r,r*.55,length(uv-c));
    bk+=mix(vec3(.45,.65,1.),vec3(1.,.62,.82),step(.72,hash21(vec2(fi,2.2))))*m*(.5+.5*sin(uTime*.4+fi));
  }
  col+=bk*.07*uBokeh*uExp;

  // 蒙太奇 2：光圈 + 闪白
  float rr2=length(uv);
  float ringAmp=smoothstep(0.,.15,uRing)*(1.-smoothstep(1.1,1.6,uRing));
  col+=vec3(.6,.88,1.7)*exp(-pow((rr2-uRing)*8.,2.))*ringAmp*1.1;
  col+=vec3(.5,.8,1.5)*uFlash*(1.15-rr2*.5);

  col+=pow(max(col-.9,0.),vec3(1.6))*.5;
  col=1.-exp(-col*1.05);
  col=pow(col,vec3(.80,.82,.84));
  col*=mix(.55,1.,smoothstep(1.3,.25,length(uv*vec2(.85,1.))));
  col+=(hash21(gl_FragCoord.xy+fract(uTime)*97.)-.5)*.03;
  gl_FragColor=vec4(col,1.);
}`;
const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';

export const bootStyles = `
#boot{--e1:cubic-bezier(.16,1,.3,1);--e2:cubic-bezier(.65,0,.35,1);--e3:cubic-bezier(.22,.68,0,1);
  --bar:max(0px,calc((100vh - 100vw / 2.39) / 2));--o:2.9s;background:#000;overflow:hidden}
#boot #bootsplash{background:#000;overflow:hidden}
#boot #bootsplash::before,#boot #bootsplash::after{display:none}
.pf-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;will-change:filter,transform}
.pf-fallback{position:absolute;right:12vw;top:50%;width:min(46vmin,420px);aspect-ratio:1;margin-top:calc(min(46vmin,420px) * -.5);border-radius:50%;opacity:0;display:none;
  background:radial-gradient(circle at 32% 28%,#fff,#9fd0ff 14%,#3d78ff 48%,#0a1a5a 82%);box-shadow:0 0 120px rgba(70,140,255,.55),0 40px 120px -10px rgba(40,90,255,.6)}
#boot.pf-nogl .pf-canvas{display:none}
#boot.pf-nogl .pf-fallback{display:block}
#boot.pf-nogl #bootsplash{background:radial-gradient(120% 90% at 70% 50%,#0b1a4a,#04060f 70%)}
#bootsplash.on .pf-fallback{animation:fbIn 2.4s var(--e1) calc(var(--o) + .5s) both,fbBreath 5.2s var(--e2) calc(var(--o) + 3s) infinite}
@keyframes fbIn{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}
@keyframes fbBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}

/* 2.39:1 黑边：开场收窄到电影画幅，欢迎词出现时完全收起 */
.pf-bar{position:absolute;left:0;right:0;height:50.1vh;background:#000;z-index:4;pointer-events:none}
.pf-bar.t{top:0}.pf-bar.b{bottom:0}
#bootsplash.on .pf-bar{animation:barOpen 1.4s var(--e1) calc(var(--o) + .15s) both,barClose 1.05s var(--e2) calc(var(--o) + 6.55s) forwards}
@keyframes barOpen{from{height:50.1vh}to{height:var(--bar)}}
@keyframes barClose{from{height:var(--bar)}to{height:0}}

/* 欢迎词：一种字重、很开的字距，只靠光来揭示，不描边、不发光 */
.pf-title{position:absolute;left:clamp(30px,8.5vw,170px);top:50%;transform:translateY(-54%);z-index:3;pointer-events:none}
.pf-cn{position:relative;display:flex;flex-wrap:nowrap;white-space:nowrap;
  font-family:"HarmonyOS Sans SC","PingFang SC","Microsoft YaHei UI Light","Microsoft YaHei UI","Noto Sans SC",sans-serif;
  font-weight:200;font-size:clamp(38px,6.5vw,106px);line-height:1.12;letter-spacing:.2em}
.pf-cn b{display:inline-block;font:inherit;opacity:0;transform:translateY(.28em);filter:blur(14px);
  background:linear-gradient(180deg,#fff 26%,#b8d4ff 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
#bootsplash.on .pf-cn b{animation:cnIn 1.7s var(--e1) calc(var(--o) + 6.95s + var(--i) * 90ms) both}
@keyframes cnIn{from{opacity:0;transform:translateY(.28em);filter:blur(14px)}to{opacity:1;transform:translateY(0);filter:blur(0)}}
.pf-cn::after{content:attr(data-t);position:absolute;left:0;top:0;white-space:pre;pointer-events:none;color:transparent;opacity:0;letter-spacing:inherit;
  background:linear-gradient(105deg,transparent 42%,rgba(210,232,255,.95) 50%,transparent 58%);background-size:280% 100%;background-position:140% 0;
  -webkit-background-clip:text;background-clip:text}
#bootsplash.on .pf-cn::after{animation:cnSheen 2.4s var(--e1) calc(var(--o) + 8.5s) both}
@keyframes cnSheen{0%{opacity:1;background-position:140% 0}100%{opacity:1;background-position:-40% 0}}
.pf-en{display:flex;align-items:center;gap:18px;margin-top:clamp(18px,3.6vh,34px);font:400 clamp(10px,1vw,13px)/1 "SF Pro Text","Segoe UI","Helvetica Neue",sans-serif;
  letter-spacing:.62em;color:#8fb6ff;opacity:0}
.pf-en i{display:block;width:clamp(40px,7vw,96px);height:1px;background:linear-gradient(90deg,#7fb0ff,transparent);transform-origin:left;transform:scaleX(0)}
#bootsplash.on .pf-en{animation:fade 1.5s var(--e1) calc(var(--o) + 8.3s) both}
#bootsplash.on .pf-en i{animation:grow 1.6s var(--e1) calc(var(--o) + 8.3s) both}
@keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}


/* ── 开场 Logo：线稿鲸鱼描边成形 → 字标逐字显影 → 一道光掠过 → 溶入主场景 ── */
.pf-logo{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;gap:.26em;pointer-events:none;
  font-size:clamp(54px,9.4vw,150px);will-change:opacity,transform,filter}
#bootsplash.on .pf-logo{animation:logoOut .95s var(--e2) 2.2s forwards}
@keyframes logoOut{from{opacity:1;transform:scale(1);filter:blur(0)}to{opacity:0;transform:scale(1.14);filter:blur(16px)}}
.pf-logo::before{content:'';position:absolute;left:50%;top:50%;width:1.9em;height:1.9em;margin:-.95em 0 0 -.95em;border-radius:50%;opacity:0;
  background:radial-gradient(closest-side,rgba(60,120,255,.34),rgba(40,80,220,.12) 56%,transparent)}
#bootsplash.on .pf-logo::before{animation:logoGlow 2.4s var(--e1) .1s both}
@keyframes logoGlow{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1.25)}}
.pf-whale{position:relative;width:.92em;height:.69em;overflow:visible;flex:none}
.pf-whale path.o{fill:none;stroke:#8fbaff;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;filter:drop-shadow(0 0 7px rgba(80,140,255,.8))}
.pf-whale path.f{fill:url(#pfWg);opacity:0}
.pf-whale circle{fill:#04112e;opacity:0}
#bootsplash.on .pf-whale path.o{animation:draw 1.5s var(--e2) .2s both}
#bootsplash.on .pf-whale path.f{animation:fillIn 1.1s var(--e1) 1.15s both}
#bootsplash.on .pf-whale circle{animation:fillIn .8s var(--e1) 1.5s both}
@keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes fillIn{from{opacity:0}to{opacity:1}}
.pf-word{position:relative;display:flex;font-family:"SF Pro Display","Segoe UI Variable Display","Segoe UI","HarmonyOS Sans SC","Microsoft YaHei UI",sans-serif;
  font-weight:600;letter-spacing:-.045em;line-height:1}
.pf-word b{display:inline-block;font:inherit;opacity:0;transform:translateY(.34em);filter:blur(18px);
  background:linear-gradient(180deg,#ffffff 14%,#a9ccff 56%,#4d86ff 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
#bootsplash.on .pf-word b{animation:wordIn 1.5s var(--e1) calc(.6s + var(--i) * 70ms) both}
@keyframes wordIn{from{opacity:0;transform:translateY(.34em);filter:blur(18px)}to{opacity:1;transform:translateY(0);filter:blur(0)}}
.pf-word::after{content:attr(data-t);position:absolute;left:0;top:0;white-space:pre;color:transparent;opacity:0;pointer-events:none;
  background:linear-gradient(105deg,transparent 42%,rgba(235,246,255,.98) 50%,transparent 58%);background-size:280% 100%;background-position:140% 0;
  -webkit-background-clip:text;background-clip:text}
#bootsplash.on .pf-word::after{animation:logoSheen 1.5s var(--e1) 1.75s both}
@keyframes logoSheen{0%{opacity:1;background-position:140% 0}100%{opacity:1;background-position:-40% 0}}
.pf-logo-line{position:absolute;left:50%;top:calc(50% + .62em);width:3.4em;height:1px;margin-left:-1.7em;opacity:0;transform:scaleX(0);
  background:linear-gradient(90deg,transparent,#7fb0ff 30%,#cfe4ff 50%,#7fb0ff 70%,transparent);box-shadow:0 0 14px rgba(90,150,255,.7)}
#bootsplash.on .pf-logo-line{animation:lineIn 1.4s var(--e1) 1.5s both}
@keyframes lineIn{from{opacity:0;transform:scaleX(0)}to{opacity:.9;transform:scaleX(1)}}
@media(max-width:760px){.pf-logo{font-size:15vw}}

#boot #bootskip{z-index:20;border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:rgba(255,255,255,.8);backdrop-filter:blur(14px);letter-spacing:.06em}
#boot #bootskip:hover{background:rgba(255,255,255,.15);color:#fff}
#boot.out{transition:opacity .95s var(--e2),transform 1.1s var(--e1),visibility .95s var(--e2);transform:scale(1.03)}
@media(max-width:760px){.pf-title{left:24px;right:18px;top:62%}.pf-cn{font-size:11vw;letter-spacing:.1em}.pf-en{letter-spacing:.34em}.pf-fallback{right:-8vw;top:34%}}
@media(prefers-reduced-motion:reduce){#boot{display:none!important}}
`;

const logoWord = Array.from('deepseek').map((ch, i) => `<b style="--i:${i}" aria-hidden="true">${ch}</b>`).join('');
const cn = Array.from('欢迎回来，老大').map((ch, i) => `<b style="--i:${i}" aria-hidden="true">${ch}</b>`).join('');

export const bootMarkup = `<div id="boot" role="dialog" aria-modal="true" aria-labelledby="bootTitle" aria-describedby="bootDescription">
  <div id="bootsplash">
    <canvas class="pf-canvas" id="pfCanvas" aria-hidden="true"></canvas>
    <div class="pf-fallback" aria-hidden="true"></div>
    <div class="pf-logo" aria-hidden="true"><svg class="pf-whale" viewBox="0 0 64 48" aria-hidden="true"><defs><linearGradient id="pfWg" x1="6" y1="8" x2="58" y2="44" gradientUnits="userSpaceOnUse"><stop stop-color="#e8f2ff"/><stop offset=".5" stop-color="#7fb0ff"/><stop offset="1" stop-color="#3a6dff"/></linearGradient></defs><path class="f" pathLength="1" d="M5 27C5 15 17 8 30 9c10 1 18 7 22 15 2-4 6-8 11-9-1 8-4 14-10 17-6 9-20 13-32 9C10 38 5 34 5 27Z"/><path class="o" pathLength="1" d="M5 27C5 15 17 8 30 9c10 1 18 7 22 15 2-4 6-8 11-9-1 8-4 14-10 17-6 9-20 13-32 9C10 38 5 34 5 27Z"/><circle cx="19" cy="25" r="2.2"/></svg><div class="pf-word" data-t="deepseek">${logoWord}</div><i class="pf-logo-line"></i></div>
    <div class="pf-bar t" aria-hidden="true"></div><div class="pf-bar b" aria-hidden="true"></div>
    <div class="pf-title">
      <div class="pf-cn" id="bootTitle" data-t="欢迎回来，老大" aria-label="欢迎回来，老大">${cn}</div>
      <div class="pf-en" id="bootDescription"><i></i>WELCOME BACK</div>
    </div>
  </div><button id="bootskip" type="button">跳过开场 ↗</button>
</div>`;

export const bootScript = 'var __PF_FRAG=' + JSON.stringify(FRAG) + ';var __PF_VERT=' + JSON.stringify(VERT) + ';' + String.raw`
(function pfBoot(){
  var boot=document.getElementById('boot'), splash=document.getElementById('bootsplash'), canvas=document.getElementById('pfCanvas');
  if(!boot||!splash||!canvas) return;
  function fallback(){ boot.classList.add('pf-nogl'); }
  var gl=null;
  try{ gl=canvas.getContext('webgl',{antialias:false,alpha:false,powerPreference:'high-performance',preserveDrawingBuffer:false}); }catch(e){}
  if(!gl){ fallback(); return; }
  function sh(type,src){ var s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){ console.warn('boot shader:',gl.getShaderInfoLog(s)); return null; } return s; }
  var vs=sh(gl.VERTEX_SHADER,__PF_VERT), fs=sh(gl.FRAGMENT_SHADER,__PF_FRAG);
  if(!vs||!fs){ fallback(); return; }
  var prog=gl.createProgram(); gl.attachShader(prog,vs); gl.attachShader(prog,fs); gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){ fallback(); return; }
  gl.useProgram(prog);
  var buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  var loc=gl.getAttribLocation(prog,'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  var U={}; ['uRes','uTime','uCam','uTarget','uBlob','uFocal','uScale','uMorph','uFlute','uExp','uSweep','uFlash','uRing','uRot','uRingOn','uBokeh'].forEach(function(n){ U[n]=gl.getUniformLocation(prog,n); });
  canvas.addEventListener('webglcontextlost',function(e){ e.preventDefault(); stop(); fallback(); });

  // cubic-bezier 数值解：与 CSS 缓动同一条曲线
  function bez(x1,y1,x2,y2){ return function(p){ if(p<=0) return 0; if(p>=1) return 1; var t=p;
    for(var i=0;i<8;i++){ var cx=3*x1,bx=3*(x2-x1)-cx,ax=1-cx-bx; var x=((ax*t+bx)*t+cx)*t-p; var d=(3*ax*t+2*bx)*t+cx; if(Math.abs(x)<1e-5||Math.abs(d)<1e-6) break; t-=x/d; }
    var cy=3*y1,by=3*(y2-y1)-cy,ay=1-cy-by; return ((ay*t+by)*t+cy)*t; }; }
  var eIO=bez(.65,0,.35,1), eO=bez(.16,1,.3,1), eIn=bez(.7,0,.84,0), eS=bez(.4,0,.2,1);
  function c01(x){ return x<0?0:(x>1?1:x); }
  function mix(a,b,t){ return a+(b-a)*t; }
  function seg(t,a,b,e){ return (e||eIO)(c01((t-a)/(b-a))); }

  // 时间线：返回这一刻的相机与材质参数
  function params(t){
    var P={yaw:0,pitch:.1,dist:4,focal:1.5,blob:[0,0,0],scale:1,flute:.25,morph:.6,exp:1,sweep:0,flash:0,ring:0,ringOn:0,blur:0,bokeh:1};
    if(t<4.3){
      var a=seg(t,0,3.9,eS), w=seg(t,3.75,4.3,eIO);
      P.yaw=mix(mix(-.55,.25,a),1.9,w); P.dist=mix(mix(5.4,3.7,a),1.75,w); P.focal=mix(1.5,2.3,w); P.pitch=mix(.12,.06,w);
      P.sweep=mix(0,.5,seg(t,.3,4.3,eS)); P.flute=mix(.25,1,w); P.morph=.6; P.exp=seg(t,.25,2,eO)*mix(1,1.1,w);
      P.blur=Math.sin(Math.PI*w)*20; P.ringOn=1;
    } else if(t<6.1){
      var b=seg(t,4.3,6.1,eS);
      P.yaw=mix(1.9,2.35,b); P.dist=mix(1.75,1.5,b); P.focal=2.3; P.pitch=.06+.06*b;
      P.sweep=mix(.5,.98,b); P.flute=1; P.morph=.5; P.exp=1.1; P.bokeh=.4;
    } else if(t<6.55){
      var d=seg(t,6.1,6.55,eIn);
      P.yaw=2.35+.2*d; P.dist=mix(1.5,.35,d); P.focal=mix(2.3,1.2,d); P.pitch=.12;
      P.sweep=.98; P.flute=1; P.morph=.5; P.exp=1.1; P.flash=1.6*smoothstepJS(.35,1,d); P.ring=seg(t,6.1,6.7,eO)*1.5; P.bokeh=.2;
    } else {
      var c=seg(t,6.55,10.4,eS), g=seg(t,6.6,8.2,eO);
      P.yaw=mix(.5,-.15,c); P.dist=mix(6.4,5.3,c); P.focal=1.45; P.pitch=.1; P.blob=[1.55,0,0];
      P.scale=mix(.8,1.15,g); P.flute=.45; P.morph=.85; P.exp=1; P.sweep=mix(1,1.5,c);
      P.flash=1.6*(1-seg(t,6.55,7.3,eO)); P.ring=1.5+seg(t,6.55,7.4,eO)*.4; P.ringOn=1; P.bokeh=1;
    }
    return P;
  }
  function smoothstepJS(a,b,x){ var t=c01((x-a)/(b-a)); return t*t*(3-2*t); }

  var INTRO=2.9,running=false,t0=0,raf=0,lastOn=false,lastBlur=-1,q=1,dtAcc=0,dtN=0,lastNow=0,stopTimer=0;
  function resize(){
    var dpr=Math.min(window.devicePixelRatio||1,2), w=Math.max(2,window.innerWidth), h=Math.max(2,window.innerHeight);
    var px=w*h*dpr*dpr, budget=8e6, s=Math.min(1,Math.sqrt(budget/px))*q*dpr;
    canvas.width=Math.max(2,Math.floor(w*s)); canvas.height=Math.max(2,Math.floor(h*s));
    gl.viewport(0,0,canvas.width,canvas.height);
  }
  window.addEventListener('resize',resize);
  function frame(now){
    if(!running) return;
    raf=requestAnimationFrame(frame);
    var el=(now-t0)/1000-INTRO;
    if(el<0){ window.__pfLast=null; gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); return; }
    var t=Math.min(10.4,el), P=params(t);
    var cp=Math.cos(P.pitch), cam=[P.dist*Math.sin(P.yaw)*cp,P.dist*Math.sin(P.pitch),P.dist*Math.cos(P.yaw)*cp];
    window.__pfLast={cam:cam,blob:P.blob,scale:P.scale,focal:P.focal,t:t,exp:P.exp,morph:P.morph,flute:P.flute,sweep:P.sweep};
    gl.uniform2f(U.uRes,canvas.width,canvas.height); gl.uniform1f(U.uTime,t);
    gl.uniform3f(U.uCam,cam[0],cam[1],cam[2]); gl.uniform3f(U.uTarget,0,0,0); gl.uniform3f(U.uBlob,P.blob[0],P.blob[1],P.blob[2]);
    gl.uniform1f(U.uFocal,P.focal); gl.uniform1f(U.uScale,P.scale); gl.uniform1f(U.uMorph,P.morph); gl.uniform1f(U.uFlute,P.flute);
    gl.uniform1f(U.uExp,P.exp); gl.uniform1f(U.uSweep,P.sweep); gl.uniform1f(U.uFlash,P.flash); gl.uniform1f(U.uRing,P.ring);
    gl.uniform1f(U.uRot,t*.18); gl.uniform1f(U.uRingOn,P.ringOn); gl.uniform1f(U.uBokeh,P.bokeh);
    gl.drawArrays(gl.TRIANGLES,0,3);
    // 甩镜的动态模糊：交给 CSS 滤镜（GPU），比在着色器里多采样便宜得多
    if(Math.abs(P.blur-lastBlur)>.25){ lastBlur=P.blur; canvas.style.filter=P.blur>.25?'blur('+P.blur.toFixed(1)+'px)':'none'; canvas.style.transform=P.blur>.25?'scale('+(1+P.blur*.006).toFixed(3)+')':'none'; }
    // 自适应降档已关闭：帧率不再被动降分辨率（如需保护弱显卡，可把 q 的下限改回 .5）
    lastNow=now;
  }
  function start(){ if(running) return; running=true; t0=performance.now(); lastNow=0; lastBlur=-1; resize(); raf=requestAnimationFrame(frame); }
  // 球在屏幕上的位置与半径（与着色器同一套相机公式），交接动画从这里起飞
  window.__pfOrbRect=function(){
    var S=window.__pfLast; if(!S) return null;
    var c=S.cam, L=Math.sqrt(c[0]*c[0]+c[1]*c[1]+c[2]*c[2])||1, fw=[-c[0]/L,-c[1]/L,-c[2]/L];
    var rx=-fw[2], rz=fw[0], rl=Math.sqrt(rx*rx+rz*rz)||1; rx/=rl; rz/=rl;
    var rt=[rx,0,rz], up=[rt[1]*fw[2]-rt[2]*fw[1], rt[2]*fw[0]-rt[0]*fw[2], rt[0]*fw[1]-rt[1]*fw[0]];
    var p=[S.blob[0]-c[0],S.blob[1]-c[1],S.blob[2]-c[2]];
    var xr=p[0]*rt[0]+p[1]*rt[1]+p[2]*rt[2], yr=p[0]*up[0]+p[1]*up[1]+p[2]*up[2], zr=p[0]*fw[0]+p[1]*fw[1]+p[2]*fw[2];
    if(zr<.3) return null;
    var b=canvas.getBoundingClientRect(), H=b.height;
    return {cx:b.left+b.width/2+S.focal*xr/zr*H, cy:b.top+b.height/2-S.focal*yr/zr*H,
            r:S.focal*S.scale/Math.sqrt(Math.max(.01,zr*zr-S.scale*S.scale))*H};
  };
  function stop(){ running=false; if(raf) cancelAnimationFrame(raf); raf=0; }
  function check(){
    var on=splash.classList.contains('on')&&boot.style.display!=='none';
    if(on&&!lastOn){ clearTimeout(stopTimer); stop(); start(); }
    if(!on&&lastOn) stop();
    lastOn=on;
    if(boot.classList.contains('out')&&running){ clearTimeout(stopTimer); stopTimer=setTimeout(stop,1200); }
  }
  var mo=new MutationObserver(check);
  mo.observe(splash,{attributes:true,attributeFilter:['class']});
  mo.observe(boot,{attributes:true,attributeFilter:['class','style']});
  check();
})();
`;
