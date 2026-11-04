import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMemoryPage } from '../src/memory-page.js';

const qqRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(new URL('../src/bridge.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const { dashboardScript: script } = await import('../src/dashboard-motion.js');
const { dashboardStyles, dashboardBoot } = await import('../src/dashboard-ui.js');
assert(/<script>\$\{dashboardScript\}\$\{sceneScript\}\$\{personalityScript\}[^<]*<\/script>/.test(source), 'dashboard script tag composes motion + scene + personality (+ additions)');
assert(/<style>\$\{dashboardStyles\}\$\{sceneStyles\}\$\{personalityStyles\}[^<]*<\/style>/.test(source), 'dashboard style tag composes ui + scene + personality (+ additions)');
const { sceneStyles, sceneScript } = await import('../src/dashboard-scenes.js');
const { personalityStyles, personalityScript } = await import('../src/dashboard-personality.js');
new vm.Script(personalityScript);
new vm.Script(script + sceneScript + personalityScript);
assert(!/https?:\/\//.test(personalityStyles + personalityScript), 'no remote assets in personality layer');
assert(!/\b(?:ease-in-out|ease-in|ease-out|ease|linear)\b/.test(personalityStyles.replace(/linear-gradient|--ease-out|--ease-in-out|--ease-soft/g,'')), 'personality layer uses bezier tokens only');
assert(/prefers-reduced-motion/.test(personalityStyles) && /calm/.test(personalityScript), 'personality layer honours reduced motion');
assert(source.includes('id="forgetData"') && source.includes('id="forgetChart"'), 'forgetting-curve card is mounted');
console.log('PASS personality layer: forgetting-curve card, counters, cursor glow — local, bezier-only, reduced-motion safe');
for (const file of ['dusk', 'terrace', 'sea', 'bokeh']) {
  assert(fs.existsSync(path.join(qqRoot, 'public', 'scene', file + '-atmo.jpg')), file + ' atmosphere asset present');
}
assert(sceneStyles.includes('/media/scene/dusk-atmo.jpg'));
new vm.Script(sceneScript);
new vm.Script(script + sceneScript);
assert(!/\/\/\s*[^\n]*http(s)?:\/\/(?!127\.0\.0\.1)/.test(sceneStyles));
assert(!/https?:\/\//.test(sceneStyles), 'no remote assets in scene layer');
assert(!/\b(?:ease-in-out|ease-in|ease-out|ease|linear)\b/.test(sceneStyles.replace(/linear-gradient|--ease-out|--ease-in-out|--ease-soft|linear,filter/g,'')));
console.log('PASS scene modules mounted with local graded assets and bezier-only transitions');
assert(dashboardBoot.includes('id="bootsplash"'));
assert(!/\b(?:ease-in-out|ease-in|ease-out|ease|linear)\b/.test(dashboardStyles.replace(/linear-gradient|--ease-out|--ease-in-out|--ease-soft/g,'')));
assert(!source.slice(source.indexOf('function buildDashboardFancy'),source.indexOf('function buildDashboardHtml')).includes('http-equiv="refresh"'));
console.log('PASS cinematic modules mounted; all visual transitions use bezier tokens; no forced meta refresh');
new vm.Script(script);
console.log('PASS rendered dashboard script syntax');
for(const match of renderMemoryPage([]).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if(!/application\/json/.test(match[1])) new vm.Script(match[2]);
}
console.log('PASS rendered memory page script syntax');

const classes = new Set();
const frame = {src:'',contentWindow:{}};
const layer = {setAttribute(){},classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v)}};
const bodyClasses=new Set();
const timers=[];
const shell={inert:false};
const documentEvents = {}, windowEvents = {}, buttonEvents = {};
const window = {addEventListener:(name,fn)=>windowEvents[name]=fn};
const document = {
  activeElement:{focus(){}},body:{classList:{add:v=>bodyClasses.add(v),remove:v=>bodyClasses.delete(v)}},
  getElementById:id=>({starFrame:frame,starLayer:layer,appShell:shell,starClose:{focus(){},addEventListener:(name,fn)=>buttonEvents[name]=fn}}[id]),
  addEventListener:(name,fn)=>documentEvents[name]=fn
};
const ctx = {window,document,URLSearchParams,clearTimeout(){},setTimeout:fn=>timers.push(fn),starUnloadTimer:0,starReturnFocus:null,location:{search:'?token=test%2Btoken&auto=1',origin:'http://127.0.0.1:3100'}};
vm.runInNewContext(script.slice(script.indexOf('window.openStar ='),script.indexOf('function tick()')),ctx);
window.openStar();
const url = new URL(frame.src,ctx.location.origin);
assert.equal(url.searchParams.get('token'),'test+token');
assert.equal(url.searchParams.get('embed'),'1');
assert(classes.has('on'));
windowEvents.message({origin:'http://untrusted.invalid',source:frame.contentWindow,data:'close-star'});
assert(classes.has('on'));
windowEvents.message({origin:ctx.location.origin,source:frame.contentWindow,data:'close-star'});
assert(!classes.has('on'));timers.splice(0).forEach(fn=>fn());assert.equal(frame.src,'about:blank');assert.equal(shell.inert,false);
window.openStar(); documentEvents.keydown({key:'Escape',preventDefault(){}}); assert(!classes.has('on'));
window.openStar(); buttonEvents.click(); assert(!classes.has('on'));
console.log('PASS overlay opens, preserves token, rejects unrelated messages, closes and unloads');

const memorySource = fs.readFileSync(new URL('../src/memory-page.js',import.meta.url),'utf8');
// The story card follows the focused star: compositor transform, every frame,
// critically damped, and no per-frame backdrop blur (that was the stutter).
assert(!/detail\.style\.(left|top|right|width|bottom)\s*=/.test(memorySource), 'card position is transform-only');
assert(/detail\.style\.transform='translate3d\('/.test(memorySource), 'card moves with translate3d');
assert(/if\(spot && cardShown\) followCard\(spot,dt\);/.test(memorySource), 'card follows every frame with dt');
assert(/function followCard\(n,dt\)/.test(memorySource) && /Math\.exp\(-w\*dt\)/.test(memorySource), 'critically damped follow');
assert(/n\.px\+cardOffX/.test(memorySource), 'card is welded to the star, no positional lag');
assert(!/\.detail\{[^}]*backdrop-filter/.test(memorySource), 'moving card does not re-blur the scene each frame');
assert(/\.detail\{[^}]*will-change:transform/.test(memorySource), 'card is promoted to its own layer');
assert(!/placeCard\(/.test(memorySource), 'old stepped layout helper is gone');
console.log('PASS story card follows the star smoothly (transform, per-frame, critically damped)');

// Behavioural check on the shipped follow math: no positional lag while the star
// glides, and a side swap eases instead of teleporting.
{
  const vars = memorySource.match(/var cardX=0,[^\n]+/)[0] + '\n' + memorySource.match(/var CARD_FOLLOW=[^\n]+/)[0];
  const from = memorySource.indexOf('  function measureCard(){');
  const to = memorySource.indexOf('  function focusNext(){');
  assert(from > 0 && to > from);
  const detailStub = {
    offsetWidth: 360, offsetHeight: 150, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect: () => ({ left: 12, top: 500 })
  };
  const box = { window: { innerWidth: 1440, innerHeight: 900 }, detail: detailStub };
  vm.createContext(box);
  vm.runInContext(vars + '\n' + memorySource.slice(from, to), box);
  const node = { px: 200, py: 450 };
  box.snapCard(node);
  let worstLag = 0;
  for (let i = 0; i < 120; i++) {
    node.px = 200 + i * 4;
    node.py = 450 + Math.sin(i / 12) * 40;
    box.followCard(node, 1 / 60);
    worstLag = Math.max(worstLag, Math.abs(box.cardBox.left - (node.px + 58)));
  }
  assert(worstLag < 0.01, 'card tracks the star without lag');
  box.snapCard(node);
  let prev = box.cardBox.left, step = 0;
  for (let i = 0; i < 120; i++) {
    node.px = 600 + i * 7;
    box.followCard(node, 1 / 60);
    step = Math.max(step, Math.abs(box.cardBox.left - prev));
    prev = box.cardBox.left;
  }
  assert(step < 90, 'side swap eases, max frame step ' + step.toFixed(1) + 'px');
  console.log('PASS card follow: zero lag (' + worstLag.toFixed(3) + 'px), eased side swap');
}
const memoryPart = memorySource.slice(memorySource.indexOf('  var embedded=false;'),memorySource.indexOf('  // 自动巡视开关'));
const memoryEvents = {}, closeEvents = {}, calls=[];
const parent={postMessage:(...args)=>calls.push(args)};
const embeddedWindow={self:{},top:{},parent};
vm.runInNewContext(memoryPart,{
  window:embeddedWindow,location:{search:'?embed=1',origin:ctx.location.origin},
  document:{addEventListener:(name,fn)=>memoryEvents[name]=fn,getElementById:id=>id==='closechip'?{addEventListener:(name,fn)=>closeEvents[name]=fn}:null}
});
memoryEvents.keydown({key:'Escape',preventDefault(){}});
closeEvents.click();
assert.deepEqual(calls,[['close-star',ctx.location.origin],['close-star',ctx.location.origin]]);
console.log('PASS Escape and return button work inside embedded star map');
