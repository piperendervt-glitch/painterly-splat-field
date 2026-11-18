// 粒の空間：書き出した奥行き・カメラ情報と、絵（絵画 or プレビズの色）から、1画素を1粒として3D空間に置いて見る。
// 置き方は cameras.json の projection のとおり。プレビズの形そのものは使わない（線で重ねる確かめ用を除く）。
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, uniform, uv, vec2, vec3, vec4, float, step, exp, mix, max, abs, fract, sqrt, atan, dot, clamp, cameraViewMatrix, varying } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene, PAINT_SUN } from '../previz/scene.js';
import { labelScene, renderSunMap, sunVisibility } from '../previz/gbuffer.js';
import { TYPES, SKY_TYPE, hexToRgb, objectColor, typeByKey } from '../shared/labels.js';
import { parsePly, checkSharp, sharpScale, splatsFromSharp, sharpGrid, sharpBack, sharpBackSplats } from './sharp.js';
import { SIGMA_K, BACK_RING, BACK_BEHIND, surfelCov, roundCov, viewNormal, frontTable, backLayer, backSplats, plateRequest, withPlate, refineBackDepth, gridToPixels } from './layers.js';
import { FLAT_LIGHT, LIT_LIGHT, PRESET_HOURS, dayLight, sunDirection } from '../shared/light.js';
import { createWalk } from './walk.js';
import { backgroundMesh, objectBoxes, toObj } from './estimate.js';
import { createFx, KIND, SUN_MAP_SIZE } from './fx.js';
import { AI_W, AI_H, FACE, buildSkyMap, colorDome, domeDirections, faceCamera, faceHoles, fillSky, pasteFace, renderFace, sampleMap, skyDistance, skyNoise, withAi } from './skydome.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), msg = $('msg');
const say = (text) => { msg.textContent = text; msg.style.display = text ? 'flex' : 'none'; };

const SKY_Z = 1200;           // 空の置き方が「遠くの壁」のときに、空の粒を置く距離（m）
const SKY_R = 3000;           // 天球の半径（m）。天球はいつもカメラを中心に置くので、空は無限に遠く見える
const SKY_SIZE = 1.4;         // 天球の粒は、すき間から背景が透けないよう少し大きく描く
const EDGE_MAX = 7;           // 境界からの距離をここまで数える（画素）
const EDGE_LOG = 0.1;         // 隣との距離の比がこれ（対数）を超えたら境界
const VIEW_TINTS = [[1, 0.64, 0.23], [0.31, 0.82, 1], [0.78, 0.55, 1], [0.6, 0.9, 0.4]];
const BG = 0x0e120f, BG_HOLES = 0xff00ff;

const LABEL_EDGE_MAX = 12;    // 種類・物体の境目からの距離をここまで数える（画素）

// 粒の色のもと。painted* は絵画化の結果、ほかはプレビズの下絵。fallback は、その絵が無い視点で代わりに使うもの。
// light は「その絵がどんな光で描かれたか」の見立て（光を付け替えるときの基準）。
const SOURCES = {
  painted: { file: (n) => `/files/paint-out/${n}_painted.png`, fallback: 'previz', light: 'flat', name: '最初の絵', sfx: '', paint: 'free' },
  painted_flat: { file: (n) => `/files/paint-out/${n}_painted_flat.png`, fallback: 'flat', light: 'flat', name: '光の少ない絵', sfx: '_flat', paint: 'flat' },
  painted_lit: { file: (n) => `/files/paint-out/${n}_painted_lit.png`, fallback: 'lit', light: 'lit', name: '影つきの絵', sfx: '_lit', paint: 'previz' },
  previz: { key: 'color', fallback: null, light: 'flat', name: 'プレビズの色', sfx: '', paint: 'free' },
  flat: { key: 'flat', fallback: 'previz', light: 'flat', name: '下絵（光なし）', sfx: '_flat', paint: 'flat' },
  lit: { key: 'lit', fallback: 'previz', light: 'lit', name: '下絵（影つき）', sfx: '_lit', paint: 'previz' },
};
// sfx は、AI が描いた空の絵（paint/out/sky_ai<sfx>.png）の名前の後ろ。paint は、空を描いてもらうときの光の描かせ方（paint.mjs の --light）。
const PAINT_LIGHTS = { flat: FLAT_LIGHT, lit: LIT_LIGHT };

const ui = { colorSrc: 'previz', source: 'all', nav: 'orbit', mode: 'color', stride: 2, order: 'sort', paintLight: 'flat', placement: 'depth', sharpFit: true, shape: 'surfel', stretch: 16, back: true, halo: 3, plate: true, backDepth: 'plate', walkShape: 'auto', surround: true, surroundFill: true, surroundAi: true, skyMode: 'dome', skyStep: 0.2 };
// 角度を変えたときの崩れを減らす設定（計算は studio/layers.js）：shape = 粒の形（round 丸 / surfel 面に沿う楕円）、stretch = 面に沿って伸ばす上限（倍）、
// back = 手前の物の後ろに背景の層を作る、halo = 物のまわり何画素を背景の色で塗り直すか、plate = 背後の層の色に、AI が描いた背景の絵（あれば）を使う、
// surround = 絵の外の地面（周囲の地面）を置く、surroundFill = その穴をツール内の計算で埋める、surroundAi = AI が描いた地面（あれば）を使う
// walkShape = 歩くときの当たりの形（auto = プレビズのある場面はプレビズ、絵から作った場面は推定 / previz / estimate）
// backDepth = 背後の層の位置（calc 計算で延ばす / plate AI が描いた背景の絵を SHARP に通した奥行き。あれば）
// 粒の置き方：depth = 奥行きの絵から 1 画素 1 粒、sharp = SHARP の .ply（<視点>_sharp.ply）、both = 両方を重ねる

// 実在の絵から作った場面（painting/build.mjs）の種類の名前を、shared/labels.js の種類へ読み替える
const PAINT_TYPE_KEYS = { sky: 'sky', ground: 'grass', water: 'water', figure: 'figure', far: 'far', tree: 'leaves' };
// いまの光。方位・高さは度。色は sRGB の #rrggbb。bands は明暗の段階の数（0 = なめらか）。maxGain は明るくする上限（倍）。
const light = { azimuth: PAINT_SUN.azimuth, elevation: PAINT_SUN.elevation, sun: LIT_LIGHT.sun, sunColor: '#ffffff', sky: LIT_LIGHT.ambient, skyColor: '#ffffff', bands: 0, maxGain: 4 };
const uSize = uniform(2.6), uEdge = uniform(1), uSky = uniform(1), uView = uniform(-1), uShape = uniform(1), uDome = uniform(1);

// 動きと光（風・草よけ・足跡・光の付け替え）をシェーダーで付ける部品。足跡は作り直しても残るよう、ここで1つだけ持つ。
const fx = createFx();
// 時計：hour は時刻（0〜24）、playing で自動で進む、dayLength は1日にかける秒数。manual は光のつまみを手で動かした状態（時刻と無関係）。
const clock = { hour: 12, playing: false, dayLength: 120, manual: true };

let app = null, data = null, cloud = null, starting = false;
const query = new URLSearchParams(location.search);
let forceGL = query.has('gl');
if (['1', '2', '4', '8'].includes(query.get('stride'))) ui.stride = Number(query.get('stride')); // 例：splat.html?stride=4 で粗く始める
if (Number(query.get('skystep')) >= 0.1) ui.skyStep = Number(query.get('skystep'));                 // 例：splat.html?skystep=1 で天球を粗く始める

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

// AI が描いた背景の絵を SHARP に通した粒（<視点>_plate_<色のもと>_sharp.ply）。無ければ null
async function loadPlateSharp(name, key) {
  const res = await fetch(`/files/paint-out/${name}_plate_${key}_sharp.ply`, { cache: 'no-store' });
  if (!res.ok) return null;
  try { const ply = parsePly(await res.arrayBuffer()); checkSharp(ply); return ply; } catch (e) { console.warn(e); return null; }
}
let plateVersion = 0; // AI が描いた背景の絵を読むたびに増やす（作り置きの層を作り直す目印）
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
    // 実在の絵から作った場面は、種類（labels）と物体（objects）だけがあり、種類の番号と物体の色の詰め方が違う。
    const lab = {}, painting = !v.type && !!v.labels;
    for (const key of ['type', 'object', 'normal', 'sun']) lab[key] = v[key] ? await tryImage(`/files/previz-export/${v[key]}`, W, H) : null;
    if (painting) { lab.type = await tryImage(`/files/previz-export/${v.labels}`, W, H); lab.object = v.objects ? await tryImage(`/files/previz-export/${v.objects}`, W, H) : null; }
    const hasTypes = !!(lab.type && lab.object), hasLabels = hasTypes && !!(lab.normal && lab.sun);
    const type = new Uint8Array(W * H), object = new Uint16Array(W * H);
    if (hasTypes && painting) {
      const remap = new Uint8Array(256);
      for (const t of (cams.labels && cams.labels.types) || []) remap[t.id] = PAINT_TYPE_KEYS[t.name] ? typeByKey(PAINT_TYPE_KEYS[t.name]).id : 0;
      for (let i = 0; i < W * H; i++) { type[i] = remap[lab.type[i * 4]]; object[i] = lab.object[i * 4] + lab.object[i * 4 + 1] * 256; }
    } else if (hasTypes) for (let i = 0; i < W * H; i++) { type[i] = lab.type[i * 4]; object[i] = lab.object[i * 4] * 256 + lab.object[i * 4 + 1]; }
    const isSky = new Uint8Array(W * H); // 空の画素：奥行きが無く、札があれば種類も空
    for (let i = 0; i < W * H; i++) isSky[i] = z[i] === 0 && (!hasTypes || type[i] === SKY_TYPE) ? 1 : 0;
    // SHARP の粒（sharp/psf_sharp.py の書き出し）。無ければ null
    let sharp = null;
    if (st.sharp) {
      const res = await fetch(`/files/paint-out/${v.name}_sharp.ply`, { cache: 'no-store' });
      if (res.ok) { sharp = parsePly(await res.arrayBuffer()); checkSharp(sharp); }
    }
    // AI が描いた「手前の物を消した背景の絵」と、そのときの穴の印（色のもとごと。studio/server.mjs の plates）
    const plates = {};
    for (const key of st.plates || []) {
      const px = await tryImage(`/files/paint-out/${v.name}_plate_${key}.png`, W, H), mask = px && await tryImage(`/files/paint-out/${v.name}_platemask_${key}.png`, W, H);
      if (!px || !mask) continue;
      plates[key] = { px, mask, version: ++plateVersion, sharp: null };
      if ((st.plate_sharp || []).includes(key)) plates[key].sharp = await loadPlateSharp(v.name, key); // その絵を SHARP に通した粒（奥行きに使う）
    }
    views.push({
      plates, painting,
      def: v, W, H, z, edge: edgeDistance(z, W, H), near, far, isSky, skyDist: skyDistance(isSky, W, H),
      colors, hasTypes, hasLabels, type, object, normalPx: hasLabels ? lab.normal : null, sunPx: hasLabels ? lab.sun : null,
      labelEdge: hasTypes ? labelEdgeDistance(type, object, W, H) : null, sharp,
      onlyNew: st.new_mask ? await loadImage(`/files/paint-out/${v.name}_new.png`, W, H) : null, // 穴埋めで足した視点：白い画素だけ粒にする
      matrix: new THREE.Matrix4().set(...v.extrinsics.camera_to_world.flat()),
      c2w: v.extrinsics.camera_to_world.flat(), w2c: v.extrinsics.world_to_camera.flat(), // 行ごとに並んだ 4x4（studio/layers.js 用）
    });
  }
  return { cams, views, hasLabels: views.every((v) => v.hasLabels), hasTypes: views.every((v) => v.hasTypes), hasSharp: views.some((v) => v.sharp), skyAiFiles: state.sky_ai || {}, skyAi: {}, skyAiVersion: 0, groundAiFiles: state.ground_ai || {}, groundAi: {}, painting: views.some((v) => v.painting) };
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
  opacity: { type: Uint8Array, size: 1, default: 255 },  // 不透明さ（0〜255）。奥行きから置いた粒は 255、SHARP の粒は SHARP の値
  cov: { type: Float32Array, size: 6, default: 0 },      // 粒の形（共分散 xx, xy, xz, yy, yz, zz。m²）。面に沿う楕円や SHARP の形。「粒の大きさ」が 2.6 倍のときの広がり
  layer: { type: Uint8Array, size: 1, default: 0 },      // 層。0 = 絵に見えていた面、1 = 背後の層（手前の物の後ろに、背景を伸ばして作った粒）
  skyFrom: { type: Uint8Array, size: 1, default: 0 },    // 天球の粒の出どころ（0 = 天球の粒ではない、1 = 絵、2 = AI が描いた空、3 = ツール内で埋めた空）
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
  if (!columns.cov) for (let i = c.n; i < c.n + count; i++) roundCov(c.cov, i * 6, c.size[i] * SIGMA_K); // 形が渡されなければ丸
  for (let i = c.n; i < c.n + count; i++) c.order[i] = i;
  c.n += count;
}

