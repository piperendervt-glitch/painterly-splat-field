import * as THREE from 'three/webgpu';
import { positionView, instancedBufferAttribute, float, vec2, vec3, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { zipSync, strToU8 } from 'fflate';
import { buildScene, EXPORT, SKY, PAINT_SUN } from './scene.js';
import { DEPTH_FORMULA, zFromValue } from './depth.js';
import { labelScene, captureLabels, renderSunMap, shadeView } from './gbuffer.js';
import { TYPES, hexToRgb, objectColor } from '../shared/labels.js';
import { sunDirection, FLAT_LIGHT, LIT_LIGHT } from '../shared/light.js';

const SUN_DIR = sunDirection(PAINT_SUN.azimuth, PAINT_SUN.elevation);

const $ = (id) => document.getElementById(id);
const stage = $('stage'), msg = $('msg');
const say = (text) => { msg.textContent = text; msg.style.display = text ? 'flex' : 'none'; };

const { width: W, height: H, fovY, near: NEAR, far: FAR } = EXPORT;
const FY = (H / 2) / Math.tan(THREE.MathUtils.degToRad(fovY / 2)), FX = FY, CX = W / 2, CY = H / 2;
const CLOUD_STRIDE = 3;
const FRUSTUM_COLORS = [0xffa23a, 0x4fd2ff, 0xc78cff, 0x99e666, 0xff6f91, 0xffe066];

const ui = { view: 'overview', mode: 'color', source: 'all' };
let app = null, starting = false, forceGL = new URLSearchParams(location.search).has('gl');

// ---- 奥行きの材質 ----
function depthNodes() {
  const z = positionView.z.negate();
  const d = float(1).div(z).sub(1 / FAR).div(1 / NEAR - 1 / FAR).clamp(0, 1);
  return d;
}
function makePackMaterial() { // 16bit を R・G に詰めて描く（書き出し用）
  const m = new THREE.MeshBasicNodeMaterial();
  const v = depthNodes().mul(65535).add(0.5).floor();
  const hi = v.div(256).floor(), lo = v.sub(hi.mul(256));
  m.outputNode = vec4(hi.div(255), lo.div(255), 0, 1);
  return m;
}
function makeDepthViewMaterial() { // 目で見る用（明るいほど手前）
  const m = new THREE.MeshBasicNodeMaterial();
  const g = float(1).sub(positionView.z.negate().div(NEAR).log().div(Math.log(FAR / NEAR))).clamp(0, 1); // 距離の対数
  m.outputNode = vec4(g, g, g, 1);
  return m;
}

function makeExportCamera(def) {
  const cam = new THREE.PerspectiveCamera(fovY, W / H, 0.1, 5000);
  cam.position.fromArray(def.position);
  cam.lookAt(new THREE.Vector3().fromArray(def.target));
  cam.updateMatrixWorld(true);
  cam.name = def.name;
  return cam;
}

// ---- 1視点ぶんを描いて読み戻す ----
async function capture(a, cam) {
  const { renderer, scene } = a;
  const savedBg = scene.background, extrasVisible = a.extras.visible, solidsVisible = a.solids.map((o) => o.visible);
  a.extras.visible = false; a.solids.forEach((o) => { o.visible = true; });

  renderer.setRenderTarget(a.colorRT);
  renderer.render(scene, cam);
  scene.background = null; scene.overrideMaterial = a.packMat;
  renderer.setClearColor(0x000000, 1);
  renderer.setRenderTarget(a.depthRT);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null; scene.background = savedBg;
  a.extras.visible = extrasVisible; a.solids.forEach((o, i) => { o.visible = solidsVisible[i]; });

  const [half, packed] = await Promise.all([
    renderer.readRenderTargetPixelsAsync(a.colorRT, 0, 0, W, H),
    renderer.readRenderTargetPixelsAsync(a.depthRT, 0, 0, W, H),
  ]);

  // 読み戻しの行の向きは描画方式で変わりうるので、形との当たり判定（正解の距離）に合う向きを選ぶ。
  const value = (flip, x, y) => { const i = ((flip ? H - 1 - y : y) * W + x) * 4; return packed[i] * 256 + packed[i + 1]; };
  const truth = groundTruth(a, cam);
  const errs = [false, true].map((flip) => truth.map((t) => {
    const v = value(flip, t.x, t.y);
    if (t.z === null) return v === 0 ? 0 : 1e6;
    return v === 0 ? 1e6 : Math.abs(zFromValue(v, NEAR, FAR) - t.z) / t.z;
  }).sort((p, q) => p - q));
  const med = (e) => e[e.length >> 1];
  const flip = med(errs[1]) < med(errs[0]);
  const e = errs[flip ? 1 : 0];

  const depth = new Uint16Array(W * H), rgba = new Uint8ClampedArray(W * H * 4);
  const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255 + 0.5;
  const isHalf = half instanceof Uint16Array, isFloat = half instanceof Float32Array;
  const lin = (raw) => (isHalf ? THREE.DataUtils.fromHalfFloat(raw) : isFloat ? raw : raw / 255);
  for (let y = 0; y < H; y++) {
    const sy = flip ? H - 1 - y : y;
    for (let x = 0; x < W; x++) {
      const s = (sy * W + x) * 4, o = (y * W + x) * 4;
      depth[y * W + x] = packed[s] * 256 + packed[s + 1];
      rgba[o] = srgb(lin(half[s])); rgba[o + 1] = srgb(lin(half[s + 1])); rgba[o + 2] = srgb(lin(half[s + 2])); rgba[o + 3] = 255;
    }
  }
  const labels = await captureLabels(renderer, scene, cam, a.depthRT, a.labels, flip); // 種類・物体・面の向き
  return { name: cam.name, cam, rgba, depth, ...labels, flip, errMedian: med(e), errP99: e[Math.floor(e.length * 0.99)], samples: e.length };
}

// 形に光線を当てて求めた正解の距離（画素の中心を通る光線）。
function groundTruth(a, cam) {
  const ray = new THREE.Raycaster(), out = [];
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const dir = new THREE.Vector3();
  for (let y = 16; y < H; y += 48) for (let x = 16; x < W; x += 48) {
    dir.set((x + 0.5 - CX) / FX, -(y + 0.5 - CY) / FY, -1).normalize().transformDirection(cam.matrixWorld);
    ray.set(cam.position, dir);
    const hit = ray.intersectObjects(a.solids, false)[0];
    const z = hit ? hit.distance * dir.dot(fwd) : null;
    out.push({ x, y, z: z !== null && z < FAR ? z : null });
  }
  return out;
}

// ---- 書き出したデータだけから点群を置き直す ----
function buildCloud(c) {
  const pos = [], col = [], size = [];
  const p = new THREE.Vector3();
  const toLin = (c) => Math.pow(c / 255, 2.2);
  {
    const m = c.cam.matrixWorld;
    for (let y = 0; y < H; y += CLOUD_STRIDE) for (let x = 0; x < W; x += CLOUD_STRIDE) {
      const v = c.depth[y * W + x]; if (!v) continue;
      const z = zFromValue(v, NEAR, FAR);
      p.set((x + 0.5 - CX) / FX * z, -(y + 0.5 - CY) / FY * z, -z).applyMatrix4(m);
      pos.push(p.x, p.y, p.z);
      const i = (y * W + x) * 4;
      col.push(toLin(c.rgba[i]), toLin(c.rgba[i + 1]), toLin(c.rgba[i + 2]));
      size.push(z * CLOUD_STRIDE / FY * 1.15);
    }
  }
  const P = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(pos), 3));
  const C = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(col), 3));
  const S = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(size), 1));
  const m = new THREE.SpriteNodeMaterial();
  m.positionNode = vec3(P);
  m.scaleNode = vec2(S, S);
  m.colorNode = C;
  const sprite = new THREE.Sprite(m);
  sprite.count = size.length; sprite.frustumCulled = false;
  return sprite;
}

