// 筆跡の粒：3D の形（プレビズ）を、参照の絵画の筆のタッチの粒に変えて、歩いて見る。
// 変える仕組みは shared/strokefield.js（Web Worker：studio/strokeworker.js）。ここは描画・LOD・確かめ用の表示。
//
// LOD：空間を 8 分木に分け、深い箱ほど細い筆跡を持つ。毎フレーム、画面の上での筆の太さが「絵の筆の太さ（を画面の大きさに直したもの）」に
// いちばん近くなる深さの箱を選んで描く。そのため、近くでも遠くでも筆跡が画面の上で同じくらいの大きさに見え、遠くの粒は少なく大きくなる。
// 並べ直し（遠い順のソート）はしない：筆跡は不透明の筆の形（brushtex.js）で、奥行きで隠し合う。同じ面の上で重なる筆跡は、
// 「塗る順番」（K.w）に応じてカメラの方へ少しずらし、後から塗った筆が上に来るようにする。
import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, cameraPosition, cameraViewMatrix, uniform, vec2, vec3, vec4, float, normalize, cross, dot, mix, step, cos, sin, texture, abs, clamp, pow, max, atan, fract, varying } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadScene } from './strokescene.js';
import { TYPES, hexToRgb } from '../shared/labels.js';
import { createWalk } from './walk.js';
import { brushAtlas, BRUSH_N } from './brushtex.js';
import { nodeKey, nodeBox, nodeWidth, STROKE_ATTRS } from '../shared/strokefield.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), view = $('view'), msg = $('msg');
const say = (t) => { msg.textContent = t; msg.style.display = t ? 'flex' : 'none'; };
const query = new URLSearchParams(location.search);
const SKY_R = 3000;
const MODES = ['color', 'source', 'type', 'orient', 'level', 'normal', 'shade'];

// 設定（URL でも渡せる：?brush=2&cover=1.5 など。ヘッドレスで試すとき粒を減らす用）
const ui = {
  paint: 'painted', refs: ['A'], mode: 'color', nav: 'orbit', orient: 'world', brush: Number(query.get('brush')) || 1, coverage: Number(query.get('cover')) || 2.4,
  across: Number(query.get('across')) || 48, paintedMix: 1, orientMix: 1, bristle: 1, layer: 0.3, underpaint: true, holes: false, sky: !query.has('nosky'), freeze: false, boxes: false,
  compare: 'off', compareOpacity: 0.5, tilt: true, stand: true, page: '3d', overlay: 'orient',
};
const PAINTS = { painted: { sfx: '', name: '最初の絵' }, painted_flat: { sfx: '_flat', name: '光の少ない絵' }, painted_lit: { sfx: '_lit', name: '影つきの絵' } };

let app = null, worker = null, summary = null, maps = null, cams = [], paintings = new Map(), gen = 0;

