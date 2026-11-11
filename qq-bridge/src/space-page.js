// 她的家 · 第 2 轮：只读的 3D 画面。
//
// 这一轮**没有任何写入口**：页面只读 state/space.json，把「她在哪个房间」画出来。
// 目的是验证「她说的和画面对得上」，不是好看 —— 所以人是个胶囊，家具是几个盒子。
//
// 房间数据全部来自 public/space/rooms.json（房子骨架在那边改，不在这里硬编码）。
// 每层单独渲染，楼层之间用按钮切换；她换楼层时画面自动跟过去。
//
// 依赖：/media/space/three.module.min.js（本地副本，离线可用）。

export function renderSpacePage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>她的家</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;
    background:radial-gradient(circle at 50% 28%,#121a26,#07090d 78%);
    font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#e6ecf6}
  #app{position:fixed;inset:0}
  canvas{display:block}
  .hud{position:fixed;left:18px;top:16px;pointer-events:none;font-size:12px;letter-spacing:.3px}
  .hud .now{font-size:15px;color:#cfe0ff;font-weight:600;margin-bottom:2px}
  .hud .sub{color:#7c90ab}
  .hud .sub b{color:#a8c4e8;font-weight:500}
  .floors{position:fixed;left:50%;top:14px;transform:translateX(-50%);display:flex;gap:6px;
    background:rgba(10,14,20,.66);border:1px solid rgba(120,150,190,.22);border-radius:11px;padding:5px}
  .floors button{background:transparent;border:0;color:#8fa4c0;font:inherit;font-size:12.5px;
    padding:5px 15px;border-radius:8px;cursor:pointer;transition:.18s}
  .floors button:hover{color:#d7e6ff;background:rgba(120,160,220,.12)}
  .floors button.on{background:rgba(96,136,210,.3);color:#eaf3ff}
  .floors button.dot::after{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;
    background:#7fd4a0;margin-left:6px;vertical-align:middle}
  .warn{position:fixed;left:50%;top:62px;transform:translateX(-50%);background:rgba(120,30,40,.85);
    border:1px solid rgba(255,120,140,.4);color:#ffd9e0;padding:6px 14px;border-radius:9px;font-size:12px;display:none}
  .bar{position:fixed;left:18px;bottom:16px;display:flex;gap:8px}
  .bar button{background:rgba(255,255,255,.05);border:1px solid rgba(140,170,220,.28);color:#c7d6ea;
    border-radius:9px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;transition:.2s}
  .bar button:hover{background:rgba(120,170,255,.16);border-color:rgba(140,180,255,.5);color:#eaf2ff}
  .note{position:fixed;right:18px;bottom:16px;font-size:11.5px;color:#5f708c;max-width:340px;text-align:right}
</style></head><body>
<div id="app"></div>
<div class="hud">
  <div class="now" id="hPlace">—</div>
  <div class="sub"><b id="hFloor">—</b> · 在 <b id="hDoing">—</b></div>
</div>
<div class="floors" id="floors"></div>
<div class="warn" id="warn"></div>
<div class="bar"><button id="bFace">看她</button><button id="bReload">重新读取</button><button id="bReset">回正视角</button></div>
<div class="note">只读画面：她还不会自己动。<br>改 <code>rooms.json</code> 改房子，改 <code>space.json</code> 改她在哪。</div>

<script type="importmap">
{
  "imports": {
    "three": "/media/space/three.module.min.js",
    "@pixiv/three-vrm": "/media/space/vendor/three-vrm.module.js"
  }
}
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from '/media/space/vendor/loaders/GLTFLoader.js';
import { RoomEnvironment } from '/media/space/vendor/environments/RoomEnvironment.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

var TOKEN = new URLSearchParams(location.search).get('token') || '';
var PARAMS = new URLSearchParams(location.search);
var warnEl = document.getElementById('warn');
var hPlace = document.getElementById('hPlace');
var hFloor = document.getElementById('hFloor');
var hDoing = document.getElementById('hDoing');
function warn(msg){ warnEl.textContent = msg || ''; warnEl.style.display = msg ? 'block' : 'none'; }

// ── 渲染器与相机 ────────────────────────────────────────────────────
var app = document.getElementById('app');
var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
app.appendChild(renderer.domElement);

var scene = new THREE.Scene();
var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);
var viewSpan = 16;                 // 正交视野宽度（世界单位），随楼层大小自适应
var lookAt = new THREE.Vector3(0, 0.6, 0);
// 轨道状态：不要每帧从 camera.position 反算角度，否则到了上下限会"卡住"，而且有累积误差。
var orbit = { theta: Math.PI / 4, phi: 0.62, radius: 22, target: new THREE.Vector3(0, 0.6, 0) };
var PHI_MIN = 0.12, PHI_MAX = 1.42;   // 0=水平看，π/2=俯视

function applyOrbit(){
  orbit.target.copy(lookAt);
  var r = orbit.radius;
  camera.position.set(
    orbit.target.x + Math.cos(orbit.theta) * r * Math.cos(orbit.phi),
    orbit.target.y + Math.sin(orbit.phi) * r,
    orbit.target.z + Math.sin(orbit.theta) * r * Math.cos(orbit.phi)
  );
  camera.lookAt(orbit.target);
}

// ── 视角运镜：全景 ⇄ 她面前 ─────────────────────────────────────────
// 正交相机没有"距离"，放大靠 viewSpan；所以运镜要同时插值 角度 + 视野宽度 + 注视点。
var camTween = null;
var faceMode = false;
var faceBaseSpan = 2.4;     // 贴脸时的基准视野，慢推以它为起点

function startTween(to, dur){
  camTween = {
    t: 0,
    dur: dur || 1.5,
    from: { theta: orbit.theta, phi: orbit.phi, radius: orbit.radius, span: viewSpan, x: lookAt.x, y: lookAt.y, z: lookAt.z },
    to: to
  };
}

function floorBounds(id){
  var rooms = DATA.rooms.filter(function(r){ return r.floor === id; });
  if (!rooms.length) return null;
  var minX = Math.min.apply(null, rooms.map(function(r){ return r.x - r.w / 2; }));
  var maxX = Math.max.apply(null, rooms.map(function(r){ return r.x + r.w / 2; }));
  var minZ = Math.min.apply(null, rooms.map(function(r){ return r.z - r.d / 2; }));
  var maxZ = Math.max.apply(null, rooms.map(function(r){ return r.z + r.d / 2; }));
  var span = Math.max(maxX - minX, maxZ - minZ);
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, span: span };
}

function focusOnHer(dur){
  var b = floorBounds(floorId);
  var span = b ? b.span : 12;
  var p = avatar.position;
  faceBaseSpan = Math.max(2.2, span * 0.17);
  setWallsFaded(true);      // 镜头进屋前先把墙淡掉，否则隔着墙看
  // 镜头距离按房间大小收：小房间（厕所 3×3）不能站 3.4 米外，那已经到隔壁了
  var room = resolveRoom(lastState);
  var roomMin = room ? Math.min(room.w, room.d) : 5;
  var radius = Math.min(3.4, Math.max(1.7, roomMin * 0.62));
  startTween({
    theta: Math.PI / 2,        // 相机落在 +Z 侧：她转 180° 后正面朝 +Z
    phi: 0.06,                 // 几乎平视
    radius: radius,
    span: faceBaseSpan,        // 视野收到约一人高
    x: p.x, y: Math.max(0.85, span * 0.06), z: p.z
  }, dur || 1.5);
}

function focusOverview(dur){
  var b = floorBounds(floorId);
  if (!b) return;
  setWallsFaded(false);
  startTween({
    theta: Math.PI * 0.25,
    phi: 0.62,
    radius: b.span * 1.5,
    span: b.span * 1.55,
    x: b.cx, y: 0.5, z: b.cz
  }, dur || 1.5);
}

// 把矮墙淡成半透明：贴脸时镜头在屋内，墙在相机背后/旁边，不该挡视线
function setWallsFaded(fade){
  group.traverse(function (o){
    if (!o.isMesh || !o.userData.isWall || !o.material) return;
    o.material.transparent = fade;
    o.material.opacity = fade ? 0.14 : 1;
    o.material.depthWrite = !fade;
    o.material.needsUpdate = true;
  });
}

function toggleView(){
  faceMode = !faceMode;
  var b = document.getElementById('bFace');
  if (b) b.textContent = faceMode ? '回全景' : '看她';
  if (faceMode) focusOnHer(); else focusOverview();
}

scene.add(new THREE.AmbientLight(0xc6d8f5, 0.32));
var key = new THREE.DirectionalLight(0xfff3e0, 1.55);
key.position.set(9, 15, 7); scene.add(key);
var rim = new THREE.DirectionalLight(0x88aaff, 0.45);
rim.position.set(-10, 8, -9); scene.add(rim);

// PBR 需要环境反射：没有 envMap 时，metallic 高的模型会渲染成一片白（Tripo 导出默认 metallic=1）。
// RoomEnvironment 是程序化的室内环境，不用下载 HDRI。
var pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

function resize(){
  var w = innerWidth, h = innerHeight, aspect = w / h;
  var span = viewSpan;
  camera.left = -span * aspect / 2; camera.right = span * aspect / 2;
  camera.top = span / 2; camera.bottom = -span / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', resize);

// ── 数据 ────────────────────────────────────────────────────────────
var DATA = { floors: [], rooms: [], scenery: {}, outside: { label: '外面', floor: 'out', x: 0, z: 6 } };
var floorId = '1f';
var autoFollow = true;
var roomIndex = new Map();          // label / alias → room
var group = new THREE.Group();      // 当前楼层的一切
scene.add(group);

var MATERIAL = {
  wood:  new THREE.MeshLambertMaterial({ color: 0x6b573c }),
  dark:  new THREE.MeshLambertMaterial({ color: 0x3a3630 }),
  cloth: new THREE.MeshLambertMaterial({ color: 0x5a6f92 }),
  white: new THREE.MeshLambertMaterial({ color: 0xcfd8e3 }),
  metal: new THREE.MeshLambertMaterial({ color: 0x8d99a8 }),
  leaf:  new THREE.MeshLambertMaterial({ color: 0x2f6b42 }),
  water: new THREE.MeshLambertMaterial({ color: 0x2f8fb5, transparent: true, opacity: 0.72 }),
  stone: new THREE.MeshLambertMaterial({ color: 0x4a4a4a }),
  // 临海的后墙用玻璃：depthWrite 关掉，避免和后面的海面抢深度、也免得挡住房里其它半透明物件
  glass: new THREE.MeshLambertMaterial({ color: 0x9fd0ea, transparent: true, opacity: 0.15, depthWrite: false }),
  frame: new THREE.MeshLambertMaterial({ color: 0x2a2f36 }),
  sea:   new THREE.MeshLambertMaterial({ color: 0x0d2a3d }),
  seaFar:new THREE.MeshBasicMaterial({ color: 0x3d6b86, transparent: true, opacity: 0.5 }),
  foam:  new THREE.MeshBasicMaterial({ color: 0xbfe0f0, transparent: true, opacity: 0.07 })
};

function box(w, h, d, mat, x, y, z){
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function makeLabel(text, color, maxW){
  var c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  var g = c.getContext('2d');
  g.fillStyle = 'rgba(7,9,13,0.8)'; g.fillRect(0, 0, 256, 64);
  g.strokeStyle = 'rgba(140,170,220,0.32)'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 253, 61);
  g.fillStyle = color; g.font = '600 30px system-ui, "Microsoft YaHei", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  var t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter;
  var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  var w = Math.max(1.1, Math.min(2.2, maxW * 0.62));
  s.scale.set(w, w / 4, 1);
  return s;
}

// ── 每间房的家具（先都是盒子，模型回来再换）────────────────────────
function furniture(room){
  var g = new THREE.Group();
  switch (room.id){
    case 'living':
      g.add(box(3.1, 0.52, 1.0, MATERIAL.cloth, 0, 0.26, -1.9));
      g.add(box(3.1, 0.6, 0.26, MATERIAL.cloth, 0, 0.7, -2.4));
      g.add(box(1.25, 0.36, 0.7, MATERIAL.wood, 0, 0.18, -0.4));
      g.add(box(0.9, 0.34, 0.5, MATERIAL.white, 2.6, 0.17, -0.9));   // 单人椅
      break;
    case 'kitchen':
      g.add(box(2.7, 0.88, 0.62, MATERIAL.stone, 0, 0.44, -1.9));
      g.add(box(0.72, 1.75, 0.72, MATERIAL.metal, -1.7, 0.87, -1.95));
      g.add(box(2.7, 0.06, 0.62, MATERIAL.white, 0, 0.9, -1.9));      // 台面
      break;
    case 'study':
      g.add(box(1.9, 0.74, 0.78, MATERIAL.wood, 0, 0.37, -1.5));
      g.add(box(1.1, 1.85, 0.32, MATERIAL.dark, 1.85, 0.92, -1.95));
      g.add(box(0.5, 0.45, 0.5, MATERIAL.cloth, 0, 0.22, -0.75));     // 椅子
      break;
    case 'bath':
      g.add(box(1.7, 0.58, 0.9, MATERIAL.white, -0.4, 0.29, -0.75));  // 浴缸
      g.add(box(1.5, 0.06, 0.72, MATERIAL.water, -0.4, 0.52, -0.75)); // 水面
      g.add(box(0.42, 0.62, 0.55, MATERIAL.white, 1.1, 0.31, -1.1));  // 马桶
      break;
    case 'hall':
      g.add(box(1.7, 0.8, 0.38, MATERIAL.wood, 0, 0.4, -1.2));
      g.add(box(0.8, 0.05, 0.5, MATERIAL.stone, 0, 0.03, 0.6));       // 地垫
      break;
    case 'stairs':
      for (var i = 0; i < 5; i++){
        g.add(box(1.4, 0.2, 0.55, MATERIAL.stone, 0, 0.1 + i * 0.2, 1.15 - i * 0.55));
      }
      break;
    case 'bedroom':
      g.add(box(2.2, 0.52, 2.7, MATERIAL.cloth, 1.0, 0.26, -1.4));
      g.add(box(2.2, 0.62, 0.22, MATERIAL.wood, 1.0, 0.6, -2.8));     // 床头
      g.add(box(0.55, 0.55, 0.55, MATERIAL.wood, -0.75, 0.27, -2.5));
      g.add(box(2.6, 0.03, 3.1, MATERIAL.dark, 1.0, 0.02, -1.4));     // 地毯
      break;
    case 'guest':
      g.add(box(1.8, 0.5, 2.2, MATERIAL.cloth, 0, 0.25, -0.9));
      g.add(box(1.8, 0.58, 0.2, MATERIAL.wood, 0, 0.57, -2.0));
      break;
    case 'storage':
      g.add(box(0.9, 0.7, 0.9, MATERIAL.wood, -1.1, 0.35, -0.5));
      g.add(box(0.7, 0.55, 0.7, MATERIAL.wood, -0.2, 0.27, -0.55));
      g.add(box(1.0, 0.8, 0.6, MATERIAL.wood, 1.1, 0.4, -0.5));
      break;
    case 'corridor':
      g.add(box(0.9, 0.05, 1.6, MATERIAL.cloth, -2.6, 0.03, 0));
      break;
    case 'garden':
      [[-4.2, -1.6], [3.9, 1.5], [4.6, -2.0]].forEach(function(p){
        var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.5, 8), MATERIAL.wood);
        trunk.position.set(p[0], 0.75, p[1]);
        var crown = new THREE.Mesh(new THREE.SphereGeometry(0.85, 10, 8), MATERIAL.leaf);
        crown.position.set(p[0], 1.9, p[1]);
        g.add(trunk); g.add(crown);
      });
      // 花：一小片彩色球
      for (var k = 0; k < 9; k++){
        var fx = -4.8 + (k % 3) * 0.75, fz = 0.6 + Math.floor(k / 3) * 0.6;
        var petal = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5),
          new THREE.MeshLambertMaterial({ color: [0xd4697f, 0xe0b95f, 0x9b7ed4][k % 3] }));
        petal.position.set(fx, 0.14, fz);
        g.add(petal);
      }
      break;
    case 'pool':
      // 池体与水面由 buildFloor 处理（要单独叠在花园草地上）
      break;
  }
  return g;
}

// ── 环境：房后是海，房前是草坪 ──────────────────────────────────────
// 海画在 -z 方向（后墙外），草坪画在 +z 方向（前门外的花园方向）。
// 两者都不参与「相机对焦」的包围盒计算 —— 否则 200 米宽的海会把房子缩成一个点。
function buildScenery(id){
  var s = DATA.scenery || {};
  var sea = s.sea;
  if (sea && (sea.floors || []).indexOf(id) >= 0){
    var d = Number(sea.d) || 80, w = Number(sea.w) || 200;
    var surf = new THREE.Mesh(new THREE.PlaneGeometry(w, d), MATERIAL.sea);
    surf.rotation.x = -Math.PI / 2;
    surf.position.set(0, -0.65, -d / 2 + 0.4);
    group.add(surf);
    // 远处海平线：一条比海面亮的窄带，撑出「望不到边」的感觉
    var far = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.6), MATERIAL.seaFar);
    far.rotation.x = -Math.PI / 2;
    far.position.set(0, -0.6, -d + 0.6);
    group.add(far);
    // 几道浪：平行于房子的细长白条，给水面一点层次
    for (var i = 0; i < 8; i++){
      var line = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.98, 0.1 + Math.random() * 0.08), MATERIAL.foam);
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, -0.58, -3 - i * 8);
      group.add(line);
    }
  }
  var lawn = s.lawn;
  if (lawn && (lawn.floors || []).indexOf(id) >= 0){
    var grass = new THREE.Mesh(
      new THREE.PlaneGeometry(Number(lawn.w) || 60, Number(lawn.d) || 16),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(lawn.color || '#223a26') })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(0, -0.09, Number(lawn.z) || 16);
    group.add(grass);
  }
}