// 1視点ぶんの画素を粒の列にする。置き方は cameras.json の projection のとおり。
// 視点 v で、色のもと src の絵を返す。無ければ fallback をたどる。
function colorOf(v, src) { for (let key = src; key; key = SOURCES[key].fallback) if (v.colors[key]) return { key, px: v.colors[key] }; return { key: 'previz', px: v.colors.previz }; }

// back（studio/layers.js の backLayer の結果）を渡すと、物のまわりの縁の画素は置かない（背後の層の粒が代わりに入る）。
function splatsFromView(v, vi, stride, src, back = null) {
  const { W, H, z, edge, near, far } = v, { fx, fy, cx, cy } = v.def.intrinsics;
  const max = Math.ceil(W / stride) * Math.ceil(H / stride);
  const col = { position: new Float32Array(max * 3), size: new Float32Array(max), color: new Uint8Array(max * 3), edge: new Uint8Array(max), sky: new Uint8Array(max), view: new Uint8Array(max).fill(vi), depthGray: new Uint8Array(max), cov: new Float32Array(max * 6) };
  if (v.hasTypes) Object.assign(col, { type: new Uint8Array(max), object: new Uint16Array(max), sway: new Uint8Array(max), labelEdge: new Uint8Array(max) });
  if (v.hasLabels) Object.assign(col, { normal: new Int8Array(max * 3), sunVis0: new Uint8Array(max), lift: new Float32Array(max) });
  const px = colorOf(v, src).px, p = new THREE.Vector3(), off = stride >> 1, zStep = (1 / near - 1 / far) / 65535;
  const eye = [v.c2w[3], v.c2w[7], v.c2w[11]], nrm = [0, 0, 1], nStep = Math.max(2, stride); // nStep = 面の向きを奥行きから求めるときの画素の間隔
  let k = 0;
  for (let y = off; y < H; y += stride) for (let x = off; x < W; x += stride) {
    const i = y * W + x, sky = z[i] === 0, zz = sky ? SKY_Z : z[i];
    if (sky && ui.skyMode !== 'wall') continue; // 空は天球（下の「空の天球」）が受け持つ
    if (v.onlyNew && v.onlyNew[i * 4] < 128) continue;
    if (back && back.kind[i] === BACK_RING) continue;
    p.set((x + 0.5 - cx) / fx * zz, -(y + 0.5 - cy) / fy * zz, -zz).applyMatrix4(v.matrix);
    col.position[k * 3] = p.x; col.position[k * 3 + 1] = p.y; col.position[k * 3 + 2] = p.z;
    col.size[k] = zz * stride / fy;
    // 形：面に沿う楕円（面の向きは、面の向きの絵か、無ければ奥行きから）。空と、向きが求まらない所は丸
    // 面の向きの絵が無い場面（実在の絵から作った場面）では、手前の物（人・木）は板として置いてあり、奥行きから求めた向きが荒れるので丸のまま
    if (!sky && (v.hasLabels || !v.hasTypes || !FRONT[v.type[i]]) && viewNormal(v, z, x, y, nStep, nrm)) { const rx = p.x - eye[0], ry = p.y - eye[1], rz = p.z - eye[2], rl = Math.hypot(rx, ry, rz); surfelCov(col.cov, k * 6, nrm[0], nrm[1], nrm[2], rx / rl, ry / rl, rz / rl, col.size[k] * SIGMA_K, ui.stretch); }
    else roundCov(col.cov, k * 6, col.size[k] * SIGMA_K);
    col.color[k * 3] = px[i * 4]; col.color[k * 3 + 1] = px[i * 4 + 1]; col.color[k * 3 + 2] = px[i * 4 + 2];
    col.depthGray[k] = sky ? 0 : Math.max(0, Math.min(255, (1 - Math.log(zz / near) / Math.log(far / near)) * 255));
    col.edge[k] = edge[i]; col.sky[k] = sky ? 1 : 0;
    if (v.hasTypes) { // 札は、絵と同じ画素からそのまま引き継ぐ
      const t = v.type[i];
      col.type[k] = t; col.object[k] = v.object[i];
      col.sway[k] = Math.round(((TYPE_BY_ID.get(t) || {}).sway || 0) * 255);
      col.labelEdge[k] = v.labelEdge[i];
    }
    if (v.hasLabels) {
      for (let c = 0; c < 3; c++) col.normal[k * 3 + c] = Math.round((v.normalPx[i * 4 + c] / 127.5 - 1) * 127);
      col.sunVis0[k] = v.sunPx[i * 4];
      col.lift[k] = 0.05 + zz * zz * zStep;
    }
    k++;
  }
  return { columns: col, count: k };
}
// 「視点」の札の番号：奥行きの絵からの粒は視点の番号、SHARP の粒はその後ろ（視点の数 + 何番目か）、背後の層の粒はさらに後ろ（視点の数 × 2 + 何番目か）。
// 視点別の表示で色が分かれ、「使う視点」で出し入れもできる。
const sharpViewIndex = (vi) => data.views.length + vi;
const backViewIndex = (vi) => data.views.length * 2 + vi;
const surroundViewIndex = () => data.views.length * 3; // 周囲の地面の粒
const FRONT = frontTable(TYPES);            // 種類 → 手前の物かどうか
const backInfo = { on: false, views: [] };  // 背後の層の作り方の結果（画面に出す）
const SPLAT_OPTS = () => ({ skyZ: SKY_Z, typeOf: (t) => TYPE_BY_ID.get(t), edgeMax: EDGE_MAX, labelEdgeMax: LABEL_EDGE_MAX, maxStretch: ui.stretch, emitSky: ui.skyMode === 'wall' });
// 視点 v の背後の層（画素ごと）。色のもとと縁の幅が同じなら作り直さない
// 背景の絵を SHARP に通した粒から、視点 v のます目（g × g）の奥行きを作る（1 回だけ）。倍率は合わせない（refineBackDepth が縁で合わせる）
function plateDepth(v, p) {
  if (!p || !p.sharp) return null;
  if (p.depth === undefined) {
    const inv = v.matrix.clone().invert(), cam = new THREE.Vector3().setFromMatrixPosition(v.matrix).toArray();
    const grid = sharpGrid(p.sharp, { scale: 1, inv, cam, edgeMax: EDGE_MAX });
    p.depth = grid ? { g: grid.g, z: grid.z[0], px: null } : null;
  }
  return p.depth;
}
// 計算で作った層に、AI が描いた背景の色（withPlate）と、その絵から推定した奥行き（refineBackDepth）を重ねる。作ったものは holder.variants に取っておく
function dressBack(holder, v, key, { pixel = null, W, H, z, zp }) {
  const p = ui.plate ? v.plates[key] : null, depth = ui.backDepth === 'plate' && zp ? 1 : 0;
  if (!p && !depth) return holder.layer;
  const id = `${p ? p.version : '-'}:${depth}`;
  if (!holder.variants.has(id)) {
    let layer = holder.layer;
    if (depth) layer = refineBackDepth(layer, { W, H, z, zp });
    if (p) layer = withPlate(layer, p.px, p.mask, pixel);
    holder.variants.clear(); holder.variants.set(id, layer);
  }
  return holder.variants.get(id);
}
// plated = false にすると、AI が描いた背景の絵を使わない、計算だけの層を返す（AI に頼むときの目安の絵に使う）
function backOf(v, src, plated = true) {
  const c = colorOf(v, src), key = `${c.key}:${ui.halo}`;
  if (!v.back || v.back.key !== key) v.back = { key, layer: backLayer({ W: v.W, H: v.H, z: v.z, type: v.type, rgba: c.px, front: FRONT, halo: ui.halo }), variants: new Map() };
  if (!plated) return v.back.layer;
  const d = plateDepth(v, v.plates[c.key]);
  if (d && !d.px) d.px = gridToPixels(d.z, d.g, v.W, v.H);
  return dressBack(v.back, v, c.key, { W: v.W, H: v.H, z: v.z, zp: d && d.px });
}
function sharpParts(withBack) {
  const out = [];
  data.views.forEach((v, vi) => {
    if (!v.sharp) return;
    const inv = v.matrix.clone().invert(), cam = new THREE.Vector3().setFromMatrixPosition(v.matrix).toArray();
    if (v.sharpScale === undefined) v.sharpScale = sharpScale(v.sharp, v, inv); // 奥行きの絵に合わせる倍率（読み込みごとに 1 回）
    const keep = Math.max(1, (ui.stride / 2) ** 2); // SHARP は 2 画素に 1 粒（× 2 層）なので、「ふつう」で全部使う
    const scale = ui.sharpFit ? v.sharpScale : 1;
    // 粒の並び（ます目）から、手前と奥をつなぐ膜を探す。倍率が同じなら作り直さない
    if (!v.sharpGrid || v.sharpGrid.scale !== scale) v.sharpGrid = { scale, grid: sharpGrid(v.sharp, { scale, inv, cam, edgeMax: EDGE_MAX }) };
    const grid = v.sharpGrid.grid, opts = SPLAT_OPTS();
    const p = splatsFromSharp(v.sharp, v, sharpViewIndex(vi), { keep, scale, inv, cam, typeOf: opts.typeOf, edgeMax: EDGE_MAX, labelEdgeMax: LABEL_EDGE_MAX, grid });
    v.sharpStats = p.stats;
    out.push(p);
    if (withBack && grid && v.hasTypes) { // 背後の層：SHARP の奥行きのます目から作る（SHARP の地面とずれないように）
      const c = colorOf(v, ui.colorSrc), key = `${c.key}:${ui.halo}:${scale}`;
      if (!v.sharpBack || v.sharpBack.key !== key) v.sharpBack = { key, layer: sharpBack(v.sharp, v, grid, c.px, { scale, inv, cam, front: FRONT, halo: Math.max(1, Math.round(ui.halo / 2)) }), variants: new Map() };
      const pl = ui.plate ? v.plates[c.key] : null, base = v.sharpBack.layer; // AI が描いた背景の絵があれば、色はそこから
      const pd = plateDepth(v, v.plates[c.key]);                              // その絵を SHARP に通してあれば、位置もそこから（ます目は同じ並び）
      const layer = dressBack(v.sharpBack, v, c.key, { pixel: base.pixel, W: grid.g, H: grid.g, z: base.gridZ, zp: pd && pd.g === grid.g ? pd.z : null });
      const b = sharpBackSplats(v.sharp, v, grid, layer, backViewIndex(vi), { ...opts, step: Math.max(1, ui.stride >> 1), scale, inv, cam });
      out.push(b);
      backInfo.views.push({ name: `${v.def.name}（SHARP）`, count: b.count, covered: 0, stats: v.sharpBack.layer.stats, ai: !!pl, refined: layer.refined, kept: layer.kept });
    }
  });
  return out;
}
function buildCloud() {
  const placement = data.hasSharp ? ui.placement : 'depth';
  const withBack = ui.back && data.hasTypes; // 背後の層には種類の札が要る
  backInfo.on = withBack; backInfo.views = [];
  const parts = [];
  if (placement !== 'sharp') data.views.forEach((v, vi) => {
    const back = withBack && !v.onlyNew ? backOf(v, ui.colorSrc) : null; // 穴埋めで足した視点（穴の所だけの絵）には作らない
    parts.push(splatsFromView(v, vi, ui.stride, ui.colorSrc, back));
    if (!back) return;
    const b = backSplats(v, back, backViewIndex(vi), ui.stride, { ...SPLAT_OPTS(), others: data.views.filter((o) => o !== v) });
    parts.push(b);
    backInfo.views.push({ name: v.def.name, count: b.count, covered: b.covered, stats: back.stats, ai: back.used !== undefined, refined: back.refined, kept: back.kept });
  });
  if (placement !== 'depth') parts.push(...sharpParts(withBack && placement === 'sharp'));
  const around = surroundSplats(); if (around) parts.push(around);
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
  relit: painted,                                                                                     // 光を変えた後（色はシェーダーが掛ける）
  relitCpu: relit,                                                                                    // 確かめ用：同じ式を CPU で計算したもの
  sway: (c, i, out) => { const l = luma(c, i) * 0.35, k = c.sway[i] / 255; out[0] = l * (1 - k) + 0.1 * k; out[1] = l * (1 - k) + k; out[2] = l * (1 - k) + 0.75 * k; }, // 揺れる粒
  depth: (c, i, out) => gray(out, LIN[c.depthGray[i]]),                                               // 奥行き
  view: (c, i, out) => {                                                                              // 視点別
    if (c.skyFrom[i] > 1) return gray(out, 0.05 + 0.3 * luma(c, i)); // 絵から来ていない空（埋めた所）は灰色
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
  sunNow: painted,                                                                                    // いまの日なた（シェーダーが灰色にする）
  layer: (c, i, out) => {                                                                             // 層：絵に見えていた面は灰色、背後の層は黄
    const l = 0.15 + 0.85 * luma(c, i);
    if (c.layer[i] === 2) { out[0] = l * 0.1; out[1] = l * 0.8; out[2] = l; }                              // 周囲の地面は水色
    else if (c.layer[i]) { out[0] = l; out[1] = l * 0.8; out[2] = l * 0.1; } else gray(out, l * 0.6);
  },
  labelEdge: (c, i, out) => {                                                                         // 札の境目の近く
    painted(c, i, out);
    const k = 1 - Math.min(1, c.labelEdge[i] / 6); // 境目に近いほど赤く
    out[0] = out[0] * (1 - k) + k; out[1] *= 1 - k; out[2] *= 1 - k;
  },
};
// 空の出どころ：天球の粒を、絵から来た所（視点の色）・AI が描いた所（緑）・ツール内で埋めた所（赤紫）に色分けする。空でない粒は暗い灰色
const SKY_FROM_TINT = [null, null, [0.25, 0.9, 0.35], [0.95, 0.2, 0.75]];
DISPLAY.skySrc = (c, i, out) => {
  const from = c.skyFrom[i], l = 0.25 + 0.75 * luma(c, i);
  if (!from) return gray(out, 0.02 + 0.1 * luma(c, i));
  const t = from === 1 ? VIEW_TINTS[c.view[i] % VIEW_TINTS.length] : SKY_FROM_TINT[from];
  out[0] = LIN[t[0] * 255 | 0] * l; out[1] = LIN[t[1] * 255 | 0] * l; out[2] = LIN[t[2] * 255 | 0] * l;
};
const NEEDS_LABELS = new Set(['relit', 'sway', 'type', 'typeMix', 'object', 'normal', 'sun0', 'sunNow', 'labelEdge', 'layer']);
const TYPE_MODES = new Set(['type', 'typeMix', 'object', 'labelEdge', 'layer']); // 種類と物体の札だけで出せる表示（実在の絵の場面でも使える）
const SHADER_SHOW = { relit: 1, sunNow: 2 };     // シェーダー側で色を作る表示
const COLOR_FX = new Set(['color', 'relit']);    // 風の照りと足跡の色を掛ける表示
const KIND_OF = new Map(TYPES.map((t) => [t.id, KIND[t.light] + (t.tracks ? 4 : 0)]));

// いまの光を、シェーダーの値へ写す。
function applyLight() {
  prepareLight();
  const u = fx.u;
  u.sunDir.value.fromArray(L.dir); u.sunDir0.value.fromArray(L.dir0);
  u.sunRGB.value.fromArray(L.sun); u.skyRGB.value.fromArray(L.sky); u.skyGain.value.fromArray(L.skyGain);
  u.paintAmb.value = L.paint.ambient; u.paintSun.value = L.paint.sun; u.bands.value = L.bands; u.maxGain.value = L.maxGain;
}

// いまの太陽の向きで、影用の地図（プレビズの形を太陽から見た奥行き）を作り直してシェーダーへ渡す。粒ごとの比較は描くときにする。
let sunBusy = false, sunDirty = false;
async function updateSun() {
  if (sunBusy) { sunDirty = true; return; }
  sunBusy = true;
  try {
    do {
      sunDirty = false;
      const a = app; if (!a || !data.hasLabels) break;
      const t0 = performance.now(), dir = sunDirection(light.azimuth, light.elevation);
      const map = await renderSunMap(a.renderer, a.previz, a.labels, dir, { size: SUN_MAP_SIZE, depth: false, packed: true });
      if (a !== app) break; // 待っている間に作り直された
      fx.setSunMap(map);
      $('sSun').textContent = `${Math.round(performance.now() - t0)} ms`;
    } while (sunDirty);
  } catch (e) { console.error(e); } finally { sunBusy = false; }
}
// 確かめ用：以前の CPU の計算（細かい地図で粒ごとに影を調べる）。relitCpu の表示と比べるときに使う。
async function cpuSun() {
  const a = app, c = cloud, map = await renderSunMap(a.renderer, a.previz, a.labels, sunDirection(light.azimuth, light.elevation), { size: SUN_MAP_SIZE });
  const { n, position: P, normal: N, lift, sunNow } = c;
  for (let i = 0; i < n; i++) sunNow[i] = c.object[i] ? Math.round(255 * sunVisibility(map, P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3] / 127, N[i * 3 + 1] / 127, N[i * 3 + 2] / 127, lift[i])) : 255;
}

