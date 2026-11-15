// 3D 等角辦公室場景：家具、燈光、尋路網格、像素風角色。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const W = 22, D = 14;            // 房間：x ∈ [-11, 11]，z ∈ [-7, 7]
const CELL = 0.5;
const COLS = W / CELL, ROWS = D / CELL;
const WALL_H = 3.2;

export const STATUS_TEXT = { idle: '閒置', working: '工作中', thinking: '思考中', chatting: '聊天中', walking: '移動中' };

/* ---------------- helpers ---------------- */
const matCache = new Map();
function mat(color, opts = {}) {
  const { unique, ...rest } = opts;
  const key = color + JSON.stringify(rest);
  if (!unique && matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...rest });
  if (!unique) matCache.set(key, m);
  return m;
}
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* ---------------- Office ---------------- */
export class Office {
  constructor(container) {
    this.container = container;
    this.blocked = new Uint8Array(COLS * ROWS);
    this.screens = [];      // 每個座位的螢幕材質
    this.lamps = [];
    this.agents = [];

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(r.domElement);

    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.minZoom = 0.6;
    this.controls.maxZoom = 3;
    this.controls.minPolarAngle = 0.45;
    this.controls.maxPolarAngle = 1.25;
    this.controls.minAzimuthAngle = -0.2;
    this.controls.maxAzimuthAngle = 1.75;
    this.resetCamera();

    this.buildLights();
    this.buildRoom();
    this.buildFurniture();

    this.clock = new THREE.Clock();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    r.setAnimationLoop(() => this.tick());
  }