// ── 建某个楼层 ──────────────────────────────────────────────────────
function clearGroup(){
  while (group.children.length){
    var c = group.children.pop();
    group.remove(c);
  }
}

function buildFloor(id){
  clearGroup();
  var rooms = DATA.rooms.filter(function(r){ return r.floor === id; });
  if (!rooms.length) return;

  buildScenery(id);

  var outdoor = id === 'out';
  if (!outdoor){
    // 室内：一块大地面承托整层
    var minX = Math.min.apply(null, rooms.map(function(r){ return r.x - r.w / 2; }));
    var maxX = Math.max.apply(null, rooms.map(function(r){ return r.x + r.w / 2; }));
    var minZ = Math.min.apply(null, rooms.map(function(r){ return r.z - r.d / 2; }));
    var maxZ = Math.max.apply(null, rooms.map(function(r){ return r.z + r.d / 2; }));
    var slab = box(maxX - minX + 1.2, 0.16, maxZ - minZ + 1.2, MATERIAL.dark,
      (minX + maxX) / 2, -0.1, (minZ + maxZ) / 2);
    group.add(slab);
  } else {
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60),
      new THREE.MeshLambertMaterial({ color: 0x101a14 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.04;
    group.add(ground);
  }

  // 水先画（泳池在花园里，要被草地压住边界感）
  rooms.filter(function(r){ return r.kind === 'water'; }).forEach(function(r){
    var basin = box(r.w + 0.5, 0.3, r.d + 0.5, MATERIAL.stone, r.x, -0.14, r.z);
    group.add(basin);
    var surf = box(r.w, 0.06, r.d, MATERIAL.water, r.x, 0.03, r.z);
    group.add(surf);
  });

  rooms.forEach(function(r){
    if (r.kind === 'water') return;
    var g = new THREE.Group();
    g.position.set(r.x, 0, r.z);

    var floorMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(r.floorColor) });
    var floor = box(r.w, 0.12, r.d, floorMat, 0, -0.06, 0);
    g.add(floor);

    if (r.kind !== 'outdoor'){
      var wallMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(r.wallColor) });
      var H = 1.12, T = 0.11;
      // 墙全部打标记：贴脸时要把它们淡掉，否则镜头停在房间外，隔着墙看她
      var addWall = function (mesh){ mesh.userData.isWall = true; g.add(mesh); };
      if (r.window === 'sea'){
        // 临海：后墙只留墙裙和上沿，中间整面玻璃 —— 坐在里头就能看见海
        var sill = 0.34, cap = 0.16, paneH = H - sill - cap;
        addWall(box(r.w, sill, T, wallMat, 0, sill / 2, -r.d / 2));
        addWall(box(r.w, cap, T, wallMat, 0, H - cap / 2, -r.d / 2));
        g.add(box(r.w - 0.08, paneH, 0.03, MATERIAL.glass, 0, sill + paneH / 2, -r.d / 2));
        for (var k = 1; k < 3; k++){
          g.add(box(0.045, paneH, 0.06, MATERIAL.frame, -r.w / 2 + (k * r.w) / 3, sill + paneH / 2, -r.d / 2));
        }
        g.add(box(r.w - 0.08, 0.045, 0.06, MATERIAL.frame, 0, sill + paneH / 2, -r.d / 2));
      } else {
        addWall(box(r.w, H, T, wallMat, 0, H / 2, -r.d / 2));
      }
      addWall(box(T, H, r.d, wallMat, -r.w / 2, H / 2, 0));
      var label = makeLabel(r.label, r.wallColor, r.w);
      label.position.set(0, H + 0.5, -r.d / 2 + 0.12);
      g.add(label);
    } else {
      var gl = makeLabel(r.label, '#7fd4a0', r.w);
      gl.position.set(0, 0.95, -r.d / 2 + 0.1);
      g.add(gl);
    }

    var f = furniture(r);
    g.add(f);

    group.add(g);
  });
}