// 描画用は vec4 を4本にまとめる（WebGPU は頂点バッファの本数に上限があるため、列ごとに分けない）。
//   A = [位置 xyz, 粒の間隔]  B = [表示する色 rgb, 境界からの距離]
//   C = [空, 視点, 揺れやすさ, 光の受け方＋足跡が付くか]  D = [面の向き xyz, 描いたときの日なた]（C・D の使い方は studio/fx.js）
//   E = [形 xx, xy, xz, yy]  F = [形 yz, zz, 空き, 空き]（粒の形の共分散。makeMaterials で画面の上の楕円に直す）
// 遠い順（視点からの距離）に並べ直すのは別の糸（studio/sortworker.js）で行い、描画は止めない。
// ここでは、粒の元の並びのまま描画用の値を作って渡す（表示・粒を変えたときだけ。光や動きは描くときに付けるので送り直さない）。
const OPACITY_PACK = 0.45; // B.w の小数部に「1 − 不透明さ」をこの幅で詰める（境界の判定 step(uEdge, B.w + 0.5) を変えない幅）
function sendSource() {
  const a = app, c = cloud; if (!a || !c) return;
  const n = c.n, P = new Float32Array(n * 4), B = new Float32Array(n * 4), C = new Float32Array(n * 4), D = new Float32Array(n * 4), E = new Float32Array(n * 4), F = new Float32Array(n * 4);
  prepareLight();
  const display = DISPLAY[ui.mode] || DISPLAY.color, rgb = [0, 0, 0], labels = data.hasLabels;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    P[o] = c.position[i * 3]; P[o + 1] = c.position[i * 3 + 1]; P[o + 2] = c.position[i * 3 + 2]; P[o + 3] = c.size[i];
    display(c, i, rgb);
    B[o] = rgb[0]; B[o + 1] = rgb[1]; B[o + 2] = rgb[2]; B[o + 3] = c.edge[i] + (1 - c.opacity[i] / 255) * OPACITY_PACK; // 境界からの距離（整数）＋ 透けぐあい（小数）
    C[o] = c.sky[i]; C[o + 1] = c.view[i];
    E[o] = c.cov[i * 6]; E[o + 1] = c.cov[i * 6 + 1]; E[o + 2] = c.cov[i * 6 + 2]; E[o + 3] = c.cov[i * 6 + 3]; F[o] = c.cov[i * 6 + 4]; F[o + 1] = c.cov[i * 6 + 5];
    if (labels) {
      C[o + 2] = c.sway[i] / 255; C[o + 3] = KIND_OF.get(c.type[i]) || 0;
      D[o] = c.normal[i * 3] / 127; D[o + 1] = c.normal[i * 3 + 1] / 127; D[o + 2] = c.normal[i * 3 + 2] / 127; D[o + 3] = c.sunVis0[i] / 255;
    }
  }
  const arrays = [P, B, C, D, E, F];
  a.sorter.worker.postMessage({ type: 'source', arrays }, arrays.map((x) => x.buffer));
}
// 並べ直しの係。終わった配列を描画用の値と入れ替え、外した方を次の並べ直しの書き込み先に回す。
function makeSorter(a, n) {
  const worker = new Worker(new URL('./sortworker.js', import.meta.url), { type: 'module' });
  const s = { worker, busy: false, pending: null, spare: a.attrs.map(() => new Float32Array(n * 4)), done: 0 };
  s.sort = (eye) => { // eye = [x, y, z]
    if (s.busy || !s.spare) { s.pending = eye; return; }
    s.busy = true; const arrays = s.spare; s.spare = null;
    worker.postMessage({ type: 'sort', eye, arrays }, arrays.map((x) => x.buffer));
  };
  worker.onmessage = (e) => {
    const m = e.data;
    if (!m.empty) {
      s.spare = a.attrs.map((t) => t.array);
      a.attrs.forEach((t, i) => { t.array = m.arrays[i]; t.needsUpdate = true; });
      s.done++;
      $('sSort').textContent = `${Math.round(m.ms)} ms（描画とは別の糸）`;
    } else s.spare = m.arrays;
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
  const [P, B, M, D, E, F] = a.attrs.map((t) => instancedBufferAttribute(t));
  const moved = fx.nodes(P, B, M, D); // 風・草よけ・足跡・光の付け替えを掛けた位置と色
  const edgeOk = step(uEdge, B.w.add(0.5));                               // 境界から uEdge 画素以上はなれた粒だけ
  const skyOk = mix(float(1), uSky, M.x);                                 // 空の粒は uSky で出し入れ
  const viewOk = max(step(uView, -0.5), float(1).sub(step(0.5, abs(M.y.sub(uView))))); // 使う視点だけ
  const show = edgeOk.mul(skyOk).mul(viewOk);
  const s = P.w.mul(uSize);
  const r = uv().sub(0.5).length();

  // 粒の形（3D の共分散）を、いまのカメラから見た画面の上の楕円に直す（3D Gaussian Splatting と同じ計算）。
  //   m1・m2 = 「粒の中心を通り、画面に平行な板」への写し方（遠近のゆがみ込み）。板の上での共分散 [[ca, cb], [cb, cc]] の
  //   長い軸・短い軸の広がり（√固有値）と傾きを求め、板（スプライト）の縦横の大きさと回転にする。
  const V = cameraViewMatrix, r1 = vec3(V[0].x, V[1].x, V[2].x), r2 = vec3(V[0].y, V[1].y, V[2].y), r3 = vec3(V[0].z, V[1].z, V[2].z);
  const t = V.mul(vec4(moved.position, 1)).xyz;
  const m1 = r1.sub(r3.mul(clamp(t.x.div(t.z), -2, 2))), m2 = r2.sub(r3.mul(clamp(t.y.div(t.z), -2, 2)));
  const S0 = vec3(E.x, E.y, E.z), S1 = vec3(E.y, E.w, F.x), S2 = vec3(E.z, F.x, F.y);
  const Sm1 = vec3(dot(S0, m1), dot(S1, m1), dot(S2, m1)), Sm2 = vec3(dot(S0, m2), dot(S1, m2), dot(S2, m2));
  const ca = dot(m1, Sm1), cb = dot(m1, Sm2), cc = dot(m2, Sm2);
  const mid = ca.add(cc).mul(0.5), half = ca.sub(cc).mul(0.5), rad = sqrt(half.mul(half).add(cb.mul(cb)));
  const floor2 = P.w.mul(P.w).mul(MIN_SIGMA * MIN_SIGMA);                 // 真横から見た面が線より細くならないように
  const l1 = max(mid.add(rad), floor2), l2 = max(mid.sub(rad), floor2);
  const k = uSize.div(2.6).mul(6);                                        // 板の一辺 = 広がり（σ）× 6（下のぼかしが σ = 一辺 / 6）
  const oval = vec2(sqrt(l1), sqrt(l2)).mul(k);
  const tilt = atan(cb.mul(2), ca.sub(cc).add(1e-12)).mul(0.5).mul(uShape); // 長い軸の傾き。丸のときは 0
  const size = mix(vec2(s, s), oval, uShape);                             // uShape = 0 なら今までどおりの丸

  const soft = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  soft.positionNode = moved.position; soft.scaleNode = size.mul(show); soft.rotationNode = tilt; soft.colorNode = moved.color;
  const alpha = float(1).sub(fract(B.w).div(OPACITY_PACK)); // 不透明さ（sendSource で B.w の小数部に詰めたもの）
  soft.opacityNode = exp(r.mul(r).mul(-18)).mul(alpha);

  const hard = new THREE.SpriteNodeMaterial({ transparent: false, depthWrite: true, depthTest: true, alphaTest: 0.5 });
  // ぼかさないぶん小さめの円にする
  hard.positionNode = moved.position; hard.scaleNode = size.mul(show).mul(0.62); hard.rotationNode = tilt; hard.colorNode = moved.color;
  hard.opacityNode = float(1).sub(step(0.5, r)).mul(step(0.5, alpha)); // 半分より透ける粒は描かない
  return { soft, hard };
}
const MIN_SIGMA = 0.12; // 粒の広がり（σ）の下限 ÷ 粒の間隔

// ---- 空の天球 ----
// 空の画素は粒の雲に入れず、向きだけで 1 枚の空の地図にまとめてから、カメラを中心にした球の内側に粒として並べる（studio/skydome.js）。
// 並べ直しは要らない（重なりが無いので）。別の Sprite として、ほかの粒より先に描く。
const sky = { dome: null, cloud: null, maps: new Map(), fillKey: '', fill: null, counts: [0, 0, 0, 0], busy: false, again: false };
const skySfx = () => SOURCES[ui.colorSrc].sfx;
// いまの色のもと用の「AI が描いた空」を読む（あれば）。1 回読んだら覚えておく
async function skyAiLayer() {
  const sfx = skySfx();
  if (!(sfx in data.skyAi)) {
    const px = data.skyAiFiles[`sky_ai${sfx}`] ? await tryImage(`/files/paint-out/sky_ai${sfx}.png`, AI_W, AI_H) : null;
    data.skyAi[sfx] = px ? { W: AI_W, H: AI_H, rgba: px } : null;
  }
  return data.skyAi[sfx];
}
// 絵の地図。source = 'all' か視点の番号。色のもと・使う視点・輪郭からの幅が同じなら作り直さない
function skyMap(source = ui.source) {
  const margin = Number($('skyMargin').value), width = ui.skyStep <= 0.15 ? 3072 : 2048, key = `${ui.colorSrc}|${source}|${margin}|${width}`;
  if (sky.maps.has(key)) return sky.maps.get(key);
  const views = data.views.map((v, vi) => ({ v, vi })).filter(({ vi }) => source === 'all' || Number(source) === vi)
    .map(({ v, vi }) => ({ W: v.W, H: v.H, ...v.def.intrinsics, m: v.matrix.elements, dist: v.skyDist, px: colorOf(v, ui.colorSrc).px, fresh: v.onlyNew ? v.freshMask || (v.freshMask = Uint8Array.from({ length: v.W * v.H }, (_, i) => (v.onlyNew[i * 4] >= 128 ? 1 : 0))) : null, vi }));
  const map = buildSkyMap(views, { width, margin });
  for (let i = 0; i < map.src.length; i++) if (map.src[i]) map.src[i] = views[map.src[i] - 1].vi + 1; // 並びの番号 → 視点の番号
  map.key = key;
  if (sky.maps.size >= 3) sky.maps.delete(sky.maps.keys().next().value); // 覚えておくのは 3 枚まで
  sky.maps.set(key, map);
  return map;
}
function makeSkySprite(a) {
  if (a.sky) { a.scene.remove(a.sky.sprite); a.sky.sprite.material.dispose(); }
  const dome = sky.dome && sky.dome.step === ui.skyStep ? sky.dome : (sky.dome = domeDirections(ui.skyStep)), n = dome.n;
  const attrA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4), attrB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const P = instancedBufferAttribute(attrA), B = instancedBufferAttribute(attrB), u = fx.u;
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  const s = P.w.mul(uSize).mul(uDome).mul(SKY_SIZE), r = uv().sub(0.5).length();
  mat.positionNode = P.xyz; mat.scaleNode = vec2(s, s);
  // 空は太陽の計算をせず、空の光の色と強さだけを掛ける（studio/fx.js の空の粒と同じ）
  mat.colorNode = varying(mix(mix(B.xyz, B.xyz.mul(u.skyGain), step(0.5, u.show)), vec3(0.3), step(1.5, u.show)));
  mat.opacityNode = exp(r.mul(r).mul(-18));
  const sprite = new THREE.Sprite(mat);
  sprite.count = n; sprite.frustumCulled = false; sprite.renderOrder = 0;
  a.scene.add(sprite);
  a.sky = { sprite, attrA, attrB, n };
  sky.cloud = makeCloud(n); sky.cloud.n = n;
}
// 天球の粒の色を、いまの表示の種類で描画用の値へ写す
function sendSky() {
  const a = app, c = sky.cloud; if (!a || !a.sky || !c || ui.skyMode !== 'dome') return;
  const { n, attrA, attrB } = a.sky, A = attrA.array, B = attrB.array, dir = sky.dome.dir, size = SKY_R * ui.skyStep * Math.PI / 180;
  prepareLight();
  const display = DISPLAY[ui.mode] || DISPLAY.color, rgb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    A[o] = dir[i * 3] * SKY_R; A[o + 1] = dir[i * 3 + 1] * SKY_R; A[o + 2] = dir[i * 3 + 2] * SKY_R; A[o + 3] = c.skyFrom[i] ? size : 0; // 穴は描かない
    display(c, i, rgb);
    B[o] = rgb[0]; B[o + 1] = rgb[1]; B[o + 2] = rgb[2];
  }
  attrA.needsUpdate = attrB.needsUpdate = true;
}
// 空を作り直す：絵の地図 → AI の層を重ねる → 残りをツール内で埋める → 粒の色
async function refreshSky() {
  if (sky.busy) { sky.again = true; return; }
  sky.busy = true;
  try {
    do {
      sky.again = false;
      const a = app; if (!a || ui.skyMode !== 'dome') break;
      const t0 = performance.now();
      if (!a.sky || !sky.dome || sky.dome.step !== ui.skyStep) makeSkySprite(a);
      const ai = $('skyAi').checked ? await skyAiLayer() : null;
      if (a !== app) break;
      const map = skyMap(), fillKey = `${map.key}|${ai ? skySfx() + data.skyAiVersion : '-'}`;
      if ($('skyFill').checked && sky.fillKey !== fillKey) { sky.fill = fillSky(withAi(map, ai)); sky.fillKey = fillKey; }
      const out = colorDome(sky.dome, { map, ai, fill: $('skyFill').checked ? sky.fill : null, mottle: Number($('skyMottle').value) });
      const c = sky.cloud;
      c.color.set(out.color); c.skyFrom.set(out.from); c.sky.fill(1);
      for (let i = 0; i < c.n; i++) c.view[i] = out.view[i] ? out.view[i] - 1 : 0;
      sky.counts = out.counts;
      sendSky();
      const pct = (k) => `${Math.round(100 * out.counts[k] / c.n)}%`;
      $('sSky').textContent = `${(c.n / 10000).toFixed(1)} 万粒（絵 ${pct(1)}・AI ${pct(2)}・ツール内 ${pct(3)}・穴 ${pct(0)}）${Math.round(performance.now() - t0)} ms`;
      $('skyAi').disabled = !data.skyAiFiles[`sky_ai${skySfx()}`];
    } while (sky.again);
  } catch (e) { console.error(e); $('sSky').textContent = '作れませんでした：' + e.message; } finally { sky.busy = false; }
}

