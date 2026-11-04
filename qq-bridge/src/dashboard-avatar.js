// 面板首页「她的形象」：整张夜景立绘作为主视觉，四周用径向遮罩"化"进深色背景，
// 不套相框、不加边框 —— 让她像是浮在页面里，而不是一张贴上去的图。

export const avatarStyles = `
.hero-art{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px}
.portrait{position:relative;width:min(560px,50vw);aspect-ratio:16/10;display:grid;place-items:center;isolation:isolate}
.portrait-img{position:relative;z-index:2;width:100%;height:100%;object-fit:cover;object-position:52% 44%;
  display:block;border-radius:8px;
  filter:saturate(1.04) contrast(1.02);   /* drop-shadow 会在每次缩放时重算，去掉后用外层柔和光晕代替 */
  will-change:transform;
  -webkit-mask-image:radial-gradient(120% 115% at 52% 46%,#000 46%,rgba(0,0,0,.55) 68%,transparent 92%);
  mask-image:radial-gradient(120% 115% at 52% 46%,#000 46%,rgba(0,0,0,.55) 68%,transparent 92%);
  animation:portraitBreath 9s ease-in-out infinite;will-change:transform}
.portrait-glow{position:absolute;z-index:1;inset:-14% -10%;pointer-events:none;
  background:radial-gradient(circle at 50% 46%,rgba(110,160,255,.34),rgba(110,160,255,0) 66%);
  filter:blur(60px);animation:portraitGlow 10s ease-in-out infinite;will-change:opacity}
.portrait-meta{display:flex;flex-direction:column;align-items:center;gap:10px}
.portrait-name{font-size:16px;font-weight:600;letter-spacing:.03em;color:#eef3fb;text-align:center}
.portrait-name small{display:block;margin-top:4px;font-size:10px;font-weight:400;letter-spacing:.22em;
  color:rgba(170,192,224,.6);text-transform:uppercase}
.portrait-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-width:460px}
.portrait-chips span{font-size:11px;line-height:1;padding:6px 11px;border-radius:999px;
  background:rgba(255,255,255,.045);border:1px solid rgba(160,190,240,.18);color:#c3d2e6;
  backdrop-filter:blur(8px);white-space:nowrap}
.portrait-chips span b{color:#eaf2ff;font-weight:600}
.orb-caption{margin:0;font-size:10px;letter-spacing:.26em;color:rgba(160,182,214,.5);text-transform:uppercase}
/* 旧版 hero 把 caption 绝对定位（bottom:12px），换成形象卡后它会压到数据条上 */
.hero-art .orb-caption{position:static;left:auto;right:auto;bottom:auto;margin-top:6px;text-align:center}
@keyframes portraitBreath{
  0%,100%{transform:translateY(0) scale(1)}
  50%{transform:translateY(-6px) scale(1.008)}}
@keyframes portraitGlow{0%,100%{opacity:.6}50%{opacity:1}}
@media (max-width:1024px){.portrait{width:min(420px,86vw)}}
@media (prefers-reduced-motion:reduce){.portrait-img,.portrait-glow{animation:none}}
`;
