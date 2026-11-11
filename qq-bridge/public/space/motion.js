// 她的动作系统：坐 / 看书 / 玩手机 / 泡水
// ---------------------------------------------------------------
// 为什么是「代码摆骨骼」而不是动画文件：
//   她没有动画资源，也没有能导出的绑定师。VRM 自带 54 根归一化骨骼，
//   直接给骨骼写欧拉角 + 四元数插值，就能做出连续动作，而且零下载、零版权。
//
// 两条铁律（踩了就是「假」）：
//   1. 任何骨骼角度都是「静止姿态 × 偏移」，绝不直接覆盖 —— 覆盖会把她整个人拽变形。
//   2. 换姿势必须 slerp 过渡（0.4~0.8 秒），瞬间跳过去比不动还难看。
//
// 方向约定（VRM 1.0 面朝 +Z，单位米）：
//   朝上的骨头（脊柱/颈/头）：+X = 往前倾 / 低头
//   朝下的骨头（手臂/腿）：    +X = 往后摆，-X = 往前摆
//   手臂下垂：左 +Z，右 -Z（这个符号是原页面 「+0.10 / -0.10」 验证过的）

export function createMotion(ctx) {
  const { THREE, vrm, avatar, idle, renderer, params, updateIdle, updateWalk, setTarget } = ctx;

  const hum = vrm.humanoid;
  const BONES = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot'
  ];
  const node = {}, rest = {};
  for (const n of BONES) {
    const b = hum.getNormalizedBoneNode(n);
    if (!b) continue;
    node[n] = b;
    rest[n] = b.quaternion.clone();
  }
  const HIPS_Y0 = node.hips ? node.hips.position.y : 0;

  // ── 姿势库 ────────────────────────────────────────────────────────
  // 所有角度都是用 VRM 骨骼做正向运动学（FK）量出来的，不是拍脑袋写的。
  // 关键事实（实测）：
  //   · 她的静止姿态是 **T-pose**（双臂平举），手在肩正外侧 0.43m
  //   · 左臂 z 负 = 下垂，右臂 z 正 = 下垂（z 正负号对左右臂相反）
  //   · 手臂 y 负（左）/ 正（右）= 往前摆；前臂同样
  //   · 大腿 x 负 = 抬腿朝前；小腿 x 正 = 膝盖后折
  //   · 髋下沉 0.36 时脚尖刚好落在 y=0（椅面高 0.54，正好坐实）
  const POSE = {
    stand: { hipsY: 0, q: { leftUpperArm: [0, 0, -1.25], rightUpperArm: [0, 0, 1.25] } },

    // 坐在椅子 / 沙发上：手放在大腿上（实测手高 0.73、身前 0.14）
    // 腿不再抬平：大腿 -1.10 / 小腿 +1.10 → 脚落在 y≈0.03，膝盖只比髋低 0.2
    // （原来 -1.48 是把大腿抱到胸口，膝盖顶到桌面，看着当然夸张）
    sit: {
      hipsY: -0.237,
      q: {
        leftUpperLeg: [-1.10, 0.06, 0.05], rightUpperLeg: [-1.10, -0.06, -0.05],
        leftLowerLeg: [1.10, 0, 0], rightLowerLeg: [1.10, 0, 0],
        leftFoot: [0.02, 0, 0], rightFoot: [0.02, 0, 0],
        spine: [0.05, 0, 0], chest: [0.02, 0, 0], neck: [-0.02, 0, 0],
        leftUpperArm: [0, 0, -1.00], rightUpperArm: [0, 0, 1.00],
        leftLowerArm: [0, -0.90, 0], rightLowerArm: [0, 0.90, 0]
      }
    },

    // 桌前看书：手落在桌面上（桌面顶 0.775，手实测 0.80），上身只前倾 13°
    // 之前是 37° 前倾 + 手举到 0.93（悬空捧书）+ 大腿抱到胸口 —— 三个地方一起夸张。
    read: {
      hipsY: -0.272,
      q: {
        leftUpperLeg: [-1.10, 0.06, 0.05], rightUpperLeg: [-1.10, -0.06, -0.05],
        leftLowerLeg: [1.10, 0, 0], rightLowerLeg: [1.10, 0, 0],
        leftFoot: [0.02, 0, 0], rightFoot: [0.02, 0, 0],
        spine: [0.10, 0, 0], chest: [0.05, 0, 0], neck: [0.16, 0, 0], head: [0.30, 0, 0],
        leftUpperArm: [0, -0.42, -1.00], rightUpperArm: [0, 0.42, 1.00],
        leftLowerArm: [0, -1.22, 0.62], rightLowerArm: [0, 1.22, -0.62]
      }
    },

    // 站着/坐着捧书看：手抬到胸口把书托住，头低下去看字。
    // 和 read 的区别是「手不在桌上」，所以书能跟着她走到别的房间。
    read_hold: {
      hipsY: -0.02,
      q: {
        spine: [0.08, 0, 0], chest: [0.05, 0, 0], neck: [0.20, 0, 0], head: [0.38, 0, 0],
        leftUpperArm: [0, -0.52, -0.72], rightUpperArm: [0, 0.52, 0.72],
        leftLowerArm: [0, -1.18, 0.30], rightLowerArm: [0, 1.18, -0.30],
        leftHand: [0, -0.15, 0], rightHand: [0, 0.15, 0]
      }
    },

    // 玩手机：右手举到右前方胸口高度，低头看屏幕
    phone: {
      hipsY: -0.237,
      q: {
        leftUpperLeg: [-1.10, 0.06, 0.05], rightUpperLeg: [-1.10, -0.06, -0.05],
        leftLowerLeg: [1.10, 0, 0], rightLowerLeg: [1.10, 0, 0],
        leftFoot: [0.02, 0, 0], rightFoot: [0.02, 0, 0],
        spine: [0.05, 0, 0], chest: [0.02, 0, 0], neck: [0.10, 0, 0], head: [0.22, 0.05, 0],
        rightUpperArm: [0, 0.20, 0.55], rightLowerArm: [0, 1.35, 0], rightHand: [0, 0.20, 0],
        leftUpperArm: [0, 0, -1.15], leftLowerArm: [0, -0.50, 0]
      }
    },

    // 泡水：整个身体沉到水面以下，靠裁切面把水下的部分剪掉。
    // 实测量出来的约束：胸口比脚踝高 0.988，水面 0.035 → 下沉 0.953。
    // 手臂必须保持在 1.04 以上才不会被裁切面带下去，所以是「手臂浮在水面上」，
    // 不是「双手垂在水里」—— 后者会被剪掉，看着像没有手。
    swim: {
      hipsY: 0,
      q: {
        spine: [-0.06, 0, 0], chest: [-0.04, 0, 0], neck: [-0.10, 0, 0], head: [-0.08, 0, 0],
        leftUpperArm: [0, -0.30, -0.25], rightUpperArm: [0, 0.30, 0.25],
        leftLowerArm: [0, -0.40, 0], rightLowerArm: [0, 0.40, 0],
        leftUpperLeg: [-0.28, 0.05, 0], rightUpperLeg: [0.10, -0.05, 0],
        leftLowerLeg: [0.55, 0, 0], rightLowerLeg: [0.35, 0, 0],
        leftFoot: [0.28, 0, 0], rightFoot: [0.22, 0, 0]
      }
    }
  };

  // ── 锚点：坐在哪儿、朝哪边 ────────────────────────────────────────
  // 房间家具坐标（家具组原点 = 房间中心），sign 决定朝向
  const ANCHOR = {
    // 每件家具的座面高度和腿部角度都不一样。
    // hipsY = (座面 + 0.06) - 站立髋高 0.912 —— 再高就飘，再低屁股就陷进垫子。
    // leg = [大腿, 小腿]：这两组角度是用「线段采样 vs 家具包围盒」碰撞检测挑出来的，
    // 只有大腿接近水平时，才不会横穿坐垫（斜着往下放必然穿进椅面）。
    study: { dx: 0, dz: -0.75, rotY: Math.PI, pose: 'read', hipsY: -0.282, leg: [-1.45, 0.75] },
    living: { dx: 0, dz: -1.60, rotY: 0, pose: 'sit', hipsY: -0.277, leg: [-1.45, 1.15] },
    // 泳池没有「座位」，但必须给个锚点：否则 setTarget 不会被调用，
    // 她会沿用上一次的客厅座位坐标，沉在客厅地板下面泡水。
    pool: { dx: 0, dz: 0, rotY: 0, pose: 'swim', hipsY: 0, leg: null }
  };

  // ── 手机 ──────────────────────────────────────────────────────────
  const phone = new THREE.Group();
  phone.visible = false;
  (function buildPhone() {
    const W = 0.074, H = 0.152, D = 0.0085;
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1d2028, roughness: 0.32, metalness: 0.55 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), bodyMat);
    body.castShadow = true;
    phone.add(body);

    // 屏幕：canvas 画一个简版聊天界面（她本来就是个聊天机器人，这个细节值）
    const c = document.createElement('canvas');
    c.width = 96; c.height = 196;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 196);
    grd.addColorStop(0, '#101a2e'); grd.addColorStop(1, '#0b1220');
    g.fillStyle = grd; g.fillRect(0, 0, 96, 196);
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(28, 5, 40, 3);     // 状态条
    g.fillStyle = 'rgba(255,158,181,.9)';                                  // 她的气泡
    g.beginPath(); g.roundRect ? g.roundRect(46, 26, 42, 20, 7) : g.rect(46, 26, 42, 20); g.fill();
    g.fillStyle = 'rgba(120,180,255,.85)';                                 // 对面气泡
    g.beginPath(); g.roundRect ? g.roundRect(8, 56, 40, 26, 7) : g.rect(8, 56, 40, 26); g.fill();
    g.beginPath(); g.roundRect ? g.roundRect(8, 90, 30, 18, 7) : g.rect(8, 90, 30, 18); g.fill();
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(8, 150, 80, 3);      // 输入条
    g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(8, 158, 54, 3);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 0.90, H * 0.94),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    );
    screen.position.z = D / 2 + 0.0006;
    phone.add(screen);
    // 摄像头
    const cam = new THREE.Mesh(new THREE.CircleGeometry(0.0022, 8),
      new THREE.MeshBasicMaterial({ color: 0x0a0c10 }));
    cam.position.set(0, H / 2 - 0.006, D / 2 + 0.0008);
    phone.add(cam);
    phone.rotation.x = -0.35;
  })();
  avatar.add(phone);

  // ── 泡水：水面裁切 ────────────────────────────────────────────────
  // 泳池水面在 y=0.035。给她挂一个水平裁切面，把水面以下的部分剪掉，
  // 再把整个人沉下去 —— 裁切面正好落在她腰胸之间，看起来就是「泡在水里」。
  const WATER_Y = 0.035;
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_Y);
  renderer.localClippingEnabled = true;
  const herMats = [];
  vrm.scene.traverse(function (o) {
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
      if (m && herMats.indexOf(m) === -1) herMats.push(m);
    });
  });
  let clipped = false;
  function setClip(on) {
    if (on === clipped) return;
    clipped = on;
    for (const m of herMats) {
      m.clippingPlanes = on ? [clipPlane] : null;
      m.clipShadows = on;
      m.needsUpdate = true;      // 裁切面数量变了必须重编译着色器
    }
  }

  // 她的胸高（站立时，相对脚底），用来算该沉多深
  let chestH = 1.13;
  (function measureChest() {
    try {
      const cb = node.chest || node.spine;
      if (!cb) return;
      const p = new THREE.Vector3();
      cb.getWorldPosition(p);
      const foot = new THREE.Vector3();
      (node.leftFoot || node.hips).getWorldPosition(foot);
      const d = p.y - foot.y;
      if (d > 0.6 && d < 1.6) chestH = d;
    } catch (e) {}
  })();

  // ── 状态 ──────────────────────────────────────────────────────────
  let poseName = 'stand';
  let want = 'stand';
  let weight = 0;
  let anchorKey = '';
  let facing = 0;
  let swimY = 0;
  let lastState = null;
  // ── 自己走动 ──
  let curRoom = null;         // 她现在所在的房间（用于取随机落点）
  let swimSite = false;       // 在泳池里就别乱走了
  let goal = null;            // 当前目标点 { x, z }
  let stroll = false;         // false | 'roam' | 'return'
  let strollUntil = 0;
  let sitSecs = 0;            // 这次坐下了多久
  let nextStroll = 35 + Math.random() * 55;
  let wayTimer = 0;
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _tmpQ = new THREE.Quaternion();
  const _hp = new THREE.Vector3(), _wp = new THREE.Vector3(), _av = new THREE.Vector3(), _lv = new THREE.Vector3();

  function pickWant(st) {
    if (!st) return { pose: 'stand', anchor: null };
    const place = String(st.place || '').trim();
    const doing = String((st.detail || '') + ' ' + (st.doing || '')).trim();
    if (/泳池|水池|水里|游泳|泡水|浴缸|洗澡/.test(place + doing)) return { pose: 'swim', anchor: 'pool' };
    if (/书房/.test(place)) return { pose: 'read', anchor: 'study' };
    // 在别处也看书：捧着书站着看，书会跟到那个房间
    if (/看书|读书|翻书|阅读/.test(doing)) return { pose: 'read_hold', anchor: null };
    if (/客厅/.test(place)) {
      if (/手机|刷|直播/.test(doing)) return { pose: 'phone', anchor: 'living' };
      // 沙发上就不做「手伸到桌面」的看书动作了，坐着就好
      return { pose: 'sit', anchor: 'living' };
    }
    // 卧室暂时站着：躺姿还没做，先别让她坐在半空
    return { pose: 'stand', anchor: null };
  }

  function setState(st) {
    lastState = st;
    const w = pickWant(st);
    want = w.pose;
    curRoom = findRoom(String(st.place || '').trim());
    swimSite = (w.pose === 'swim');
    anchorKey = w.anchor || '';
    // 目标点必须每次重新压一遍：placeAvatar() 每 3 秒会把 targetPos 打回房间中心，
    // 只在「锚点变了」时设一次的话，她会每 3 秒从座位上/溜达路上被拽回去。
    if (stroll !== false){
      // 正在溜达：把当前目标点重新压回去，别被打断
      if (goal && setTarget) setTarget(goal.x, goal.z);
    } else if (w.anchor){
      toSeat();
    } else if (goal && setTarget){
      setTarget(goal.x, goal.z);
    }
  }

  function findRoom(label) {
    const rooms = (ctx.DATA && ctx.DATA.rooms) || [];
    for (const r of rooms) {
      if (r.label === label) return r;
      if ((r.aliases || []).indexOf(label) >= 0) return r;
    }
    return null;
  }

  function applyPose(p, k, dt, t, hipsY) {
    const q = p.q || {};
    const ease = 1 - Math.exp(-9 * dt);
    const kk = Math.max(0, Math.min(1, k));
    // 髋高按家具座面算（每个锚点不一样），没锚点才用姿势自带的默认值
    const hy = (hipsY === undefined || hipsY === null) ? (p.hipsY || 0) : hipsY;
    // 坐着也要呼吸：胸口叠一点点起伏，否则就是个静止的模型
    const br = Math.sin((t || 0) * 1.25) * 0.014;
    for (const n of Object.keys(node)) {
      const e = q[n];
      if (e) { _e.set(e[0] + ((n === 'spine' || n === 'chest') ? br : 0), e[1], e[2]); _tmpQ.setFromEuler(_e); }
      else _tmpQ.identity();
      _q.copy(rest[n]).multiply(_tmpQ);      // 目标姿势
      _q2.copy(rest[n]).slerp(_q, kk);       // 按权重混回静止姿态
      node[n].quaternion.slerp(_q2, ease);   // 再平滑逼近，避免任何跳变
    }
    if (node.hips) {
      const targetY = HIPS_Y0 + hy * kk;
      node.hips.position.y += (targetY - node.hips.position.y) * Math.min(1, ease * 1.6);
    }
  }

  // 把锚点里的腿部角度盖到姿势上（碰撞检测过的值）
  function withLeg(p, leg) {
    if (!leg) return p;
    const q = Object.assign({}, p.q);
    q.leftUpperLeg = [leg[0], 0.06, 0.05];
    q.rightUpperLeg = [leg[0], -0.06, -0.05];
    q.leftLowerLeg = [leg[1], 0, 0];
    q.rightLowerLeg = [leg[1], 0, 0];
    q.leftFoot = [0.02, 0, 0];
    q.rightFoot = [0.02, 0, 0];
    return { hipsY: p.hipsY, q };
  }

  function update(dt, t, spd) {
    // ── 她会自己走动 ────────────────────────────────────────────────
    // 坐久了就起身在屋里溜达一圈，再走回座位坐下。
    // 目标点由 motion 自己持有，并且每次 setState（页面每 3 秒轮询）都会重新压回去，
    // 否则 placeAvatar() 会把她拽回房间中心。
    const roaming = stroll !== false;
    const effWant = roaming ? 'stand' : want;
    if (effWant !== poseName) { poseName = effWant; }
    const target = poseName === 'stand' ? 0 : 1;
    weight += (target - weight) * Math.min(1, dt * 3.2);
    if (weight < 0.004) weight = 0;

    if (curRoom && !swimSite){
      const seated = weight > 0.4;
      if (stroll === false){
        if (seated){
          sitSecs += dt;
          if (sitSecs > nextStroll) startStroll(t);
        } else {
          if (!goal) pickWay();
          wayTimer -= dt;
          if (wayTimer <= 0) pickWay();
        }
      } else if (roaming){
        if (stroll === 'roam' && t > strollUntil){ stroll = 'return'; toSeat(); }
        if (stroll === 'return' && nearGoal(0.4)){ stroll = false; sitSecs = 0; nextStroll = 35 + Math.random() * 55; }
        else if (stroll === 'roam' && nearGoal(0.3)) pickWay();
      }
    } else if (stroll !== false) stroll = false;

    // 泡水：沉下去 + 缓慢起伏
    const swimming = poseName === 'swim' && weight > 0.2;
    const wantY = swimming ? (WATER_Y - chestH) + Math.sin(t * 0.9) * 0.022 : 0;
    swimY += (wantY - swimY) * Math.min(1, dt * 2.4);
    avatar.position.y = swimY;
    setClip(swimming);

    // 朝向：坐着面向桌子/沙发背；走路时朝行进方向；站着回正
    let wantRot = 0;
    if (weight > 0.02) wantRot = facing;
    else if (goal && !nearGoal(0.35)){
      wantRot = Math.atan2(goal.x - avatar.position.x, goal.z - avatar.position.z);
      facing = wantRot;
    }
    let dr = ((wantRot - avatar.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    avatar.rotation.y += dr * Math.min(1, dt * (weight > 0.02 ? 4 : 2.6));

    if (weight > 0) {
      const a = ANCHOR[anchorKey];
      applyPose(withLeg(POSE[poseName] || POSE.stand, a && a.leg), weight, dt, t, a ? a.hipsY : null);
      // 手机只在 phone 姿势里出现，并且跟着右手走
      updatePhone(dt, weight);
    } else {
      setClip(false);
      if (spd > 0.25) updateWalk(dt, Math.min(spd, 3.5));
      else updateIdle(t);
    }
  }

  // ── 走动：目标点 / 溜达 / 回座位 ──────────────────────────────────
  function setGoal(x, z, rotY){
    goal = { x, z };
    if (rotY !== undefined) facing = rotY;
    if (setTarget) setTarget(x, z);
  }
  function nearGoal(r){
    if (!goal) return true;
    const dx = goal.x - avatar.position.x, dz = goal.z - avatar.position.z;
    return Math.sqrt(dx * dx + dz * dz) < (r || 0.3);
  }
  function pickWay(){
    if (!curRoom) return;
    const p = ctx.wpos(curRoom);
    // 房间没有 w/d 或者数据坏了，就当 4×4 —— 否则随机落点会算出 NaN，
    // 一旦 NaN 进了 avatar.position，她整个人就从画面里消失且再也回不来。
    const w = Number.isFinite(curRoom.w) ? curRoom.w : 4;
    const d = Number.isFinite(curRoom.d) ? curRoom.d : 4;
    const mx = Math.max(0.35, w / 2 - 0.95);
    const mz = Math.max(0.35, d / 2 - 0.95);
    const gx = p.x + (Math.random() * 2 - 1) * mx;
    const gz = p.z + (Math.random() * 2 - 1) * mz;
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) return;
    setGoal(gx, gz);
    wayTimer = 3.5 + Math.random() * 4.5;
  }
  function startStroll(t){
    if (stroll !== false) return;
    stroll = 'roam';
    strollUntil = t + 9 + Math.random() * 8;   // 溜达 9~17 秒
    pickWay();
  }
  function toSeat(){
    const room = curRoom;
    const a = ANCHOR[anchorKey];
    if (room && a){
      const p = ctx.wpos(room);
      setGoal(p.x + a.dx, p.z + a.dz, a.rotY);
    }
  }

  function updatePhone(dt, k) {
    const on = poseName === 'phone';
    if (!on) { if (phone.visible) phone.visible = false; return; }
    phone.visible = true;
    const hand = node.rightHand;
    if (!hand) return;
    hand.getWorldPosition(_wp);
    avatar.worldToLocal(_hp.copy(_wp));
    phone.position.copy(_hp).add(_av.set(0, 0.05, 0.025));
    const head = node.head;
    if (head) {
      head.getWorldPosition(_lv);
      // Object3D.lookAt 让 +Z 朝向目标；屏幕就在 +Z 那一面，所以正好朝她自己
      phone.lookAt(_lv);
      phone.rotateX(-0.22);               // 稍微仰一点，像在看屏幕
    }
  }

  // ── 调试：把所有姿势的关节位置打出来，不用眼睛也能验收 ────────────
  function testAll() {
    const out = [];
    const keepPose = poseName, keepW = weight, keepY = avatar.position.y, keepRot = avatar.rotation.y;
    for (const name of Object.keys(POSE)) {
      for (const n of Object.keys(node)) node[n].quaternion.copy(rest[n]);
      if (node.hips) node.hips.position.y = HIPS_Y0;
      if (name === 'swim') { avatar.position.y = WATER_Y - chestH; avatar.rotation.y = 0; }
      else { avatar.position.y = 0; avatar.rotation.y = name === 'stand' ? 0 : facingFor(name); }
      const p = POSE[name];
      for (const n of Object.keys(node)) {
        const e = (p.q || {})[n];
        if (e) { _e.set(e[0], e[1], e[2]); _tmpQ.setFromEuler(_e); }
        else _tmpQ.identity();
        node[n].quaternion.copy(rest[n]).multiply(_tmpQ);
      }
      if (node.hips) node.hips.position.y = HIPS_Y0 + (p.hipsY || 0);
      avatar.updateMatrixWorld(true);
      const g = function (n2) { const b = node[n2]; if (!b) return null; const v = new THREE.Vector3(); b.getWorldPosition(v); return v; };
      const lf = g('leftFoot'), rf = g('rightFoot'), hp = g('hips'), hd = g('head');
      const lh = g('leftHand'), rh = g('rightHand');
      const f = (v) => v ? `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})` : '-';
      out.push(`${name.padEnd(6)} 脚底 y=${lf ? lf.y.toFixed(2) : '?'}/${rf ? rf.y.toFixed(2) : '?'} 髋 y=${hp ? hp.y.toFixed(2) : '?'} 头 y=${hd ? hd.y.toFixed(2) : '?'} 左手 ${f(lh)} 右手 ${f(rh)}`);
    }
    // 复原
    poseName = keepPose; weight = keepW; avatar.position.y = keepY; avatar.rotation.y = keepRot;
    return out.join('\n');
  }
  function facingFor(name) { return name === 'stand' || name === 'swim' ? 0 : Math.PI; }

  return {
    update,
    setState,
    setFacing(y) { facing = y; },
    info() {
      return `动作 ${poseName} (w=${weight.toFixed(2)}) y=${avatar.position.y.toFixed(2)} rot=${avatar.rotation.y.toFixed(2)}`
        + ` 手机=${phone.visible ? '在手上' : '收起'} 裁切=${clipped ? '开' : '关'}`
        + ` 走动=${stroll || '坐定'} 坐下=${sitSecs.toFixed(0)}s`;
    },
    testAll,
    phone
  };
}