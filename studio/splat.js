// 粒の空間：書き出した奥行き・カメラ情報と、絵（絵画 or プレビズの色）から、1画素を1粒として3D空間に置いて見る。
// 置き方は cameras.json の projection のとおり。プレビズの形そのものは使わない（線で重ねる確かめ用を除く）。
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, uniform, uv, vec2, float, step, exp, mix, max, abs } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene, PAINT_SUN } from '../previz/scene.js';
import { labelScene, renderSunMap, sunVisibility } from '../previz/gbuffer.js';
import { TYPES, hexToRgb, objectColor } from '../shared/labels.js';
import { FLAT_LIGHT, LIT_LIGHT, PRESETS, sunDirection } from '../shared/light.js';
import { createWalk } from './walk.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), msg = $('msg');
const say = (text) => { msg.textContent = text; msg.style.display = text ? 'flex' : 'none'; };

const SKY_Z = 1200;           // 空の粒を置く距離（m）
const EDGE_MAX = 7;           // 境界からの距離をここまで数える（画素）
const EDGE_LOG = 0.1;         // 隣との距離の比がこれ（対数）を超えたら境界
const VIEW_TINTS = [[1, 0.64, 0.23], [0.31, 0.82, 1], [0.78, 0.55, 1], [0.6, 0.9, 0.4]];
const BG = 0x0e120f, BG_HOLES = 0xff00ff;

const LABEL_EDGE_MAX = 12;    // 種類・物体の境目からの距離をここまで数える（画素）

// 粒の色のもと。painted* は絵画化の結果、ほかはプレビズの下絵。fallback は、その絵が無い視点で代わりに使うもの。
// light は「その絵がどんな光で描かれたか」の見立て（光を付け替えるときの基準）。
const SOURCES = {
  painted: { file: (n) => `/files/paint-out/${n}_painted.png`, fallback: 'previz', light: 'flat', name: '最初の絵' },
  painted_flat: { file: (n) => `/files/paint-out/${n}_painted_flat.png`, fallback: 'flat', light: 'flat', name: '光の少ない絵' },
  painted_lit: { file: (n) => `/files/paint-out/${n}_painted_lit.png`, fallback: 'lit', light: 'lit', name: '影つきの絵' },
  previz: { key: 'color', fallback: null, light: 'flat', name: 'プレビズの色' },
  flat: { key: 'flat', fallback: 'previz', light: 'flat', name: '下絵（光なし）' },
  lit: { key: 'lit', fallback: 'previz', light: 'lit', name: '下絵（影つき）' },
};
const PAINT_LIGHTS = { flat: FLAT_LIGHT, lit: LIT_LIGHT };

const ui = { colorSrc: 'previz', source: 'all', nav: 'orbit', mode: 'color', stride: 2, order: 'sort', paintLight: 'flat' };
// いまの光。方位・高さは度。色は sRGB の #rrggbb。bands は明暗の段階の数（0 = なめらか）。maxGain は明るくする上限（倍）。
const light = { azimuth: PAINT_SUN.azimuth, elevation: PAINT_SUN.elevation, sun: LIT_LIGHT.sun, sunColor: '#ffffff', sky: LIT_LIGHT.ambient, skyColor: '#ffffff', bands: 0, maxGain: 4 };
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

async function tryImage(url, w, h) { try { return await loadImage(url, w, h); } catch { return null; } }

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
    // 粒の色のもと（ある物だけ）
    const colors = {};
    for (const [key, src] of Object.entries(SOURCES)) {
      if (src.file) colors[key] = key in st && !st[key] ? null : await tryImage(src.file(v.name), W, H); // /api/state が「無い」と言う絵は読みに行かない
      else colors[key] = v[src.key] ? await tryImage(`/files/previz-export/${v[src.key]}`, W, H) : null;
    }
    if (!colors.previz) throw new Error(`/files/previz-export/${v.color} を読めませんでした`);
    // 札（種類・物体・面の向き・描いたときの日なた）。古い書き出しには無いので、無ければ null。
    const lab = {};
    for (const key of ['type', 'object', 'normal', 'sun']) lab[key] = v[key] ? await tryImage(`/files/previz-export/${v[key]}`, W, H) : null;
    const hasLabels = !!(lab.type && lab.object && lab.normal && lab.sun);
    const type = new Uint8Array(W * H), object = new Uint16Array(W * H);
    if (hasLabels) for (let i = 0; i < W * H; i++) { type[i] = lab.type[i * 4]; object[i] = lab.object[i * 4] * 256 + lab.object[i * 4 + 1]; }
    views.push({
      def: v, W, H, z, edge: edgeDistance(z, W, H), near, far,
      colors, hasLabels, type, object, normalPx: hasLabels ? lab.normal : null, sunPx: hasLabels ? lab.sun : null,
      labelEdge: hasLabels ? labelEdgeDistance(type, object, W, H) : null,
      onlyNew: st.new_mask ? await loadImage(`/files/paint-out/${v.name}_new.png`, W, H) : null, // 穴埋めで足した視点：白い画素だけ粒にする
      matrix: new THREE.Matrix4().set(...v.extrinsics.camera_to_world.flat()),
    });
  }
  return { cams, views, hasLabels: views.every((v) => v.hasLabels) };
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