  resetCamera() {
    this.camera.position.set(16, 17, 18);
    this.camera.zoom = 1;
    this.controls.target.set(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const aspect = w / h;
    const view = aspect > 1.4 ? 9 : 13 / Math.max(aspect, 0.7);
    this.camera.left = -view * aspect; this.camera.right = view * aspect;
    this.camera.top = view; this.camera.bottom = -view;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    for (const a of this.agents) a.update(dt, t);
    for (const s of this.screens) {
      if (s.on) s.mat.emissiveIntensity = 0.9 + Math.sin(t * 9 + s.phase) * 0.15;
    }
    this.onTick?.(dt, t);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  /* ---------- building blocks ---------- */
  box(w, h, d, color, x, y, z, o = {}) {
    const m = new THREE.Mesh(boxGeo, o.material || mat(color, o.mat));
    m.scale.set(w, h, d);
    m.position.set(x, y + h / 2, z);
    m.castShadow = o.cast !== false;
    m.receiveShadow = true;
    (o.parent || this.scene).add(m);
    if (o.block) this.block(x - w / 2, z - d / 2, x + w / 2, z + d / 2);
    return m;
  }

  block(x0, z0, x1, z1) {
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const [x, z] = cellCenter(c, r);
      if (x > x0 - 0.2 && x < x1 + 0.2 && z > z0 - 0.2 && z < z1 + 0.2) this.blocked[r * COLS + c] = 1;
    }
  }

  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a2a1c, 0.6);
    this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 1.6));
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 50 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
  }

  buildRoom() {
    // 木地板
    const floorTex = canvasTexture(512, 512, (g, w, h) => {
      const rows = 8;
      for (let i = 0; i < rows; i++) {
        const off = (i % 2) * 128;
        for (let x = -off; x < w; x += 256) {
          const shade = 150 + Math.floor(Math.random() * 25);
          g.fillStyle = `rgb(${shade + 25},${shade - 25},${shade - 75})`;
          g.fillRect(x, i * (h / rows), 256, h / rows);
          g.strokeStyle = 'rgba(60,30,10,.55)';
          g.lineWidth = 3;
          g.strokeRect(x, i * (h / rows), 256, h / rows);
        }
      }
    });
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(W / 4, D / 4);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, D), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.75 }));
    floor.position.y = -0.15;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 牆面（後牆與左牆，前方開放方便觀看）
    const wallMat = mat(0x5f8f8a);
    this.box(W + 0.3, WALL_H, 0.3, null, 0, 0, -D / 2 - 0.15, { material: wallMat });
    this.box(0.3, WALL_H, D, null, -W / 2 - 0.15, 0, 0, { material: wallMat });
    this.box(W + 0.3, 0.18, 0.34, 0x3c2a20, 0, 0, -D / 2 - 0.1, { cast: false });
    this.box(0.34, 0.18, D, 0x3c2a20, -W / 2 - 0.1, 0, 0, { cast: false });
    this.box(W + 0.3, 0.12, 0.4, 0x2f3f5a, 0, WALL_H - 0.12, -D / 2 - 0.1, { cast: false });
    this.box(0.4, 0.12, D, 0x2f3f5a, -W / 2 - 0.1, WALL_H - 0.12, 0, { cast: false });
    // 牆邊動線限制
    this.block(-W / 2 - 1, -D / 2 - 1, W / 2 + 1, -D / 2 + 0.1);
    this.block(-W / 2 - 1, -D / 2 - 1, -W / 2 + 0.1, D / 2 + 1);

    // 窗戶
    this.windowMats = [];
    for (const x of [0, 4.6]) {
      this.box(3.6, 1.5, 0.12, 0x2b2b38, x, 0.95, -D / 2 + 0.02, { cast: false });
      const m = new THREE.MeshStandardMaterial({ roughness: 0.4, emissive: 0xffffff, emissiveIntensity: 0.6 });
      this.windowMats.push(m);
      this.box(3.3, 1.3, 0.05, null, x, 1.05, -D / 2 + 0.1, { material: m, cast: false });
      this.box(0.08, 1.3, 0.08, 0x2b2b38, x, 1.05, -D / 2 + 0.14, { cast: false });
    }
    this.cityNight = canvasTexture(256, 112, (g, w, h) => {
      g.fillStyle = '#0d1a4a'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 40; i++) { g.fillStyle = '#fff'; g.fillRect(Math.random() * w, Math.random() * h * 0.4, 1.5, 1.5); }
      for (let x = 0; x < w; x += 18 + Math.random() * 10) {
        const bh = 30 + Math.random() * 70, bw = 14 + Math.random() * 12;
        g.fillStyle = '#121a33'; g.fillRect(x, h - bh, bw, bh);
        for (let wy = h - bh + 4; wy < h - 3; wy += 6) for (let wx = x + 2; wx < x + bw - 2; wx += 4)
          if (Math.random() < 0.45) { g.fillStyle = Math.random() < 0.8 ? '#ffe9a8' : '#9fd3ff'; g.fillRect(wx, wy, 2, 3); }
      }
    });
    this.cityDay = canvasTexture(256, 112, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#7fc4ff'); grd.addColorStop(1, '#d9f0ff');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(60, 25, 22, 8, 0, 0, 7); g.ellipse(180, 18, 28, 9, 0, 0, 7); g.fill();
      for (let x = 0; x < w; x += 18 + Math.random() * 10) {
        const bh = 30 + Math.random() * 70, bw = 14 + Math.random() * 12;
        g.fillStyle = ['#8aa2bd', '#9fb3c8', '#7d93ad'][Math.floor(Math.random() * 3)]; g.fillRect(x, h - bh, bw, bh);
        g.fillStyle = 'rgba(255,255,255,.35)';
        for (let wy = h - bh + 4; wy < h - 3; wy += 6) g.fillRect(x + 2, wy, bw - 4, 2);
      }
    });

    // 白板（折線圖）
    const chartTex = canvasTexture(256, 140, (g, w, h) => {
      g.fillStyle = '#fafafa'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#e04848'; g.lineWidth = 5; g.beginPath();
      [[20, 110], [60, 85], [95, 95], [135, 60], [170, 70], [205, 35]].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.fillStyle = '#f4c542'; g.fillRect(222, 30, 22, 22); g.fillStyle = '#5aa0e6'; g.fillRect(222, 58, 22, 22);
    });
    this.box(3.4, 1.9, 0.08, null, -8, 1.0, -D / 2 + 0.04, { material: new THREE.MeshStandardMaterial({ map: chartTex }), cast: false });

    // 時鐘
    const clock = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.06, 24), mat(0xe8e0d0));
    clock.rotation.x = Math.PI / 2; clock.position.set(2.3, 2.3, -D / 2 + 0.05); this.scene.add(clock);
    this.clockHand = new THREE.Group();
    this.clockHand.position.set(2.3, 2.3, -D / 2 + 0.1);
    this.scene.add(this.clockHand);
    this.box(0.05, 0.24, 0.02, 0x222222, 0, -0.03, 0, { parent: this.clockHand, cast: false });

    // 出入口 + 綠色指示燈
    this.box(1.3, 2.3, 0.12, 0x6b3b1f, 8.6, 0, -D / 2 + 0.06);
    this.box(1.1, 2.15, 0.06, 0x8a4d28, 8.6, 0, -D / 2 + 0.12);
    this.box(0.08, 0.08, 0.1, 0xd9b45a, 9.0, 1.05, -D / 2 + 0.18, { cast: false });
    this.box(0.7, 0.24, 0.06, null, 8.6, 2.55, -D / 2 + 0.06, { material: mat(0x1aa34a, { emissive: 0x22dd66, emissiveIntensity: 0.9 }), cast: false });

    // 壁燈
    for (const x of [-9.5, -6.5, -3.6, 0, 4.6]) {
      const m = mat(0xfff3cf, { emissive: 0xffd27a, emissiveIntensity: 1.2, unique: true });
      this.box(0.5, 0.28, 0.25, null, x, WALL_H - 0.6, -D / 2 + 0.15, { material: m, cast: false });
      const pl = new THREE.PointLight(0xffb866, 0, 9, 1.6);
      pl.position.set(x, WALL_H - 0.9, -D / 2 + 1.2);
      this.scene.add(pl);
      this.lamps.push({ mesh: m, light: pl });
    }
  }

  buildFurniture() {
    /* --- 會議室（左後） --- */
    const glass = new THREE.MeshStandardMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.18, roughness: 0.1, depthWrite: false });
    const glassWall = (w, d, x, z, gapFrom, gapTo) => {
      // 玻璃牆，可留一個門口
      const horizontal = w > d;
      const len = horizontal ? w : d;
      const start = (horizontal ? x : z) - len / 2;
      const segs = gapFrom == null ? [[0, len]] : [[0, gapFrom], [gapTo, len]];
      for (const [a, b] of segs) {
        const L = b - a, mid = start + a + L / 2;
        const gx = horizontal ? mid : x, gz = horizontal ? z : mid;
        const gw = horizontal ? L : 0.06, gd = horizontal ? 0.06 : L;
        this.box(gw, 1.6, gd, null, gx, 0, gz, { material: glass, cast: false, block: true });
        this.box(horizontal ? L : 0.1, 0.08, horizontal ? 0.1 : L, 0x1d2433, gx, 1.6, gz, { cast: false });
        this.box(horizontal ? L : 0.1, 0.06, horizontal ? 0.1 : L, 0x1d2433, gx, 0, gz, { cast: false });
      }
    };
    glassWall(6.2, 0.06, -7.9, -2.4, 3.6, 4.8);
    glassWall(0.06, 4.6, -4.8, -4.7);
    this.box(4.2, 0.12, 1.4, 0xf3ede2, -7.9, 0.75, -4.7, { block: true });
    for (const lx of [-9.8, -6.0]) for (const lz of [-5.2, -4.2]) this.box(0.1, 0.75, 0.1, 0x222222, lx, 0, lz);
    this.box(0.4, 0.25, 0.3, 0x222222, -7.4, 0.87, -4.7);
    this.meetingSeats = [];
    for (const cx of [-9.3, -7.9, -6.5]) {
      this.chair(cx, -5.75, 0, 0xf1e6d2);
      this.chair(cx, -3.65, Math.PI, 0xf1e6d2);
      this.meetingSeats.push({ x: cx, z: -5.75, ry: 0 }, { x: cx, z: -3.65, ry: Math.PI });
    }

    /* --- 書櫃（後牆） --- */
    this.shelf(-3.6, -D / 2 + 0.45);

    /* --- 辦公區（中間，2 排 × 3 張） --- */
    this.seats = [];
    for (const z of [-3.6, -0.4]) for (const x of [-2.6, 0.6, 3.8]) this.seats.push(this.desk(x, z));

    /* --- 主管辦公室（右前，玻璃隔間） --- */
    glassWall(0.06, 5.6, 5.6, 4.2, 3.4, 4.6);
    glassWall(5.4, 0.06, 8.3, 1.4);
    this.box(2.4, 0.1, 1.1, 0xf3ead8, 8.3, 0.8, 4.3, { block: true });
    this.box(2.4, 0.8, 0.1, 0x2c3245, 8.3, 0, 4.85);
    this.box(0.1, 0.8, 1.1, 0x2c3245, 7.15, 0, 4.3);
    this.box(0.1, 0.8, 1.1, 0x2c3245, 9.45, 0, 4.3);
    const mon = this.box(0.9, 0.55, 0.06, 0x111111, 8.7, 0.95, 4.55);
    mon.rotation.y = Math.PI;
    const msm = mat(0x223355, { emissive: 0x7fb7ff, emissiveIntensity: 0.9, unique: true });
    this.box(0.82, 0.47, 0.02, null, 8.7, 0.99, 4.51, { material: msm, cast: false });
    this.screens.push({ mat: msm, on: true, phase: 1 });
    this.box(0.25, 0.2, 0.2, 0xffffff, 7.7, 0.9, 4.2);
    this.plant(9.6, 5.6, 1.1);
    this.chair(8.3, 3.55, 0, 0x2f2f3a);
    this.managerSeat = { x: 8.3, z: 3.55, ry: 0, sit: true };
    this.box(0.5, 1.6, 2.2, 0xd8c7a6, 10.6, 0, 3.6, { block: true });   // 主管櫃
    // 檯燈
    this.box(0.06, 0.45, 0.06, 0x333333, 9.2, 0.9, 4.5);
    const lampMat = mat(0xfff0c8, { emissive: 0xffcc66, emissiveIntensity: 1.2, unique: true });
    this.box(0.3, 0.16, 0.3, null, 9.2, 1.33, 4.5, { material: lampMat });
    const deskLamp = new THREE.PointLight(0xffaa55, 0, 6, 1.4);
    deskLamp.position.set(9.0, 1.8, 4.0); this.scene.add(deskLamp);
    this.lamps.push({ mesh: lampMat, light: deskLamp, strong: true });

    /* --- 茶水間（右後） --- */
    this.box(3.6, 0.9, 0.7, 0xdad6cf, 10.6 - 1.8, 0, -4.2, { block: true });
    this.box(3.6, 0.06, 0.74, 0x3a3a44, 10.6 - 1.8, 0.9, -4.2);
    this.box(0.45, 0.55, 0.4, 0x333333, 7.8, 0.96, -4.2);
    this.box(0.2, 0.04, 0.2, 0xffffff, 7.8, 1.0, -3.95);
    this.box(0.9, 2.0, 0.8, 0xe8edf0, 10.4, 0, -6.2, { block: true });
    this.box(0.05, 0.6, 0.05, 0x999999, 10.0, 1.1, -5.78);
    this.box(0.45, 1.3, 0.45, 0xf2f2f2, 7.3, 0, -6.4, { block: true });
    this.box(0.35, 0.45, 0.35, null, 7.3, 1.3, -6.4, { material: mat(0x6ec6ff, { transparent: true, opacity: 0.75 }) });
    this.pantrySpots = [{ x: 8.3, z: -3.3, ry: Math.PI }, { x: 9.4, z: -3.3, ry: Math.PI }, { x: 7.3, z: -5.7, ry: Math.PI }];

    /* --- 休息區（左前） --- */
    this.box(5.4, 0.02, 3.8, 0x3d4a8a, -7.6, 0, 4.2, { cast: false });
    this.box(4.2, 0.45, 0.9, 0x5a6fd0, -7.6, 0, 6.3, { block: true });
    this.box(4.2, 0.7, 0.3, 0x4a5dbb, -7.6, 0.45, 6.6);
    this.box(0.9, 0.45, 2.4, 0x5a6fd0, -10.2, 0, 4.8, { block: true });
    this.box(0.3, 0.7, 2.4, 0x4a5dbb, -10.5, 0.45, 4.8);
    this.box(1.6, 0.4, 0.9, 0x8a5a3c, -7.6, 0, 4.4, { block: true });
    this.box(0.25, 0.12, 0.18, 0xffffff, -7.9, 0.4, 4.3);
    this.plant(-4.8, 6.4, 1.3);
    this.plant(-10.4, 2.4, 1.0);
    // 圓桌 + 小凳
    const rt = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.08, 20), mat(0x6b4a7a));
    rt.position.set(-2.4, 0.72, 4.8); rt.castShadow = true; this.scene.add(rt);
    this.box(0.12, 0.72, 0.12, 0x333333, -2.4, 0, 4.8, { block: true });
    this.block(-3.1, 4.1, -1.7, 5.5);
    this.loungeSpots = [
      { x: -8.6, z: 5.95, ry: Math.PI, sit: true }, { x: -6.6, z: 5.95, ry: Math.PI, sit: true },
      { x: -9.65, z: 4.4, ry: Math.PI / 2, sit: true }, { x: -2.4, z: 3.8, ry: 0 }, { x: -1.3, z: 4.8, ry: -Math.PI / 2 },
      { x: -2.4, z: 5.9, ry: Math.PI },
    ];
    this.chatPairs = [
      [{ x: -8.6, z: 5.95, ry: Math.PI, sit: true }, { x: -6.6, z: 5.95, ry: Math.PI, sit: true }],
      [{ x: -2.4, z: 3.7, ry: 0 }, { x: -2.4, z: 5.9, ry: Math.PI }],
      [{ x: 8.0, z: -3.2, ry: Math.PI / 2 }, { x: 9.2, z: -3.2, ry: -Math.PI / 2 }],
      [{ x: 2.3, z: 2.4, ry: Math.PI / 2 }, { x: 3.3, z: 2.4, ry: -Math.PI / 2 }],
    ];
    this.wanderSpots = [
      ...this.pantrySpots, { x: -3.6, z: -5.9, ry: Math.PI }, { x: 4.6, z: -5.6, ry: Math.PI },
      { x: 1.0, z: 2.6, ry: 0 }, { x: -1.0, z: 6.0, ry: 0 }, { x: 4.5, z: 5.8, ry: 0 },
    ];
    this.managerVisit = { x: 6.4, z: 4.0, ry: Math.PI / 2 };

    // 其他裝飾
    this.plant(6.6, -6.4, 1.2);
    this.plant(-4.2, -2.0, 0.9);
    this.plant(1.2, 6.4, 1.1);
    this.box(0.9, 0.04, 0.6, 0x222222, 6.9, 0, -2.0, { cast: false }); // 門墊
  }

  chair(x, z, ry, color = 0xe0743c, block = true) {
    const g = new THREE.Group();
    g.position.set(x, 0, z); g.rotation.y = ry;
    this.box(0.55, 0.08, 0.55, color, 0, 0.42, 0, { parent: g });
    this.box(0.55, 0.6, 0.08, color, 0, 0.5, -0.26, { parent: g });
    this.box(0.08, 0.42, 0.08, 0x222222, 0, 0, 0, { parent: g });
    this.box(0.45, 0.04, 0.45, 0x222222, 0, 0, 0, { parent: g, cast: false });
    this.scene.add(g);
    if (block) { /* 椅子不阻擋，角色要坐上去 */ }
    return g;
  }

  desk(x, z) {
    // 桌子朝向後牆，座位在桌子前方（+z）
    this.box(1.7, 0.08, 0.85, 0xf2e6d0, x, 0.72, z, { block: true });
    this.box(1.7, 0.72, 0.06, 0x2c3245, x, 0, z - 0.4);
    this.box(0.06, 0.72, 0.85, 0x2c3245, x - 0.82, 0, z);
    this.box(0.06, 0.72, 0.85, 0x2c3245, x + 0.82, 0, z);
    this.box(0.08, 0.3, 0.08, 0x222222, x, 0.8, z - 0.18);
    this.box(0.8, 0.5, 0.06, 0x111111, x, 0.98, z - 0.2);
    const sm = mat(0x10131c, { emissive: 0x5fa8ff, emissiveIntensity: 0, unique: true });
    this.box(0.72, 0.42, 0.02, null, x, 1.02, z - 0.16, { material: sm, cast: false });
    this.box(0.55, 0.03, 0.18, 0x333333, x, 0.8, z + 0.15);
    this.box(0.25, 0.25, 0.2, null, x + 0.6, 0.8, z - 0.1, { material: mat(0x4f7a3a) });
    const chair = this.chair(x, z + 0.75, Math.PI, 0xe0743c);
    const screen = { mat: sm, on: false, phase: Math.random() * 6 };
    this.screens.push(screen);
    return { x, z: z + 0.75, ry: Math.PI, sit: true, screen, chair };
  }

  shelf(x, z) {
    this.box(2.2, 2.2, 0.5, 0x6b4a32, x, 0, z, { block: true });
    const colors = [0xd9534f, 0x5bc0de, 0xf0ad4e, 0x5cb85c, 0x9b59b6, 0xecf0f1];
    for (let r = 0; r < 4; r++) {
      this.box(2.1, 0.04, 0.46, 0x4a3222, x, 0.1 + r * 0.52, z + 0.02, { cast: false });
      let bx = x - 0.95;
      while (bx < x + 0.9) {
        const bw = 0.08 + Math.random() * 0.08, bh = 0.3 + Math.random() * 0.12;
        this.box(bw, bh, 0.32, colors[Math.floor(Math.random() * colors.length)], bx + bw / 2, 0.14 + r * 0.52, z + 0.05, { cast: false });
        bx += bw + 0.015;
      }
    }
  }

  plant(x, z, s = 1) {
    this.box(0.45 * s, 0.45 * s, 0.45 * s, 0x8b5a2b, x, 0, z, { block: true });
    for (let i = 0; i < 5; i++) {
      const leaf = this.box(0.1 * s, (0.6 + Math.random() * 0.4) * s, 0.1 * s, 0x3f9a4a, x + (Math.random() - 0.5) * 0.25 * s, 0.4 * s, z + (Math.random() - 0.5) * 0.25 * s);
      leaf.rotation.set((Math.random() - 0.5) * 0.7, Math.random() * 3, (Math.random() - 0.5) * 0.7);
    }
  }

  setNight(night) {
    this.night = night;
    this.scene.background = new THREE.Color(night ? 0x141a33 : 0xbfd8f2);
    this.hemi.intensity = night ? 0.25 : 0.9;
    this.sun.intensity = night ? 0.35 : 1.8;
    this.sun.color.set(night ? 0x8aa0ff : 0xfff4e0);
    for (const m of this.windowMats) {
      m.map = m.emissiveMap = night ? this.cityNight : this.cityDay;
      m.emissiveIntensity = night ? 0.9 : 0.75;
      m.needsUpdate = true;
    }
    for (const l of this.lamps) {
      l.light.intensity = night ? (l.strong ? 10 : 14) : 0;
      l.mesh.emissiveIntensity = night ? 1.6 : 0.3;
    }
    this.renderer.toneMappingExposure = night ? 1.15 : 1.0;
  }

  setClock(date) {
    const minutes = date.getHours() * 60 + date.getMinutes();
    this.clockHand.rotation.z = -(minutes / 720) * Math.PI * 2;
  }

  /* ---------- 尋路（A*，8 方向） ---------- */
  findPath(from, to) {
    let [sc, sr] = toCell(from.x, from.z);
    let [ec, er] = toCell(to.x, to.z);
    const free = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS && !this.blocked[r * COLS + c];
    const nearestFree = (c0, r0) => {
      if (free(c0, r0)) return [c0, r0];
      for (let rad = 1; rad < 8; rad++) for (let dc = -rad; dc <= rad; dc++) for (let dr = -rad; dr <= rad; dr++)
        if (free(c0 + dc, r0 + dr)) return [c0 + dc, r0 + dr];
      return [c0, r0];
    };
    [sc, sr] = nearestFree(sc, sr);
    [ec, er] = nearestFree(ec, er);
    const N = COLS * ROWS, start = sr * COLS + sc, goal = er * COLS + ec;
    const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const h = (i) => { const c = i % COLS, r = (i / COLS) | 0; const dx = Math.abs(c - ec), dy = Math.abs(r - er); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const open = [start]; g[start] = 0;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (g[open[i]] + h(open[i]) < g[open[bi]] + h(open[bi])) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) break;
      closed[cur] = 1;
      const cc = cur % COLS, cr = (cur / COLS) | 0;
      for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
        if (!dc && !dr) continue;
        const nc = cc + dc, nr = cr + dr;
        if (!free(nc, nr)) continue;
        if (dc && dr && (!free(cc + dc, cr) || !free(cc, cr + dr))) continue;
        const ni = nr * COLS + nc;
        if (closed[ni]) continue;
        const ng = g[cur] + (dc && dr ? 1.414 : 1);
        if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; if (!open.includes(ni)) open.push(ni); }
      }
    }
    const pts = [];
    if (came[goal] === -1 && goal !== start) return [new THREE.Vector3(to.x, 0, to.z)];
    for (let i = goal; i !== -1 && i !== start; i = came[i]) { const [x, z] = cellCenter(i % COLS, (i / COLS) | 0); pts.push(new THREE.Vector3(x, 0, z)); }
    pts.reverse();
    // 去掉共線點
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = out[out.length - 1] || from, b = pts[i], c = pts[i + 1];
      if (c && Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)) < 1e-6) continue;
      out.push(b);
    }
    out.push(new THREE.Vector3(to.x, 0, to.z));
    return out;
  }

  addAgent(member, opts) {
    const a = new Agent(this, member, opts);
    this.agents.push(a);
    return a;
  }
  removeAgent(a) {
    a.dispose();
    this.agents = this.agents.filter((x) => x !== a);
  }
}