// ---- 形とカメラ（studio/strokescene.js） ----
async function loadPainting(name, key) {
  const id = `${name}${PAINTS[key].sfx}`; if (paintings.has(id)) return paintings.get(id);
  let out = null;
  try {
    const r = await fetch(`/files/paint-out/${name}_painted${PAINTS[key].sfx}.png`, { cache: 'no-store' });
    if (r.ok) { const blob = await r.blob(); out = { bmp: await createImageBitmap(blob), url: URL.createObjectURL(blob) }; }
  } catch { out = null; }
  paintings.set(id, out); return out;
}
function rgbaOf(bmp, W, H) { const c = new OffscreenCanvas(W, H), g = c.getContext('2d'); g.drawImage(bmp, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; }

// ---- 描画の部品 ----
const uMode = uniform(0), uScreen = uniform(0), uLayer = uniform(0.3), uBristle = uniform(1), uHoles = uniform(0), uSizeK = uniform(1);
function makeTextures() {
  const b = brushAtlas(), brush = new THREE.DataTexture(b.data, b.width, b.height, THREE.RGBAFormat);
  brush.magFilter = THREE.LinearFilter; brush.minFilter = THREE.LinearMipmapLinearFilter; brush.generateMipmaps = true; brush.needsUpdate = true;
  const t = new Uint8Array(16 * 4);
  for (const x of TYPES) { const [r, g, bb] = hexToRgb(x.color); t.set([r, g, bb, STAND.has(x.key) ? 255 : 0], x.id * 4); }
  const types = new THREE.DataTexture(t, 16, 1, THREE.RGBAFormat); types.needsUpdate = true;
  return { brush, types };
}
const hue = (h) => clamp(abs(fract(vec3(h, h.add(2 / 3), h.add(1 / 3))).mul(6).sub(3)).sub(1), 0, 1);
const toLin = (c) => pow(max(c, vec3(0)), vec3(2.2));

// 立てて描く種類：草は、地面に寝かせず、根元から立つ葉のように描く（板はいつもカメラの方を向き、傾きは絵の筆の向き）。
// 絵の草の筆跡は、地面の上の模様ではなく、立っている葉を横から見たものだから。
const STAND = new Set(['grass']);
const uStand = uniform(1);
function strokeMaterial(tex, sky) {
  const P = attribute('sP', 'vec4'), N = attribute('sN', 'vec4'), T = attribute('sT', 'vec4'), K = attribute('sK', 'vec4'), M = attribute('sM', 'vec4'), G = attribute('sG', 'vec4');
  const corner = positionGeometry.xy; // x = 筆の進む向き（-0.5〜0.5）、y = 幅の向き
  const n = normalize(N.xyz);
  const center = sky ? cameraPosition.add(P.xyz.mul(SKY_R)) : P.xyz;
  const width = (sky ? P.w.mul(SKY_R) : P.w).mul(uSizeK), len = (sky ? N.w.mul(SKY_R) : N.w).mul(uSizeK);
  // 「画面に合わせる」向き：絵の上の角度（画像の y は下向き）を、画面の右・上の向きから作り、面に沿わせる
  const V = cameraViewMatrix, right = vec3(V[0].x, V[1].x, V[2].x), up = vec3(V[0].y, V[1].y, V[2].y);
  const D = right.mul(cos(T.w)).sub(up.mul(sin(T.w))), tS = D.sub(n.mul(dot(D, n)));
  const t0 = normalize(mix(T.xyz, normalize(tS.add(T.xyz.mul(1e-4))), uScreen));
  const toCam = normalize(cameraPosition.sub(center));
  // 寝かせる筆：面に沿った板
  const bF = normalize(cross(n, t0)), tF = cross(bF, n);
  // 立てる筆：絵の上の傾き（画面の向き D）で根元から立ち、板はカメラの方を向く
  const tUp2 = normalize(D.mul(step(0, dot(D, n)).mul(2).sub(1)).add(n.mul(0.35))); // D を面の外向き（上）へそろえ、少し立てる
  const bUp = normalize(cross(tUp2, toCam));
  const stand = sky ? float(0) : texture(tex.types, vec2(M.x.add(0.5).div(16), 0.5)).a.mul(uStand).mul(step(M.z, 7.5)); // 点（筆の形 8 番から）は立てない
  // 点（点描の一筆。筆の形 8 番から）：面に寝かせず、いつもカメラの方を向く丸。斜めに見た地面でも、絵と同じ大きさの点に見える
  const dab = sky ? float(0) : step(7.5, M.z);
  const tDab = normalize(cross(up, toCam)), bDab = cross(toCam, tDab);
  const t = mix(mix(tF, tUp2, stand), tDab, dab), b = mix(mix(bF, bUp, stand), bDab, dab);
  // 立てる筆の高さ：地面を浅い角度で見るほど低くする（遠くの草が、地平線より上へ伸びて物の足元を隠さないように）
  const lenS = len.mul(mix(float(1), clamp(dot(n, toCam).abs().sqrt().mul(1.8), 0.12, 1), stand));
  const base = mix(vec3(0), t.mul(lenS.mul(0.5)), stand).add(n.mul(width.mul(0.5)).mul(dab)); // 立てる筆は根元を地面に。点は半分だけ面から浮かせる（面に埋まらないように）
  const show = sky ? float(1) : max(step(-0.05, dot(n, toCam)), stand); // 裏を向いた面の筆跡は描かない
  const lift = sky ? vec3(0) : toCam.mul(K.w.mul(width).mul(uLayer)); // 後から塗った筆ほど手前（同じ面の上の重なりの順番）
  const pos = center.add(base).add(lift).add(t.mul(corner.x.mul(lenS))).add(b.mul(corner.y.mul(width)));
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, depthWrite: !sky, depthTest: !sky });
  m.positionNode = mix(center, pos, show);
  // 色
  const br = texture(tex.brush, vec2(corner.x.add(0.5), corner.y.add(0.5).add(M.z).div(BRUSH_N)));
  const ang = atan(dot(t, up), dot(t, right)); // 画面の上での筆の向き（色分け用。前後どちら向きでも同じ色）
  const sel = (i) => float(1).sub(step(0.5, abs(uMode.sub(i))));
  const flat = vec3(0).add(toLin(mix(vec3(0.95, 0.55, 0.15), vec3(0.25, 0.85, 0.35), M.y)).mul(sel(1)))
    .add(toLin(texture(tex.types, vec2(M.x.add(0.5).div(16), 0.5)).rgb).mul(sel(2)))
    .add(hue(ang.div(Math.PI).add(1).fract()).mul(sel(3)))
    .add(hue(M.w.div(12)).mul(sel(4)))
    .add(n.mul(0.5).add(0.5).mul(sel(5)));
  const painted = toLin(K.rgb).mul(sel(0)).add(toLin(G.rgb).mul(sel(6)));
  const streak = float(1).add(br.g.sub(0.5).mul(G.w).mul(uBristle).mul(0.9));
  m.colorNode = vec4(painted.mul(streak).add(flat), 1);
  m.opacityNode = br.r; m.alphaTest = 0.5;
  return m;
}

function quadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
function strokeMesh(arrays, count, mat) {
  const g = quadGeometry();
  for (const k of STROKE_ATTRS) g.setAttribute('s' + k, new THREE.InstancedBufferAttribute(arrays[k], 4));
  g.instanceCount = count;
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false;
  return mesh;
}

// ---- 8 分木の LOD ----
const nodes = new Map(); // key → { key, l, x, y, z, state: 'want' | 'busy' | 'ready', mesh, count, mask, used }
const queue = new Set(); let busy = 0, lastSel = { drawn: 0, strokes: 0, levels: [], want: 0 };
const MAX_BUSY = 3, BUDGET = Number(query.get('budget')) || 8e6;
function nodeOf(key) {
  let n = nodes.get(key);
  if (!n) { const [l, x, y, z] = key.split('/').map(Number); n = { key, l, x, y, z, state: 'want', mesh: null, count: 0, mask: 0, used: 0, prio: 0 }; nodes.set(key, n); }
  return n;
}
const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _box = new THREE.Box3(), _frustum = new THREE.Frustum(), _m = new THREE.Matrix4();
function pxPerMeter() { const a = app; return a.canvasH * (a.focalScale || 1) / (2 * Math.tan(THREE.MathUtils.degToRad(a.camera.fov) / 2)); }
function targetPx() { return summary.ref.width * (app.canvasH / summary.ref.H) * ui.brush; }
function select() {
  const a = app, tree = summary.tree, cam = a.camera.position, f = pxPerMeter(), target = targetPx() * Math.SQRT2, now = performance.now();
  _frustum.setFromProjectionMatrix(_m.multiplyMatrices(a.camera.projectionMatrix, a.camera.matrixWorldInverse));
  const draw = [];
  const visit = (key) => { // この箱の中を描けたら true
    const n = nodeOf(key); n.used = now;
    const { lo, s } = nodeBox(tree, n.l, n.x, n.y, n.z);
    _box.min.set(lo[0], lo[1], lo[2]); _box.max.set(lo[0] + s, lo[1] + s, lo[2] + s);
    const pad = nodeWidth(tree, n.l) * 6; _box.expandByScalar(pad); // はみ出した筆跡のぶん
    if (!_frustum.intersectsBox(_box)) return true;
    if (n.state !== 'ready') { want(n, 0); return false; }
    const d = Math.max(0.05, _box.distanceToPoint(cam));
    // 平らな箱を斜めに見るときは、筆跡が画面の上でつぶれて小さく見えるので、そのぶん粗い段で足りる（面積で √cos）
    let tilt = 1;
    n.frac = 1;
    if (ui.tilt && n.flat && n.flat.k > 0.85) {
      _v.copy(_box.getCenter(_c)).sub(cam).normalize(); const cos = Math.abs(_v.x * n.flat.n[0] + _v.y * n.flat.n[1] + _v.z * n.flat.n[2]);
      // 点（いつもカメラの方を向く）は、斜めに見ても画面の上で小さくならない。段は粗くせず、同じ面積に重なりすぎるぶん、描く数を減らす（筆跡は箱の中で順不同なので、先頭から何割かを描けば一様に間引ける）
      if (n.flat.dab > 0.5) { if (d > s) n.frac = Math.min(1, Math.max(0.12, cos * 1.6)); }
      else tilt = Math.max(0.2, Math.sqrt(cos));
    }
    const px = nodeWidth(tree, n.l) * f / d * tilt;
    if (n.mask && px > target && n.l < tree.maxLevel && !ui.freeze) {
      const kids = []; for (let c = 0; c < 8; c++) if (n.mask & (1 << c)) kids.push(nodeKey(n.l + 1, n.x * 2 + (c & 1), n.y * 2 + ((c >> 1) & 1), n.z * 2 + ((c >> 2) & 1)));
      const ready = kids.map((k) => nodeOf(k)).every((c) => c.state === 'ready');
      if (ready) { const before = draw.length; let ok = true; for (const k of kids) ok = visit(k) && ok; if (ok) return true; draw.length = before; }
      else for (const k of kids) { const c = nodeOf(k); c.used = now; want(c, px); }
    }
    draw.push(n); return true;
  };
  visit(nodeKey(0, 0, 0, 0));
  return draw;
}
function want(n, prio) { if (n.state === 'want') { n.prio = Math.max(n.prio, prio + 1000 / (n.l + 1)); queue.add(n.key); } }
function pump() {
  while (busy < MAX_BUSY && queue.size) {
    let best = null; for (const k of queue) { const n = nodes.get(k); if (!n || n.state !== 'want') { queue.delete(k); continue; } if (!best || n.l < best.l || (n.l === best.l && n.prio > best.prio)) best = n; }
    if (!best) break;
    queue.delete(best.key); best.state = 'busy'; busy++;
    worker.postMessage({ type: 'node', key: best.key, gen });
  }
}
function onNode(m) {
  busy = Math.max(0, busy - 1);
  if (m.gen !== gen) return;
  const n = nodeOf(m.key);
  n.state = 'ready'; n.count = m.count; n.mask = m.mask; n.ms = m.ms; n.flat = m.flat;
  if (m.count) { n.mesh = strokeMesh(m.arrays, m.count, app.mat); n.mesh.visible = false; app.strokes.add(n.mesh); }
  evict(); pump(); // 次の箱をすぐ頼む（描画が遅くても作る速さが落ちないように）
}
function evict() {
  let total = 0; for (const n of nodes.values()) total += n.count;
  if (total <= BUDGET) return;
  const old = [...nodes.values()].filter((n) => n.state === 'ready' && n.l > 0).sort((a, b) => a.used - b.used);
  for (const n of old) { if (total <= BUDGET * 0.8) break; if (performance.now() - n.used < 2000) break; dropNode(n); total -= n.count; }
}
function dropNode(n) { if (n.mesh) { app.strokes.remove(n.mesh); n.mesh.geometry.dispose(); } nodes.delete(n.key); }
function clearNodes() { for (const n of [...nodes.values()]) dropNode(n); nodes.clear(); queue.clear(); busy = 0; gen++; }