// ---- AI（Codex）に空の穴を描いてもらう ----
// 上半分を覆う 4 つの向きを順に見て、穴のある向きだけ頼む。描けた分はすぐ空の層に貼るので、次の向きは前の続きから描かれる。
const api = async (url, body, method = 'POST') => {
  const res = await fetch(url, { method, headers: body instanceof Blob ? {} : { 'Content-Type': 'application/json' }, body: body instanceof Blob ? body : JSON.stringify(body || {}) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `${url} が失敗しました`);
  return out;
};
function pngBlob(rgba, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, h), 0, 0);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let skyJob = false, skyStop = false;
const HOLE_MIN = 0.01; // 穴がこの割合より少ない向きは頼まない
async function paintSky(dryRun) {
  if (skyJob || !app || !data) return;
  const log = (t) => { $('skyLog').hidden = false; $('skyLog').textContent = t; };
  skyJob = true; skyStop = false; $('skyPaint').disabled = $('skyDry').disabled = $('skyForget').disabled = true; $('skyStopBtn').hidden = false;
  try {
    const sfx = skySfx(), map = skyMap('all'), src = SOURCES[ui.colorSrc];
    const old = await skyAiLayer(), ai = { W: AI_W, H: AI_H, rgba: old ? new Uint8ClampedArray(old.rgba) : new Uint8ClampedArray(AI_W * AI_H * 4) };
    // 画風の見本：いまの色のもとの、最初の視点の絵（絵画があるときだけ）
    const first = data.views[0], styleRef = src.file && first.colors[ui.colorSrc] ? `${first.def.name}_painted${sfx}` : null;
    let done = 0;
    for (let k = 0; k < FACE.count && !skyStop; k++) {
      const known = withAi(map, ai), face = renderFace(k, known, fillSky(known)), name = faceCamera(k).name;
      if (face.holes < HOLE_MIN) continue;
      log(`${name}：穴 ${Math.round(face.holes * 100)}%。${dryRun ? '文と絵を用意しています' : 'Codex が描いています（30 秒〜数分）'}`);
      await api(`/api/paint-out/sky_face${k}${sfx}.png`, await pngBlob(face.image, FACE.w, FACE.h));
      await api(`/api/paint-out/sky_face${k}${sfx}_holes.png`, await pngBlob(face.mask, FACE.w, FACE.h));
      await api('/api/paint/sky', { face: k, sfx, light: src.paint, styleRef, dryRun });
      let st;
      for (;;) { await sleep(1000); st = await (await fetch('/api/paint/status', { cache: 'no-store' })).json(); if (!st.running) break; if (skyStop) await api('/api/paint/stop'); else log(`${name}：穴 ${Math.round(face.holes * 100)}%。Codex が描いています（${st.seconds} 秒）`); }
      if (skyStop) break;
      if (st.code !== 0) throw new Error(st.log.trim().split('\n').slice(-4).join('\n') || 'Codex が失敗しました');
      done++;
      if (dryRun) continue;
      const painted = await loadImage(`/files/paint-out/sky_face${k}${sfx}_painted.png`, FACE.w, FACE.h);
      pasteFace(ai, k, painted, face.mask);
      await api(`/api/paint-out/sky_ai${sfx}.png`, await pngBlob(ai.rgba, AI_W, AI_H));
      data.skyAi[sfx] = ai; data.skyAiFiles[`sky_ai${sfx}`] = true; data.skyAiVersion++;
      $('skyAi').disabled = false; $('skyAi').checked = true;
      await refreshSky(); // 描けた向きから順に、画面の空に出す
    }
    log(skyStop ? '止めました。' : !done ? '穴のある向きがありません（空はもう全部埋まっています）。' : dryRun ? `${done} 枚ぶんの文と絵を paint/out/work/ に用意しました（Codex は呼んでいません）。` : `${done} 枚描いてもらい、空に貼りました。`);
  } catch (e) { console.error(e); log('止まりました：' + e.message); }
  finally { skyJob = false; $('skyPaint').disabled = $('skyDry').disabled = $('skyForget').disabled = false; $('skyStopBtn').hidden = true; showSkyPlan(); }
}
// 「AI に描いてもらう」を押す前に、いま何枚ぶん頼むことになるかを書く
function showSkyPlan() {
  if (!data || !app || skyJob) return;
  const map = skyMap('all'), ai = data.skyAi[skySfx()] || null, known = withAi(map, ai);
  let n = 0; for (let k = 0; k < FACE.count; k++) if (faceHoles(k, known) >= HOLE_MIN) n++;
  $('skyPlan').textContent = n ? `いま穴のある向きは ${n} / ${FACE.count}。押すと ChatGPT の利用枠を ${n} 枚ぶん使います（1 枚 1〜2 分）。` : '空は全部埋まっています。押しても Codex は呼びません。';
}
async function forgetSky() {
  if (skyJob || !data) return;
  const sfx = skySfx();
  try { await api(`/api/paint-out/sky_ai${sfx}.png`, null, 'DELETE'); } catch (e) { $('skyLog').hidden = false; $('skyLog').textContent = e.message; return; }
  data.skyAi[sfx] = null; data.skyAiFiles[`sky_ai${sfx}`] = false; data.skyAiVersion++;
  await refreshSky(); showSkyPlan();
}

