// 粒の空間：書き出した奥行き・カメラ情報と、絵（絵画 or プレビズの色）から、1画素を1粒として3D空間に置いて見る。
// 置き方は cameras.json の projection のとおり。プレビズの形そのものは使わない（線で重ねる確かめ用を除く）。
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, uniform, uv, vec2, float, step, exp, mix, max, abs } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene } from '../previz/scene.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), msg = $('msg');
const say = (text) => { msg.textContent = text; msg.style.display = text ? 'flex' : 'none'; };

const EYE = 1.7;              // 歩くときの目の高さ（m）
const SKY_Z = 1200;           // 空の粒を置く距離（m）
const EDGE_MAX = 7;           // 境界からの距離をここまで数える（画素）
const EDGE_LOG = 0.1;         // 隣との距離の比がこれ（対数）を超えたら境界
const VIEW_TINTS = [[1, 0.64, 0.23], [0.31, 0.82, 1], [0.78, 0.55, 1], [0.6, 0.9, 0.4]];
const BG = 0x0e120f, BG_HOLES = 0xff00ff;

const ui = { colorSrc: 'previz', source: 'all', nav: 'orbit', mode: 0, stride: 2, order: 'sort' };
const uSize = uniform(2.6), uEdge = uniform(1), uSky = uniform(1), uView = uniform(-1);

let app = null, data = null, cloud = null, starting = false;
const query = new URLSearchParams(location.search);
let forceGL = query.has('gl');
if (['1', '2', '4', '8'].includes(query.get('stride'))) ui.stride = Number(query.get('stride')); // 例：splat.html?stride=4 で粗く始める

function fail(e) { console.error(e); starting = false; say('表示中に問題が起きました：' + e.message); }