// 種類か物体が隣と違う画素（札の境目）からの距離（画素、LABEL_EDGE_MAX まで）。絵と札がずれやすいのはこの近く。
function labelEdgeDistance(type, object, W, H) {
  const d = new Uint8Array(W * H).fill(LABEL_EDGE_MAX);
  const differs = (i, j) => type[i] !== type[j] || object[i] !== object[j];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x + 1 < W && differs(i, i + 1)) d[i] = d[i + 1] = 0;
    if (y + 1 < H && differs(i, i + W)) d[i] = d[i + W] = 0;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
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
// 粒が持つ列の一覧。列を足すときはここに1行足す。
// 知らない名前の列は無視し、渡されなかった列は default で埋める。
export const COLUMNS = {
  position: { type: Float32Array, size: 3, default: 0 }, // ワールド座標（m）
  size: { type: Float32Array, size: 1, default: 0 },     // 粒の間隔（m）。描くときに「粒の大きさ」を掛ける
  color: { type: Uint8Array, size: 3, default: 128 },    // 絵の色（sRGB）
  edge: { type: Uint8Array, size: 1, default: EDGE_MAX }, // 奥行きの境界からの距離（画素）
  sky: { type: Uint8Array, size: 1, default: 0 },        // 1 = 空（奥行きが無い画素）
  view: { type: Uint8Array, size: 1, default: 0 },       // どの視点（や穴埋めの回）から来たか
  depthGray: { type: Uint8Array, size: 1, default: 0 },  // 奥行き表示用の明るさ
  type: { type: Uint8Array, size: 1, default: 0 },       // 種類の札（shared/labels.js の TYPES の id）。0 = 空
  object: { type: Uint16Array, size: 1, default: 0 },    // 物体の札（cameras.json の labels.objects の id）。0 = 物体なし
  normal: { type: Int8Array, size: 3, default: 0 },      // 面の向き（ワールド座標、-127〜127）
  sunVis0: { type: Uint8Array, size: 1, default: 255 },  // 描いたときの日なた（255）・影（0）
  sunNow: { type: Uint8Array, size: 1, default: 255 },   // いまの太陽での日なた・影（太陽を動かすたびに計算し直す）
  sway: { type: Uint8Array, size: 1, default: 0 },       // 揺れやすさ（0〜255）。いまは種類ごとに一律
  labelEdge: { type: Uint8Array, size: 1, default: LABEL_EDGE_MAX }, // 札の境目からの距離（画素）
  lift: { type: Float32Array, size: 1, default: 0.05 },  // 影を調べるときに面から浮かせる量（m）。奥行きの刻みの粗さ
};
const TYPE_BY_ID = new Map(TYPES.map((t) => [t.id, t]));
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
// 視点 v で、色のもと src の絵を返す。無ければ fallback をたどる。
function colorOf(v, src) { for (let key = src; key; key = SOURCES[key].fallback) if (v.colors[key]) return { key, px: v.colors[key] }; return { key: 'previz', px: v.colors.previz }; }