// ---- cameras.json ----
const rows = (m) => { const e = m.elements; return [0, 1, 2, 3].map((r) => [e[r], e[r + 4], e[r + 8], e[r + 12]].map((v) => +v.toFixed(9))); };
function camerasJson(caps) {
  return {
    generator: 'painterly-splat-field previz',
    units: 'meters',
    world: 'right-handed, +Y up',
    camera_axes: 'three.js / OpenGL: +X right, +Y up, camera looks down -Z',
    pixel_coords: 'origin at top-left, +x right, +y down, pixel centers at +0.5',
    projection: 'x_cam = (px - cx) / fx * z, y_cam = -(py - cy) / fy * z, z_cam = -z, then world = camera_to_world * [x_cam, y_cam, z_cam, 1]',
    depth: { ...DEPTH_FORMULA, near: NEAR, far: FAR },
    // 画素ごとの札。どの絵も color.png と同じ大きさ・同じ画素の並び。空（何も無い画素）は type 0・object 0。
    labels: {
      type_png: 'R = G = B = type id (see types). 0 = sky / nothing rendered',
      object_png: 'object id = R * 256 + G (see objects). 0 = no object',
      normal_png: 'world-space unit normal n = rgb / 127.5 - 1. Meaningless where type is 0',
      sun_png: 'sun visibility at paint time: 255 = sunlit, 0 = in cast shadow (does not include n.l). 255 where type is 0',
      types: TYPES,
      objects: app.labels.objects.map(({ id, name, type, type_id, base_color, bounds }) => ({ id, name, type, type_id, base_color, bounds })),
    },
    // 下絵の光。粒の光を付け替えるときの「描いたときの光」。式は shared/light.js。
    paint_light: {
      formula: 'L = ambient * (0.8 + 0.2 * n.y) + sun * max(dot(n, sun_direction), 0) * sun_visibility',
      sun_direction: SUN_DIR.map((v) => +v.toFixed(6)),
      sun_direction_meaning: 'unit vector from the surface toward the sun, world space',
      sun_azimuth_deg: PAINT_SUN.azimuth, sun_elevation_deg: PAINT_SUN.elevation,
      flat: { ...FLAT_LIGHT, image: 'X_flat.png = base colour * L, no sun, no cast shadows' },
      lit: { ...LIT_LIGHT, image: 'X_lit.png = base colour * L, neutral white sun with cast shadows' },
    },
    views: caps.map((c, i) => ({
      name: c.name,
      color: `${c.name}_color.png`,
      depth: `${c.name}_depth.png`,
      depth_view: `${c.name}_depth_view.png`,
      type: `${c.name}_type.png`,
      type_view: `${c.name}_type_view.png`,
      object: `${c.name}_object.png`,
      normal: `${c.name}_normal.png`,
      sun: `${c.name}_sun.png`,
      flat: `${c.name}_flat.png`,
      lit: `${c.name}_lit.png`,
      width: W, height: H,
      intrinsics: { fx: +FX.toFixed(6), fy: +FY.toFixed(6), cx: CX, cy: CY, fov_y_deg: fovY, K: [[+FX.toFixed(6), 0, CX], [0, +FY.toFixed(6), CY], [0, 0, 1]] },
      extrinsics: {
        position: EXPORT.cameras[i].position,
        target: EXPORT.cameras[i].target,
        camera_to_world: rows(c.cam.matrixWorld),
        world_to_camera: rows(c.cam.matrixWorldInverse),
        matrix_layout: 'row-major 4x4, column vectors (p_world = M * p_cam)',
      },
    })),
  };
}