// ---- 始める ----
async function start() {
  say('形と絵を読んでいます…');
  const baked = await loadScene();
  cams = baked.cams;
  if (!cams.some((c) => ui.refs.includes(c.name))) ui.refs = [cams[0].name];
  const refs = [];
  for (const name of ui.refs) {
    const c = cams.find((x) => x.name === name), p = c && await loadPainting(name, ui.paint);
    if (p) refs.push({ name, cam: c.cam, rgba: rgbaOf(p.bmp, c.W, c.H), mask: c.mask || null });
  }
  for (const c of cams) await loadPainting(c.name, ui.paint); // 見比べ用（参照に使わない視点の絵も）
  setupViewButtons();
  if (!refs.length) return say(`参照にする絵がありません。\n「絵画化」のタブで ${ui.refs.join('・')} の「${PAINTS[ui.paint].name}」を作ってから、「作り直す」を押してください。`);

  if (!app) await makeApp(baked);
  say('絵の筆跡を測り、色の決まりを学んでいます…');
  clearNodes();
  if (worker) worker.terminate();
  worker = new Worker(new URL('./strokeworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') { summary = m.summary; maps = m.maps; onReady(m.ms); }
    else if (m.type === 'node') onNode(m);
    else if (m.type === 'sky') onSky(m);
    else if (m.type === 'shade') onShade(m);
    else if (m.type === 'error') { busy = Math.max(0, busy - 1); console.error(m.message); say('筆跡を作るときに問題が起きました：' + m.message); }
  };
  worker.postMessage({ type: 'init', tris: baked.tris, refs, opts: genOpts(), tree: { across: ui.across, minWidth: 0.015 } });
}
const genOpts = () => ({ coverage: ui.coverage, paintedMix: ui.paintedMix, orientMix: ui.orientMix });

async function makeApp(baked) {
  let renderer;
  try { renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: query.has('gl') }); await renderer.init(); }
  catch (e) { console.error(e); return say('このブラウザでは 3D 描画を開始できませんでした。Chrome か Edge の最新版で開いてください。'); }
  view.prepend(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 1, 0.05, 8000), controls = new OrbitControls(camera, renderer.domElement);
  const tex = makeTextures();
  const a = app = { renderer, scene, camera, controls, tex, mat: strokeMaterial(tex, false), skyMat: strokeMaterial(tex, true), strokes: new THREE.Group(), yaw: 0, pitch: 0, canvasH: 600, baked };
  // 下塗り：形そのものを、学んだ陰影の色で塗る（筆跡のすき間から見える色）。筆跡より少し奥に描く
  const under = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
  const ug = new THREE.BufferGeometry(); ug.setAttribute('position', new THREE.BufferAttribute(baked.tris.pos, 3)); ug.setAttribute('color', new THREE.BufferAttribute(new Float32Array(baked.tris.n * 9).fill(0.3), 3));
  a.under = new THREE.Mesh(ug, under); a.under.frustumCulled = false;
  a.walk = createWalk(scene, baked.solids, baked.objects);
  a.boxes = new THREE.Group();
  scene.add(a.under, a.strokes, a.boxes);
  jump(cams[0] ? cams[0].name : null);
  layout();
  let frames = 0, t0 = performance.now(), last = t0, selAt = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (ui.nav === 'walk') walkStep(dt); else controls.update();
    if (summary && now - selAt > 60) { selAt = now; frame(); }
    renderer.render(scene, camera);
    if (++frames >= 30) { $('sFps').textContent = Math.round(frames * 1000 / (now - t0)) + ' fps'; frames = 0; t0 = now; }
  });
  $('sBackend').textContent = renderer.backend && renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
}