// ---- ファイルを読む ----
async function loadImage(url, w, h) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} を読めませんでした`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

async function loadData() {
  const [camsRes, stateRes] = await Promise.all([fetch('/files/previz-export/cameras.json', { cache: 'no-store' }), fetch('/api/state', { cache: 'no-store' })]);
  if (!camsRes.ok) throw new Error('プレビズの書き出しがまだありません。\n「プレビズ」のタブで「previz-export に保存」を押してから、ここで「ファイルを読み直す」を押してください。');
  const cams = await camsRes.json();
  const state = stateRes.ok ? await stateRes.json() : { views: [] };
  const { near, far } = cams.depth;
  const views = [];
  for (const v of cams.views) {
    const st = state.views.find((s) => s.name === v.name) || {};
    const W = v.width, H = v.height;
    const depthPx = await loadImage(`/files/previz-export/${v.depth}`, W, H);
    const z = new Float32Array(W * H); // 0 = 空
    for (let i = 0; i < W * H; i++) {
      const value = depthPx[i * 4] * 256 + depthPx[i * 4 + 1];
      z[i] = value ? 1 / (value / 65535 * (1 / near - 1 / far) + 1 / far) : 0;
    }
    views.push({
      def: v, W, H, z, edge: edgeDistance(z, W, H), near, far,
      previz: await loadImage(`/files/previz-export/${v.color}`, W, H),
      painted: st.painted ? await loadImage(`/files/paint-out/${v.name}_painted.png`, W, H) : null,
      matrix: new THREE.Matrix4().set(...v.extrinsics.camera_to_world.flat()),
    });
  }
  return { cams, views };
}

// 奥行きが急に変わる画素（境界）からの距離（画素、EDGE_MAX まで）。
function edgeDistance(z, W, H) {
  const d = new Uint8Array(W * H).fill(EDGE_MAX);
  const differs = (a, b) => (a === 0) !== (b === 0) || (a !== 0 && Math.abs(Math.log(a / b)) > EDGE_LOG);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x + 1 < W && differs(z[i], z[i + 1])) d[i] = d[i + 1] = 0;
    if (y + 1 < H && differs(z[i], z[i + W])) d[i] = d[i + W] = 0;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { // 行きと帰りの2回でおおよその距離を広げる
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) v = Math.min(v, d[i - W] + 1);
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x + 1 < W) v = Math.min(v, d[i + 1] + 1);
    if (y + 1 < H) v = Math.min(v, d[i + W] + 1);
    d[i] = v;
  }
  return d;
}

// ---- 粒の元データ（並べ直す前） ----
// 粒が持つ列の一覧。列を足すときはここに1行足す（種類・物体・法線などは別の作業で追加予定）。
// 知らない名前の列は無視し、渡されなかった列は default で埋める。
export const COLUMNS = {
  position: { type: Float32Array, size: 3, default: 0 }, // ワールド座標（m）
  size: { type: Float32Array, size: 1, default: 0 },     // 粒の間隔（m）。描くときに「粒の大きさ」を掛ける
  color: { type: Uint8Array, size: 3, default: 128 },    // 絵の色（sRGB）
  edge: { type: Uint8Array, size: 1, default: EDGE_MAX }, // 奥行きの境界からの距離（画素）
  sky: { type: Uint8Array, size: 1, default: 0 },        // 1 = 空（奥行きが無い画素）
  view: { type: Uint8Array, size: 1, default: 0 },       // どの視点（や穴埋めの回）から来たか
  depthGray: { type: Uint8Array, size: 1, default: 0 },  // 奥行き表示用の明るさ
};
export function makeCloud(capacity) {
  const c = { n: 0, capacity, order: new Uint32Array(capacity), keys: new Uint16Array(capacity), dist: new Float32Array(capacity) };
  for (const [name, d] of Object.entries(COLUMNS)) { c[name] = new d.type(capacity * d.size); if (d.default) c[name].fill(d.default); }
  return c;
}
/** 粒をまとめて足す。columns は { 列の名前: 配列（count × 列の幅） }。 */
export function appendSplats(c, columns, count) {
  if (c.n + count > c.capacity) throw new Error('粒の数が用意した枠を超えました');
  for (const [name, d] of Object.entries(COLUMNS)) { const src = columns[name]; if (src) c[name].set(src.subarray(0, count * d.size), c.n * d.size); }
  for (let i = c.n; i < c.n + count; i++) c.order[i] = i;
  c.n += count;
}

// 1視点ぶんの画素を粒の列にする。置き方は cameras.json の projection のとおり。
function splatsFromView(v, vi, stride, usePainted) {
  const { W, H, z, edge, near, far } = v, { fx, fy, cx, cy } = v.def.intrinsics;
  const max = Math.ceil(W / stride) * Math.ceil(H / stride);
  const col = { position: new Float32Array(max * 3), size: new Float32Array(max), color: new Uint8Array(max * 3), edge: new Uint8Array(max), sky: new Uint8Array(max), view: new Uint8Array(max).fill(vi), depthGray: new Uint8Array(max) };
  const px = usePainted && v.painted ? v.painted : v.previz, p = new THREE.Vector3(), off = stride >> 1;
  let k = 0;
  for (let y = off; y < H; y += stride) for (let x = off; x < W; x += stride) {
    const i = y * W + x, sky = z[i] === 0, zz = sky ? SKY_Z : z[i];
    p.set((x + 0.5 - cx) / fx * zz, -(y + 0.5 - cy) / fy * zz, -zz).applyMatrix4(v.matrix);
    col.position[k * 3] = p.x; col.position[k * 3 + 1] = p.y; col.position[k * 3 + 2] = p.z;
    col.size[k] = zz * stride / fy;
    col.color[k * 3] = px[i * 4]; col.color[k * 3 + 1] = px[i * 4 + 1]; col.color[k * 3 + 2] = px[i * 4 + 2];
    col.depthGray[k] = sky ? 0 : Math.max(0, Math.min(255, (1 - Math.log(zz / near) / Math.log(far / near)) * 255));
    col.edge[k] = edge[i]; col.sky[k] = sky ? 1 : 0;
    k++;
  }
  return { columns: col, count: k };
}
function buildCloud() {
  const parts = data.views.map((v, vi) => splatsFromView(v, vi, ui.stride, ui.colorSrc === 'painted'));
  const c = makeCloud(parts.reduce((s, p) => s + p.count, 0));
  for (const p of parts) appendSplats(c, p.columns, p.count);
  return c;
}

const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });

// 表示の種類ごとに、粒 i の色（リニア）を out に入れる。表示を足すときはここに足す。
const DISPLAY = [
  (c, i, out) => { out[0] = LIN[c.color[i * 3]]; out[1] = LIN[c.color[i * 3 + 1]]; out[2] = LIN[c.color[i * 3 + 2]]; },   // 絵の色
  (c, i, out) => { out[0] = out[1] = out[2] = LIN[c.depthGray[i]]; },                                                    // 奥行き
  (c, i, out) => {                                                                                                       // 視点別
    const t = VIEW_TINTS[c.view[i] % VIEW_TINTS.length];
    const l = 0.25 + 0.75 * (0.2126 * LIN[c.color[i * 3]] + 0.7152 * LIN[c.color[i * 3 + 1]] + 0.0722 * LIN[c.color[i * 3 + 2]]);
    out[0] = LIN[t[0] * 255 | 0] * l; out[1] = LIN[t[1] * 255 | 0] * l; out[2] = LIN[t[2] * 255 | 0] * l;
  },
];

// 遠い順（視点からの距離）に並べ、描画用の配列へ書き込む。eye が null なら並びはそのままで書き直すだけ。
// 描画用は vec4 を3本にまとめる（WebGPU は頂点バッファの本数に上限があるため、列ごとに分けない）。
//   A = [位置 xyz, 粒の間隔]  B = [表示する色 rgb, 境界からの距離]  C = [空, 視点, 空き, 空き]
function sortAndFill(eye) {
  const a = app, c = cloud; if (!a || !c) return;
  const t0 = performance.now();
  const { n, position, order, keys, dist } = c;
  if (eye) {
    const ex = eye.x, ey = eye.y, ez = eye.z;
    let far = 0;
    for (let i = 0; i < n; i++) {
      const dx = position[i * 3] - ex, dy = position[i * 3 + 1] - ey, dz = position[i * 3 + 2] - ez;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz); dist[i] = d; if (d > far) far = d;
    }
    // 近い所ほど細かく分けたいので、距離の平方根で 16bit に刻む
    const scale = 65535 / Math.sqrt(far || 1), count = new Uint32Array(65537);
    for (let i = 0; i < n; i++) { const key = 65535 - Math.min(65535, Math.sqrt(dist[i]) * scale | 0); keys[i] = key; count[key + 1]++; }
    for (let i = 0; i < 65536; i++) count[i + 1] += count[i];
    for (let i = 0; i < n; i++) order[count[keys[i]]++] = i;
  }
  const A = a.attrA.array, B = a.attrB.array, C = a.attrC.array, display = DISPLAY[ui.mode] || DISPLAY[0], rgb = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    const i = order[j], o = j * 4;
    A[o] = position[i * 3]; A[o + 1] = position[i * 3 + 1]; A[o + 2] = position[i * 3 + 2]; A[o + 3] = c.size[i];
    display(c, i, rgb);
    B[o] = rgb[0]; B[o + 1] = rgb[1]; B[o + 2] = rgb[2]; B[o + 3] = c.edge[i];
    C[o] = c.sky[i]; C[o + 1] = c.view[i];
  }
  a.attrA.needsUpdate = a.attrB.needsUpdate = a.attrC.needsUpdate = true;
  if (eye) { a.sortEye.copy(eye); a.sortAt = performance.now(); $('sSort').textContent = `${Math.round(a.sortAt - t0)} ms`; }
}

// ---- 材質 ----
function makeMaterials(a) {
  const P = instancedBufferAttribute(a.attrA), B = instancedBufferAttribute(a.attrB), M = instancedBufferAttribute(a.attrC), C = B.xyz;
  const edgeOk = step(uEdge, B.w.add(0.5));                               // 境界から uEdge 画素以上はなれた粒だけ
  const skyOk = mix(float(1), uSky, M.x);                                 // 空の粒は uSky で出し入れ
  const viewOk = max(step(uView, -0.5), float(1).sub(step(0.5, abs(M.y.sub(uView))))); // 使う視点だけ
  const s = P.w.mul(uSize).mul(edgeOk).mul(skyOk).mul(viewOk);
  const r = uv().sub(0.5).length();

  const soft = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  soft.positionNode = P.xyz; soft.scaleNode = vec2(s, s); soft.colorNode = C;
  soft.opacityNode = exp(r.mul(r).mul(-18));

  const hard = new THREE.SpriteNodeMaterial({ transparent: false, depthWrite: true, depthTest: true, alphaTest: 0.5 });
  const sh = s.mul(0.62); // ぼかさないぶん小さめの円にする
  hard.positionNode = P.xyz; hard.scaleNode = vec2(sh, sh); hard.colorNode = C;
  hard.opacityNode = float(1).sub(step(0.5, r));
  return { soft, hard };
}

// ---- 起動（描画方式・粒の細かさ・色のもとを替えるたびに作り直す） ----
async function start(useGL) {
  if (starting) return; starting = true;
  say('準備しています…');
  const keep = app ? { pos: app.camera.position.clone(), quat: app.camera.quaternion.clone(), target: app.controls.target.clone() } : null;
  if (app) { app.renderer.setAnimationLoop(null); app.controls.dispose(); app.renderer.domElement.remove(); app.renderer.dispose(); app = null; }

  try { if (!data) { data = await loadData(); setupViewButtons(); } }
  catch (e) { starting = false; console.error(e); return say(e.message); }

  let renderer;
  try { renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: useGL }); await renderer.init(); }
  catch (e) { starting = false; console.error(e); return say('このブラウザでは 3D 描画を開始できませんでした。Chrome か Edge の最新版で開いてください。'); }
  forceGL = useGL;
  stage.prepend(renderer.domElement);

  cloud = buildCloud();
  const n = cloud.n;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);

  const a = app = {
    renderer, scene, camera, controls,
    attrA: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
    attrB: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
    attrC: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
    sortEye: new THREE.Vector3(Infinity, 0, 0), sortAt: 0, yaw: 0, pitch: 0,
  };
  a.mats = makeMaterials(a);
  a.sprite = new THREE.Sprite(a.mats.soft);
  a.sprite.count = n; a.sprite.frustumCulled = false; a.sprite.renderOrder = 1;
  scene.add(a.sprite);

  // 確かめ用：プレビズの形（線）と、書き出しカメラの視錐台
  a.wire = new THREE.Group();
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5, depthTest: false });
  buildScene().traverse((o) => { if (o.isMesh && o.name !== 'ground') { const m = new THREE.Mesh(o.geometry, wireMat); o.updateWorldMatrix(true, false); m.applyMatrix4(o.matrixWorld); m.renderOrder = 2; a.wire.add(m); } });
  a.frusta = new THREE.Group();
  data.views.forEach((v, i) => {
    const cam = new THREE.PerspectiveCamera(v.def.intrinsics.fov_y_deg, v.W / v.H, 1, 40);
    v.matrix.decompose(cam.position, cam.quaternion, cam.scale); cam.updateMatrixWorld(true);
    const h = new THREE.CameraHelper(cam), col = new THREE.Color(...VIEW_TINTS[i % VIEW_TINTS.length]);
    h.setColors(col, col, col, col, col); h.renderOrder = 2; a.frusta.add(h);
  });
  scene.add(a.wire, a.frusta);

  if (keep) { camera.position.copy(keep.pos); camera.quaternion.copy(keep.quat); controls.target.copy(keep.target); syncAngles(); }
  else jump('0');

  if (ui.order !== 'sort') { sortAndFill(new THREE.Vector3().setFromMatrixPosition(data.views[0].matrix)); a.sortEye.set(Infinity, 0, 0); }
  applyUi();

  const gpu = !!(renderer.backend && renderer.backend.isWebGPUBackend);
  $('sBackend').textContent = gpu ? 'WebGPU' : 'WebGL 2';
  $('swap').textContent = gpu ? 'WebGL 2 で描き直す' : 'WebGPU で描き直す';
  $('sCount').textContent = `${(n / 10000).toFixed(1)} 万粒`;
  const painted = data.views.filter((v) => v.painted).length;
  $('srcNote').textContent = painted === data.views.length ? '' : painted ? `絵画がある視点は ${painted} / ${data.views.length}。無い視点はプレビズの色で置きます。` : '絵画がまだありません（「絵画化」のタブで作れます）。プレビズの色で置いています。';
  $('srcNote').classList.toggle('warn', ui.colorSrc === 'painted' && painted < data.views.length);

  layout(); say('');
  let frames = 0, t0 = performance.now(), last = t0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (ui.nav === 'walk') walkStep(dt); else controls.update();
    if (ui.order === 'sort' && now - a.sortAt > 120 && camera.position.distanceToSquared(a.sortEye) > 0.09) sortAndFill(camera.position);
    renderer.render(scene, camera);
    if (++frames >= 30) {
      $('sFps').textContent = Math.round(frames * 1000 / (now - t0)) + ' fps'; frames = 0; t0 = now;
      const p = camera.position; $('sPos').textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} m`;
    }
  });
  starting = false;
  window.__splat = { app: a, cloud, data, ui, backend: gpu ? 'webgpu' : 'webgl2', jump };
  window.__ready = true;
}