// 札や下絵を、書き出す絵（RGBA）にする。画面で見る用の 'object_view' もここで作る。
const TYPE_RGB = new Map(TYPES.map((t) => [t.id, hexToRgb(t.color)]));
function picture(c, kind) {
  if (kind === 'flat' || kind === 'lit') return c[kind];
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; let r = 0, g = 0, b = 0;
    if (kind === 'type') r = g = b = c.type[i];
    else if (kind === 'type_view') [r, g, b] = TYPE_RGB.get(c.type[i]) || [255, 0, 255];
    else if (kind === 'object') { r = c.object[i] >> 8; g = c.object[i] & 255; }
    else if (kind === 'object_view') [r, g, b] = objectColor(c.object[i]);
    else if (kind === 'normal') { if (c.object[i]) { r = c.normal[i * 3] / 127 * 127.5 + 127.5; g = c.normal[i * 3 + 1] / 127 * 127.5 + 127.5; b = c.normal[i * 3 + 2] / 127 * 127.5 + 127.5; } }
    else if (kind === 'sun') r = g = b = c.sun[i];
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}

async function png(rgba) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
async function exportFiles(caps) {
  const files = {};
  for (const c of caps) {
    const packed = new Uint8ClampedArray(W * H * 4), view = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const v = c.depth[i], g = v ? (1 - Math.log(zFromValue(v, NEAR, FAR) / NEAR) / Math.log(FAR / NEAR)) * 255 + 0.5 : 0;
      packed[i * 4] = v >> 8; packed[i * 4 + 1] = v & 255; packed[i * 4 + 3] = 255;
      view[i * 4] = view[i * 4 + 1] = view[i * 4 + 2] = g; view[i * 4 + 3] = 255;
    }
    files[`${c.name}_color.png`] = await png(c.rgba);
    files[`${c.name}_depth.png`] = await png(packed);
    files[`${c.name}_depth_view.png`] = await png(view);
    for (const kind of ['type', 'type_view', 'object', 'normal', 'sun', 'flat', 'lit']) files[`${c.name}_${kind}.png`] = await png(picture(c, kind));
  }
  files['cameras.json'] = strToU8(JSON.stringify(camerasJson(caps), null, 2));
  return files;
}