// ---- 周囲の地面（絵の外の地面） ----
// 空の天球と同じ道具（studio/skydome.js）を、上下を逆さにした世界で使う：絵の視点を中心に、地平線より下の向きの色を 1 枚の全周の絵にまとめ、
// 絵に無い向きをツール内の計算か AI（Codex）で埋める。粒は、その向きの視線が土台の平面（推定した地面の高さ）に当たる所に置く。
// 逆さの世界で「空」として扱うのは、絵の中心の視点の「空でない背景の画素」（AI が描いた背景の絵があれば、物があった所も使う）。
const SURROUND_SIGMA = 0.65; // 粒の広がり（σ）÷ 粒の間隔。後ろが何も無いので、絵の粒（SIGMA_K）より広くしてすき間を無くす
const SURROUND_GRID = 0.12, SURROUND_GROW = 0.012, SURROUND_MAX = 180; // 粒の間隔（m）：近くは GRID、遠くは 距離 × GROW。置く距離の上限（m）
const surround = { key: '', map: null, soil: null, type: 0, fillKey: '', fill: null, grid: null, counts: [0, 0, 0, 0] };
const SOIL = new Uint8Array(256); for (const t of TYPES) if (t.tracks) SOIL[t.id] = 1; // 足あとが付く種類（地面、草地）= 歩ける地面
const centerView = () => data.views.find((v) => !v.onlyNew) || data.views[0];
const flipV = (rgba, w, h) => { const out = new Uint8ClampedArray(rgba.length); for (let y = 0; y < h; y++) out.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4); return out; };
function groundMap() {
  const v = centerView(), c = colorOf(v, ui.colorSrc), plate = ui.plate ? v.plates[c.key] : null, back = v.hasTypes ? backOf(v, ui.colorSrc, false) : null;
  const key = `${data.views.indexOf(v)}|${c.key}|${plate ? plate.version : '-'}|${ui.halo}`;
  if (surround.key === key) return surround.map;
  const n = v.W * v.H, member = new Uint8Array(n), soil = new Uint8Array(n), seen = new Uint32Array(256);
  let soils = 0;
  for (let i = 0; i < n; i++) {
    member[i] = v.isSky[i] ? 0 : back && (back.thing[i] || back.kind[i]) ? (plate && plate.mask[i * 4] >= 128 ? 1 : 0) : 1;
    if (member[i] && v.hasTypes && SOIL[v.type[i]] && !(back && (back.thing[i] || back.kind[i]))) { soil[i] = 1; soils++; seen[v.type[i]]++; }
  }
  const m = Array.from(v.matrix.elements); m[1] = -m[1]; m[5] = -m[5]; m[9] = -m[9]; // 世界の上下を逆さにする
  const build = (mask) => buildSkyMap([{ W: v.W, H: v.H, ...v.def.intrinsics, m, dist: skyDistance(mask, v.W, v.H), px: plate ? plate.px : c.px, fresh: null }], { width: 2048, margin: 4 });
  surround.map = build(member);
  // ツール内で埋める色は、歩ける地面（地面、草地）の画素だけから伸ばす。水や遠景の色が、周囲の地面に広がらないようにする
  surround.soil = soils > n * 0.005 ? build(soil) : surround.map;
  surround.type = GROUND_TYPE; { let best = 0; for (let t = 0; t < 256; t++) if (seen[t] > best) { best = seen[t]; surround.type = t; } }
  surround.key = key; surround.fillKey = '';
  return surround.map;
}
async function groundAiLayer() {
  const sfx = skySfx();
  if (!(sfx in data.groundAi)) {
    const px = data.groundAiFiles[`ground_ai${sfx}`] ? await tryImage(`/files/paint-out/ground_ai${sfx}.png`, AI_W, AI_H) : null;
    data.groundAi[sfx] = px ? { W: AI_W, H: AI_H, rgba: px, version: 1 } : null;
  }
  return data.groundAi[sfx];
}
// いまの地図（絵 + AI の層）と、ツール内で埋めた色
function groundKnown() {
  const map = groundMap(), ai = ui.surroundAi ? data.groundAi[skySfx()] || null : null, known = withAi(map, ai), fillKey = `${surround.key}|${ai ? skySfx() + ai.version : '-'}`;
  if (surround.fillKey !== fillKey) { surround.fill = fillSky(withAi(surround.soil, ai), { ground: true }); surround.fillKey = fillKey; }
  return { map, ai, known, fill: surround.fill };
}
// 地面の上の点を、視点の真下を中心にした輪に並べる（高さ h の視点から見た向きと、全周の絵の上の位置も持つ）。逆さの世界の向きなので y は上向き
function groundGrid(h) {
  if (surround.grid && surround.grid.h === h) return surround.grid;
  const rs = [];
  let n = 0;
  for (let r = SURROUND_GRID / 2; r <= SURROUND_MAX;) { const s = Math.max(SURROUND_GRID, r * SURROUND_GROW), count = Math.max(6, Math.round(2 * Math.PI * r / s)); rs.push({ r, s, count }); n += count; r += s; }
  const dir = new Float32Array(n * 3), u = new Float32Array(n), v = new Float32Array(n), x = new Float32Array(n), z = new Float32Array(n), gap = new Float32Array(n);
  let k = 0;
  rs.forEach(({ r, s, count }, ring) => {
    const t = Math.hypot(r, h), el = Math.atan2(h, r);
    for (let i = 0; i < count; i++, k++) {
      const az = (i + (ring & 1 ? 0.5 : 0)) / count, a = az * 2 * Math.PI, sx = Math.sin(a), cz = Math.cos(a);
      dir[k * 3] = sx * r / t; dir[k * 3 + 1] = h / t; dir[k * 3 + 2] = cz * r / t;
      u[k] = az % 1; v[k] = 0.5 - el / Math.PI; x[k] = sx * r; z[k] = cz * r; gap[k] = s;
    }
  });
  return (surround.grid = { h, n, dir, u, v, x, z, gap });
}
// 視点ごとの「背景の奥行き」（手前の物を取り除いた奥行き。物の後ろは背後の層の奥行き、分からない所は -1、空は 0）
function backgroundDepth(o) {
  if (o.onlyNew) return null;
  const back = o.hasTypes ? backOf(o, ui.colorSrc) : null;
  if (!back) return o.z;
  const n = o.W * o.H, bz = new Float32Array(n);
  for (let i = 0; i < n; i++) bz[i] = back.kind[i] === BACK_BEHIND ? back.z2[i] : back.thing[i] ? -1 : o.z[i];
  return bz;
}
// ワールドの点が、視点 o の絵（と背後の層）でもう覆われているか。覆われている所には周囲の地面の粒を置かない。
// わくの中で、背景がその点と同じくらいの距離か、もっと遠い（= 絵ではそこに地面が無く、向こうが見えている）なら「覆われている」。
// 背景のほうがずっと手前（木立ちや遠景の後ろ）や空なら、覆われていない。
// 戻り値：0 = 覆われていない、1 = 覆われている、2 = 覆われているが、視線が地面をかすめていて 1 画素が地面の上で GRAZE m より長い（絵の粒では横から見るとすじになる所）
const GRAZE = 1.5;
function framedIn(o, bz, x, y, z) {
  const m = o.w2c, { fx, fy, cx, cy } = o.def.intrinsics;
  const xc = m[0] * x + m[1] * y + m[2] * z + m[3], yc = m[4] * x + m[5] * y + m[6] * z + m[7], zc = -(m[8] * x + m[9] * y + m[10] * z + m[11]);
  if (zc <= 0.05) return 0;
  const ix = Math.floor(cx + xc / zc * fx), iy = Math.floor(cy - yc / zc * fy);
  if (ix < 0 || iy < 0 || ix >= o.W || iy >= o.H) return 0;
  const j = iy * o.W + ix;
  if (bz ? !(bz[j] < 0 || bz[j] > 0.75 * zc) : !(o.onlyNew[j * 4] >= 128 && o.z[j] > 0.75 * zc)) return 0; // 足した視点は、新しく描いた画素だけ
  return zc * zc / (fy * Math.max(0.1, Math.abs(o.c2w[7] - y))) > GRAZE ? 2 : 1;
}
function surroundSplats() {
  if (!ui.surround || !data) return null;
  const v = centerView(), { map, ai, fill } = groundKnown();
  const eye = [v.c2w[3], v.c2w[7], v.c2w[11]], baseY = data.baseY !== undefined ? data.baseY : (data.baseY = estimateModel().baseY), h = eye[1] - baseY;
  if (!(h > 0.2)) { surround.counts = [0, 0, 0, 0]; return null; }
  const grid = groundGrid(h), out = colorDome(grid, { map, ai, fill: ui.surroundFill ? fill : null, mottle: 0 });
  const sway = Math.round(((TYPE_BY_ID.get(surround.type) || {}).sway || 0) * 255), counts = [0, 0, 0, 0], amp = fill ? fill.rough * 1.6 : 0;
  const keep = [], bzs = data.views.map(backgroundDepth), tmp = [0, 0, 0, 0], nv = data.views.length;
  for (let i = 0; i < grid.n; i++) {
    const px = eye[0] + grid.x[i], pz = eye[2] + grid.z[i];
    // ほかの視点の絵で覆われている所には置かない。ただし、絵の中心の視点や足した視点で「かすめて見えている」だけの所には置く
    // （中心の視点なら絵と同じ色なので、元の視点からの見え方は変わらず、横や上から見たときのすじのすき間が埋まる）
    let cover = 0, own = false;
    for (let k = 0; k < nv && cover !== 1; k++) { const o = data.views[k], f = framedIn(o, bzs[k], px, baseY, pz); if (f === 1 || (f === 2 && o !== v && !o.onlyNew)) cover = 1; else if (f === 2) { cover = 2; own = own || o === v; } }
    if (cover === 1) { counts[1]++; continue; }
    if (cover === 2 && own && out.from[i] === 1) { counts[1]++; keep.push(i); continue; }
    // 絵ではその向きに別の物（木立ちや遠景）が見えていて、地面はその後ろ：絵の色は使わず、ツール内で埋めた色にする
    if (out.from[i] === 1) { if (ui.surroundFill && fill) { sampleMap(fill, grid.u[i], grid.v[i], tmp); out.color[i * 3] = tmp[0]; out.color[i * 3 + 1] = tmp[1]; out.color[i * 3 + 2] = tmp[2]; out.from[i] = 3; } else out.from[i] = 0; }
    counts[out.from[i]]++;
    if (out.from[i] >= 2) keep.push(i);
  }
  surround.counts = counts;
  const n = keep.length, col = {
    position: new Float32Array(n * 3), size: new Float32Array(n), color: new Uint8Array(n * 3), view: new Uint8Array(n).fill(surroundViewIndex()), depthGray: new Uint8Array(n),
    type: new Uint8Array(n).fill(surround.type), sway: new Uint8Array(n).fill(sway), normal: new Int8Array(n * 3), cov: new Float32Array(n * 6), layer: new Uint8Array(n).fill(2),
  };
  keep.forEach((i, k) => {
    const t = Math.hypot(grid.x[i], grid.z[i], h), s2 = (grid.gap[i] * SURROUND_SIGMA) ** 2;
    // ツール内で埋めた所には、絵と同じくらいの色のムラを足す（地面の上の位置で決まる、1 m ほどと 30 cm ほどの模様）
    const j = out.from[i] === 3 ? skyNoise(grid.x[i] * 0.03, 0.5, grid.z[i] * 0.03) * amp : 0;
    col.position[k * 3] = eye[0] + grid.x[i]; col.position[k * 3 + 1] = baseY; col.position[k * 3 + 2] = eye[2] + grid.z[i];
    col.size[k] = grid.gap[i];
    for (let c = 0; c < 3; c++) col.color[k * 3 + c] = Math.max(0, Math.min(255, out.color[i * 3 + c] + j));
    col.depthGray[k] = Math.max(0, Math.min(255, (1 - Math.log(Math.max(t, v.near) / v.near) / Math.log(v.far / v.near)) * 255));
    col.normal[k * 3 + 1] = 127;
    col.cov[k * 6] = s2; col.cov[k * 6 + 3] = s2 * 0.0225; col.cov[k * 6 + 5] = s2; // 地面に寝た丸（厚みは 0.15 倍）
  });
  return { columns: col, count: n };
}
// 地平線より上の向き（逆さの世界では下半分）を「もう絵がある」ことにした地図。頼む絵の穴を、地平線より下だけにする
function belowHorizon(known) {
  const a = new Float32Array(known.a); a.fill(1, (known.H >> 1) * known.W);
  return { ...known, a };
}
// 頼む絵の、地平線より上（空の帯）を、うすい色 1 色の仮の帯にする。y0 = 地平線の行（上から）
const GROUND_HORIZON = Math.round(FACE.h / 2 - FACE.w / 2 / Math.tan(FACE.hfov / 2 * Math.PI / 180) * Math.tan(FACE.pitch * Math.PI / 180));
function hazeBand(image, w) {
  const o = (GROUND_HORIZON * w + (w >> 1)) * 4, c = [0, 1, 2].map((k) => Math.round(image[o + k] * 0.45 + 255 * 0.55));
  for (let i = 0; i < (GROUND_HORIZON + 3) * w; i++) { image[i * 4] = c[0]; image[i * 4 + 1] = c[1]; image[i * 4 + 2] = c[2]; image[i * 4 + 3] = 255; }
  return image;
}
function showSurround() {
  if (!data || groundJob) return;
  const [hole, painted, byAi, byTool] = surround.counts, total = Math.max(1, hole + painted + byAi + byTool), pc = (x) => `${Math.round(100 * x / total)}%`;
  $('surroundInfo').textContent = !ui.surround ? '' : `視点のまわり ${SURROUND_MAX} m の地面のうち、絵に描かれている所 ${pc(painted)}、AI が描いた所 ${pc(byAi)}、ツール内で埋めた所 ${pc(byTool)}、空いたまま ${pc(hole)}。`;
  $('surroundAi').disabled = !data.groundAiFiles[`ground_ai${skySfx()}`];
  const known = belowHorizon(withAi(groundMap(), data.groundAi[skySfx()] || null)); // 頼む枚数は、AI の層を使う・使わないに関係なく、もう描いてもらった所を除いて数える
  let n = 0; for (let k = 0; k < FACE.count; k++) if (faceHoles(k, known) >= HOLE_MIN) n++;
  $('groundPlan').textContent = n ? `いま穴のある向きは ${n} / ${FACE.count}。押すと ChatGPT の利用枠を ${n} 枚ぶん使います（1 枚 1〜2 分）。` : '周囲は全部埋まっています。押しても Codex は呼びません。';
}
// AI（Codex）に周囲の地面を描いてもらう：4 つの向きを順に、30° 見下ろした絵として頼む（逆さの世界の絵を上下に返してから渡す）
let groundJob = false, groundStop = false;
const GROUND_BUTTONS = ['groundPaint', 'groundDry', 'groundForget'];
async function paintGround(dryRun) {
  if (groundJob || !app || !data) return;
  const log = (t) => { $('groundLog').hidden = false; $('groundLog').textContent = t; };
  groundJob = true; groundStop = false; for (const id of GROUND_BUTTONS) $(id).disabled = true; $('groundStopBtn').hidden = false;
  let done = 0;
  try {
    const sfx = skySfx(), map = groundMap(), src = SOURCES[ui.colorSrc], old = await groundAiLayer();
    const ai = { W: AI_W, H: AI_H, rgba: old ? new Uint8ClampedArray(old.rgba) : new Uint8ClampedArray(AI_W * AI_H * 4), version: (old ? old.version : 0) + 1 };
    const first = data.views[0], styleRef = src.file && first.colors[ui.colorSrc] ? `${first.def.name}_painted${sfx}` : null;
    for (let k = 0; k < FACE.count && !groundStop; k++) {
      const known = belowHorizon(withAi(map, ai)), face = renderFace(k, known, fillSky(withAi(surround.soil, ai), { ground: true })), name = faceCamera(k).name;
      if (face.holes < HOLE_MIN) continue;
      const head = `${name}：穴 ${Math.round(face.holes * 100)}%。`;
      log(head + (dryRun ? '文と絵を用意しています' : 'Codex が描いています（30 秒〜数分）'));
      await api(`/api/paint-out/ground_face${k}${sfx}.png`, await pngBlob(hazeBand(flipV(face.image, FACE.w, FACE.h), FACE.w), FACE.w, FACE.h));
      await api(`/api/paint-out/ground_face${k}${sfx}_holes.png`, await pngBlob(flipV(face.mask, FACE.w, FACE.h), FACE.w, FACE.h));
      await api('/api/paint/sky', { kind: 'ground', face: k, sfx, light: src.paint, styleRef, dryRun });
      let st;
      for (;;) { await sleep(1000); st = await (await fetch('/api/paint/status', { cache: 'no-store' })).json(); if (!st.running) break; if (groundStop) await api('/api/paint/stop'); else log(`${head}Codex が描いています（${st.seconds} 秒）`); }
      if (groundStop) break;
      if (st.code !== 0) throw new Error(st.log.trim().split('\n').slice(-4).join('\n') || 'Codex が失敗しました');
      done++;
      if (dryRun) continue;
      const painted = flipV(await loadImage(`/files/paint-out/ground_face${k}${sfx}_painted.png`, FACE.w, FACE.h), FACE.w, FACE.h);
      pasteFace(ai, k, painted, face.mask);
      await api(`/api/paint-out/ground_ai${sfx}.png`, await pngBlob(ai.rgba, AI_W, AI_H));
      ai.version++; data.groundAi[sfx] = ai; data.groundAiFiles[`ground_ai${sfx}`] = true;
    }
    log(groundStop ? '止めました。' : !done ? '穴のある向きがありません。' : dryRun ? `${done} 枚ぶんの文と絵を paint-out/work/ に用意しました（Codex は呼んでいません）。` : `${done} 枚描いてもらい、周囲の地面に使っています。`);
  } catch (e) { console.error(e); log('止まりました：' + e.message); }
  finally {
    groundJob = false; for (const id of GROUND_BUTTONS) $(id).disabled = false; $('groundStopBtn').hidden = true;
    if (done && !dryRun) { ui.surroundAi = true; $('surroundAi').checked = true; rebuild(); } else showSurround();
  }
}
async function forgetGround() {
  if (groundJob || !data) return;
  const sfx = skySfx();
  try { await api(`/api/paint-out/ground_ai${sfx}.png`, null, 'DELETE'); } catch (e) { $('groundLog').hidden = false; $('groundLog').textContent = e.message; return; }
  data.groundAi[sfx] = null; data.groundAiFiles[`ground_ai${sfx}`] = false; $('groundLog').hidden = true;
  rebuild();
}