function applyUi() {
  const a = app; if (!a) return;
  uSize.value = Number($('size').value); $('oSize').textContent = `${uSize.value.toFixed(2)} 倍`;
  uEdge.value = Number($('edge').value); $('oEdge').textContent = uEdge.value ? `${uEdge.value} 画素` : '消さない';
  uSky.value = $('sky').checked ? 1 : 0;
  uView.value = ui.source === 'all' ? -1 : Number(ui.source);
  a.scene.background = new THREE.Color($('holes').checked ? BG_HOLES : BG);
  a.wire.visible = $('wire').checked; a.frusta.visible = $('frusta').checked;
  a.sprite.material = ui.order === 'opaque' ? a.mats.hard : a.mats.soft;
  a.controls.enabled = ui.nav === 'orbit';
  $('hint').textContent = ui.nav === 'walk'
    ? '画面をクリックで視線を動かす（Esc で解除）・ W A S D か矢印で歩く ・ Shift で速く'
    : 'ドラッグで回す ・ ホイールで前後 ・ 右ドラッグで横に動く';
}

// ---- 視点 ----
function syncAngles() { // カメラの向きから、歩くときの向き（左右・上下の角度）を取る
  const a = app, e = new THREE.Euler().setFromQuaternion(a.camera.quaternion, 'YXZ');
  a.yaw = e.y; a.pitch = e.x;
}
function jump(v) {
  const a = app; if (!a) return;
  if (v === 'overview') { a.camera.position.set(75, 55, 125); a.controls.target.set(0, 12, -35); a.camera.lookAt(a.controls.target); }
  else {
    const view = data.views[Number(v)]; if (!view) return;
    const s = new THREE.Vector3();
    view.matrix.decompose(a.camera.position, a.camera.quaternion, s);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(a.camera.quaternion);
    const t = view.def.extrinsics.target;
    if (t) a.controls.target.fromArray(t); else a.controls.target.copy(a.camera.position).addScaledVector(fwd, 40);
  }
  syncAngles();
}
function setNav(v) {
  const a = app; ui.nav = v; if (!a) return;
  if (v === 'walk') { syncAngles(); a.camera.position.y = EYE; }
  else {
    if (document.pointerLockElement) document.exitPointerLock();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(a.camera.quaternion);
    a.controls.target.copy(a.camera.position).addScaledVector(fwd, 40);
  }
  applyUi();
}