// ── 相机对焦到楼层 ──────────────────────────────────────────────────
function focusFloor(id){
  var rooms = DATA.rooms.filter(function(r){ return r.floor === id; });
  if (!rooms.length) return;
  var minX = Math.min.apply(null, rooms.map(function(r){ return r.x - r.w / 2; }));
  var maxX = Math.max.apply(null, rooms.map(function(r){ return r.x + r.w / 2; }));
  var minZ = Math.min.apply(null, rooms.map(function(r){ return r.z - r.d / 2; }));
  var maxZ = Math.max.apply(null, rooms.map(function(r){ return r.z + r.d / 2; }));
  var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  var span = Math.max(maxX - minX, maxZ - minZ);
  viewSpan = span * 1.55;
  lookAt.set(cx, 0.5, cz);
  orbit.radius = span * 1.5;
  orbit.theta = Math.PI * 0.25;          // 从 +x+z 斜看
  orbit.phi = 0.62;                      // 约 35°，等距视角
  camTween = null;                       // 换楼层时取消运镜，免得飞到一半
  faceMode = false;
  setWallsFaded(false);
  var fb = document.getElementById('bFace');
  if (fb) fb.textContent = '看她';
  applyOrbit();
  resize();
}

function goFloor(id){
  if (id === floorId) return;
  floorId = id;
  buildFloor(id);
  focusFloor(id);
  renderFloorButtons();
  placeAvatar();
}