function toCell(x, z) {
  return [Math.max(0, Math.min(COLS - 1, Math.floor((x + W / 2) / CELL))), Math.max(0, Math.min(ROWS - 1, Math.floor((z + D / 2) / CELL)))];
}
function cellCenter(c, r) { return [-W / 2 + (c + 0.5) * CELL, -D / 2 + (r + 0.5) * CELL]; }

/* ---------------- 角色 ---------------- */
const SKIN = [0xf6d2b0, 0xeec29a, 0xd9a87c, 0xf3c9a5];
const HAIR = [0x2b1d16, 0x4a2c1a, 0x111111, 0x7a4a2a, 0xc98a3a, 0x3b2a4a];

export class Agent {
  constructor(office, member, { index = 0, onClick } = {}) {
    this.office = office;
    this.member = member;
    this.status = 'idle';
    this.path = [];
    this.speed = 2.0;
    this.sitting = false;
    this.typing = false;
    this.seat = null;
    this.phase = Math.random() * 10;

    const g = (this.group = new THREE.Group());
    const body = (this.body = new THREE.Group());
    g.add(body);
    const b = (w, h, d, color, x, y, z, parent = body) => office.box(w, h, d, color, x, y, z, { parent, mat: {} });
    const skin = SKIN[index % SKIN.length], hair = HAIR[(index * 3 + 1) % HAIR.length];

    // 腿
    this.legL = new THREE.Group(); this.legL.position.set(-0.11, 0.42, 0); body.add(this.legL);
    this.legR = new THREE.Group(); this.legR.position.set(0.11, 0.42, 0); body.add(this.legR);
    b(0.17, 0.42, 0.2, 0x2d3550, 0, -0.42, 0, this.legL);
    b(0.17, 0.42, 0.2, 0x2d3550, 0, -0.42, 0, this.legR);
    // 身體
    this.shirt = b(0.48, 0.48, 0.3, member.color, 0, 0.42, 0);
    this.shirt.material = this.shirt.material.clone();
    // 手
    this.armL = new THREE.Group(); this.armL.position.set(-0.31, 0.86, 0); body.add(this.armL);
    this.armR = new THREE.Group(); this.armR.position.set(0.31, 0.86, 0); body.add(this.armR);
    this.armMeshes = [b(0.13, 0.42, 0.16, member.color, 0, -0.42, 0, this.armL), b(0.13, 0.42, 0.16, member.color, 0, -0.42, 0, this.armR)];
    for (const m of this.armMeshes) m.material = this.shirt.material;
    b(0.12, 0.1, 0.13, skin, 0, -0.5, 0, this.armL);
    b(0.12, 0.1, 0.13, skin, 0, -0.5, 0, this.armR);
    // 頭
    const head = (this.head = new THREE.Group()); head.position.set(0, 0.9, 0); body.add(head);
    b(0.5, 0.46, 0.46, skin, 0, 0, 0, head);
    b(0.54, 0.14, 0.5, hair, 0, 0.4, -0.01, head);
    b(0.54, 0.3, 0.12, hair, 0, 0.16, -0.22, head);
    const style = index % 3;
    if (style === 1) b(0.54, 0.45, 0.14, hair, 0, -0.18, -0.2, head);                 // 長髮
    if (style === 2) b(0.2, 0.18, 0.2, hair, 0, 0.5, -0.12, head);                     // 丸子頭
    b(0.12, 0.12, 0.12, hair, -0.22, 0.26, 0.18, head);                                // 瀏海
    b(0.07, 0.08, 0.02, 0x1a1a1a, -0.11, 0.2, 0.235, head);
    b(0.07, 0.08, 0.02, 0x1a1a1a, 0.11, 0.2, 0.235, head);
    b(0.08, 0.04, 0.02, 0xe6a0a0, -0.17, 0.12, 0.235, head);
    b(0.08, 0.04, 0.02, 0xe6a0a0, 0.17, 0.12, 0.235, head);
    if (member.glasses) {
      b(0.15, 0.12, 0.02, 0x8a5a2a, -0.11, 0.17, 0.25, head);
      b(0.15, 0.12, 0.02, 0x8a5a2a, 0.11, 0.17, 0.25, head);
    }
    g.traverse((o) => { if (o.isMesh) o.userData.agent = this; });
    office.scene.add(g);

    // 名牌與泡泡
    const label = document.createElement('div');
    label.className = 'label';
    label.innerHTML = '<i class="dot idle"></i><span></span>';
    label.querySelector('span').textContent = member.name;
    label.addEventListener('click', () => onClick?.(this));
    this.labelEl = label;
    this.labelObj = new CSS2DObject(label);
    this.labelObj.position.set(0, 1.85, 0);
    g.add(this.labelObj);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    this.bubbleEl = bubble;
    this.bubbleObj = new CSS2DObject(bubble);
    this.bubbleObj.position.set(0, 2.35, 0);
    this.bubbleObj.center.set(0.5, 1);
    g.add(this.bubbleObj);
  }