// ---- 起動（描画方式を替えるたびに作り直す） ----
async function start(useGL) {
  if (starting) return; starting = true;
  say('準備しています…');
  if (app) { app.renderer.setAnimationLoop(null); app.controls.dispose(); app.renderer.domElement.remove(); app.renderer.dispose(); app = null; }

  let renderer;
  try { renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: useGL }); await renderer.init(); }
  catch (e) { starting = false; console.error(e); return say('このブラウザでは 3D 描画を開始できませんでした。Chrome か Edge の最新版で開いてください。'); }
  forceGL = useGL;
  stage.prepend(renderer.domElement);

  const scene = buildScene();
  const solids = []; scene.traverse((o) => { if (o.isMesh) solids.push(o); });
  scene.updateMatrixWorld(true);
  const labels = labelScene(scene);
  const exportCams = EXPORT.cameras.map(makeExportCamera);

  const extras = new THREE.Group(), frusta = new THREE.Group();
  exportCams.forEach((cam, i) => { // 視錐台は見やすいよう手前 60m までで描く
    const short = cam.clone(); short.near = 1; short.far = 60; short.updateProjectionMatrix(); short.updateMatrixWorld(true);
    const h = new THREE.CameraHelper(short); const c = new THREE.Color(FRUSTUM_COLORS[i % FRUSTUM_COLORS.length]);
    h.setColors(c, c, c, c, c); frusta.add(h);
  });
  extras.add(frusta); scene.add(extras);

  const overview = new THREE.PerspectiveCamera(50, 1, 0.5, 5000);
  overview.position.set(75, 55, 125);
  const controls = new OrbitControls(overview, renderer.domElement);
  controls.target.set(0, 12, -35); controls.maxPolarAngle = Math.PI * 0.495; controls.update();

  const a = app = {
    renderer, scene, solids, labels, exportCams, extras, frusta, overview, controls, clouds: [], caps: null,
    packMat: makePackMaterial(), viewMat: makeDepthViewMaterial(),
    colorRT: new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 }),
    depthRT: new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, samples: 0, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter }),
  };

  a.caps = [];
  for (const cam of exportCams) a.caps.push(await capture(a, cam));
  // 日なた・影と、下絵の2枚（光なし・影つき）。太陽の向きは scene.js の PAINT_SUN。
  a.sunMap = await renderSunMap(renderer, scene, labels, SUN_DIR);
  for (const c of a.caps) {
    Object.assign(c, shadeView({ W, H, depth: c.depth, type: c.type, object: c.object, normal: c.normal, matrixWorld: c.cam.matrixWorld.elements, fx: FX, fy: FY, cx: CX, cy: CY, near: NEAR, far: FAR }, labels, a.sunMap, SUN_DIR));
  }
  a.clouds = a.caps.map(buildCloud); extras.add(...a.clouds);

  const gpu = !!(renderer.backend && renderer.backend.isWebGPUBackend);
  $('sBackend').textContent = gpu ? 'WebGPU' : 'WebGL 2';
  $('swap').textContent = gpu ? 'WebGL 2 で描き直す' : 'WebGPU で描き直す';
  $('sSize').textContent = `${W} × ${H}`;
  const worst = a.caps.reduce((p, c) => (c.errP99 > p.errP99 ? c : p));
  $('sErr').textContent = `中央値 ${(Math.max(...a.caps.map((c) => c.errMedian)) * 100).toFixed(3)}% ・ 99% が ${(worst.errP99 * 100).toFixed(2)}% 以内`;

  layout(); showShot(); say('');
  let frames = 0, t0 = performance.now();
  renderer.setAnimationLoop(() => {
    draw();
    if (++frames >= 30) { const t1 = performance.now(); $('sFps').textContent = Math.round(frames * 1000 / (t1 - t0)) + ' fps'; frames = 0; t0 = t1; }
  });
  starting = false;
  window.__previz = { caps: a.caps, exportFiles: () => exportFiles(a.caps), camerasJson: () => camerasJson(a.caps), backend: gpu ? 'webgpu' : 'webgl2' };
  window.__ready = true;
}