function renderFloorButtons(){
  var host = document.getElementById('floors');
  host.textContent = '';
  var herFloor = (lastRoom && lastRoom.floor) || '';
  DATA.floors.forEach(function(f){
    var b = document.createElement('button');
    b.textContent = f.label;
    if (f.id === floorId) b.classList.add('on');
    if (f.id === herFloor) b.classList.add('dot');
    b.addEventListener('click', function(){ autoFollow = false; goFloor(f.id); });
    host.appendChild(b);
  });
}

// ── 她 ──────────────────────────────────────────────────────────────
var avatar = new THREE.Group();
// 占位小人：身体 + 头 + 头发。模型回来后整块替换，但比例（约 1.2 高）先给她留好。
// 设定上她是女孩子——占位也得让人一眼看出是个人，而不是一根柱子。
var body = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.25, 0.40, 6, 14),
  new THREE.MeshLambertMaterial({ color: 0x6f9ad6, emissive: 0x14243c })
);
body.position.y = 0.52;
avatar.add(body);

var head = new THREE.Mesh(
  new THREE.SphereGeometry(0.20, 18, 14),
  new THREE.MeshLambertMaterial({ color: 0xf0d9c8 })
);
head.position.y = 0.99;
avatar.add(head);

// 头发：半球盖住上半颗头，颜色取她形象的深蓝
var hair = new THREE.Mesh(
  new THREE.SphereGeometry(0.215, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.58),
  new THREE.MeshLambertMaterial({ color: 0x2c4270 })
);
hair.position.y = 1.00;
avatar.add(hair);