function splatsFromView(v, vi, stride, src) {
  const { W, H, z, edge, near, far } = v, { fx, fy, cx, cy } = v.def.intrinsics;
  const max = Math.ceil(W / stride) * Math.ceil(H / stride);
  const col = { position: new Float32Array(max * 3), size: new Float32Array(max), color: new Uint8Array(max * 3), edge: new Uint8Array(max), sky: new Uint8Array(max), view: new Uint8Array(max).fill(vi), depthGray: new Uint8Array(max) };
  if (v.hasLabels) Object.assign(col, { type: new Uint8Array(max), object: new Uint16Array(max), normal: new Int8Array(max * 3), sunVis0: new Uint8Array(max), sway: new Uint8Array(max), labelEdge: new Uint8Array(max), lift: new Float32Array(max) });
  const px = colorOf(v, src).px, p = new THREE.Vector3(), off = stride >> 1, zStep = (1 / near - 1 / far) / 65535;
  let k = 0;
  for (let y = off; y < H; y += stride) for (let x = off; x < W; x += stride) {
    const i = y * W + x, sky = z[i] === 0, zz = sky ? SKY_Z : z[i];
    if (v.onlyNew && v.onlyNew[i * 4] < 128) continue;
    p.set((x + 0.5 - cx) / fx * zz, -(y + 0.5 - cy) / fy * zz, -zz).applyMatrix4(v.matrix);
    col.position[k * 3] = p.x; col.position[k * 3 + 1] = p.y; col.position[k * 3 + 2] = p.z;
    col.size[k] = zz * stride / fy;
    col.color[k * 3] = px[i * 4]; col.color[k * 3 + 1] = px[i * 4 + 1]; col.color[k * 3 + 2] = px[i * 4 + 2];
    col.depthGray[k] = sky ? 0 : Math.max(0, Math.min(255, (1 - Math.log(zz / near) / Math.log(far / near)) * 255));
    col.edge[k] = edge[i]; col.sky[k] = sky ? 1 : 0;
    if (v.hasLabels) { // 札は、絵と同じ画素からそのまま引き継ぐ
      const t = v.type[i];
      col.type[k] = t; col.object[k] = v.object[i];
      for (let c = 0; c < 3; c++) col.normal[k * 3 + c] = Math.round((v.normalPx[i * 4 + c] / 127.5 - 1) * 127);
      col.sunVis0[k] = v.sunPx[i * 4];
      col.sway[k] = Math.round(((TYPE_BY_ID.get(t) || {}).sway || 0) * 255);
      col.labelEdge[k] = v.labelEdge[i];
      col.lift[k] = 0.05 + zz * zz * zStep;
    }
    k++;
  }
  return { columns: col, count: k };
}
function buildCloud() {
  const parts = data.views.map((v, vi) => splatsFromView(v, vi, ui.stride, ui.colorSrc));
  const c = makeCloud(parts.reduce((s, p) => s + p.count, 0));
  for (const p of parts) appendSplats(c, p.columns, p.count);
  return c;
}

const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });

// 表示の種類ごとに、粒 i の色（リニア）を out に入れる。表示を足すときはここに足す。
const TYPE_LIN = new Map(TYPES.map((t) => [t.id, hexToRgb(t.color).map((v) => LIN[v])]));
const LIGHT_KIND = new Map(TYPES.map((t) => [t.id, t.light])); // 'sun' / 'sky' / 'self'
const gray = (out, v) => { out[0] = out[1] = out[2] = v; };
const painted = (c, i, out) => { out[0] = LIN[c.color[i * 3]]; out[1] = LIN[c.color[i * 3 + 1]]; out[2] = LIN[c.color[i * 3 + 2]]; };
const luma = (c, i) => 0.2126 * LIN[c.color[i * 3]] + 0.7152 * LIN[c.color[i * 3 + 1]] + 0.0722 * LIN[c.color[i * 3 + 2]];