  setMember(m) {
    this.member = m;
    this.shirt.material.color.set(m.color);
    this.labelEl.querySelector('span').textContent = m.name;
  }

  setStatus(s) {
    this.status = s;
    this.labelEl.querySelector('.dot').className = 'dot ' + (s === 'walking' ? 'idle' : s);
    if (this.seat?.screen) this.seat.screen.on = s === 'working';
    if (this.seat?.screen && s !== 'working') this.seat.screen.mat.emissiveIntensity = 0;
  }

  say(text, ms = 3500) {
    clearTimeout(this.bubbleTimer);
    this.bubbleEl.textContent = text;
    this.bubbleEl.classList.add('show');
    if (ms > 0) this.bubbleTimer = setTimeout(() => this.bubbleEl.classList.remove('show'), ms);
  }
  hush() { clearTimeout(this.bubbleTimer); this.bubbleEl.classList.remove('show'); }

  placeAt(spot) {
    this.group.position.set(spot.x, 0, spot.z);
    this.group.rotation.y = spot.ry ?? 0;
    this.path = [];
    this.arrive(spot);
  }

  /** 走到某個點；回傳抵達時 resolve 的 Promise（被新指令中斷時 resolve false） */
  goTo(spot) {
    this.standUp();
    this.pendingResolve?.(false);
    this.path = this.office.findPath(this.group.position, spot);
    this.target = spot;
    return new Promise((res) => { this.pendingResolve = res; });
  }