function frame() {
  const a = app, draw = select();
  for (const n of nodes.values()) if (n.mesh) n.mesh.visible = false;
  let strokes = 0; const levels = new Map();
  for (const n of draw) if (n.mesh) { n.mesh.visible = true; const c = Math.max(1, Math.round(n.count * (n.frac || 1))); n.mesh.geometry.instanceCount = c; strokes += c; levels.set(n.l, (levels.get(n.l) || 0) + c); }
  pump();
  lastSel = { drawn: draw.length, strokes, levels: [...levels].sort((x, y) => x[0] - y[0]), want: queue.size + busy };
  $('sStrokes').textContent = `${(strokes / 10000).toFixed(1)} 万本（箱 ${draw.length}）`;
  $('sLevels').textContent = lastSel.levels.map(([l, c]) => `${l}:${(c / 1000).toFixed(0)}k`).join(' ');
  $('sQueue').textContent = lastSel.want ? `${lastSel.want} 箱を作成中` : 'なし';
  $('sTarget').textContent = `${targetPx().toFixed(1)} px`;
  if (a.sky) a.sky.visible = ui.sky;
  if (ui.boxes) showBoxes(draw); else if (a.boxes.children.length) a.boxes.clear();
}
function showBoxes(draw) {
  const a = app; a.boxes.clear();
  for (const n of draw.slice(0, 600)) {
    const { lo, s } = nodeBox(summary.tree, n.l, n.x, n.y, n.z);
    const h = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(lo[0] + s, lo[1] + s, lo[2] + s)), new THREE.Color().setHSL((n.l / 12) % 1, 0.9, 0.6));
    a.boxes.add(h);
  }
}

function onReady(ms) {
  const a = app;
  say('');
  $('sAnalyze').textContent = `${(ms / 1000).toFixed(1)} 秒`;
  worker.postMessage({ type: 'shade' });
  if (ui.sky) worker.postMessage({ type: 'sky', gen, opts: { scale: ui.brush } });
  // 空の背景色：空の決まりの、地平線の少し上の色
  if (summary.models.sky) { const c = summary.models.sky.coef; const d = [0, 0.148, -0.989]; const col = [0, 1, 2].map((k) => c[0][k] + c[1][k] * d[0] + c[2][k] * d[1] + c[3][k] * d[2]); a.scene.background = new THREE.Color().setRGB(...col.map((v) => Math.min(1, Math.max(0, v))), THREE.SRGBColorSpace); }
  showStats(); drawAnalysis();
  window.__strokes.ready = true;
}
function onShade(m) {
  const a = app, c = a.under.geometry.attributes.color;
  for (let i = 0; i < m.colors.length; i++) m.colors[i] = Math.pow(m.colors[i], 2.2);
  c.array.set(m.colors); c.needsUpdate = true; a.shadeColors = m.colors.slice(); applyUi();
}
function onSky(m) {
  const a = app; if (m.gen !== gen) return;
  if (a.sky) { a.scene.remove(a.sky); a.sky.geometry.dispose(); a.sky = null; }
  if (!m.count) return;
  a.sky = strokeMesh(m.arrays, m.count, a.skyMat); a.sky.renderOrder = -1; a.scene.add(a.sky);
  $('sSky').textContent = `${(m.count / 10000).toFixed(1)} 万本`;
}

// ---- 表示 ----
function applyUi() {
  const a = app; if (!a) return;
  uMode.value = MODES.indexOf(ui.mode); uStand.value = ui.stand ? 1 : 0; uScreen.value = ui.orient === 'screen' ? 1 : 0; uLayer.value = ui.layer; uBristle.value = ui.bristle;
  a.under.visible = ui.underpaint || ui.holes;
  a.under.material.vertexColors = !ui.holes; a.under.material.color.set(ui.holes ? 0xff00ff : 0xffffff); a.under.material.needsUpdate = true;
  a.walk.shapes.visible = $('shapes').checked; a.walk.me.visible = ui.nav === 'walk' && $('third').checked;
  for (const [id, v] of [['mode', ui.mode], ['orient', ui.orient], ['nav', ui.nav], ['compare', ui.compare], ['page', ui.page], ['overlay', ui.overlay], ['paint', ui.paint]]) press($(id), v);
  $('hint').textContent = ui.nav === 'walk' ? 'クリックで視線を動かす（Esc で解除）・WASD で歩く・Shift で走る・Space で跳ぶ' : 'ドラッグで回す・右ドラッグで動かす・ホイールで近づく';
  $('cmpImg').hidden = ui.compare === 'off' || ui.page !== '3d';
  $('cmpImg').style.opacity = ui.compare === 'overlay' ? ui.compareOpacity : 1;
  $('cmpImg').style.clipPath = ui.compare === 'split' ? 'inset(0 50% 0 0)' : 'none';
  $('anaCanvas').hidden = ui.page !== 'analysis';
  layout();
}
function press(el, v) { if (el) for (const x of el.children) x.setAttribute('aria-pressed', x.dataset.v === String(v) ? 'true' : 'false'); }
function seg(id, fn) { $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.v != null) fn(b.dataset.v); }); }