// 一小截鲸鱼尾，别太抢眼，只是让她不完全是个人形积木
var tail = new THREE.Mesh(
  new THREE.ConeGeometry(0.11, 0.26, 10),
  new THREE.MeshLambertMaterial({ color: 0x2c4270 })
);
tail.position.set(0, 0.40, 0.22);
tail.rotation.x = Math.PI * 0.62;
avatar.add(tail);

var shadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.3, 24),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
);
shadow.rotation.x = -Math.PI / 2;
shadow.position.y = 0.012;
avatar.add(shadow);
scene.add(avatar);

// ── 角色模型（VRM 或普通 glb 都吃；没有模型就留占位小人）──────────────
// 加载失败不影响任何功能：占位小人还在，位置照样跟着 state 走。
var vrm = null;
var vrmReady = false;
// 默认走 VRM（自带骨骼、表情、头发/裙摆/胸部物理）；?model=glb 可切回 Tripo 那个写实模型做对比。
var MODEL_FILE = PARAMS.get('model') === 'glb'
  ? '/media/space/models/her.glb'
  : '/media/space/models/her.vrm';

function fitModel(root){
  // 按真实高度缩放，落到地面（场景里墙只有 1.12，她略高一点）
  var box = new THREE.Box3().setFromObject(root);
  var h = box.max.y - box.min.y;
  var targetH = 1.55;
  if (h > 0.001 && h < 1000) root.scale.setScalar(targetH / h);
  box.setFromObject(root);
  root.position.y -= box.min.y;
}

// ── 程序化待机 ──────────────────────────────────────────────────────
// VRM 只带物理（头发/裙子），身体本身没有任何动画 —— 不写这段她就一直僵着。
// 关键：必须在**原始值上叠加**，不能直接赋值。髋骨原本的 y 是站立高度（约 1m），
// 直接写成 hips.position.y = 0.01 等于把她整个人往下拽 1 米 —— 就卡进地板了。
var idle = { ok: false, base: null };
var prevPos = new THREE.Vector3();   // 上一帧位置，用来算实际速度

function setupIdle(v){
  try {
    var h = v.humanoid;
    if (!h || typeof h.getNormalizedBoneNode !== 'function') return;
    idle.hips = h.getNormalizedBoneNode('hips');
    idle.spine = h.getNormalizedBoneNode('spine');
    idle.chest = h.getNormalizedBoneNode('chest');
    idle.head = h.getNormalizedBoneNode('head');
    idle.lua = h.getNormalizedBoneNode('leftUpperArm');
    idle.rua = h.getNormalizedBoneNode('rightUpperArm');
    idle.ok = !!(idle.hips && idle.spine);
    if (!idle.ok) return;
    idle.base = {
      hipsY: idle.hips.position.y,
      hipsZ: idle.hips.position.z,
      hipsRZ: idle.hips.rotation.z,
      spineX: idle.spine.rotation.x,
      chestX: idle.chest ? idle.chest.rotation.x : 0,
      headX: idle.head ? idle.head.rotation.x : 0,
      headY: idle.head ? idle.head.rotation.y : 0,
      luaZ: idle.lua ? idle.lua.rotation.z : 0,
      ruaZ: idle.rua ? idle.rua.rotation.z : 0
    };
    console.log('[space] idle 已绑定，髋原始高度 =', idle.base.hipsY.toFixed(3));
    setupLegs(v);
  } catch (e) {
    console.warn('[space] idle 绑定异常', e);
  }
}