function draw() {
  const a = app; if (!a) return;
  if (SHOT_MODES[ui.mode] && ui.view !== 'overview') return; // 書き出す絵を重ねて見せている間は描かない
  const over = ui.view === 'overview', depth = ui.mode === 'depth', hide = $('hide').checked && $('cloud').checked && !depth;
  const cam = over ? a.overview : a.exportCams[Number(ui.view)];
  if (over) a.controls.update();
  a.extras.visible = !depth;
  a.frusta.visible = over && $('frusta').checked;
  a.clouds.forEach((c, i) => { c.visible = $('cloud').checked && (ui.source === 'all' || Number(ui.source) === i); });
  a.solids.forEach((o) => { o.visible = !hide; });
  const bg = a.scene.background;
  if (depth) { a.scene.background = null; a.scene.overrideMaterial = a.viewMat; a.renderer.setClearColor(0x000000, 1); }
  a.renderer.render(a.scene, cam);
  a.scene.overrideMaterial = null; a.scene.background = bg;
}

// 書き出す札・下絵（種類、物体、面の向き、日なた、光なし、影つき）は、書き出す絵そのものを重ねて見せる。
const SHOT_MODES = { type: 'type_view', object: 'object_view', normal: 'normal', sun: 'sun', flat: 'flat', lit: 'lit' };
function showShot() {
  const shot = $('shot'), kind = SHOT_MODES[ui.mode], a = app;
  if (!kind || !a || !a.caps) { shot.style.display = 'none'; return; }
  if (ui.view === 'overview') { // 書き出す絵はカメラの視点にしか無いので、カメラAへ移す
    ui.view = '0';
    for (const x of $('view').children) x.setAttribute('aria-pressed', x.dataset.v === '0' ? 'true' : 'false');
    layout();
  }
  shot.width = W; shot.height = H;
  shot.getContext('2d').putImageData(new ImageData(picture(a.caps[Number(ui.view)], kind), W, H), 0, 0);
  shot.style.display = 'block';
}