// ---- 絵と奥行きから推定したプレビズのモデル（studio/estimate.js） ----
// 背景の面（手前の物を消した後ろの奥行きのメッシュ）と、手前の物を囲む箱。歩くときの当たりの形と、OBJ の書き出しに使う。
const GROUND_TYPE = typeByKey('grass').id;
const estimateOn = () => (ui.walkShape === 'auto' ? !!(data && data.painting) : ui.walkShape === 'estimate');
function estimateModel() {
  const objName = new Map(((data.cams.labels && data.cams.labels.objects) || []).map((o) => [o.id, o.name]));
  const grounds = [], seen = [];
  for (const v of data.views) {
    if (v.onlyNew) continue; // 足した視点（穴の所だけの絵）は使わない
    const n = v.W * v.H, bz = new Float32Array(n), fill = new Uint8Array(n), bt = new Uint8Array(n).fill(GROUND_TYPE);
    const back = v.hasTypes ? backOf(v, ui.colorSrc) : null;
    for (let i = 0; i < n; i++) {
      if (!back) { bz[i] = v.z[i]; continue; }
      if (back.kind[i] === BACK_BEHIND) { bz[i] = back.z2[i]; const s = back.from[i], t = s >= 0 ? v.type[s] : 0; if (t && !FRONT[t]) bt[i] = t; } // 物の後ろ：背後の層の奥行き
      else if (back.thing[i]) fill[i] = 1;                                                                                               // 物の足もとなど：まわりから埋める
      else { bz[i] = v.z[i]; bt[i] = v.type[i] || GROUND_TYPE; }
    }
    grounds.push({ name: `background_${v.def.name}`, mesh: backgroundMesh({ W: v.W, H: v.H, bz, fill, btype: bt, c2w: v.c2w, intr: v.def.intrinsics }) });
    if (v.hasTypes) seen.push({ W: v.W, H: v.H, z: v.z, type: v.type, object: v.object, c2w: v.c2w, intr: v.def.intrinsics });
  }
  const boxes = objectBoxes(seen, { front: FRONT }).map((b) => ({ ...b, name: `${objName.get(b.objectId) || (TYPE_BY_ID.get(b.typeId) || {}).key || 'object'}_${b.objectId}` }));
  // 土台の平面：歩ける面の高さのまん中。推定した面の外へ出たときや、面に穴がある所で、下へ落ちないようにする
  const ys = [];
  for (const g of grounds) { const { positions, indices, triType } = g.mesh; for (let k = 0; k < triType.length; k += 7) if ((TYPE_BY_ID.get(triType[k]) || {}).solid === 'walk') ys.push(positions[indices[k * 3] * 3 + 1]); }
  ys.sort((p, q) => p - q);
  return { grounds, boxes, baseY: ys.length ? ys[ys.length >> 1] : 0 };
}
// 推定したモデルを、当たり判定に渡せる形（shared/collision.js の solids）にする
function estimateSolids(model) {
  const solids = [];
  for (const g of model.grounds) {
    const { positions, indices, triType } = g.mesh;
    for (const t of new Set(triType)) { // 種類ごとに 1 つのメッシュ
      const idx = []; for (let k = 0; k < triType.length; k++) if (triType[k] === t) idx.push(indices[k * 3], indices[k * 3 + 1], indices[k * 3 + 2]);
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geo.setIndex(idx);
      solids.push({ mesh: new THREE.Mesh(geo), typeId: t, objectId: 0 });
    }
  }
  const base = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200)); base.rotation.x = -Math.PI / 2; base.position.y = model.baseY - 0.02;
  solids.push({ mesh: base, typeId: GROUND_TYPE, objectId: 0 });
  for (const b of model.boxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2));
    mesh.position.fromArray(b.center); mesh.rotation.y = b.yaw;
    solids.push({ mesh, typeId: b.typeId, objectId: b.objectId });
  }
  return solids;
}
async function exportEstimate() {
  if (!data) return;
  const note = (t) => { $('estimateNote').textContent = t; };
  try {
    const model = estimateModel(), obj = toObj(model, (t) => (TYPE_BY_ID.get(t) || {}).key || `type${t}`);
    await api('/api/previz-export/estimated_model.obj', new Blob([obj], { type: 'text/plain' }));
    await api('/api/previz-export/estimated_model.json', new Blob([JSON.stringify({ units: 'metres, +Y up', base_y: model.baseY, boxes: model.boxes.map((b) => ({ name: b.name, part: b.part, object: b.objectId, type: (TYPE_BY_ID.get(b.typeId) || {}).key, center: b.center, half: b.half, yaw: b.yaw })) }, null, 1)], { type: 'application/json' }));
    note(`previz-export に estimated_model.obj（背景の面 ${model.grounds.reduce((s, g) => s + g.mesh.triType.length, 0)} 三角形、物体 ${new Set(model.boxes.map((b) => b.name)).size} 個を箱 ${model.boxes.length} 個で）と estimated_model.json（箱の一覧）を書き出しました。`);
  } catch (e) { console.error(e); note('書き出せませんでした：' + e.message); }
}