function updateIdle(t){
  if (!idle.ok || !idle.base) return;
  var b = idle.base;
  var breath = Math.sin(t * 1.15);
  var sway = Math.sin(t * 0.42);
  var look = Math.sin(t * 0.23);
  // 全部是 base + 偏移，绝不覆盖
  idle.hips.position.y = b.hipsY + breath * 0.008;
  idle.hips.rotation.z = b.hipsRZ + sway * 0.020;
  idle.spine.rotation.x = b.spineX + breath * 0.012;
  if (idle.chest) idle.chest.rotation.x = b.chestX + Math.sin(t * 1.15 + 0.6) * 0.014;
  if (idle.head) {
    idle.head.rotation.y = b.headY + look * 0.15;
    idle.head.rotation.x = b.headX + Math.sin(t * 0.31) * 0.035;
  }
  if (idle.lua) idle.lua.rotation.z = b.luaZ + 0.10 + breath * 0.010;
  if (idle.rua) idle.rua.rotation.z = b.ruaZ - 0.10 - breath * 0.010;
  // 腿回到站立（如果刚从走路切回来）
  if (idle.lul) idle.lul.rotation.x = (idle.base.lulX || 0);
  if (idle.rul) idle.rul.rotation.x = (idle.base.rulX || 0);
  if (idle.lll) idle.lll.rotation.x = (idle.base.lllX || 0);
  if (idle.rll) idle.rll.rotation.x = (idle.base.rllX || 0);
}

// ── 程序化走路 ──────────────────────────────────────────────────────
// 没有动画文件，就用正弦波驱动大腿/小腿/手臂。不是专业动作，但"腿在迈"和"滑行"
// 是两种观感。步频跟着移动速度走，停下会自动回到 idle。
var walkPhase = 0;

function setupLegs(v){
  try {
    var h = v.humanoid;
    var g = function (name) { return h.getNormalizedBoneNode(name); };
    idle.lul = g('leftUpperLeg');
    idle.rul = g('rightUpperLeg');
    idle.lll = g('leftLowerLeg');
    idle.rll = g('rightLowerLeg');
    idle.lua = idle.lua || g('leftUpperArm');
    idle.rua = idle.rua || g('rightUpperArm');
    idle.lal = g('leftLowerArm');
    idle.ral = g('rightLowerArm');
    // 记录腿和手臂的原始角度
    idle.base.lulX = idle.lul ? idle.lul.rotation.x : 0;
    idle.base.rulX = idle.rul ? idle.rul.rotation.x : 0;
    idle.base.lllX = idle.lll ? idle.lll.rotation.x : 0;
    idle.base.rllX = idle.rll ? idle.rll.rotation.x : 0;
    idle.base.luaX = idle.lua ? idle.lua.rotation.x : 0;
    idle.base.ruaX = idle.rua ? idle.rua.rotation.x : 0;
    idle.base.lalX = idle.lal ? idle.lal.rotation.x : 0;
    idle.base.ralX = idle.ral ? idle.ral.rotation.x : 0;
  } catch (e) { console.warn('[space] 腿骨绑定失败', e); }
}

function updateWalk(dt, speed){
  if (!idle.ok || !idle.base) return;
  var b = idle.base;
  // 步频跟着速度走；速度是每秒移动的米数
  walkPhase += dt * Math.min(9, 4.2 + speed * 2.2);
  var s = Math.sin(walkPhase);
  var c = Math.cos(walkPhase);
  var amp = Math.min(0.62, 0.28 + speed * 0.10);

  if (idle.lul) idle.lul.rotation.x = b.lulX + s * amp;
  if (idle.rul) idle.rul.rotation.x = b.rulX - s * amp;
  // 膝盖只往后弯：正弦半波，避免小腿往前折
  if (idle.lll) idle.lll.rotation.x = b.lllX + Math.max(0, -s) * amp * 1.15;
  if (idle.rll) idle.rll.rotation.x = b.rllX + Math.max(0, s) * amp * 1.15;
  // 手臂反摆
  if (idle.lua) idle.lua.rotation.x = b.luaX - s * amp * 0.55;
  if (idle.rua) idle.rua.rotation.x = b.ruaX + s * amp * 0.55;
  if (idle.lal) idle.lal.rotation.x = b.lalX + Math.max(0, -s) * 0.18;
  if (idle.ral) idle.ral.rotation.x = b.ralX + Math.max(0, s) * 0.18;
  // 走路时上身轻微上下 + 侧倾，比纯腿摆更像人
  if (idle.hips) {
    idle.hips.position.y = b.hipsY + Math.abs(s) * 0.022 - 0.011;
    idle.hips.rotation.z = b.hipsRZ + c * 0.035;
  }
  if (idle.spine) idle.spine.rotation.x = b.spineX + 0.03;
}