// 比べるとき：画面を参照の絵と同じ縦横比（2:3）の枠にし、カメラをその視点に合わせる
let cmpView = null;
function layout() {
  const a = app; if (!a) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  let w = W, h = H;
  const c = cmpView && cams.find((x) => x.name === cmpView);
  if ((ui.compare !== 'off' || ui.page === 'analysis') && c) { const k = c.W / c.H; if (W / H > k) w = Math.round(H * k); else h = Math.round(W / k); }
  Object.assign(view.style, { width: w + 'px', height: h + 'px', left: Math.round((W - w) / 2) + 'px', top: Math.round((H - h) / 2) + 'px' });
  a.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); a.renderer.setSize(w, h, false);
  a.canvasH = h * a.renderer.getPixelRatio();
  // 絵と比べるときだけ、絵のカメラの枠（光軸が絵のまん中に無い場面は、大きな対称の枠の一部）に合わせる
  const locked = (ui.compare !== 'off' || ui.page === 'analysis') && c;
  if (locked && c.offset) { a.camera.setViewOffset(...c.offset); a.camera.aspect = c.offset[0] / c.offset[1]; a.camera.fov = c.fovFull; a.focalScale = c.offset[1] / c.H; }
  else { a.camera.clearViewOffset(); a.camera.aspect = w / h; if (c) a.camera.fov = c.fovPlain; a.focalScale = 1; }
  a.camera.updateProjectionMatrix();
}
window.addEventListener('resize', layout);

function jump(name) {
  const a = app, c = cams.find((x) => x.name === name); if (!a || !c) return;
  cmpView = name;
  c.apply(a.camera); a.controls.target.fromArray(c.target); 
  const p = paintings.get(`${name}${PAINTS[ui.paint].sfx}`);
  $('cmpImg').src = p ? p.url : '';
  $('cmpNote').textContent = p ? (ui.refs.includes(name) ? `${name} は参照に使っている絵です（写した色がそのまま出る視点）。` : `${name} は参照に使っていない絵です（答え合わせ用。筆跡はこの絵を見ていません）。`) : `${name} の「${PAINTS[ui.paint].name}」はまだありません。`;
  syncAngles(); if (ui.nav === 'walk') placeAtCamera();
  layout();
}
function setupViewButtons() {
  const el = $('views'); el.innerHTML = '';
  for (const c of cams) { const b = document.createElement('button'); b.type = 'button'; b.dataset.v = c.name; b.textContent = c.name; el.append(b); }
  const r = $('refs'); r.innerHTML = '';
  for (const c of cams) {
    const l = document.createElement('label'); l.className = 'check';
    l.innerHTML = `<input type="checkbox" value="${c.name}" ${ui.refs.includes(c.name) ? 'checked' : ''}> ${c.name}`;
    r.append(l);
  }
}
seg('views', (v) => { jump(v); press($('views'), v); });