// 光を付け替えるときに毎回使う値。refill の前に prepareLight() で作る。
const L = { dir: [0, 1, 0], dir0: [0, 1, 0], sun: [1, 1, 1], sky: [1, 1, 1], skyGain: [1, 1, 1], paint: FLAT_LIGHT, bands: 0, maxGain: 4 };
function prepareLight() {
  L.dir = sunDirection(light.azimuth, light.elevation);
  const pl = data && data.cams.paint_light;
  L.dir0 = pl ? pl.sun_direction : sunDirection(PAINT_SUN.azimuth, PAINT_SUN.elevation);
  L.sun = hexToRgb(light.sunColor).map((v) => LIN[v] * light.sun);
  L.sky = hexToRgb(light.skyColor).map((v) => LIN[v] * light.sky);
  L.skyGain = L.sky.map((v) => v / LIT_LIGHT.ambient); // 空そのものは、空の光の色と強さだけで動かす
  L.paint = PAINT_LIGHTS[ui.paintLight];
  L.bands = light.bands; L.maxGain = light.maxGain;
}
// 粒 i が、いまの太陽で照らされる度合い（0〜1）。面の向きと影の両方を掛けたもの。
function sunAmount(c, i, dir, vis) {
  const nd = (c.normal[i * 3] * dir[0] + c.normal[i * 3 + 1] * dir[1] + c.normal[i * 3 + 2] * dir[2]) / 127;
  return nd > 0 ? nd * vis[i] / 255 : 0;
}
// 光を変えた後の色 = 絵の色 × いまの明るさ ÷ 描いたときの明るさ（式は shared/light.js）。
function relit(c, i, out) {
  painted(c, i, out);
  const kind = LIGHT_KIND.get(c.type[i]);
  if (kind === 'self') return;
  if (kind === 'sky') { out[0] *= L.skyGain[0]; out[1] *= L.skyGain[1]; out[2] *= L.skyGain[2]; return; }
  const h = 0.8 + 0.2 * c.normal[i * 3 + 1] / 127;
  const before = Math.max(0.05, L.paint.ambient * h + L.paint.sun * sunAmount(c, i, L.dir0, c.sunVis0));
  let d = sunAmount(c, i, L.dir, c.sunNow);
  if (L.bands) d = Math.round(d * L.bands) / L.bands; // 明暗を段階に分ける（絵の具の色数を絞る感じ）
  for (let k = 0; k < 3; k++) out[k] *= Math.min(L.maxGain, (L.sky[k] * h + L.sun[k] * d) / before);
}

const DISPLAY = {
  color: painted,                                                                                     // 絵のままの色
  relit,                                                                                              // 光を変えた後
  depth: (c, i, out) => gray(out, LIN[c.depthGray[i]]),                                               // 奥行き
  view: (c, i, out) => {                                                                              // 視点別
    const t = VIEW_TINTS[c.view[i] % VIEW_TINTS.length], l = 0.25 + 0.75 * luma(c, i);
    out[0] = LIN[t[0] * 255 | 0] * l; out[1] = LIN[t[1] * 255 | 0] * l; out[2] = LIN[t[2] * 255 | 0] * l;
  },
  type: (c, i, out) => { const t = TYPE_LIN.get(c.type[i]) || [1, 0, 1]; out[0] = t[0]; out[1] = t[1]; out[2] = t[2]; }, // 種類
  typeMix: (c, i, out) => {                                                                           // 種類を絵に重ねる
    const t = TYPE_LIN.get(c.type[i]) || [1, 0, 1]; painted(c, i, out);
    for (let k = 0; k < 3; k++) out[k] = out[k] * 0.5 + t[k] * 0.5;
  },
  object: (c, i, out) => { const t = objectColor(c.object[i]); out[0] = LIN[t[0]]; out[1] = LIN[t[1]]; out[2] = LIN[t[2]]; }, // 物体
  normal: (c, i, out) => {                                                                            // 面の向き
    if (!c.object[i]) return gray(out, 0.02);
    for (let k = 0; k < 3; k++) out[k] = LIN[Math.round(c.normal[i * 3 + k] / 127 * 127.5 + 127.5)];
  },
  sun0: (c, i, out) => (c.object[i] ? gray(out, 0.03 + 0.97 * sunAmount(c, i, L.dir0, c.sunVis0)) : gray(out, 0.3)),   // 描いたときの日なた
  sunNow: (c, i, out) => (c.object[i] ? gray(out, 0.03 + 0.97 * sunAmount(c, i, L.dir, c.sunNow)) : gray(out, 0.3)),   // いまの日なた
  labelEdge: (c, i, out) => {                                                                         // 札の境目の近く
    painted(c, i, out);
    const k = 1 - Math.min(1, c.labelEdge[i] / 6); // 境目に近いほど赤く
    out[0] = out[0] * (1 - k) + k; out[1] *= 1 - k; out[2] *= 1 - k;
  },
};
const NEEDS_LABELS = new Set(['relit', 'type', 'typeMix', 'object', 'normal', 'sun0', 'sunNow', 'labelEdge']);