function loadModel(){
  var loader = new GLTFLoader();
  loader.register(function (parser){ return new VRMLoaderPlugin(parser); });
  loader.load(MODEL_FILE, function (gltf){
    try {
      var v = gltf.userData.vrm;
      if (v){
        // VRM：自带骨骼、表情、头发物理
        if (VRMUtils && VRMUtils.removeUnnecessaryVertices) VRMUtils.removeUnnecessaryVertices(gltf.scene);
        if (VRMUtils && VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
        v.scene.traverse(function (o){ if (o.isMesh) o.frustumCulled = false; });
        // 朝向：VRM 1.0 面朝 +Z（正对镜头），VRM 0.x 面朝 -Z 才需要转 180°。
// 版本号在 v.meta.metaVersion 上，不是 v.metaVersion —— 取错地方就会一直转 180°，看到后脑勺。
var ver = String((v.meta && v.meta.metaVersion) || '0');
var isVrm1 = ver === '1';
v.scene.rotation.y = isVrm1 ? 0 : Math.PI;
console.log('[space] VRM 版本', ver, '→ rotation.y =', v.scene.rotation.y);
        fitModel(v.scene);
        avatar.add(v.scene);
        vrm = v;
        setupIdle(v);
      } else {
        // 普通 glb（Tripo 这类）：只有网格，没骨骼
        gltf.scene.traverse(function (o){
          if (!o.isMesh) return;
          o.frustumCulled = false;
          // Tripo 默认 metallicFactor=1，她不是金属件；不改的话整张脸会被"金属反射"吃掉，
          // 看起来就是白模。顺手把粗糙度抬一点，避免塑料感。
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(function (m){
            if (!m) return;
            if ('metalness' in m) m.metalness = 0.0;
            if ('roughness' in m && m.roughness > 0.85) m.roughness = 0.7;
            if ('envMapIntensity' in m) m.envMapIntensity = 1.1;
            m.needsUpdate = true;
          });
        });
        gltf.scene.rotation.y = Math.PI;
        fitModel(gltf.scene);
        avatar.add(gltf.scene);
      }
      vrmReady = true;
      body.visible = false; head.visible = false; hair.visible = false; tail.visible = false;
      warn('');
      console.log('[space] 模型已加载' + (v ? '（VRM）' : '（glb）'));
    } catch (e) {
      warn('模型处理失败：' + (e && e.message ? e.message : e));
    }
  }, function (p){
    if (p && p.total) hDoing.textContent = '模型加载中 ' + Math.round(p.loaded / p.total * 100) + '%';
    else if (p) hDoing.textContent = '模型加载中 ' + Math.round(p.loaded / 1024 / 1024) + 'MB';
  }, function (err){
    warn('模型加载失败（占位小人继续用）：' + (err && err.message ? err.message : err));
  });
}

var targetPos = new THREE.Vector3(0, 0, 0);
var placed = false;
var lastRoom = null;
var lastState = null;

function resolveRoom(state){
  if (!state || !state.place) return null;
  var want = String(state.place).trim();
  if (!want) return null;
  var hit = roomIndex.get(want);
  if (hit) return hit;
  for (var i = 0; i < DATA.rooms.length; i++){
    var r = DATA.rooms[i];
    if ((r.aliases || []).indexOf(want) >= 0) return r;
  }
  return null;
}

function placeAvatar(){
  var room = resolveRoom(lastState);
  lastRoom = room;
  if (!room){
    // 不在房间表里：放到 outside，并且只有在花园页才显示
    avatar.visible = floorId === (DATA.outside.floor || 'out');
    targetPos.set(DATA.outside.x, 0, DATA.outside.z);
    if (!placed) { avatar.position.copy(targetPos); placed = true; }
    return;
  }
  avatar.visible = room.floor === floorId;
  targetPos.set(room.x, 0, room.z);
  if (!placed) { avatar.position.copy(targetPos); placed = true; }
}

// ── 读状态 ──────────────────────────────────────────────────────────
async function load(force){
  try {
    var url = '/api/space/state' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : '');
    var res = await fetch(url, { cache: 'no-store' });
    if (res.status === 401 || res.status === 403){ warn('缺少或无效的控制台令牌：' + location.pathname + '?token=…'); return; }
    if (!res.ok){ warn('读取状态失败（HTTP ' + res.status + '）'); return; }
    var j = await res.json();

    var first = !DATA.rooms.length;
    if (first){
      DATA.floors = (j.rooms && j.rooms.floors) || [{ id: '1f', label: '一楼' }];
      DATA.rooms = (j.rooms && j.rooms.rooms) || [];
      DATA.outside = (j.rooms && j.rooms.outside) || DATA.outside;
      DATA.scenery = (j.rooms && j.rooms.scenery) || {};
      roomIndex.clear();
      DATA.rooms.forEach(function(r){
        roomIndex.set(r.label, r);
        (r.aliases || []).forEach(function(a){ roomIndex.set(a, r); });
      });
      floorId = (DATA.floors[0] && DATA.floors[0].id) || '1f';
      buildFloor(floorId);
      focusFloor(floorId);
    }

    lastState = j.state || null;
    placeAvatar();

    // 她在别的楼层 → 自动跟过去（用户手动切过就不再抢）
    if (autoFollow && lastRoom && lastRoom.floor !== floorId) goFloor(lastRoom.floor);
    if (autoFollow && !lastRoom && DATA.outside.floor && DATA.outside.floor !== floorId) goFloor(DATA.outside.floor);

    hPlace.textContent = lastState && lastState.place ? lastState.place : '（没有空间状态）';
    hDoing.textContent = (lastState && (lastState.detail || lastState.doing)) || '—';
    hFloor.textContent = lastRoom ? labelOfFloor(lastRoom.floor) : (lastState && lastState.place ? '不在房间表里' : '—');
    renderFloorButtons();
    warn('');
  } catch (e) {
    warn('连不上桥接：' + (e && e.message ? e.message : e));
  }
}