function layout() {
  const a = app; if (!a) return;
  const sw = stage.clientWidth, sh = stage.clientHeight; if (!sw || !sh) return;
  const over = ui.view === 'overview';
  let w = sw, h = sh;
  if (!over) { const k = Math.min(sw / W, sh / H); w = Math.floor(W * k); h = Math.floor(H * k); }
  a.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  a.renderer.setSize(w, h);
  $('shot').style.width = w + 'px'; $('shot').style.height = h + 'px';
  a.overview.aspect = w / h; a.overview.updateProjectionMatrix();
  a.controls.enabled = over;
  $('hint').textContent = over ? 'ドラッグで回す ・ ホイールで前後 ・ 橙の枠がカメラA、水色がカメラB' : '';
}

function seg(id, fn) {
  const el = $(id);
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return;
    for (const x of el.children) x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); fn(b.dataset.v); });
}
seg('view', (v) => { ui.view = v; layout(); showShot(); });
seg('mode', (v) => { ui.mode = v; showShot(); });
seg('source', (v) => { ui.source = v; });
$('swap').addEventListener('click', () => start(!forceGL));
new ResizeObserver(layout).observe(stage);

$('export').addEventListener('click', async () => {
  if (!app || !app.caps) return;
  const btn = $('export'); btn.disabled = true;
  try {
    const zip = zipSync(await exportFiles(app.caps), { level: 0 });
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const link = document.createElement('a'); link.href = url; link.download = 'previz_export.zip';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } finally { btn.disabled = false; }
});

async function saveToFolder() {
  const files = await exportFiles(app.caps);
  for (const [name, bytes] of Object.entries(files)) {
    const res = await fetch(`/api/previz-export/${name}`, { method: 'POST', body: bytes });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `保存できませんでした（${res.status}）`);
  }
  return Object.keys(files).length;
}

// GUI（start.bat / npm run dev）から開いたときは、previz-export フォルダへ直接保存できる。
fetch('/api/state').then((r) => (r.ok ? r.json() : null)).then((s) => {
  if (!s || !('views' in s)) return;
  const btn = $('save'), note = $('saveNote'), zip = $('export');
  btn.hidden = note.hidden = false; zip.className = 'plain';
  btn.addEventListener('click', async () => {
    if (!app || !app.caps) return;
    btn.disabled = true;
    try {
      const count = await saveToFolder();
      note.textContent = `保存しました（${count} ファイル、${new Date().toLocaleTimeString()}）。`;
    } catch (e) { note.textContent = e.message; } finally { btn.disabled = false; }
  });
}).catch(() => {});

// 公開ページの枠の中ではファイルの保存ができないため、その場合は書き出しボタンを出さない。
if (import.meta.env.VITE_NO_DOWNLOAD) {
  $('export').hidden = true;
  $('exportNote').textContent = 'このページは表示の確認用です。zip の書き出しは、リポジトリを手元で動かしたとき（npm run dev）に使えます。';
}

// GUI の「視点を足す」で足したカメラ（previz-export/extra_cameras.json）も、同じように書き出す。
try {
  const res = await fetch('/files/previz-export/extra_cameras.json', { cache: 'no-store' });
  const extra = res.ok ? await res.json() : [];
  for (const c of Array.isArray(extra) ? extra : []) {
    if (!c || !/^[A-Za-z0-9]+$/.test(c.name || '') || EXPORT.cameras.some((x) => x.name === c.name)) continue;
    EXPORT.cameras.push({ name: c.name, position: c.position, target: c.target });
    const b = document.createElement('button'); b.type = 'button'; b.dataset.v = String(EXPORT.cameras.length - 1); b.textContent = c.name; b.setAttribute('aria-pressed', 'false');
    $('view').append(b);
  }
} catch { /* GUI のサーバーが無いときは A・B だけ */ }

await start(forceGL).catch((e) => { console.error(e); say('表示中に問題が起きました：' + e.message); });

// ?autosave つきで開かれたら（GUI の「視点を足す」から）、保存まで済ませて親の画面に知らせる。
if (new URLSearchParams(location.search).has('autosave')) {
  let ok = false, error = '';
  try { if (!app || !app.caps) throw new Error('プレビズを描けませんでした'); await saveToFolder(); ok = true; } catch (e) { error = e.message; }
  window.parent.postMessage({ type: 'previz-saved', ok, error }, location.origin);
}