// いまの太陽の向きで、粒ごとの日なた・影を計算し直す。プレビズの形を太陽から見た奥行きの地図を作り、粒ごとに比べる。
let sunBusy = false, sunDirty = false;
async function updateSun() {
  if (sunBusy) { sunDirty = true; return; }
  sunBusy = true;
  try {
    do {
      sunDirty = false;
      const a = app, c = cloud; if (!a || !c || !data.hasLabels) break;
      const t0 = performance.now(), dir = sunDirection(light.azimuth, light.elevation);
      const map = await renderSunMap(a.renderer, a.previz, a.labels, dir);
      if (a !== app || c !== cloud) break; // 待っている間に作り直された
      const { n, position: P, normal: N, lift, sunNow } = c;
      for (let i = 0; i < n; i++) {
        sunNow[i] = c.object[i] ? Math.round(255 * sunVisibility(map, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3] / 127, N[i * 3 + 1] / 127, N[i * 3 + 2] / 127, lift[i])) : 255;
      }
      a.sunMap = map;
      $('sSun').textContent = `${Math.round(performance.now() - t0)} ms`;
      refill();
    } while (sunDirty);
  } catch (e) { console.error(e); } finally { sunBusy = false; }
}

// 描画用は vec4 を3本にまとめる（WebGPU は頂点バッファの本数に上限があるため、列ごとに分けない）。
//   A = [位置 xyz, 粒の間隔]  B = [表示する色 rgb, 境界からの距離]  C = [空, 視点, 空き, 空き]
// 遠い順（視点からの距離）に並べ直すのは別の糸（studio/sortworker.js）で行い、描画は止めない。
// ここでは、粒の元の並びのまま描画用の値を作って渡す（表示・光・粒を変えたときだけ）。
function sendSource() {
  const a = app, c = cloud; if (!a || !c) return;
  const n = c.n, P = new Float32Array(n * 4), B = new Float32Array(n * 4), C = new Float32Array(n * 4);
  prepareLight();
  const display = DISPLAY[ui.mode] || DISPLAY.color, rgb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    P[o] = c.position[i * 3]; P[o + 1] = c.position[i * 3 + 1]; P[o + 2] = c.position[i * 3 + 2]; P[o + 3] = c.size[i];
    display(c, i, rgb);
    B[o] = rgb[0]; B[o + 1] = rgb[1]; B[o + 2] = rgb[2]; B[o + 3] = c.edge[i];
    C[o] = c.sky[i]; C[o + 1] = c.view[i];
  }
  a.sorter.worker.postMessage({ type: 'source', P, B, C }, [P.buffer, B.buffer, C.buffer]);
}
// 並べ直しの係。終わった配列を描画用の値と入れ替え、外した方を次の並べ直しの書き込み先に回す。
function makeSorter(a, n) {
  const worker = new Worker(new URL('./sortworker.js', import.meta.url), { type: 'module' });
  const s = { worker, busy: false, pending: null, spare: [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)], done: 0 };
  s.sort = (eye) => { // eye = [x, y, z]
    if (s.busy || !s.spare) { s.pending = eye; return; }
    s.busy = true; const [A, B, C] = s.spare; s.spare = null;
    worker.postMessage({ type: 'sort', eye, A, B, C }, [A.buffer, B.buffer, C.buffer]);
  };
  worker.onmessage = (e) => {
    const m = e.data;
    if (!m.empty) {
      s.spare = [a.attrA.array, a.attrB.array, a.attrC.array];
      a.attrA.array = m.A; a.attrB.array = m.B; a.attrC.array = m.C;
      a.attrA.needsUpdate = a.attrB.needsUpdate = a.attrC.needsUpdate = true;
      s.done++;
      $('sSort').textContent = `${Math.round(m.ms)} ms（描画とは別の糸）`;
    } else s.spare = [m.A, m.B, m.C];
    s.busy = false;
    if (s.pending) { const p = s.pending; s.pending = null; s.sort(p); }
  };
  worker.onerror = (e) => { console.error(e); say('並べ直しの準備に失敗しました：' + (e.message || '')); };
  return s;
}
// 並べ直しを頼む。「並べ直す」では今のカメラ、「固定」「不透明」では最初の視点（カメラA）から。
function orderEye() {
  const a = app;
  if (ui.order === 'sort') return a.camera.position.toArray();
  return new THREE.Vector3().setFromMatrixPosition(data.views[0].matrix).toArray();
}
function requestSort() { const a = app; if (!a) return; const e = orderEye(); a.sortEye.fromArray(e); a.sorter.sort(e); }

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
  const keep = app ? { pos: app.camera.position.clone(), quat: app.camera.quaternion.clone(), target: app.controls.target.clone(), feet: app.walk.wk.feet.slice() } : null;
  if (app) { app.sorter.worker.terminate(); app.renderer.setAnimationLoop(null); app.controls.dispose(); app.renderer.domElement.remove(); app.renderer.dispose(); app = null; }

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
    sortEye: new THREE.Vector3(Infinity, 0, 0), yaw: 0, pitch: 0,
  };
  a.sorter = makeSorter(a, n);
  a.mats = makeMaterials(a);
  a.sprite = new THREE.Sprite(a.mats.soft);
  a.sprite.count = n; a.sprite.frustumCulled = false; a.sprite.renderOrder = 1;
  scene.add(a.sprite);

  // 確かめ用：プレビズの形（線）と、書き出しカメラの視錐台
  a.wire = new THREE.Group();
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5, depthTest: false });
  a.previz = buildScene(); a.labels = labelScene(a.previz); // 太陽を動かしたときの影の計算にも使う
  a.walk = createWalk(scene, a.labels.solids, a.labels.objects); // 歩くときの当たり判定（プレビズの形そのもの）
  a.walk.setEye(Number($('eye').value)); a.walk.setSpeed(Number($('speed').value)); a.walk.wk.noclip = !$('collide').checked;
  a.previz.traverse((o) => { if (o.isMesh && o.name !== 'ground') { const m = new THREE.Mesh(o.geometry, wireMat); o.updateWorldMatrix(true, false); m.applyMatrix4(o.matrixWorld); m.renderOrder = 2; a.wire.add(m); } });
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
  if (keep && keep.feet) a.walk.place(...keep.feet); else placeAtCamera();

  sendSource(); requestSort();
  applyUi();
  await updateSun();

  const gpu = !!(renderer.backend && renderer.backend.isWebGPUBackend);
  $('sBackend').textContent = gpu ? 'WebGPU' : 'WebGL 2';
  $('swap').textContent = gpu ? 'WebGL 2 で描き直す' : 'WebGPU で描き直す';
  $('sCount').textContent = `${(n / 10000).toFixed(1)} 万粒`;
  const used = data.views.map((v) => colorOf(v, ui.colorSrc).key), missing = used.filter((k) => k !== ui.colorSrc).length;
  $('srcNote').textContent = missing ? `「${SOURCES[ui.colorSrc].name}」が無い視点が ${missing} / ${data.views.length} あります。その視点は「${SOURCES[used.find((k) => k !== ui.colorSrc)].name}」で置いています。` : '';
  $('srcNote').classList.toggle('warn', missing > 0);
  $('labelNote').hidden = data.hasLabels;

  layout(); say('');
  let frames = 0, t0 = performance.now(), last = t0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (ui.nav === 'walk') walkStep(dt); else controls.update();
    if (ui.order === 'sort' && !a.sorter.busy && camera.position.distanceToSquared(a.sortEye) > 0.09) requestSort(); // 0.3 m 動いたら、前の並べ直しが終わっていれば次を頼む
    renderer.render(scene, camera);
    if (++frames >= 30) {
      $('sFps').textContent = Math.round(frames * 1000 / (now - t0)) + ' fps'; frames = 0; t0 = now;
      const p = camera.position; $('sPos').textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} m`;
      $('sFoot').textContent = a.walk.status();
    }
  });
  starting = false;
  window.__splat = { app: a, cloud, data, ui, light, setLight, backend: gpu ? 'webgpu' : 'webgl2', jump, sunBusy: () => sunBusy,
    // 確かめ用：表示 mode での全粒の色（リニア）を返す
    colorsFor(mode) { prepareLight(); const out = new Float32Array(cloud.n * 3), rgb = [0, 0, 0]; for (let i = 0; i < cloud.n; i++) { DISPLAY[mode](cloud, i, rgb); out.set(rgb, i * 3); } return out; } };
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
  a.walk.shapes.visible = $('shapes').checked;
  a.walk.me.visible = ui.nav === 'walk' ? $('third').checked : $('shapes').checked; // 自分の体は、後ろから見るときと、回して見るときに当たりの形を出しているとき
  $('walkBox').hidden = ui.nav !== 'walk';
  $('hint').textContent = ui.nav === 'walk'
    ? (a.walk.wk.noclip ? '画面をクリックで視線を動かす（Esc で解除）・ W A S D で飛ぶ ・ E で上 ・ Q で下 ・ Shift で速く'
      : '画面をクリックで視線を動かす（Esc で解除）・ W A S D か矢印で歩く ・ Shift で走る ・ Space で跳ぶ')
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
// 歩く人を、いまのカメラの真下の床に置く
function placeAtCamera() {
  const a = app, c = a.camera.position;
  a.walk.place(c.x, c.y - a.walk.wk.p.eye, c.z);
}
function setNav(v) {
  const a = app; ui.nav = v; if (!a) return;
  if (v === 'walk') { syncAngles(); placeAtCamera(); }
  else {
    if (document.pointerLockElement) document.exitPointerLock();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(a.camera.quaternion);
    a.controls.target.copy(a.camera.position).addScaledVector(fwd, 40);
  }
  applyUi();
}

const keys = new Set();
const THIRD_BACK = 4, THIRD_UP = 0.6; // 後ろから見るときのカメラの位置（m）
let jumpQueued = false;
function walkStep(dt) {
  const a = app;
  a.camera.quaternion.setFromEuler(new THREE.Euler(a.pitch, a.yaw, 0, 'YXZ'));
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  a.walk.update(dt, {
    forward: f, right: r, yaw: a.yaw, run: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    jump: jumpQueued, up: keys.has('KeyE') || keys.has('Space'), down: keys.has('KeyQ'),
  });
  jumpQueued = false;
  const wk = a.walk.wk;
  a.camera.position.set(wk.feet[0], wk.eyeY, wk.feet[2]);
  if ($('third').checked) { // 後ろから見る：自分の体と当たりの様子を確かめる用
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(a.camera.quaternion);
    a.camera.position.addScaledVector(back, THIRD_BACK).y += THIRD_UP;
  }
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
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); // Space でボタンが押されないように
  const req = e.target.requestPointerLock && e.target.requestPointerLock();
  if (req && req.catch) req.catch(() => {}); // 使えない場合はドラッグで見回す
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => { if (document.pointerLockElement || dragging) look(e.movementX, e.movementY); });
window.addEventListener('keydown', (e) => {
  const t = e.target; // 文字を打つ欄では歩かない。チェックやつまみに触った後でも、すぐ歩けるようにする
  if (ui.nav !== 'walk' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/^(checkbox|range|radio|color)$/.test(t.type))) return;
  keys.add(e.code);
  if (e.code === 'Space' && !e.repeat) jumpQueued = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
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
  // 色のもと：どの視点にも無い絵は選べなくする。いま選んでいる絵が無くなっていたら、ある絵へ移す。
  const has = (key) => data.views.some((v) => v.colors[key]);
  for (const b of SRC_BUTTONS()) b.disabled = !has(b.dataset.v);
  if (!has(ui.colorSrc) || !setupViewButtons.done) ui.colorSrc = ['painted_flat', 'painted_lit', 'painted', 'previz'].find(has);
  setupViewButtons.done = true;
  setColorSrc(ui.colorSrc, false);
  for (const b of $('mode').children) b.disabled = NEEDS_LABELS.has(b.dataset.v) && !data.hasLabels;
  if (NEEDS_LABELS.has(ui.mode) && !data.hasLabels) { ui.mode = 'color'; press($('mode'), ui.mode); }
  $('lightBox').hidden = !data.hasLabels;
}
const SRC_BUTTONS = () => [...$('colorSrc').children, ...$('colorSrc2').children];
function setColorSrc(v, andRebuild = true) {
  ui.colorSrc = v;
  for (const b of SRC_BUTTONS()) b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
  ui.paintLight = SOURCES[v].light; press($('paintLight'), ui.paintLight); // その絵が描かれたときの光の見立て
  if (andRebuild) rebuild();
}
const refill = () => { if (app) { sendSource(); requestSort(); } };
const rebuild = () => { press($('stride'), ui.stride); start(forceGL).catch(fail); };

// ---- 光の操作 ----
const LIGHT_INPUTS = { sunAz: 'azimuth', sunEl: 'elevation', sunK: 'sun', skyK: 'sky', bands: 'bands', maxGain: 'maxGain' };
function showLight() { // light の値を、つまみと数字に写す
  for (const [id, key] of Object.entries(LIGHT_INPUTS)) $(id).value = light[key];
  $('sunColor').value = light.sunColor; $('skyColor').value = light.skyColor;
  $('oSunAz').textContent = `${Math.round(light.azimuth)}°`; $('oSunEl').textContent = `${Math.round(light.elevation)}°`;
  $('oSunK').textContent = light.sun.toFixed(2); $('oSkyK').textContent = light.sky.toFixed(2);
  $('oBands').textContent = light.bands ? `${light.bands} 段` : 'なめらか';
  $('oMaxGain').textContent = `${light.maxGain.toFixed(1)} 倍まで`;
}
function setLight(values, sunMoved) {
  Object.assign(light, values); showLight();
  if (ui.mode === 'color') { ui.mode = 'relit'; press($('mode'), ui.mode); } // 光を触ったら、変えた後の色を見せる
  if (sunMoved) updateSun(); else refill();
}
for (const [id, key] of Object.entries(LIGHT_INPUTS)) {
  $(id).addEventListener('input', () => setLight({ [key]: Number($(id).value) }, key === 'azimuth' || key === 'elevation'));
}
for (const id of ['sunColor', 'skyColor']) $(id).addEventListener('input', () => setLight({ [id]: $(id).value }, false));
$('preset').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.v === 'paint') { // 描いたときの光：「影つき」の絵なら、絵のままの色に戻るはずの設定
    const pl = data && data.cams.paint_light;
    setLight({ azimuth: pl ? pl.sun_azimuth_deg : PAINT_SUN.azimuth, elevation: pl ? pl.sun_elevation_deg : PAINT_SUN.elevation, sun: LIT_LIGHT.sun, sunColor: '#ffffff', sky: LIT_LIGHT.ambient, skyColor: '#ffffff' }, true);
  } else {
    const p = PRESETS[b.dataset.v];
    setLight({ azimuth: p.azimuth, elevation: p.elevation, sun: p.sun, sunColor: p.sunColor, sky: p.sky, skyColor: p.skyColor }, true);
  }
});
seg('paintLight', (v) => { ui.paintLight = v; refill(); });

for (const id of ['colorSrc', 'colorSrc2']) $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) setColorSrc(b.dataset.v); });
seg('source', (v) => { ui.source = v; applyUi(); });
seg('nav', setNav);
seg('mode', (v) => { ui.mode = v; refill(); });
seg('stride', (v) => { ui.stride = Number(v); rebuild(); });
seg('order', (v) => {
  ui.order = v; if (!app) return;
  requestSort(); applyUi();
});
$('jump').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { jump(b.dataset.v); if (ui.nav === 'walk') placeAtCamera(); } });
for (const id of ['size', 'edge']) $(id).addEventListener('input', applyUi);
for (const id of ['holes', 'wire', 'frusta', 'sky', 'shapes', 'third']) $(id).addEventListener('change', applyUi);
// 歩き方の操作
function showWalk() { $('oEye').textContent = `${Number($('eye').value).toFixed(2)} m`; $('oSpeed').textContent = `${Number($('speed').value).toFixed(1)} m/s`; }
$('eye').addEventListener('input', () => { showWalk(); if (app) app.walk.setEye(Number($('eye').value)); });
$('speed').addEventListener('input', () => { showWalk(); if (app) app.walk.setSpeed(Number($('speed').value)); });
$('collide').addEventListener('change', () => {
  if (!app) return;
  const wk = app.walk.wk; wk.noclip = !$('collide').checked;
  if (!wk.noclip) { const c = wk.feet; app.walk.place(c[0], c[1], c[2]); } // 当たりを戻したら、真下の床へ降ろす
  applyUi();
});
showWalk();
$('reload').addEventListener('click', () => { data = null; rebuild(); });
$('swap').addEventListener('click', () => start(!forceGL).catch(fail));
new ResizeObserver(layout).observe(stage);

press($('stride'), ui.stride);
showLight();
start(forceGL).catch(fail);