function labelOfFloor(id){
  for (var i = 0; i < DATA.floors.length; i++) if (DATA.floors[i].id === id) return DATA.floors[i].label;
  return id;
}

// ── 渲染循环 ────────────────────────────────────────────────────────
var last = performance.now();
function frame(now){
  var dt = Math.min(0.05, (now - last) / 1000); last = now;

  // 运镜插值：缓入缓出，角度/视野/注视点一起走，不然会像两个镜头硬接
  if (camTween){
    camTween.t += dt;
    var k = Math.min(1, camTween.t / camTween.dur);
    var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    var f = camTween.from, t = camTween.to;
    orbit.theta = f.theta + (t.theta - f.theta) * e;
    orbit.phi = f.phi + (t.phi - f.phi) * e;
    orbit.radius = f.radius + (t.radius - f.radius) * e;
    viewSpan = f.span + (t.span - f.span) * e;
    lookAt.set(f.x + (t.x - f.x) * e, f.y + (t.y - f.y) * e, f.z + (t.z - f.z) * e);
    resize();
    applyOrbit();
    if (k >= 1) camTween = null;
  } else if (faceMode){
    // 贴脸模式下她换房间/走动，镜头平滑跟过去，不要瞬移
    var follow = 1 - Math.exp(-5 * dt);
    lookAt.x += (avatar.position.x - lookAt.x) * follow;
    lookAt.z += (avatar.position.z - lookAt.z) * follow;
    // 电影感慢推：视野极慢地缩到 92%，到顶就停，不会一直怼脸
    var target = faceBaseSpan * 0.92;
    if (viewSpan > target) { viewSpan += (target - viewSpan) * (1 - Math.exp(-0.35 * dt)); resize(); }
    applyOrbit();
    // 一点手持晃动：完全静止的镜头最像"截图"，微抖才有呼吸
    var tt = now * 0.001;
    camera.position.x += Math.sin(tt * 1.7) * 0.004 * orbit.radius;
    camera.position.y += Math.sin(tt * 2.3) * 0.0028 * orbit.radius;
    camera.lookAt(lookAt);
  }

  if (avatar.visible){
    avatar.position.lerp(targetPos, 1 - Math.exp(-5 * dt));
    if (!vrmReady){
      // 占位小人的呼吸；VRM 加载后交给它自己的弹簧骨骼，不再整体缩放（会把模型拉变形）
      var t = now * 0.0011;
      var breath = 1 + Math.sin(t) * 0.009;
      avatar.scale.set(1, breath, 1);
      head.position.y = 0.99 + Math.sin(t) * 0.006;
      hair.position.y = 1.00 + Math.sin(t) * 0.006;
    }
  }
  // VRM 的头发/裙摆物理：每帧推进一次弹簧骨骼，不推进就是一块死的
  if (vrm) {
    // 用实际位移判断她在不在走：比"有没有目标点"准，被卡住时也不会原地踏步
    var mdx = avatar.position.x - prevPos.x;
    var mdz = avatar.position.z - prevPos.z;
    var spd = Math.sqrt(mdx * mdx + mdz * mdz) / Math.max(dt, 0.0001);
    prevPos.copy(avatar.position);
    if (spd > 0.25) updateWalk(dt, Math.min(spd, 3.5));
    else updateIdle(now * 0.001);
    try { vrm.update(dt); } catch (e) {}
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ── 交互 ────────────────────────────────────────────────────────────
document.getElementById('bReload').addEventListener('click', function(){
  DATA.rooms = []; roomIndex.clear(); placed = false; autoFollow = true; load(true);
});
document.getElementById('bFace').addEventListener('click', toggleView);
// F 键切换（页面上没有输入框，不会和打字冲突）
document.addEventListener('keydown', function(e){
  if (e.key === 'f' || e.key === 'F'){ e.preventDefault(); toggleView(); }
});
document.getElementById('bReset').addEventListener('click', function(){ faceMode = false; var fb = document.getElementById('bFace'); if (fb) fb.textContent = '看她'; focusFloor(floorId); });

// 拖拽转视角（维护角度状态，不反算；上下限夹住而不是丢增量）
var drag = null;
function endDrag(){ drag = null; }
renderer.domElement.addEventListener('pointerdown', function(e){
  drag = { x: e.clientX, y: e.clientY };
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) {}
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(function(ev){
  renderer.domElement.addEventListener(ev, endDrag);
});
window.addEventListener('blur', endDrag);   // 切窗口/丢焦点时别留着 drag，否则回来一动就跳
renderer.domElement.addEventListener('pointermove', function(e){
  if (!drag) return;
  var dx = (e.clientX - drag.x) * 0.0055, dy = (e.clientY - drag.y) * 0.0055;
  drag.x = e.clientX; drag.y = e.clientY;
  orbit.theta -= dx;
  orbit.phi = Math.max(PHI_MIN, Math.min(PHI_MAX, orbit.phi + dy));
  applyOrbit();
});
// 滚轮缩放（正交相机改视野宽度，不是距离）
renderer.domElement.addEventListener('wheel', function(e){
  e.preventDefault();
  var factor = e.deltaY > 0 ? 1.08 : 1 / 1.08;
  viewSpan = Math.max(3, Math.min(80, viewSpan * factor));
  resize();
}, { passive: false });

resize();
load(true);
loadModel();
setInterval(function(){ load(false); }, 3000);
requestAnimationFrame(frame);
</script>
</body></html>`;
}