const keys = new Set();
function walkStep(dt) {
  const a = app;
  a.camera.quaternion.setFromEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (f || r) {
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 20 : 6) * dt / Math.hypot(f, r);
    const sin = Math.sin(a.yaw), cos = Math.cos(a.yaw);
    a.camera.position.x += (-sin * f + cos * r) * speed;
    a.camera.position.z += (-cos * f - sin * r) * speed;
  }
  a.camera.position.y = EYE;
}
function look(dx, dy) {
  const a = app; if (!a || ui.nav !== 'walk') return;
  a.yaw -= dx * 0.0022;
  a.pitch = Math.max(-1.5, Math.min(1.5, a.pitch - dy * 0.0022));
}
let dragging = false;
stage.addEventListener('pointerdown', (e) => {
  if (ui.nav !== 'walk' || e.target.tagName !== 'CANVAS') return;
  dragging = true;
  const req = e.target.requestPointerLock && e.target.requestPointerLock();
  if (req && req.catch) req.catch(() => {}); // 使えない場合はドラッグで見回す
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => { if (document.pointerLockElement || dragging) look(e.movementX, e.movementY); });
window.addEventListener('keydown', (e) => { if (ui.nav === 'walk' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { keys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); } });
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

function layout() {
  const a = app; if (!a) return;
  const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
  a.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  a.renderer.setSize(w, h, false);
  a.camera.aspect = w / h; a.camera.updateProjectionMatrix();
}

// ---- 操作 ----
function press(el, v) { for (const x of el.children) x.setAttribute('aria-pressed', x.dataset.v === String(v) ? 'true' : 'false'); }
function seg(id, fn) {
  const el = $(id);
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.disabled) return; press(el, b.dataset.v); fn(b.dataset.v); });
}
function setupViewButtons() {
  const src = $('source'), jumpEl = $('jump');
  src.replaceChildren(src.firstElementChild); jumpEl.replaceChildren(jumpEl.firstElementChild);
  data.views.forEach((v, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.v = String(i); b.textContent = `${v.def.name} だけ`; b.setAttribute('aria-pressed', 'false'); src.append(b);
    const j = document.createElement('button'); j.type = 'button'; j.className = 'plain'; j.dataset.v = String(i); j.textContent = `カメラ${v.def.name}`; jumpEl.append(j);
  });
  ui.source = 'all'; press(src, 'all');
  const hasPainted = data.views.some((v) => v.painted);
  ui.colorSrc = hasPainted ? 'painted' : 'previz';
  $('colorSrc').children[0].disabled = !hasPainted;
  press($('colorSrc'), ui.colorSrc);
}
const refill = () => { if (app) { sortAndFill(null); } };
const rebuild = () => press($('stride'), ui.stride);
start(forceGL).catch(fail);

seg('colorSrc', (v) => { ui.colorSrc = v; rebuild(); });
seg('source', (v) => { ui.source = v; applyUi(); });
seg('nav', setNav);
seg('mode', (v) => { ui.mode = Number(v); refill(); });
seg('stride', (v) => { ui.stride = Number(v); rebuild(); });
seg('order', (v) => {
  ui.order = v; if (!app) return;
  if (v === 'fixed') { sortAndFill(new THREE.Vector3().setFromMatrixPosition(data.views[0].matrix)); }
  app.sortEye.set(Infinity, 0, 0); applyUi();
});
$('jump').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { jump(b.dataset.v); if (ui.nav === 'walk') app.camera.position.y = EYE; } });
for (const id of ['size', 'edge']) $(id).addEventListener('input', applyUi);
for (const id of ['holes', 'wire', 'frusta', 'sky']) $(id).addEventListener('change', applyUi);
$('reload').addEventListener('click', () => { data = null; rebuild(); });
$('swap').addEventListener('click', () => start(!forceGL).catch(fail));
new ResizeObserver(layout).observe(stage);

press($('stride'), ui.stride);
start(forceGL).catch(fail);