  arrive(spot) {
    if (spot.ry != null) this.group.rotation.y = spot.ry;
    if (spot.sit) this.sitDown();
    const r = this.pendingResolve; this.pendingResolve = null; r?.(true);
  }

  sitDown() { this.sitting = true; }
  standUp() { this.sitting = false; this.typing = false; }

  update(dt, t) {
    const pos = this.group.position;
    let walking = false;
    if (this.path.length) {
      const next = this.path[0];
      const dx = next.x - pos.x, dz = next.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist <= step) {
        pos.x = next.x; pos.z = next.z;
        this.path.shift();
        if (!this.path.length) this.arrive(this.target);
      } else {
        pos.x += (dx / dist) * step; pos.z += (dz / dist) * step;
        const want = Math.atan2(dx, dz);
        let diff = want - this.group.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        this.group.rotation.y += diff * Math.min(1, dt * 12);
      }
      walking = true;
    }
    const tt = t + this.phase;
    if (walking) {
      const s = Math.sin(tt * 11) * 0.6;
      this.legL.rotation.x = s; this.legR.rotation.x = -s;
      this.armL.rotation.x = -s * 0.8; this.armR.rotation.x = s * 0.8;
      this.body.position.y = Math.abs(Math.sin(tt * 11)) * 0.05;
    } else if (this.sitting) {
      this.legL.rotation.x = this.legR.rotation.x = -Math.PI / 2;
      this.body.position.y = -0.0;
      if (this.typing) {
        this.armL.rotation.x = -1.1 + Math.sin(tt * 18) * 0.12;
        this.armR.rotation.x = -1.1 + Math.cos(tt * 18) * 0.12;
      } else {
        this.armL.rotation.x = this.armR.rotation.x = -0.4;
      }
    } else {
      this.legL.rotation.x = this.legR.rotation.x = 0;
      this.armL.rotation.x = Math.sin(tt * 1.5) * 0.05;
      this.armR.rotation.x = -Math.sin(tt * 1.5) * 0.05;
      this.body.position.y = Math.sin(tt * 2) * 0.012;
    }
    // 坐下時往椅子方向移一點並降低高度
    this.body.position.z = this.sitting && !walking ? -0.12 : 0;
    if (this.sitting && !walking) this.body.position.y = 0.05;
    // 思考時頭部微晃
    this.head.rotation.z = this.status === 'thinking' ? Math.sin(tt * 3) * 0.12 : 0;
    this.head.rotation.x = this.status === 'chatting' ? Math.sin(tt * 6) * 0.06 : 0;
  }

  dispose() {
    this.pendingResolve?.(false);
    if (this.seat?.screen) { this.seat.screen.on = false; this.seat.screen.mat.emissiveIntensity = 0; }
    this.group.remove(this.labelObj, this.bubbleObj);
    this.labelEl.remove(); this.bubbleEl.remove();
    this.office.scene.remove(this.group);
  }
}