// ---- 歩く ----
const keys = new Set(); let jumpQueued = false, dragging = false;
function syncAngles() { const a = app, e = new THREE.Euler().setFromQuaternion(a.camera.quaternion, 'YXZ'); a.yaw = e.y; a.pitch = e.x; }
function placeAtCamera() { const a = app, c = a.camera.position; a.walk.place(c.x, c.y - a.walk.wk.p.eye, c.z); }
function walkStep(dt) {
  const a = app;
  a.camera.quaternion.setFromEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  a.walk.update(dt, { forward: f, right: r, yaw: a.yaw, run: keys.has('ShiftLeft') || keys.has('ShiftRight'), jump: jumpQueued, up: keys.has('KeyE'), down: keys.has('KeyQ') });
  jumpQueued = false;
  const wk = a.walk.wk; a.camera.position.set(wk.feet[0], wk.eyeY, wk.feet[2]);
  if ($('third').checked) a.camera.position.addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(a.camera.quaternion), 4).y += 0.6;
}
function setNav(v) {
  const a = app; ui.nav = v; if (!a) return;
  a.controls.enabled = v === 'orbit';
  if (v === 'walk') { syncAngles(); placeAtCamera(); }
  else { if (document.pointerLockElement) document.exitPointerLock(); a.controls.target.copy(a.camera.position).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(a.camera.quaternion), 30); }
  applyUi();
}
stage.addEventListener('pointerdown', (e) => {
  if (ui.nav !== 'walk' || e.target.tagName !== 'CANVAS') return;
  dragging = true; if (document.activeElement) document.activeElement.blur();
  const req = e.target.requestPointerLock && e.target.requestPointerLock(); if (req && req.catch) req.catch(() => {});
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => { if (ui.nav === 'walk' && app && (document.pointerLockElement || dragging)) { app.yaw -= e.movementX * 0.0022; app.pitch = Math.max(-1.5, Math.min(1.5, app.pitch - e.movementY * 0.0022)); } });
window.addEventListener('keydown', (e) => {
  const t = e.target; if (ui.nav !== 'walk' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/^(checkbox|range|radio)$/.test(t.type))) return;
  keys.add(e.code); if (e.code === 'Space' && !e.repeat) jumpQueued = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// ---- 測った値の表示 ----
const KIND_NAME = new Map(TYPES.map((t) => [t.id, t.name]));
function rose(hist, color) { // 向きの分布（0〜π を上半分の扇で）
  const r = 26, cx = 30, cy = 30; let d = '';
  hist.forEach((p, i) => { const a0 = (i / hist.length) * Math.PI, a1 = ((i + 1) / hist.length) * Math.PI, rr = r * Math.min(1, Math.sqrt(p * hist.length / 3));
    for (const s of [0, Math.PI]) d += `M${cx},${cy} L${cx + rr * Math.cos(a0 + s)},${cy + rr * Math.sin(a0 + s)} L${cx + rr * Math.cos(a1 + s)},${cy + rr * Math.sin(a1 + s)} Z `; });
  return `<svg width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="none" stroke="#2a332b"/><path d="${d}" fill="${color}" opacity=".85"/></svg>`;
}
function showStats() {
  const rows = summary.types.sort((x, y) => x.kind - y.kind).map((s) => {
    const col = (TYPES.find((t) => t.id === s.kind) || {}).color || '#888';
    return `<div class="trow"><div><b style="color:${col}">${KIND_NAME.get(s.kind) || s.kind}</b><br><span class="sub">幅 ${s.width.toFixed(1)} px・長さ ${s.length.toFixed(1)} px<br>長さ÷幅 ${s.aspect.toFixed(1)}・毛の筋 ${s.bristle.toFixed(2)}<br>はっきりさ ${s.coh.toFixed(2)}</span></div>
      <div title="絵の上での筆の向き">${rose(s.hist, col)}<div class="sub c">絵の上</div></div><div title="面の上での筆の向き（面に沿って上 = 右）">${rose(s.phiHist, col)}<div class="sub c">面の上</div></div></div>`;
  }).join('');
  $('typeStats').innerHTML = rows;
  const sw = Object.entries(summary.models).filter(([k]) => k.startsWith('o') || k === 'sky').map(([k, md]) => {
    const name = k === 'sky' ? '空' : ((app.baked.objects.find((o) => 'o' + o.id === k) || {}).name || k);
    const dirs = k === 'sky' ? [[0, 0.05, -1], [0, 0.4, -1], [0, 1, 0], [1, 0.2, 0], [0, 0.2, 1]] : [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 0, -1], [0, 1, 0]];
    const cells = dirs.map((d) => { const c = [0, 1, 2].map((i) => Math.round(255 * Math.min(1, Math.max(0, md.coef[0][i] + md.coef[1][i] * d[0] + md.coef[2][i] * d[1] + md.coef[3][i] * d[2])))); return `<i style="background:rgb(${c})"></i>`; }).join('');
    const bank = md.bank.map((b) => { const c = [0, 1, 2].map((i) => Math.round(255 * Math.min(1, Math.max(0, md.coef[0][i] + b[i])))); return `<i style="background:rgb(${c})"></i>`; }).join('');
    return `<div class="mrow"><span>${name}</span><span class="sw">${cells}</span><span class="sw small">${bank}</span></div>`;
  }).join('');
  $('models').innerHTML = sw;
  $('sMeasure').textContent = `筆の幅 ${summary.ref.width.toFixed(1)} px・長さ ${summary.ref.length.toFixed(1)} px（絵の高さ ${summary.ref.H} px で）`;
  $('sTree').textContent = `${summary.tree.size.toFixed(0)} m 四方・${summary.tree.maxLevel + 1} 段（いちばん細い筆 ${(nodeWidth(summary.tree, summary.tree.maxLevel) * 100).toFixed(1)} cm）`;
}

// 絵を調べる画面：参照の絵に、測った向き・はっきりさ・種類・筆跡の見本を重ねる
function drawAnalysis() {
  if (!maps) return;
  const cv = $('anaCanvas'), { W, H } = maps, g = cv.getContext('2d');
  cv.width = W; cv.height = H;
  const p = paintings.get(`${maps.refs[0]}${PAINTS[ui.paint].sfx}`); if (p) g.drawImage(p.bmp, 0, 0, W, H);
  if (ui.overlay === 'coh' || ui.overlay === 'kind' || ui.overlay === 'edge') {
    const im = g.getImageData(0, 0, W, H), d = im.data;
    for (let i = 0; i < W * H; i++) {
      let c = null;
      if (ui.overlay === 'coh') { const v = maps.coh[i]; c = [v * 255, v * 255, v * 255]; }
      else if (ui.overlay === 'kind') { const t = TYPES.find((x) => x.id === maps.kind[i]); c = t ? hexToRgb(t.color) : [0, 0, 0]; }
      else c = maps.edge[i] ? [255, 0, 255] : null;
      if (c) { const k = ui.overlay === 'edge' ? 1 : 0.65; for (let j = 0; j < 3; j++) d[i * 4 + j] = d[i * 4 + j] * (1 - k) + c[j] * k; }
    }
    g.putImageData(im, 0, 0);
  }
  if (ui.overlay === 'orient') { // 12 画素ごとに、筆の向きの線（はっきりさで濃さ）
    g.lineWidth = 1.6;
    for (let y = 6; y < H; y += 12) for (let x = 6; x < W; x += 12) {
      const i = y * W + x, t = maps.theta[i], c = maps.coh[i], L = 5.5;
      g.strokeStyle = `rgba(255,${Math.round(80 + 175 * c)},40,${0.25 + 0.75 * c})`;
      g.beginPath(); g.moveTo(x - Math.cos(t) * L, y - Math.sin(t) * L); g.lineTo(x + Math.cos(t) * L, y + Math.sin(t) * L); g.stroke();
    }
  }
  if (ui.overlay === 'sample') { // 測った幅・長さの四角を、その場所の向きで並べる（絵の筆跡と大きさが合っているかを見る）
    const by = new Map(summary.types.map((s) => [s.kind, s]));
    for (let y = 20; y < H; y += 46) for (let x = 20 + ((y / 46) % 2) * 23; x < W; x += 46) {
      const i = Math.floor(y) * W + Math.floor(x), s = by.get(maps.kind[i]); if (!s) continue;
      const t = maps.theta[i];
      g.save(); g.translate(x, y); g.rotate(t); g.strokeStyle = 'rgba(0,255,220,.9)'; g.lineWidth = 1.5; g.strokeRect(-s.length / 2, -s.width / 2, s.length, s.width); g.restore();
    }
  }
}

// ---- 操作 ----
seg('mode', (v) => { ui.mode = v; applyUi(); });
seg('orient', (v) => { ui.orient = v; applyUi(); });
seg('nav', (v) => setNav(v));
seg('compare', (v) => { ui.compare = v; applyUi(); });
seg('page', (v) => { ui.page = v; if (v === 'analysis' && maps) jump(maps.refs[0]); applyUi(); drawAnalysis(); });
seg('overlay', (v) => { ui.overlay = v; applyUi(); drawAnalysis(); });
seg('paint', (v) => { ui.paint = v; applyUi(); });
const range = (id, key, fmt, after) => { const el = $(id), out = $('o' + id[0].toUpperCase() + id.slice(1)); const show = () => { if (out) out.textContent = fmt(Number(el.value)); }; el.value = ui[key]; show(); el.addEventListener('input', () => { ui[key] = Number(el.value); show(); if (after) after(); }); };
range('brush', 'brush', (v) => `${v.toFixed(2)} 倍`);
range('layer', 'layer', (v) => v.toFixed(2), applyUi);
range('bristle', 'bristle', (v) => v.toFixed(1), applyUi);
range('opacity', 'compareOpacity', (v) => `${Math.round(v * 100)}%`, applyUi);
range('coverage', 'coverage', (v) => `${v.toFixed(1)} 重`);
range('paintedMix', 'paintedMix', (v) => `${Math.round(v * 100)}%`);
range('orientMix', 'orientMix', (v) => `${Math.round(v * 100)}%`);
for (const [id, key] of [['standOn', 'stand'], ['tiltOn', 'tilt'], ['underpaint', 'underpaint'], ['holes', 'holes'], ['skyOn', 'sky'], ['freeze', 'freeze'], ['boxesOn', 'boxes']]) { $(id).checked = ui[key]; $(id).addEventListener('change', () => { ui[key] = $(id).checked; applyUi(); }); }
for (const id of ['shapes', 'third']) $(id).addEventListener('change', applyUi);
$('regen').addEventListener('click', () => { // まき方の設定を変えて、筆跡を作り直す（絵を調べ直さない）
  if (!worker || !summary) return;
  clearNodes(); worker.postMessage({ type: 'opts', opts: genOpts() }); worker.postMessage({ type: 'sky', gen, opts: { scale: ui.brush } });
});
$('restart').addEventListener('click', () => { ui.refs = [...$('refs').querySelectorAll('input:checked')].map((x) => x.value); summary = null; window.__strokes.ready = false; start(); });

window.__strokes = { ready: false, ui, get app() { return app; }, get summary() { return summary; }, jump, applyUi, stats: () => lastSel, idle: () => !!summary && queue.size === 0 && busy === 0, nodes };
start().catch((e) => { console.error(e); say('問題が起きました：' + e.message); });