// ---- AI（Codex）に、手前の物を消した背景の絵を描いてもらう（背後の層の色） ----
// 視点ごとに 1 枚：手前の物とその縁をマゼンタの穴にした絵を見せ、後ろの背景だけ描いてもらう。できた絵は paint-out の <視点>_plate_<色のもと>.png。
const PLATE_GROW = 6; // 層のます（物とその縁）から、さらに何画素ひろげて描いてもらうか（絵と札のずれのぶん）
let plateJob = false, plateStop = false;
const PLATE_BUTTONS = ['platePaint', 'plateDry', 'plateForget', 'plateSharp'];
// まだ背景の絵が無い視点（いまの色のもとで、手前の物がある視点）
function plateTodo() {
  if (!data || !data.hasTypes) return [];
  return data.views.filter((v) => !v.onlyNew && !v.plates[colorOf(v, ui.colorSrc).key] && backOf(v, ui.colorSrc, false).stats.behind > 0);
}
const plateHave = () => (data ? data.views.filter((v) => v.plates[colorOf(v, ui.colorSrc).key]) : []);
function showPlatePlan() {
  if (!data || plateJob) return;
  const todo = plateTodo(), have = plateHave();
  $('plateBox').hidden = !data.hasTypes;
  $('plateUse').disabled = !have.length;
  $('platePlan').textContent = todo.length
    ? `まだ描いてもらっていない視点：${todo.map((v) => v.def.name).join('、')}。押すと ChatGPT の利用枠を ${todo.length} 枚ぶん使います（1 視点 1 枚、1 枚 1〜2 分）。`
    : have.length ? `いまの色のもとでは、全部の視点（${have.map((v) => v.def.name).join('、')}）に AI が描いた背景があります。押しても Codex は呼びません。` : '手前の物がある視点がありません。';
  const withDepth = have.filter((v) => v.plates[colorOf(v, ui.colorSrc).key].sharp);
  $('plateSharp').disabled = !have.length || withDepth.length === have.length;
  for (const b of $('backDepth').children) b.disabled = b.dataset.v === 'plate' && !withDepth.length;
  press($('backDepth'), withDepth.length ? ui.backDepth : 'calc');
  $('plateSharpNote').textContent = !have.length ? 'AI が描いた背景の絵ができると、押せるようになります。'
    : withDepth.length === have.length ? `奥行きを推定済み：${withDepth.map((v) => v.def.name).join('、')}。` : `まだ推定していない視点：${have.filter((v) => !withDepth.includes(v)).map((v) => v.def.name).join('、')}（1 視点 数秒〜数十秒。Codex は使いません）。`;
}
// AI が描いた背景の絵を SHARP に通し、背後の層の位置に使う奥行きを作る（視点ごと。この PC の sharp/ の用意が要る。Codex は使わない）
async function sharpPlate() {
  if (plateJob || !app || !data) return;
  const log = (t) => { $('plateLog').hidden = false; $('plateLog').textContent = t; };
  plateJob = true; plateStop = false; for (const id of PLATE_BUTTONS) $(id).disabled = true; $('plateStopBtn').hidden = false;
  let done = 0;
  try {
    for (const v of plateHave()) {
      const key = colorOf(v, ui.colorSrc).key, p = v.plates[key], name = v.def.name;
      if (p.sharp || plateStop) continue;
      log(`視点 ${name}：SHARP で奥行きを推定しています`);
      await api('/api/sharp/plate', { view: name, src: key });
      let st;
      for (;;) { await sleep(1000); st = await (await fetch('/api/paint/status', { cache: 'no-store' })).json(); if (!st.running) break; if (plateStop) await api('/api/paint/stop'); else log(`視点 ${name}：SHARP で奥行きを推定しています（${st.seconds} 秒）`); }
      if (plateStop) break;
      if (st.code !== 0) throw new Error(st.log.trim().split('\n').slice(-4).join('\n') || 'SHARP が失敗しました');
      p.sharp = await loadPlateSharp(name, key); p.depth = undefined; p.version = ++plateVersion;
      if (!p.sharp) throw new Error(`${name}_plate_${key}_sharp.ply を読めませんでした`);
      done++;
    }
    log(plateStop ? '止めました。' : done ? `${done} 視点の奥行きを推定しました。背後の層の位置に使っています。` : '推定する視点がありません。');
  } catch (e) { console.error(e); log('止まりました：' + e.message); }
  finally {
    plateJob = false; for (const id of PLATE_BUTTONS) $(id).disabled = false; $('plateStopBtn').hidden = true;
    if (done) { ui.backDepth = 'plate'; rebuild(); } else showPlatePlan();
  }
}
async function paintPlate(dryRun) {
  if (plateJob || !app || !data) return;
  const log = (t) => { $('plateLog').hidden = false; $('plateLog').textContent = t; };
  const buttons = PLATE_BUTTONS;
  plateJob = true; plateStop = false; for (const id of buttons) $(id).disabled = true; $('plateStopBtn').hidden = false;
  let done = 0;
  try {
    for (const v of plateTodo()) {
      if (plateStop) break;
      const name = v.def.name, c = colorOf(v, ui.colorSrc), req = plateRequest(backOf(v, ui.colorSrc, false), c.px, v.W, v.H, PLATE_GROW);
      const head = `視点 ${name}：手前の物とその縁 ${Math.round(req.holes * 100)}%。`;
      log(head + (dryRun ? '文と絵を用意しています' : 'Codex が描いています（30 秒〜数分）'));
      await api(`/api/paint-out/${name}_platein_${c.key}.png`, await pngBlob(c.px, v.W, v.H));
      await api(`/api/paint-out/${name}_platemask_${c.key}.png`, await pngBlob(req.mask, v.W, v.H));
      await api(`/api/paint-out/${name}_plateguide_${c.key}.png`, await pngBlob(req.guide, v.W, v.H));
      await api('/api/paint/plate', { view: name, src: c.key, dryRun });
      let st;
      for (;;) { await sleep(1000); st = await (await fetch('/api/paint/status', { cache: 'no-store' })).json(); if (!st.running) break; if (plateStop) await api('/api/paint/stop'); else log(`${head}Codex が描いています（${st.seconds} 秒）`); }
      if (plateStop) break;
      if (st.code !== 0) throw new Error(st.log.trim().split('\n').slice(-4).join('\n') || 'Codex が失敗しました');
      done++;
      if (dryRun) continue;
      v.plates[c.key] = { px: await loadImage(`/files/paint-out/${name}_plate_${c.key}.png`, v.W, v.H), mask: req.mask, version: ++plateVersion, sharp: null };
    }
    log(plateStop ? '止めました。' : !done ? '頼む視点がありません。' : dryRun ? `${done} 枚ぶんの文と絵を paint-out/work/ に用意しました（Codex は呼んでいません）。` : `${done} 枚描いてもらいました。背後の層の色に使っています。`);
  } catch (e) { console.error(e); log('止まりました：' + e.message); }
  finally {
    plateJob = false; for (const id of buttons) $(id).disabled = false; $('plateStopBtn').hidden = true;
    if (done && !dryRun) { ui.plate = true; $('plateUse').checked = true; rebuild(); } else showPlatePlan();
  }
}
async function forgetPlate() {
  if (plateJob || !data) return;
  try {
    for (const v of plateHave()) { const key = colorOf(v, ui.colorSrc).key; await api(`/api/paint-out/${v.def.name}_plate_${key}.png`, null, 'DELETE'); delete v.plates[key]; }
  } catch (e) { $('plateLog').hidden = false; $('plateLog').textContent = e.message; return; }
  $('plateLog').hidden = true; showPlatePlan();
  rebuild();
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

  if (ui.surround) await groundAiLayer(); // 周囲の地面：AI が描いた層があれば先に読む
  cloud = buildCloud();
  const n = cloud.n;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);

  const a = app = {
    renderer, scene, camera, controls,
    attrs: Array.from({ length: 6 }, () => new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)), // 描画用の A〜F（sendSource）
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
  // 歩くときの当たり判定：プレビズの形そのものか、絵と奥行きから推定したモデル（プレビズの無い場面）
  a.estimate = estimateOn() ? estimateModel() : null;
  a.walk = createWalk(scene, a.estimate ? estimateSolids(a.estimate) : a.labels.solids, a.estimate ? [{ id: 0, name: '推定した背景の面' }, ...((data.cams.labels && data.cams.labels.objects) || [])] : a.labels.objects);
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
  sky.maps.clear(); sky.fillKey = '';
  fx.u.zFromSize.value = data.views[0].def.intrinsics.fy / ui.stride;
  fx.u.zStep.value = (1 / data.cams.depth.near - 1 / data.cams.depth.far) / 65535;
  if (!keep) fx.clearFootprints(camera.position.x, camera.position.z);
  applyUi(); applyLight();
  await updateSun();
  await refreshSky(); showSkyPlan();

  const gpu = !!(renderer.backend && renderer.backend.isWebGPUBackend);
  $('sBackend').textContent = gpu ? 'WebGPU' : 'WebGL 2';
  $('swap').textContent = gpu ? 'WebGL 2 で描き直す' : 'WebGPU で描き直す';
  $('sCount').textContent = `${(n / 10000).toFixed(1)} 万粒`;
  const used = data.views.map((v) => colorOf(v, ui.colorSrc).key), missing = used.filter((k) => k !== ui.colorSrc).length;
  $('srcNote').textContent = missing ? `「${SOURCES[ui.colorSrc].name}」が無い視点が ${missing} / ${data.views.length} あります。その視点は「${SOURCES[used.find((k) => k !== ui.colorSrc)].name}」で置いています。` : '';
  $('srcNote').classList.toggle('warn', missing > 0);
  $('labelNote').hidden = data.hasLabels || data.hasTypes;
  showSharpInfo(); showLayerInfo(); showSurround();

  layout(); say('');
  let frames = 0, t0 = performance.now(), last = t0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (ui.nav === 'walk') walkStep(dt); else controls.update();
    tick(dt, now);
    if (a.sky) a.sky.sprite.position.copy(camera.position); // 天球はいつもカメラが中心（空は歩いても動かない）
    if (ui.order === 'sort' && !a.sorter.busy && camera.position.distanceToSquared(a.sortEye) > 0.09) requestSort(); // 0.3 m 動いたら、前の並べ直しが終わっていれば次を頼む
    renderer.render(scene, camera);
    if (++frames >= 30) {
      $('sFps').textContent = Math.round(frames * 1000 / (now - t0)) + ' fps'; frames = 0; t0 = now;
      const p = camera.position; $('sPos').textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} m`;
      $('sFoot').textContent = a.walk.status();
    }
  });
  starting = false;
  window.__splat = { app: a, cloud, data, ui, sky, surround, refreshSky, paintSky, light, setLight, backend: gpu ? 'webgpu' : 'webgl2', jump, sunBusy: () => sunBusy, fx, clock, setHour, cpuSun, keys,
    setMode,
    // 確かめ用：表示 mode での全粒の色（リニア）を返す
    colorsFor(mode) { prepareLight(); const out = new Float32Array(cloud.n * 3), rgb = [0, 0, 0]; for (let i = 0; i < cloud.n; i++) { DISPLAY[mode](cloud, i, rgb); out.set(rgb, i * 3); } return out; } };
  window.__ready = true;
}

// 毎フレーム：風の時間、プレイヤーの位置（草よけ）、足跡、時計
const STRIDE = 0.65, FOOT_SIDE = 0.11; // 歩幅と、足の左右の開き（m）
const lastStep = { x: NaN, z: NaN, side: 1 };
let lastSunAt = 0, lastClockShown = 0;
function tick(dt, now) {
  const a = app, u = fx.u, wk = a.walk.wk;
  u.time.value += dt;
  const walking = ui.nav === 'walk' && !wk.noclip;
  if (walking) u.player.value.set(wk.feet[0], wk.feet[1], wk.feet[2]); else u.player.value.set(0, -1e4, 0);

  // 足跡：地面や草地の上を歩幅ぶん進むたびに、左右交互に1つ押す
  if (walking && wk.onGround && $('footOn').checked && data.hasLabels) {
    const [x, , z] = wk.feet;
    fx.follow(x, z);
    if (Number.isNaN(lastStep.x)) { lastStep.x = x; lastStep.z = z; }
    const dx = x - lastStep.x, dz = z - lastStep.z, d = Math.hypot(dx, dz);
    if (d > 3) { lastStep.x = x; lastStep.z = z; } // 跳んだ・視点を移した
    else if (d >= STRIDE) {
      const t = wk.groundTri, type = t >= 0 ? TYPE_BY_ID.get(a.walk.W.typeId[t]) : null;
      if (type && type.tracks) { lastStep.side = -lastStep.side; fx.stamp(x - dz / d * FOOT_SIDE * lastStep.side, z + dx / d * FOOT_SIDE * lastStep.side, dx, dz); }
      lastStep.x = x; lastStep.z = z;
    }
  } else lastStep.x = NaN;

  // 時計：進めた時刻から光を決める。影用の地図は 0.1 秒に 1 回まで作り直す
  if (clock.playing) {
    clock.hour = (clock.hour + dt * 24 / clock.dayLength) % 24;
    Object.assign(light, dayLight(clock.hour)); applyLight();
    if (now - lastSunAt > 100) { lastSunAt = now; updateSun(); }
    if (now - lastClockShown > 250) { lastClockShown = now; showLight(); }
  }
}

function applyUi() {
  const a = app; if (!a) return;
  uSize.value = Number($('size').value); $('oSize').textContent = `${uSize.value.toFixed(2)} 倍`;
  uEdge.value = Number($('edge').value); $('oEdge').textContent = uEdge.value ? `${uEdge.value} 画素` : '消さない';
  uSky.value = ui.skyMode === 'wall' ? 1 : 0; uDome.value = ui.skyMode === 'dome' ? 1 : 0;
  if (a.sky) a.sky.sprite.visible = ui.skyMode === 'dome';
  $('skyBox').hidden = ui.skyMode !== 'dome';
  $('oSkyMargin').textContent = `${$('skyMargin').value} 画素`; $('oSkyMottle').textContent = `${Number($('skyMottle').value).toFixed(1)} 倍`;
  uView.value = ui.source === 'all' ? -1 : Number(ui.source);
  uShape.value = ui.shape === 'surfel' ? 1 : 0;
  a.scene.background = new THREE.Color($('holes').checked ? BG_HOLES : BG);
  a.wire.visible = $('wire').checked; a.frusta.visible = $('frusta').checked;
  a.sprite.material = ui.order === 'opaque' ? a.mats.hard : a.mats.soft;
  a.controls.enabled = ui.nav === 'orbit';
  // 動き：切ってあれば強さ 0。表示の種類によっては、色の効果（風の照り・足跡の暗さ）を掛けない
  const u = fx.u, moving = data.hasLabels;
  u.wind.value = moving && $('windOn').checked ? Number($('windK').value) : 0;
  u.windSpeed.value = Number($('windSpeed').value);
  const wa = Number($('windDir').value) * Math.PI / 180; u.windDir.value.set(Math.sin(wa), Math.cos(wa));
  u.part.value = moving && $('partOn').checked ? 0.45 : 0; u.partRadius.value = Number($('partR').value);
  u.foot.value = moving && $('footOn').checked ? 0.5 : 0; u.footShow.value = moving && $('footShow').checked ? 1 : 0;
  u.show.value = SHADER_SHOW[ui.mode] || 0; u.colorFx.value = COLOR_FX.has(ui.mode) ? 1 : 0;
  $('oWindK').textContent = `${Math.round(Number($('windK').value) * 100)} cm`; $('oWindSpeed').textContent = `${Number($('windSpeed').value).toFixed(1)} 倍`;
  $('oWindDir').textContent = `${$('windDir').value}°`; $('oPartR').textContent = `${Number($('partR').value).toFixed(1)} m`;
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

// SHARP の粒の読み込み結果（倍率と、札をどう取ったか）
function showSharpInfo() {
  const lines = [];
  for (const v of data.views) {
    if (!v.sharp) continue;
    const st = v.sharpStats, used = data.hasSharp && ui.placement !== 'depth';
    let t = `${v.def.name}：${(v.sharp.count / 10000).toFixed(1)} 万粒、奥行きの絵に合わせる倍率 ${v.sharpScale !== undefined ? v.sharpScale.toFixed(2) : '–'}`;
    if (used && st) t += `。視点の外 ${pct(st.outside, st.count)}、奥行きの絵と合わない ${pct(st.behind, st.count)}、そのうち札を近くから取れなかった ${pct(st.guessed, st.count)}、手前と奥をつなぐ膜 ${pct(st.sheets, st.count)}（「境界の粒を消す」で消える）`;
    lines.push(t);
  }
  $('sharpInfo').textContent = lines.join('\n');
}
const pct = (a, b) => `${b ? Math.round(a / b * 1000) / 10 : 0}%`;
// 背後の層の結果
function showLayerInfo() {
  const lines = backInfo.views.map((b) => `${b.name}：${b.count < 1000 ? `${b.count} 粒` : `${(b.count / 10000).toFixed(1)} 万粒`}${b.ai ? '（色は AI が描いた背景）' : ''}${b.refined !== undefined ? `（位置は背景の絵から推定：${Math.round(100 * b.refined / Math.max(1, b.refined + b.kept))}%）` : ''}${b.covered ? `（ほかの視点の絵に写っている ${(b.covered / 10000).toFixed(1)} 万粒は置かない）` : ''}`);
  $('layerInfo').textContent = !data.hasTypes ? '種類の札（X_type.png）が無いので、背後の層は作れません。' : !ui.back ? '' : lines.length ? lines.join('\n') : '背後の層を作れる視点がありません。';
  $('layerInfo').classList.toggle('warn', !data.hasTypes);
  showPlatePlan();
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
  { const b = document.createElement('button'); b.type = 'button'; b.dataset.v = String(surroundViewIndex()); b.textContent = '（周囲の地面）だけ'; b.setAttribute('aria-pressed', 'false'); src.append(b); }
  ui.source = 'all'; press(src, 'all');
  // 色のもと：どの視点にも無い絵は選べなくする。いま選んでいる絵が無くなっていたら、ある絵へ移す。
  const has = (key) => data.views.some((v) => v.colors[key]);
  for (const b of SRC_BUTTONS()) b.disabled = !has(b.dataset.v);
  if (!has(ui.colorSrc) || !setupViewButtons.done) ui.colorSrc = ['painted_flat', 'painted_lit', 'painted', 'previz'].find(has);
  setupViewButtons.done = true;
  setColorSrc(ui.colorSrc, false);
  const usable = (m) => !NEEDS_LABELS.has(m) || data.hasLabels || (TYPE_MODES.has(m) && data.hasTypes);
  for (const b of $('mode').children) b.disabled = !usable(b.dataset.v);
  if (!usable(ui.mode)) { ui.mode = 'color'; press($('mode'), ui.mode); }
  // SHARP の粒：視点ごとの出し入れのボタンと、置き方のボタン。初めて読めたときは SHARP だけを見せる
  data.views.forEach((v, i) => {
    if (!v.sharp) return;
    const b = document.createElement('button'); b.type = 'button'; b.dataset.v = String(sharpViewIndex(i)); b.textContent = `${v.def.name}（SHARP）だけ`; b.setAttribute('aria-pressed', 'false'); src.append(b);
  });
  if (data.hasTypes) data.views.forEach((v, i) => { // 背後の層の粒だけを見るボタン
    if (v.onlyNew) return;
    const b = document.createElement('button'); b.type = 'button'; b.dataset.v = String(backViewIndex(i)); b.textContent = `${v.def.name}（背後の層）だけ`; b.setAttribute('aria-pressed', 'false'); src.append(b);
  });
  for (const b of $('placement').children) b.disabled = b.dataset.v !== 'depth' && !data.hasSharp;
  if (!data.hasSharp) ui.placement = 'depth';
  else if (!setupViewButtons.sharpSeen) ui.placement = 'sharp';
  setupViewButtons.sharpSeen = data.hasSharp;
  press($('placement'), ui.placement);
  $('sharpBox').hidden = !data.hasSharp; $('sharpNone').hidden = data.hasSharp;
  $('lightBox').hidden = $('moveBox').hidden = !data.hasLabels;
}
const SRC_BUTTONS = () => [...$('colorSrc').children, ...$('colorSrc2').children];
function setColorSrc(v, andRebuild = true) {
  ui.colorSrc = v;
  for (const b of SRC_BUTTONS()) b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
  ui.paintLight = SOURCES[v].light; press($('paintLight'), ui.paintLight); applyLight(); // その絵が描かれたときの光の見立て
  if (andRebuild) rebuild();
}
const refill = () => { if (app) { sendSource(); requestSort(); sendSky(); } };
// 表示を切り替える。色の作り方が同じ表示どうし（絵のままの色 ⇔ 光を変えた後 など）は、シェーダーの切り替えだけで済ませる
function setMode(v) { const same = DISPLAY[v] === DISPLAY[ui.mode]; ui.mode = v; applyUi(); if (!same) refill(); }
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
  const h = clock.hour, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  $('hour').value = h; $('oHour').textContent = clock.manual ? '手で調整中' : `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}${light.moon ? '（月）' : ''}`;
  $('play').textContent = clock.playing ? '時間を止める' : '時間を進める'; $('play').setAttribute('aria-pressed', clock.playing ? 'true' : 'false');
  $('dayLength').value = clock.dayLength; $('oDayLength').textContent = `${clock.dayLength} 秒`;
}
function setLight(values, sunMoved) { // 光のつまみを手で動かした：時計は止める
  clock.playing = false; clock.manual = true;
  Object.assign(light, values); showLight(); applyLight();
  showRelit();
  if (sunMoved) updateSun();
}
function showRelit() { if (ui.mode === 'color') { ui.mode = 'relit'; press($('mode'), ui.mode); applyUi(); } } // 光を触ったら、変えた後の色を見せる
function setHour(h) { // 時刻を決める：光は1日の光（shared/light.js の dayLight）から
  clock.hour = ((h % 24) + 24) % 24; clock.manual = false;
  Object.assign(light, dayLight(clock.hour)); showLight(); applyLight(); showRelit();
  return updateSun();
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
  } else setHour(PRESET_HOURS[b.dataset.v]);
});
$('hour').addEventListener('input', () => { clock.playing = false; setHour(Number($('hour').value)); });
$('play').addEventListener('click', () => {
  clock.playing = !clock.playing;
  if (clock.playing) { if (clock.manual) setHour(clock.hour); clock.playing = true; }
  showLight();
});
$('dayLength').addEventListener('input', () => { clock.dayLength = Number($('dayLength').value); showLight(); });
seg('paintLight', (v) => { ui.paintLight = v; applyLight(); });

for (const id of ['colorSrc', 'colorSrc2']) $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) setColorSrc(b.dataset.v); });
seg('source', (v) => { ui.source = v; applyUi(); refreshSky(); });
seg('nav', setNav);
seg('mode', setMode);
seg('stride', (v) => { ui.stride = Number(v); rebuild(); });
seg('placement', (v) => { ui.placement = v; rebuild(); });
$('sharpFit').addEventListener('change', () => { ui.sharpFit = $('sharpFit').checked; rebuild(); });
// 角度を変えたときの崩れを減らす設定。形の切り替えは描き方だけ。ほかは粒を作り直す（つまみは離したときに）
seg('shape', (v) => { ui.shape = v; applyUi(); });
function showLayerUi() { $('oStretch').textContent = `${$('stretch').value} 倍まで`; $('oHalo').textContent = Number($('halo').value) ? `${$('halo').value} 画素` : '塗り直さない'; }
for (const id of ['stretch', 'halo']) { $(id).addEventListener('input', showLayerUi); $(id).addEventListener('change', () => { ui[id] = Number($(id).value); rebuild(); }); }
$('back').addEventListener('change', () => { ui.back = $('back').checked; rebuild(); });
$('plateUse').addEventListener('change', () => { ui.plate = $('plateUse').checked; rebuild(); });
$('platePaint').addEventListener('click', () => paintPlate(false));
$('plateDry').addEventListener('click', () => paintPlate(true));
$('plateStopBtn').addEventListener('click', () => { plateStop = true; });
$('plateForget').addEventListener('click', forgetPlate);
$('plateSharp').addEventListener('click', sharpPlate);
seg('walkShape', (v) => { ui.walkShape = v; rebuild(); });
for (const [id, key] of [['surround', 'surround'], ['surroundFill', 'surroundFill'], ['surroundAi', 'surroundAi']]) $(id).addEventListener('change', () => { ui[key] = $(id).checked; rebuild(); });
$('groundPaint').addEventListener('click', () => paintGround(false));
$('groundDry').addEventListener('click', () => paintGround(true));
$('groundStopBtn').addEventListener('click', () => { groundStop = true; });
$('groundForget').addEventListener('click', forgetGround);
$('estimateExport').addEventListener('click', exportEstimate);
seg('backDepth', (v) => { ui.backDepth = v; rebuild(); });
showLayerUi();
seg('order', (v) => {
  ui.order = v; if (!app) return;
  requestSort(); applyUi();
});
$('jump').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { jump(b.dataset.v); if (ui.nav === 'walk') placeAtCamera(); } });
for (const id of ['size', 'edge', 'windK', 'windSpeed', 'windDir', 'partR']) $(id).addEventListener('input', applyUi);
for (const id of ['holes', 'wire', 'frusta', 'shapes', 'third', 'windOn', 'partOn', 'footOn', 'footShow']) $(id).addEventListener('change', applyUi);
$('footClear').addEventListener('click', () => { if (app) fx.clearFootprints(app.camera.position.x, app.camera.position.z); });
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
// 空の操作
seg('skyMode', (v) => { const was = ui.skyMode; ui.skyMode = v; if ((was === 'wall') !== (v === 'wall')) rebuild(); else { applyUi(); refreshSky(); } }); // 「遠くの壁」との行き来は、粒の雲を作り直す
seg('skyStep', (v) => { ui.skyStep = Number(v); refreshSky(); });
for (const id of ['skyFill', 'skyAi']) $(id).addEventListener('change', () => refreshSky());
for (const id of ['skyMargin', 'skyMottle']) { $(id).addEventListener('input', applyUi); $(id).addEventListener('change', () => { refreshSky(); if (id === 'skyMargin') showSkyPlan(); }); }
$('skyPaint').addEventListener('click', () => paintSky(false));
$('skyDry').addEventListener('click', () => paintSky(true));
$('skyStopBtn').addEventListener('click', () => { skyStop = true; });
$('skyForget').addEventListener('click', forgetSky);
$('reload').addEventListener('click', () => { data = null; rebuild(); });
$('swap').addEventListener('click', () => start(!forceGL).catch(fail));
new ResizeObserver(layout).observe(stage);

press($('stride'), ui.stride);
press($('skyStep'), ui.skyStep);
showLight();
start(forceGL).catch(fail);
