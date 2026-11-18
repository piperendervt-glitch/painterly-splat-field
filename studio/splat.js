// 粒の空間：書き出した奥行き・カメラ情報と、絵（絵画 or プレビズの色）から、1画素を1粒として3D空間に置いて見る。
// 置き方は cameras.json の projection のとおり。プレビズの形そのものは使わない（線で重ねる確かめ用を除く）。
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, uniform, uv, vec2, vec3, vec4, float, step, exp, mix, max, abs, fract, sqrt, atan, dot, clamp, sin, cos, cameraViewMatrix, varying, texture } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildScene, PAINT_SUN } from '../previz/scene.js';
import { labelScene, renderSunMap, sunVisibility } from '../previz/gbuffer.js';
import { TYPES, SKY_TYPE, hexToRgb, objectColor, typeByKey } from '../shared/labels.js';
import { parsePly, checkSharp, sharpScale, splatsFromSharp, sharpGrid, sharpBack, sharpBackSplats } from './sharp.js';
import { SIGMA_K, BACK_RING, BACK_BEHIND, surfelCov, roundCov, viewNormal, frontTable, backLayer, backSplats, plateRequest, withPlate, refineBackDepth, gridToPixels } from './layers.js';
import { FLAT_LIGHT, LIT_LIGHT, PRESET_HOURS, dayLight, sunDirection } from '../shared/light.js';
import { createWalk } from './walk.js';
import { backgroundMesh, objectBoxes, toObj } from './estimate.js';
import { createFx, KIND, MOTION, SUN_MAP_SIZE } from './fx.js';
import { createJiggle, pickDepth, BRUSH_MODES } from './jiggle.js';
import { WORLD_PROPS, worldKind, worldTransform, fitWorldScale, splatsFromWorld } from './worldimport.js';
import { objectTargets, cutoutImage, meshPoints, plyPoints, fitContext, fitModel, modelSplats, inflateSplats } from './objectmodel.js';
import { createMover, assignSlots, slotFor, attachPhysics, SLOTS, PUSH_MASS } from './interact.js';
import { layoutFrame, worldShapes, shapeEdges, project as projectTo, rasterLayout, compareLayout, briefText } from './layoutai.js';
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

// 物を切り出して動かす：seg = 物の切り分けの版（depth = 奥行きで分けた今までの版 / sam3 = SAM 3 で切り抜いた版。painting/build.mjs --variant）、
// move = 歩く画面で物を持つ・動かす・消す（studio/interact.js）。trees = 木も動かせる物にする、boxes = 当たりの箱を表示する
ui.seg = 'depth'; ui.move = { on: true, trees: false, boxes: false };
try { const v = JSON.parse(localStorage.getItem('psf-parts') || '{}'); if (v.seg) ui.seg = v.seg; Object.assign(ui.move, v.move || {}); } catch { /* 無ければ最初の値 */ }
const saveParts = () => { try { localStorage.setItem('psf-parts', JSON.stringify({ seg: ui.seg, move: ui.move })); } catch { /* 保存できなくても動く */ } };
const mover = createMover(); // 動かせる物の変換の絵（シェーダーと並べ直しで使う）
let inter = null;            // 物理と操作（studio/interact.js の attachPhysics）

// 実在の絵から作った場面（painting/build.mjs）の種類の名前を、shared/labels.js の種類へ読み替える
const PAINT_TYPE_KEYS = { sky: 'sky', ground: 'grass', water: 'water', figure: 'figure', far: 'far', tree: 'leaves' };
// いまの光。方位・高さは度。色は sRGB の #rrggbb。bands は明暗の段階の数（0 = なめらか）。maxGain は明るくする上限（倍）。
const light = { azimuth: PAINT_SUN.azimuth, elevation: PAINT_SUN.elevation, sun: LIT_LIGHT.sun, sunColor: '#ffffff', sky: LIT_LIGHT.ambient, skyColor: '#ffffff', bands: 0, maxGain: 4 };
const uSkyYaw = uniform(0); // 天球を回した角度（雲を流す）
const uSize = uniform(2.6), uEdge = uniform(1), uSky = uniform(1), uView = uniform(-1), uShape = uniform(1), uDome = uniform(1);

// 動きと光（風・草よけ・足跡・光の付け替え）をシェーダーで付ける部品。足跡は作り直しても残るよう、ここで1つだけ持つ。
const fx = createFx();
// 触って揺らす（ブラシ・体で押すと、ばねで戻りながら揺れる）。粒を作り直すたびに attach し直す
const jiggle = createJiggle();
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
  // 物の切り分けの版：SAM 3 で切り抜いた版を選んでいて、その版があれば、奥行き・種類・物体の絵をその版に替える
  const parts = state.parts || { seg: {}, obj3d: [], full: [] };
  let segDoc = null;
  if (ui.seg !== 'depth' && parts.seg[ui.seg]) { const r = await fetch(`/files/previz-export/${parts.seg[ui.seg]}`, { cache: 'no-store' }); if (r.ok) segDoc = await r.json(); }
  const segUsed = segDoc ? ui.seg : 'depth';
  if (segDoc) cams.views = cams.views.map((v, i) => (i ? v : { ...v, ...segDoc.files }));
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
  return { cams, views, hasLabels: views.every((v) => v.hasLabels), hasTypes: views.every((v) => v.hasTypes), hasSharp: views.some((v) => v.sharp), skyAiFiles: state.sky_ai || {}, skyAi: {}, skyAiVersion: 0, groundAiFiles: state.ground_ai || {}, groundAi: {}, layoutAiFile: !!state.layout_ai, worldFile: !!state.world, objectFiles: state.objects || {}, painting: views.some((v) => v.painting),
    parts, segUsed, segObjects: segDoc ? segDoc.objects : (cams.objects || []) };
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
  view: { type: Uint16Array, size: 1, default: 0 },      // どの視点（や穴埋めの回）から来たか。視点を足し続けても足りるように 16 ビット
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
function splatsFromView(v, vi, stride, src, back = null, hide = null) {
  const { W, H, z, edge, near, far } = v, { fx, fy, cx, cy } = v.def.intrinsics;
  const max = Math.ceil(W / stride) * Math.ceil(H / stride);
  const col = { position: new Float32Array(max * 3), size: new Float32Array(max), color: new Uint8Array(max * 3), edge: new Uint8Array(max), sky: new Uint8Array(max), view: new Uint16Array(max).fill(vi), depthGray: new Uint8Array(max), cov: new Float32Array(max * 6) };
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
    if (hide && v.hasTypes && hide.has(v.object[i]) && FRONT[v.type[i]]) continue; // 3D モデルに置き換えた物体
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
// 粒の列から、3D モデルに置き換えた物体（手前の物）の粒を除く
function dropObjects(part, hide) {
  const c = part.columns; if (!c.object || !c.type) return part;
  let k = 0;
  for (let i = 0; i < part.count; i++) {
    if (hide.has(c.object[i]) && FRONT[c.type[i]]) continue;
    if (k !== i) for (const [name, d] of Object.entries(COLUMNS)) { const a = c[name]; if (a) for (let j = 0; j < d.size; j++) a[k * d.size + j] = a[i * d.size + j]; }
    k++;
  }
  return { ...part, count: k };
}
function sharpParts(withBack, hide = null) {
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
    out.push(hide ? dropObjects(p, hide) : p);
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
  const parts = [], things = objectSplats(), hide = things.length && ui.objects.replace ? new Set(things.map((t) => t.id).filter(Boolean)) : null;
  if (placement !== 'sharp') data.views.forEach((v, vi) => {
    const back = withBack && !v.onlyNew ? backOf(v, ui.colorSrc) : null; // 穴埋めで足した視点（穴の所だけの絵）には作らない
    parts.push(splatsFromView(v, vi, ui.stride, ui.colorSrc, back, hide));
    if (!back) return;
    const b = backSplats(v, back, backViewIndex(vi), ui.stride, { ...SPLAT_OPTS(), others: data.views.filter((o) => o !== v) });
    parts.push(b);
    backInfo.views.push({ name: v.def.name, count: b.count, covered: b.covered, stats: back.stats, ai: back.used !== undefined, refined: back.refined, kept: back.kept });
  });
  if (placement !== 'depth') parts.push(...sharpParts(withBack && placement === 'sharp', hide));
  const around = surroundSplats(); if (around) parts.push(around);
  const outer = worldSplats(); if (outer) parts.push(outer);
  parts.push(...things);
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

const MOTION_OF = new Map(TYPES.map((t) => [t.id, MOTION[t.motion] || 0]));
const MOTION_TINTS = [null, [0.75, 0.95, 0.2], [0.1, 0.75, 0.35], [0.7, 0.42, 0.2], [0.2, 0.5, 1], [1, 1, 1]];
const DISPLAY = {
  color: painted,                                                                                     // 絵のままの色
  relit: painted,                                                                                     // 光を変えた後（色はシェーダーが掛ける）
  relitCpu: relit,
  jiggle: painted,                                                                                    // ブラシで動いた量（色はシェーダーが付ける）
  jiggleSpeed: painted,                                                                               // いま動いている粒（同上）
  windKind: (c, i, out) => { // 風での動き方：草 黄緑・木の葉 緑・幹 茶・水面 青・雲と空 白。動かない粒は暗い灰色
    const m = MOTION_OF.get(c.type[i]) || 0, t = MOTION_TINTS[m], l = 0.35 + 0.65 * luma(c, i);
    if (!m) return gray(out, 0.03 + 0.12 * luma(c, i));
    out[0] = LIN[t[0] * 255 | 0] * l; out[1] = LIN[t[1] * 255 | 0] * l; out[2] = LIN[t[2] * 255 | 0] * l;
  },                                                                                    // 確かめ用：同じ式を CPU で計算したもの
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
    if (c.layer[i] === 4) { out[0] = l * 0.25; out[1] = l; out[2] = l * 0.25; }                            // 物体のモデルは緑
    else if (c.layer[i] === 3) { out[0] = l; out[1] = l * 0.3; out[2] = l * 0.8; }                         // 取り込んだ世界は桃色
    else if (c.layer[i] === 2) { out[0] = l * 0.1; out[1] = l * 0.8; out[2] = l; }                         // 周囲の地面は水色
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
const NEEDS_LABELS = new Set(['relit', 'sway', 'windKind', 'type', 'typeMix', 'object', 'normal', 'sun0', 'sunNow', 'labelEdge', 'layer']);
const TYPE_MODES = new Set(['windKind', 'type', 'typeMix', 'object', 'labelEdge', 'layer']); // 種類と物体の札だけで出せる表示（実在の絵の場面でも使える）
const SHADER_SHOW = { relit: 1, sunNow: 2, jiggle: 3, jiggleSpeed: 4 };     // シェーダー側で色を作る表示
const COLOR_FX = new Set(['color', 'relit']);    // 風の照りと足跡の色を掛ける表示
const KIND_OF = new Map(TYPES.map((t) => [t.id, KIND[t.light] + (t.tracks ? 4 : 0) + 8 * (MOTION[t.motion] || 0)]));

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
//   E = [形 xx, xy, xz, yy]  F = [形 yz, zz, 粒の元の番号, 空き]（粒の形の共分散。makeMaterials で画面の上の楕円に直す）
// 遠い順（視点からの距離）に並べ直すのは別の糸（studio/sortworker.js）で行い、描画は止めない。
// ここでは、粒の元の並びのまま描画用の値を作って渡す（表示・粒を変えたときだけ。光や動きは描くときに付けるので送り直さない）。
const OPACITY_PACK = 0.45; // B.w の小数部に「1 − 不透明さ」をこの幅で詰める（境界の判定 step(uEdge, B.w + 0.5) を変えない幅）
function sendSource() {
  const a = app, c = cloud; if (!a || !c) return;
  const n = c.n, P = new Float32Array(n * 4), B = new Float32Array(n * 4), C = new Float32Array(n * 4), D = new Float32Array(n * 4), E = new Float32Array(n * 4), F = new Float32Array(n * 4);
  prepareLight();
  const display = DISPLAY[ui.mode] || DISPLAY.color, rgb = [0, 0, 0], labels = data.hasLabels, types = !!c.type;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    P[o] = c.position[i * 3]; P[o + 1] = c.position[i * 3 + 1]; P[o + 2] = c.position[i * 3 + 2]; P[o + 3] = c.size[i];
    display(c, i, rgb);
    B[o] = rgb[0]; B[o + 1] = rgb[1]; B[o + 2] = rgb[2]; B[o + 3] = c.edge[i] + (1 - c.opacity[i] / 255) * OPACITY_PACK; // 境界からの距離（整数）＋ 透けぐあい（小数）
    C[o] = c.sky[i]; C[o + 1] = c.view[i];
    E[o] = c.cov[i * 6]; E[o + 1] = c.cov[i * 6 + 1]; E[o + 2] = c.cov[i * 6 + 2]; E[o + 3] = c.cov[i * 6 + 3]; F[o] = c.cov[i * 6 + 4]; F[o + 1] = c.cov[i * 6 + 5];
    F[o + 2] = i; // 粒の元の番号（並べ直しても、触って揺らすずれの画像を引けるように）
    F[o + 3] = slotFor(mover, c, i, FRONT); // 動かせる物の枠（0 = 動かない。studio/interact.js）
    if (types) { C[o + 2] = c.sway[i] / 255; C[o + 3] = KIND_OF.get(c.type[i]) || 0; } // 種類の札だけの場面（実在の絵）でも風で揺らす
    if (labels) {
      C[o + 2] = c.sway[i] / 255; C[o + 3] = KIND_OF.get(c.type[i]) || 0;
      D[o] = c.normal[i * 3] / 127; D[o + 1] = c.normal[i * 3 + 1] / 127; D[o + 2] = c.normal[i * 3 + 2] / 127; D[o + 3] = c.sunVis0[i] / 255;
    }
  }
  const arrays = [P, B, C, D, E, F];
  a.sorter.worker.postMessage({ type: 'source', arrays }, arrays.map((x) => x.buffer));
  sendMoves();
}
// 動かせる物の今の変換を、並べ直しの係にも渡す（動いた物の粒も遠い順に並ぶように）
function sendMoves() { const a = app; if (a && a.sorter) a.sorter.worker.postMessage({ type: 'xf', mats: mover.matrices() }); }
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
  const [P0, B, M, D0, E0, F0] = a.attrs.map((t) => instancedBufferAttribute(t));
  // 動かせる物：枠（F.w）の変換（studio/interact.js の絵）を、位置・面の向き・形に掛ける。枠 0 は単位行列
  const xv = F0.w.add(0.5).div(SLOTS), xr0 = texture(mover.tex, vec2(0.125, xv)), xr1 = texture(mover.tex, vec2(0.375, xv)), xr2 = texture(mover.tex, vec2(0.625, xv)), flags = texture(mover.tex, vec2(0.875, xv));
  const R0 = xr0.xyz, R1 = xr1.xyz, R2 = xr2.xyz, rot = (v) => vec3(dot(R0, v), dot(R1, v), dot(R2, v));
  const P = vec4(rot(P0.xyz).add(vec3(xr0.w, xr1.w, xr2.w)), P0.w), D = vec4(rot(D0.xyz), D0.w);
  // 形（共分散 S）：R S Rᵀ
  const S0o = vec3(E0.x, E0.y, E0.z), S1o = vec3(E0.y, E0.w, F0.x), S2o = vec3(E0.z, F0.x, F0.y);
  const T0 = vec3(dot(R0, S0o), dot(R0, S1o), dot(R0, S2o)), T1 = vec3(dot(R1, S0o), dot(R1, S1o), dot(R1, S2o)), T2 = vec3(dot(R2, S0o), dot(R2, S1o), dot(R2, S2o));
  const E = vec4(dot(T0, R0), dot(T0, R1), dot(T0, R2), dot(T1, R1)), F = vec4(dot(T1, R2), dot(T2, R2), F0.z, F0.w);
  const picked = varying(flags.y); // 選んでいる物（見ている物）は少し明るく、黄色に寄せる
  const jig = jiggle.offsetNodes(F0.z, P0.w);  // 触って揺らしたずれと、待機中のゆらぎ（studio/jiggle.js）
  const moved0 = fx.nodes(P, B, M, D, jig); // 風・草よけ・足跡・光の付け替え・触ったずれを掛けた位置と色
  const moved = { position: moved0.position, color: mix(moved0.color, moved0.color.mul(0.55).add(vec3(0.5, 0.42, 0.08)), picked.mul(0.6)) };
  const edgeOk = step(uEdge, B.w.add(0.5));                               // 境界から uEdge 画素以上はなれた粒だけ
  const skyOk = mix(float(1), uSky, M.x);                                 // 空の粒は uSky で出し入れ
  const viewOk = max(step(uView, -0.5), float(1).sub(step(0.5, abs(M.y.sub(uView))))); // 使う視点だけ
  const show = edgeOk.mul(skyOk).mul(viewOk).mul(flags.x); // flags.x = 0：消した物
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
  // 雲を流す：天球ごと風下へゆっくり回す（uSkyYaw）。雲のわき立ち：粒ごとにゆっくり揺らす（studio/fx.js の雲と同じ式）
  const cy = cos(uSkyYaw), sy = sin(uSkyYaw), ct = u.time.mul(u.cloudSpeed).mul(0.35), hd = fract(sin(dot(P.xyz, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const billow = vec3(sin(ct.add(P.y.mul(0.013)).add(hd.mul(6.283))), sin(ct.mul(0.7).add(P.x.mul(0.011))).mul(0.5), cos(ct.mul(0.8).add(P.z.mul(0.012)).add(hd.mul(3.0)))).mul(P.w).mul(u.cloud);
  mat.positionNode = vec3(P.x.mul(cy).sub(P.z.mul(sy)), P.y, P.x.mul(sy).add(P.z.mul(cy))).add(billow); mat.scaleNode = vec2(s, s);
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
    position: new Float32Array(n * 3), size: new Float32Array(n), color: new Uint8Array(n * 3), view: new Uint16Array(n).fill(surroundViewIndex()), depthGray: new Uint8Array(n),
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

// ---- 外で作った世界の取り込み（studio/worldimport.js） ----
// Marble や HunyuanWorld など、外の道具で作った世界の .ply を、位置と大きさを合わせてこの場面に重ねる。見比べ用。
const WORLD_DEFAULT = { show: true, frame: 'cv', scale: 1, yaw: 0, x: 0, y: 0, z: 0, point: 0.05 };
const world = { ply: null, name: '', kind: '', tried: false, count: 0, bounds: null, error: '' };
const worldViewIndex = () => data.views.length * 3 + 1;
ui.world = { ...WORLD_DEFAULT };
try { Object.assign(ui.world, JSON.parse(localStorage.getItem('psf-world') || '{}')); } catch { /* 無ければ最初の値 */ }
const saveWorld = () => { try { localStorage.setItem('psf-world', JSON.stringify(ui.world)); } catch { /* 保存できなくても動く */ } };
function setWorldPly(buffer, name) {
  const ply = parsePly(buffer, WORLD_PROPS);
  world.kind = worldKind(ply); world.ply = ply; world.name = name; world.error = '';
}
async function loadWorldFile() {
  if (world.tried || !data.worldFile) return;
  world.tried = true;
  try { const res = await fetch('/files/paint-out/world.ply', { cache: 'no-store' }); if (res.ok) setWorldPly(await res.arrayBuffer(), 'paint-out/world.ply'); }
  catch (e) { console.error(e); world.error = e.message; }
}
// 置き方：ずらす量は、絵の視点から見た 右 / 上 / 手前（m）
function worldPlacement() {
  const v = centerView(), w = ui.world, f = layoutFrame(v.c2w, 0);
  return worldTransform({ frame: w.frame, c2w: v.c2w, scale: w.scale, yawDeg: w.yaw, offset: [f.right[0] * w.x - f.fwd[0] * w.z, w.y, f.right[2] * w.x - f.fwd[2] * w.z] });
}
function worldSplats() {
  if (!world.ply || !ui.world.show || !data) return null;
  const out = splatsFromWorld(world.ply, worldPlacement(), worldViewIndex(), { keep: Math.max(1, (ui.stride / 2) ** 2), pointSize: ui.world.point, edgeMax: EDGE_MAX, labelEdgeMax: LABEL_EDGE_MAX });
  world.count = out.count; world.bounds = out.bounds;
  return out;
}
function showWorld() {
  const w = ui.world, has = !!world.ply, r = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
  $('worldBox').hidden = !has; $('worldPointBox').hidden = world.kind !== 'points';
  $('worldShow').checked = w.show; press($('worldFrame'), w.frame);
  $('worldScale').value = String(Math.log10(w.scale)); $('oWorldScale').textContent = `${w.scale >= 10 ? w.scale.toFixed(1) : w.scale.toFixed(3)} 倍`;
  $('worldYaw').value = String(w.yaw); $('oWorldYaw').textContent = `${w.yaw}°`;
  $('worldX').value = String(w.x); $('worldY').value = String(w.y); $('worldZ').value = String(w.z); $('oWorldOffset').textContent = `${r(w.x)} / ${r(w.y)} / ${r(w.z)} m`;
  $('worldPoint').value = String(w.point); $('oWorldPoint').textContent = `${Math.round(w.point * 1000) / 10} cm`;
  const b = world.bounds;
  $('worldInfo').textContent = world.error ? `読めませんでした：${world.error}` : !has ? 'まだ読み込んでいません。'
    : `${world.name}：${world.kind === 'gaussians' ? '3D ガウシアン' : '色つきの点'} ${world.ply.count.toLocaleString()} 個${w.show && b ? `（いま ${world.count.toLocaleString()} 粒。広がり 横 ${r(b.max[0] - b.min[0])} × 高さ ${r(b.max[1] - b.min[1])} × 奥 ${r(b.max[2] - b.min[2])} m）` : ''}`;
}

// ---- 物体ごとの 3D モデル（studio/objectmodel.js） ----
// 絵の中の物体を 1 つずつ切り抜いて外の道具で 3D モデルにしてもらい、それを絵の物体の輪郭に合わせて置いて、粒にする。
const objs = { models: new Map(), tried: false, lines: [], busy: '' }; // models：物体の番号 → { name, meshes, isObj, fit, key, error }
const objectViewIndex = () => data.views.length * 3 + 2;
ui.objects = { show: true, replace: true, paint: true, inflate: false, adjust: {}, method: 'manual', full: true, texture: false }; // adjust：物体の番号 → { yaw（度。自動の向きに足す）, scale（自動の大きさに掛ける） }
try { Object.assign(ui.objects, JSON.parse(localStorage.getItem('psf-objects') || '{}')); } catch { /* 無ければ最初の値 */ }
const saveObjects = () => { try { localStorage.setItem('psf-objects', JSON.stringify(ui.objects)); } catch { /* 保存できなくても動く */ } };
const objectTargetList = () => { if (!data.objectTargets) { const v = centerView(); data.objectTargets = v.hasTypes ? objectTargets(v, { front: FRONT }) : []; } return data.objectTargets; };
const objectAdjust = (id) => ui.objects.adjust[id] || { yaw: 0, scale: 1 };
// モデルのファイル（.glb / .gltf / .obj）から、面の集まりを取り出す（位置・面の向き・UV・頂点の色・材質の色・絵）
async function loadModelMeshes(buffer, name) {
  const isObj = /\.obj$/i.test(name);
  let root;
  if (isObj) root = new OBJLoader().parse(new TextDecoder().decode(buffer));
  else { const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder); root = (await loader.parseAsync(buffer, '')).scene; }
  root.updateMatrixWorld(true);
  const meshes = [], tmp = new THREE.Vector3(), nm = new THREE.Matrix3(), texCache = new Map();
  const pixels = (tex) => { // 絵（テクスチャ）を画素の列にする。大きい絵は 1024 まで縮める
    if (!tex || !tex.image) return null;
    if (texCache.has(tex)) return texCache.get(tex);
    let out = null;
    try {
      const img = tex.image, k = Math.min(1, 1024 / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
      out = { w, h, data: g.getImageData(0, 0, w, h).data, flipY: !!tex.flipY };
    } catch (e) { console.warn('モデルの絵を読めませんでした', e); }
    texCache.set(tex, out); return out;
  };
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const g = o.geometry, pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv, ca = g.attributes.color, mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const positions = new Float32Array(pa.count * 3), normals = na ? new Float32Array(pa.count * 3) : null;
    nm.getNormalMatrix(o.matrixWorld);
    for (let i = 0; i < pa.count; i++) {
      tmp.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); positions[i * 3] = tmp.x; positions[i * 3 + 1] = tmp.y; positions[i * 3 + 2] = tmp.z;
      if (na) { tmp.fromBufferAttribute(na, i).applyMatrix3(nm).normalize(); normals[i * 3] = tmp.x; normals[i * 3 + 1] = tmp.y; normals[i * 3 + 2] = tmp.z; }
    }
    let uvs = null, colors = null;
    if (ua) { uvs = new Float32Array(pa.count * 2); for (let i = 0; i < pa.count; i++) { uvs[i * 2] = ua.getX(i); uvs[i * 2 + 1] = ua.getY(i); } }
    if (ca) { colors = new Float32Array(pa.count * 3); for (let i = 0; i < pa.count; i++) { colors[i * 3] = ca.getX(i); colors[i * 3 + 1] = ca.getY(i); colors[i * 3 + 2] = ca.getZ(i); } }
    meshes.push({ positions, normals, uvs, colors, colorSize: 3, indices: g.index ? Uint32Array.from(g.index.array) : null, base: mat && mat.color ? [mat.color.r, mat.color.g, mat.color.b] : null, tex: mat && uvs ? pixels(mat.map) : null });
  });
  if (!meshes.length) throw new Error('モデルに面がありません');
  return { name, meshes, isObj, fit: null, key: '', error: '' };
}
async function loadObjectFiles() {
  if (objs.tried) return;
  objs.tried = true;
  if (ui.objects.method !== 'manual') { // 外の道具（TRELLIS など）で作った、物ごとの 3D（paint/objects.mjs make3d）
    for (const e of (data.parts.obj3d || []).filter((x) => x.seg === data.segUsed && x.method === ui.objects.method)) {
      try {
        const name = e.glb || e.ply, res = await fetch(`/files/paint-out/${name}`, { cache: 'no-store' }); if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        objs.models.set(e.id, e.glb ? await loadModelMeshes(buf, name) : { name, ply: parsePly(buf), meshes: true, isPly: true, fit: null, key: '', error: '' });
      } catch (err) { console.error(err); objs.models.set(e.id, { name: e.glb || e.ply, meshes: null, error: err.message }); }
    }
    return;
  }
  for (const [id, name] of Object.entries(data.objectFiles || {})) {
    try { const res = await fetch(`/files/paint-out/${name}`, { cache: 'no-store' }); if (res.ok) objs.models.set(Number(id), await loadModelMeshes(await res.arrayBuffer(), name)); }
    catch (e) { console.error(e); objs.models.set(Number(id), { name, meshes: null, error: e.message }); }
  }
}
// モデルの表面の点（メッシュでも 3D の粒でも同じ形で）
const modelPoints = (model, n, up, seed = 1) => (model.isPly ? plyPoints(model.ply, n, { up, seed }) : meshPoints(model.meshes, n, { up, seed }));
// 物体 1 つぶんの置き方（向き・大きさ・位置）。色のもとや手での直しが同じなら作り直さない
function objectFit(target, model) {
  const v = centerView(), c = colorOf(v, ui.colorSrc), adj = objectAdjust(target.id), key = `${c.key}:${adj.yaw}:${adj.scale}`;
  if (model.fit && model.key === key) return model.fit;
  const cx = fitContext({ W: v.W, H: v.H, z: v.z, type: v.type, object: v.object, c2w: v.c2w, w2c: v.w2c, intr: v.def.intrinsics }, target, { px: c.px, front: FRONT });
  let best = null;
  for (const up of model.isObj || model.isPly ? ['y', 'z'] : ['y']) { // OBJ と 3D の粒（.ply）は上の向きが決まっていないので、両方試して合うほうを使う
    const pts = modelPoints(model, 12000, up), f = fitModel(pts, cx, { manual: adj.yaw * Math.PI / 180, scaleMul: adj.scale });
    if (!best || f.auto.iou > best.auto.iou) best = { ...f, up, height: pts.size[1] * f.scale, hasColor: pts.hasColor, area: pts.area };
  }
  let r = 0, g = 0, b = 0, k = 0; // 物体の絵の色の平均（モデルに色が無いときの、見えていない側の色）
  for (let o = 0; o < cx.mask.length; o++) if (cx.mask[o] === 1) { r += cx.pc[o * 3]; g += cx.pc[o * 3 + 1]; b += cx.pc[o * 3 + 2]; k++; }
  best.fallback = k ? [r / k, g / k, b / k] : [128, 128, 128];
  model.fit = best; model.key = key;
  return best;
}
function objectSplats() {
  objs.lines = [];
  if (!data || (!objs.models.size && !ui.objects.inflate) || !centerView().hasTypes) return [];
  const v = centerView(), c = colorOf(v, ui.colorSrc), view = { W: v.W, H: v.H, z: v.z, type: v.type, object: v.object, c2w: v.c2w, w2c: v.w2c, intr: v.def.intrinsics, near: v.near, far: v.far }, out = [];
  for (const target of objectTargetList()) {
    const model = objs.models.get(target.id), kind = TYPE_BY_ID.get(target.typeId) || {};
    if (!model) { // モデルが無い物体：輪郭をふくらませた形（入れてあれば）
      if (!ui.objects.inflate) continue;
      const board = !!data.painting; // 絵から作った場面は、物体が 1 枚の板として置いてある
      const p = inflateSplats(view, target, c.px, { stride: ui.stride, board, sway: Math.round((kind.sway || 0) * 255), viewId: objectViewIndex(), maxStretch: Math.min(ui.stretch, 6), edgeMax: EDGE_MAX, labelEdgeMax: LABEL_EDGE_MAX });
      objs.lines.push(`物体 ${target.id}（${kind.name || '?'}）：輪郭をふくらませた形（厚み 最大 ${(p.half * 2).toFixed(2)} m${board ? '' : '。裏側だけ足しました'}）`);
      if (ui.objects.show) out.push({ ...p, id: board ? target.id : 0 });
      continue;
    }
    if (!model.meshes) { objs.lines.push(`物体 ${target.id}：${model.name} を読めませんでした（${model.error}）`); continue; }
    try {
      const fit = objectFit(target, model), spacing = target.depth / view.intr.fx * ui.stride, n = Math.max(3000, Math.min(400000, Math.round(fit.area * fit.scale * fit.scale / (spacing * spacing))));
      const type = TYPE_BY_ID.get(target.typeId) || {};
      objs.lines.push(`物体 ${target.id}（${type.name || '?'}）：${model.name}。輪郭の重なり ${Math.round(fit.iou * 100)}%${fit.hasColor ? `、色の近さ ${Math.round(fit.colorSim * 100)}%` : '（モデルに色なし）'}、向き ${Math.round(fit.offset * 180 / Math.PI)}°、高さ ${fit.height.toFixed(2)} m${fit.up === 'z' ? '（+Z を上として読みました）' : ''}`);
      if (!ui.objects.show) continue;
      const pts = modelPoints(model, n, fit.up, 2);
      const p = modelSplats(pts, fit, view, target, { spacing, px: c.px, paint: ui.objects.paint, sway: Math.round((type.sway || 0) * 255), viewId: objectViewIndex(), fallback: fit.fallback, edgeMax: EDGE_MAX, labelEdgeMax: LABEL_EDGE_MAX });
      out.push({ ...p, id: target.id });
    } catch (e) { console.error(e); objs.lines.push(`物体 ${target.id}：${model.name} を置けませんでした（${e.message}）`); }
  }
  return out;
}
const OBJ_SIDE = (t, W) => { const x = (t.x0 + t.x1) / 2 / W; return x < 0.33 ? '絵の左' : x > 0.67 ? '絵の右' : '絵のまん中'; };
function showObjects() {
  const box = $('objBox'); if (!box || !data) return;
  const targets = objectTargetList(), pick = $('objPick'), v = centerView();
  $('objNone').hidden = targets.length > 0; box.hidden = !targets.length;
  if (!targets.length) return;
  const cur = pick.value;
  pick.replaceChildren(...targets.map((t) => { const o = document.createElement('option'); o.value = String(t.id); o.textContent = `物体 ${t.id}：${(TYPE_BY_ID.get(t.typeId) || {}).name || '?'}（${OBJ_SIDE(t, v.W)}、${t.depth.toFixed(1)} m 先${t.cut ? '、絵の端で切れている' : ''}）${objs.models.has(t.id) ? ' ●' : ''}`; return o; }));
  if (targets.some((t) => String(t.id) === cur)) pick.value = cur;
  const id = Number(pick.value), adj = objectAdjust(id), has = objs.models.has(id);
  $('objShow').checked = ui.objects.show; $('objReplace').checked = ui.objects.replace; $('objPaint').checked = ui.objects.paint; $('objInflate').checked = ui.objects.inflate;
  $('objAdjust').hidden = !has;
  $('objYaw').value = String(adj.yaw); $('oObjYaw').textContent = `${adj.yaw > 0 ? '+' : ''}${adj.yaw}°`;
  $('objScale').value = String(Math.log2(adj.scale)); $('oObjScale').textContent = `${adj.scale.toFixed(2)} 倍`;
  $('objInfo').textContent = objs.busy || (objs.lines.length ? objs.lines.join('\n') : `手前の物が ${targets.length} 個あります。まだモデルはありません。`);
}
// 物体ごとの切り抜きの絵（物体の外は透明）を paint-out に書く。外の道具（絵 1 枚 → 3D モデル）に渡す
async function exportObjectCutouts() {
  const v = centerView(), c = colorOf(v, ui.colorSrc), targets = objectTargetList(), list = [];
  for (const [k, t] of targets.entries()) {
    objs.busy = `切り抜きを書いています…（${k + 1} / ${targets.length}）`; showObjects();
    const cut = cutoutImage(v, t, c.px), name = `object_${t.id}.png`;
    const res = await fetch(`/api/paint-out/${name}`, { method: 'POST', body: await pngBlob(cut.rgba, cut.w, cut.h) });
    if (!res.ok) throw new Error(`${name} を保存できませんでした`);
    list.push({ id: t.id, image: name, model: `object_${t.id}.glb`, type: (TYPE_BY_ID.get(t.typeId) || {}).key, bbox: [t.bx0, t.by0, t.bx1, t.by1], depth_m: Math.round(t.depth * 100) / 100, cut_by_frame: t.cut });
    await sleep(0);
  }
  await fetch('/api/paint-out/objects.json', { method: 'POST', body: JSON.stringify({ note: 'object_<id>.png is the cut-out of one object (transparent outside). Save the 3D model made from it as object_<id>.glb (or .obj) in this folder.', source: c.key, objects: list }, null, 1) });
  objs.busy = ''; showObjects();
  $('objInfo').textContent = `切り抜きを ${list.length} 枚、paint-out フォルダに書きました（object_<番号>.png）。それぞれから作った 3D モデルを、同じフォルダに object_<番号>.glb の名前で置くか、下で選んでください。\n${objs.lines.join('\n')}`;
}
async function addObjectModel(id, file) {
  const ext = (/\.(glb|obj)$/i.exec(file.name) || [])[1];
  if (!ext) throw new Error('.glb か .obj のファイルを選んでください');
  const buffer = await file.arrayBuffer(), model = await loadModelMeshes(buffer, file.name);
  objs.models.set(id, model);
  // 次に開いたときも使えるように、paint-out に置く（大きすぎて置けなければ、この場だけ）
  try {
    await fetch(`/api/paint-out/object_${id}.${ext.toLowerCase() === 'glb' ? 'obj' : 'glb'}`, { method: 'DELETE' });
    const res = await fetch(`/api/paint-out/object_${id}.${ext.toLowerCase()}`, { method: 'POST', body: buffer });
    if (res.ok) model.name = `object_${id}.${ext.toLowerCase()}`;
  } catch (e) { console.warn(e); }
}
async function forgetObjectModel(id) {
  objs.models.delete(id);
  for (const ext of ['glb', 'obj']) await fetch(`/api/paint-out/object_${id}.${ext}`, { method: 'DELETE' }).catch(() => {});
}

// ---- 物を切り出して動かす（paint/objects.mjs、studio/interact.js、studio/physics.js） ----
const METHOD_NAMES = { manual: '手で選んだモデル', trellis: 'TRELLIS', hunyuan3d: 'Hunyuan3D', sam3d: 'SAM 3D Objects' };
const objLabel = (id) => { const o = (data.segObjects || []).find((x) => x.id === id); return o ? (o.label || o.type || '') : ''; };
// 動かせる物：手前の物（木は ui.move.trees のときだけ）で、300 画素以上
function movableList() {
  if (!ui.move.on || !data || !data.hasTypes) { mover.clear(); return []; }
  if (!data.moveTargets) { const v = centerView(); data.moveTargets = objectTargets(v, { front: FRONT, minPixels: 300 }); }
  const tree = new Set(['leaves', 'trunk']);
  return assignSlots(mover, data.moveTargets, (t) => ui.move.trees || !tree.has((TYPE_BY_ID.get(t.typeId) || {}).key));
}
async function setupMoves(a, scene, list) {
  $('moveInfo').textContent = '';
  if (!list.length) { if (ui.move.on && data.hasTypes) $('moveInfo').textContent = '動かせる物がありません。'; return; }
  try {
    const v = centerView(), eye = [v.c2w[3], v.c2w[7], v.c2w[11]], p = a.walk.wk.p;
    inter = await attachPhysics(mover, { cloud, list, front: FRONT, W: a.walk.W, kindOf: (t) => (TYPE_BY_ID.get(t) || {}).key || 'default', eye, scene, player: { radius: p.radius, height: p.height } });
    inter.boxes.visible = ui.move.boxes;
    const heavy = [...inter.phys.bodies.values()].filter((b) => b.mass >= PUSH_MASS).length;
    $('moveInfo').textContent = `動かせる物 ${inter.count} 個（重い物 ${heavy} 個は当たりで止まり、軽い物 ${inter.count - heavy} 個は体で押せます）。重さは種類と大きさからの見積もりです。`;
    sendMoves();
  } catch (e) { console.error(e); inter = null; $('moveInfo').textContent = `物理を用意できませんでした：${e.message}`; }
}
let lastAim = 0;
function moveStep(dt, now) {
  const a = app, wk = a.walk.wk, walking = ui.nav === 'walk' && !wk.noclip;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(a.camera.quaternion).toArray(), eye = a.camera.position.toArray();
  if (inter.update(dt, { walking, feet: wk.feet, eye, dir })) { sendMoves(); requestSort(); }
  const hud = $('moveHud'), cross = $('crosshair');
  hud.hidden = cross.hidden = ui.nav !== 'walk';
  if (ui.nav !== 'walk') { if (mover.select(0)) mover.tex.needsUpdate = true; return; }
  if (now - lastAim < 90) return;
  lastAim = now;
  const hit = inter.aim(eye, dir), held = inter.holding();
  hud.textContent = held !== null ? `物体 ${held}${objLabel(held) ? `（${objLabel(held)}）` : ''} を持っています ・ F で放す ・ G で投げる ・ ホイールで近づける / 遠ざける`
    : hit ? `物体 ${hit.id}${objLabel(hit.id) ? `（${objLabel(hit.id)}）` : ''}・${Math.round(inter.phys.mass(hit.id))} kg・${hit.dist.toFixed(1)} m ・ F で持つ ・ X で消す` : '';
}
function moveKey(code) {
  if (!inter || ui.nav !== 'walk') return false;
  const a = app, dir = new THREE.Vector3(0, 0, -1).applyQuaternion(a.camera.quaternion).toArray(), eye = a.camera.position.toArray();
  if (code === 'KeyF') { inter.grabOrDrop(eye, dir); return true; }
  if (code === 'KeyG') { inter.throwHeld(dir); return true; }
  if (code === 'KeyX') { inter.removeAimed(eye, dir); return true; }
  if (code === 'KeyZ') { inter.undoRemove(); return true; }
  if (code === 'KeyR') { inter.resetAll(); return true; }
  return false;
}

// 切り分けの版と、物の 3D の作り方の表示
function showParts() {
  if (!data) return;
  const has = data.parts.seg || {}, painting = !!data.painting;
  for (const b of $('segPick').children) b.disabled = b.dataset.v !== 'depth' && !has[b.dataset.v];
  press($('segPick'), data.segUsed);
  const so = data.segObjects || [], labels = so.filter((o) => o.label).length;
  $('segInfo').textContent = !painting ? '物の切り分けの版は、絵から作った場面（painting/build.mjs）だけで使えます。'
    : `いまの切り分け：${data.segUsed === 'depth' ? '奥行きで分けた（今まで）' : 'SAM 3 で切り抜いた'}。物体 ${so.length} 個${labels ? `（SAM 3 の切り抜き ${labels} 個：${[...new Set(so.filter((o) => o.label).map((o) => o.label))].join('、')}）` : ''}。${has.sam3 ? '' : 'SAM 3 の版はまだありません。'}`;
  $('segRun').disabled = !painting;
  press($('obj3dMethod'), ui.objects.method);
  const mine = (data.parts.obj3d || []).filter((e) => e.seg === data.segUsed), fulls = (data.parts.full || []).filter((e) => e.seg === data.segUsed);
  const count = (m) => mine.filter((e) => e.method === m).length;
  $('obj3dInfo').textContent = `この切り分けで作った 3D：${['trellis', 'hunyuan3d', 'sam3d'].map((m) => `${METHOD_NAMES[m]} ${count(m)} 個`).join('、')}。描き足した全身の絵 ${fulls.length} 枚。${ui.objects.method === 'manual' ? '' : `いまは ${METHOD_NAMES[ui.objects.method]} の 3D を置いています（無い物は、輪郭をふくらませた形か絵の粒のまま）。`}`;
  $('obj3dFull').checked = ui.objects.full; $('obj3dTexture').checked = ui.objects.texture;
  const targets = objectTargetList();
  $('fullAll').textContent = `手前の物を全部（${targets.length} 個）、Codex で描き足す（Codex ${targets.length} 回）`;
  $('obj3dAll').textContent = `手前の物を全部（${targets.length} 個）、この作り方で 3D にする`;
  for (const id of ['obj3dOne', 'obj3dAll']) $(id).disabled = ui.objects.method === 'manual';
  $('moveOn').checked = ui.move.on; $('moveTrees').checked = ui.move.trees; $('moveBoxes').checked = ui.move.boxes;
}
let partsJob = false, partsStop = false;
async function runParts(body, what) {
  if (partsJob) return;
  partsJob = true; partsStop = false;
  const log = (t) => { $('partsLog').hidden = false; $('partsLog').textContent = t; };
  $('partsStop').hidden = false;
  try {
    await api('/api/objects/run', body);
    let st;
    for (;;) { await sleep(1000); st = await (await fetch('/api/paint/status', { cache: 'no-store' })).json(); if (!st.running) break; if (partsStop) await api('/api/paint/stop'); log(`${what}（${st.seconds} 秒）\n${st.log.split('\n').slice(-12).join('\n')}`); }
    log(`${what}：${st.code === 0 ? '終わりました' : '止まりました'}\n${st.log.split('\n').slice(-16).join('\n')}`);
    if (st.code === 0 && !body.dryRun) { data = null; objs.tried = false; objs.models.clear(); partsJob = false; $('partsStop').hidden = true; rebuild(); return; }
  } catch (e) { log(`${what}：${e.message}`); }
  partsJob = false; $('partsStop').hidden = true;
}
const pickedIds = (all) => (all ? objectTargetList().map((t) => t.id) : [Number($('objPick').value)].filter(Boolean));

// ---- AI に形の配置を書かせる（Codex。絵は作らず、文だけ。studio/layoutai.js） ----
// 絵・奥行きの絵・カメラと奥行きの表を見せて、箱と円柱の一覧（layout_ai.json）を書いてもらう。
// 「見比べて直す」回は、今の配置を絵に線で重ねた絵と、奥行き・物の輪郭との見比べの文を見せて、書き直してもらう。いちばん合った回の配置を残す。
const layoutAi = { loaded: false, layout: null }; // layout = { objects, view, scores: [{ score, covered, precise, n }], best }
async function loadLayoutAi() {
  if (layoutAi.loaded) return layoutAi.layout;
  layoutAi.loaded = true;
  if (data.layoutAiFile) { try { const r = await fetch('/files/paint-out/layout_ai.json', { cache: 'no-store' }); layoutAi.layout = r.ok ? await r.json() : null; } catch { layoutAi.layout = null; } }
  if (layoutAi.layout && !Array.isArray(layoutAi.layout.objects)) layoutAi.layout = null;
  return layoutAi.layout;
}
const STONE_TYPE = typeByKey('stone').id;
function layoutContext() {
  const v = centerView(), baseY = data.baseY !== undefined ? data.baseY : (data.baseY = estimateModel().baseY);
  let thing = null;
  if (v.hasTypes) { thing = new Uint8Array(v.W * v.H); for (let i = 0; i < thing.length; i++) { const t = v.type[i]; thing[i] = !v.z[i] || !FRONT[t] ? 0 : (TYPE_BY_ID.get(t) || {}).solid === 'none' ? 2 : 1; } }
  return { v, frame: layoutFrame(v.c2w, baseY), view: { W: v.W, H: v.H, z: v.z, c2w: v.c2w, w2c: v.w2c, intr: v.def.intrinsics }, thing, object: v.hasTypes ? v.object : null, baseY };
}
// 当たりの形にする：背景の面は推定のもの、物は AI が書いた箱と円柱
function layoutModel() {
  const cx = layoutContext(), est = estimateModel();
  return { grounds: est.grounds, baseY: est.baseY, boxes: worldShapes(layoutAi.layout, cx.frame).map((s, i) => ({ ...s, typeId: STONE_TYPE, objectId: 1000 + i })) };
}
function scoreLayout(layout, cx) {
  const shapes = worldShapes(layout, cx.frame), cmp = compareLayout(shapes, rasterLayout(shapes, cx.view), cx.view, { thing: cx.thing, object: cx.object });
  return { shapes, cmp, row: { score: cmp.score, covered: cmp.covered, precise: cmp.precise, n: shapes.length } };
}
const LAYOUT_COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a', '#ff2d92', '#30d5c8', '#ff9f0a', '#bf5af2'];
// 絵に、今の配置を線で重ねる（形ごとに色と番号）
function layoutOverlay(cx, shapes, px) {
  const { W, H } = cx.view, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), a = [0, 0, 0], b = [0, 0, 0], NEAR = 0.1;
  g.putImageData(new ImageData(px instanceof Uint8ClampedArray ? px : new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), W, H), 0, 0);
  g.lineJoin = 'round'; g.font = `bold ${Math.round(W / 34)}px sans-serif`; g.textBaseline = 'top';
  shapes.forEach((s, k) => {
    const color = LAYOUT_COLORS[k % LAYOUT_COLORS.length];
    let x0 = Infinity, y0 = Infinity;
    for (const pass of [0, 1]) { // 先に黒いふち、次に色
      g.strokeStyle = pass ? color : 'rgba(0,0,0,0.75)'; g.lineWidth = pass ? Math.max(2, W / 400) : Math.max(4, W / 200);
      g.beginPath();
      for (const [p, q] of shapeEdges(s)) {
        projectTo(cx.view, p, a); projectTo(cx.view, q, b);
        if (a[2] <= NEAR && b[2] <= NEAR) continue;
        let P = p, Q = q;
        if (a[2] <= NEAR || b[2] <= NEAR) { // カメラの後ろへ回る辺は、手前の面で切る
          const t = (NEAR * 1.01 - a[2]) / (b[2] - a[2]), m = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
          if (a[2] <= NEAR) P = m; else Q = m;
          projectTo(cx.view, P, a); projectTo(cx.view, Q, b);
        }
        g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
        if (a[0] >= 0 && a[0] < W && a[1] >= 0 && a[1] < H && (a[1] < y0 || (a[1] === y0 && a[0] < x0))) { x0 = a[0]; y0 = a[1]; }
      }
      g.stroke();
    }
    if (x0 === Infinity) return;
    const label = String(k + 1), tw = g.measureText(label).width + 8, th = Math.round(W / 34) + 6, lx = Math.max(0, Math.min(W - tw, x0)), ly = Math.max(0, Math.min(H - th, y0 - th));
    g.fillStyle = 'rgba(0,0,0,0.8)'; g.fillRect(lx, ly, tw, th); g.fillStyle = color; g.fillText(label, lx + 4, ly + 3);
  });
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}
// AI に見せる奥行きの絵：近い = 白、遠い = 黒に近い灰色、空 = まっ黒
function layoutDepthImage(v) {
  const n = v.W * v.H, out = new Uint8ClampedArray(n * 4);
  let lo = Infinity, hi = 0; for (let i = 0; i < n; i++) { const z = v.z[i]; if (z) { if (z < lo) lo = z; if (z > hi) hi = z; } }
  const k = hi > lo ? 1 / Math.log(hi / lo) : 0;
  for (let i = 0; i < n; i++) { const z = v.z[i], g = z ? 40 + 215 * (1 - Math.log(z / lo) * k) : 0; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255; }
  return out;
}
function showLayoutAi() {
  if (!data || layoutJob) return;
  const L = layoutAi.layout, fixes = Number($('layoutFixes').value), pc = (x) => `${Math.round(100 * x)}%`;
  $('layoutPlan').textContent = `押すと、Codex を ${1 + fixes} 回呼びます（最初に書く 1 回${fixes ? ` + 見比べて直す ${fixes} 回` : ''}。絵は作らず文だけで、1 回 1〜3 分）。ChatGPT の利用枠を使います。`;
  $('layoutMore').disabled = !L; $('layoutForget').disabled = !L;
  const aiBtn = document.querySelector('#walkShape button[data-v=ai]'); if (aiBtn) aiBtn.disabled = !L;
  if (!L) { $('layoutInfo').textContent = 'AI が書いた配置はまだありません。'; return; }
  const cx = layoutContext(), now = scoreLayout(L, cx).row, hist = (L.scores || []).map((r, i) => `${i ? `直し ${i}` : '最初'} ${pc(r.score)}`).join(' → ');
  $('layoutInfo').textContent = `AI が書いた配置：形 ${L.objects.length} 個。${cx.thing ? `絵の物の輪郭との重なり ${pc(now.score)}（物の画素の ${pc(now.covered)} を覆い、形の画素の ${pc(now.precise)} が物の上）` : `奥行きの合う割合 ${pc(now.score)}`}。${hist ? `回ごと：${hist}。いちばん合った回を残しています。` : ''}当たりの形の「AI が書いた形」で使えます。重ねた絵は paint-out の layout_overlay.png。`;
}
let layoutJob = false, layoutStop = false;
const LAYOUT_BUTTONS = ['layoutRun', 'layoutMore', 'layoutDry', 'layoutForget'];
async function runLayoutAi({ fresh, fixes, dryRun }) {
  if (layoutJob || !app || !data) return;
  if (!fresh && !layoutAi.layout) return;
  const log = (t) => { $('layoutLog').hidden = false; $('layoutLog').textContent = t; };
  layoutJob = true; layoutStop = false; for (const id of LAYOUT_BUTTONS) $(id).disabled = true; $('layoutStopBtn').hidden = false;
  let done = 0, changed = false;
  try {
    const cx = layoutContext(), px = colorOf(cx.v, ui.colorSrc).px, brief = briefText(cx.view, cx.frame), total = (fresh ? 1 : 0) + fixes;
    await api('/api/paint-out/layout_picture.png', await pngBlob(px, cx.view.W, cx.view.H));
    await api('/api/paint-out/layout_depth.png', await pngBlob(layoutDepthImage(cx.v), cx.view.W, cx.view.H));
    let cur = fresh ? null : { objects: layoutAi.layout.objects }, scores = fresh ? [] : (layoutAi.layout.scores || []).slice(), best = fresh ? null : { layout: cur, score: scoreLayout(cur, cx).row.score, at: layoutAi.layout.best || 0 };
    if (!fresh) await api('/api/paint-out/layout_ai.json', new Blob([JSON.stringify(cur, null, 1)], { type: 'application/json' })); // 直しのもとは、点数の記録を外した配置だけ
    for (let r = 0; r < total && !layoutStop; r++) {
      const refine = !(fresh && r === 0), head = `${refine ? `見比べて直す（${fresh ? r : r + 1} / ${fixes}）` : '最初の配置を書く'}：`;
      let report = '';
      if (refine) {
        if (!cur) break; // 文と絵だけ用意したときは、直しのもとになる配置が無い
        const now = scoreLayout(cur, cx);
        await api('/api/paint-out/layout_overlay.png', await layoutOverlay(cx, now.shapes, px));
        report = now.cmp.text;
      }
      log(head + (dryRun ? '文と絵を用意しています' : 'Codex が書いています（1〜3 分）'));
      await api('/api/paint/layout', { brief, report, refine, dryRun });
      let st;
      for (;;) { await sleep(1000); st = await (await fetch('/api/paint/status', { cache: 'no-store' })).json(); if (!st.running) break; if (layoutStop) await api('/api/paint/stop'); else log(`${head}Codex が書いています（${st.seconds} 秒）`); }
      if (layoutStop) break;
      if (st.code !== 0) throw new Error(st.log.trim().split('\n').slice(-4).join('\n') || 'Codex が失敗しました');
      done++;
      if (dryRun) break;
      cur = await (await fetch('/files/paint-out/layout_ai.json', { cache: 'no-store' })).json();
      const row = scoreLayout(cur, cx).row;
      scores.push(row); changed = true;
      if (!best || row.score >= best.score) best = { layout: cur, score: row.score, at: scores.length - 1 };
    }
    if (changed && best) { // いちばん合った回の配置を、点数の記録と一緒に残す。最後の配置を重ねた絵も作り直す
      const final = { objects: best.layout.objects, view: cx.v.def.name, scores, best: best.at };
      await api('/api/paint-out/layout_ai.json', new Blob([JSON.stringify(final, null, 1)], { type: 'application/json' }));
      await api('/api/paint-out/layout_overlay.png', await layoutOverlay(cx, scoreLayout(final, cx).shapes, px));
      layoutAi.layout = final; layoutAi.loaded = true; data.layoutAiFile = true;
    } else if (!fresh && layoutAi.layout) await api('/api/paint-out/layout_ai.json', new Blob([JSON.stringify(layoutAi.layout, null, 1)], { type: 'application/json' })); // 止めたときや、用意だけのとき：もとの記録に戻す
    log(layoutStop ? '止めました。' : dryRun ? '文と絵を paint-out/work/ に用意しました（Codex は呼んでいません）。' : `Codex を ${done} 回呼びました。`);
  } catch (e) { console.error(e); log(`止まりました：${e.message}`); }
  finally {
    layoutJob = false; for (const id of LAYOUT_BUTTONS) $(id).disabled = false; $('layoutStopBtn').hidden = true;
    if (changed && ui.walkShape === 'ai') rebuild(); else showLayoutAi();
  }
}
async function forgetLayoutAi() {
  if (layoutJob || !data) return;
  try { await api('/api/paint-out/layout_ai.json', null, 'DELETE'); } catch (e) { $('layoutLog').hidden = false; $('layoutLog').textContent = e.message; return; }
  layoutAi.layout = null; data.layoutAiFile = false; $('layoutLog').hidden = true;
  if (ui.walkShape === 'ai') { ui.walkShape = 'auto'; press($('walkShape'), 'auto'); rebuild(); } else showLayoutAi();
}

// ---- 絵と奥行きから推定したプレビズのモデル（studio/estimate.js） ----
// 背景の面（手前の物を消した後ろの奥行きのメッシュ）と、手前の物を囲む箱。歩くときの当たりの形と、OBJ の書き出しに使う。
const GROUND_TYPE = typeByKey('grass').id;
// 当たりの形のもと：previz = プレビズの形、estimate = 絵から推定した形、ai = AI が書いた形（背景の面は推定のものを使う）
const shapeMode = () => (ui.walkShape === 'auto' ? (data && data.painting ? 'estimate' : 'previz') : ui.walkShape === 'ai' && !layoutAi.layout ? 'estimate' : ui.walkShape);
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
    const mesh = new THREE.Mesh(b.shape === 'cylinder' ? new THREE.CylinderGeometry(b.half[0], b.half[0], b.half[1] * 2, 16) : new THREE.BoxGeometry(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2));
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
  if (inter) { inter.dispose(); inter = null; }
  if (app) { app.sorter.worker.terminate(); app.renderer.setAnimationLoop(null); app.controls.dispose(); app.renderer.domElement.remove(); app.renderer.dispose(); app = null; }

  try { if (!data) { data = await loadData(); setupViewButtons(); } }
  catch (e) { starting = false; console.error(e); return say(e.message); }

  let renderer;
  try { renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: useGL }); await renderer.init(); }
  catch (e) { starting = false; console.error(e); return say('このブラウザでは 3D 描画を開始できませんでした。Chrome か Edge の最新版で開いてください。'); }
  forceGL = useGL;
  stage.prepend(renderer.domElement);

  if (ui.surround) await groundAiLayer(); // 周囲の地面：AI が描いた層があれば先に読む
  await loadLayoutAi();                    // AI が書いた形の配置があれば読む
  await loadWorldFile();                   // paint-out/world.ply（外で作った世界）があれば読む
  await loadObjectFiles();                 // paint-out/object_<番号>.glb（物体ごとの 3D モデル）があれば読む
  cloud = buildCloud();
  const n = cloud.n;
  const movable = movableList(); // 動かせる物に枠を振る（sendSource の前に）
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);

  const a = app = {
    renderer, scene, camera, controls,
    attrs: Array.from({ length: 6 }, () => new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)), // 描画用の A〜F（sendSource）
    sortEye: new THREE.Vector3(Infinity, 0, 0), yaw: 0, pitch: 0,
  };
  a.sorter = makeSorter(a, n);
  // 触って揺らす：粒の元の場所を GPU へ。揺れやすさは種類の札から（札が無ければ全部同じ）
  jiggle.attach(renderer, cloud.position, n, cloud.sway ? Float32Array.from(cloud.sway.subarray(0, n), (v) => v / 255) : null);
  a.mats = makeMaterials(a);
  a.sprite = new THREE.Sprite(a.mats.soft);
  a.sprite.count = n; a.sprite.frustumCulled = false; a.sprite.renderOrder = 1;
  scene.add(a.sprite);

  // 確かめ用：プレビズの形（線）と、書き出しカメラの視錐台
  a.wire = new THREE.Group();
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5, depthTest: false });
  a.previz = buildScene(); a.labels = labelScene(a.previz); // 太陽を動かしたときの影の計算にも使う
  // 歩くときの当たり判定：プレビズの形そのものか、絵と奥行きから推定したモデル（プレビズの無い場面）
  const mode = shapeMode();
  a.estimate = mode === 'estimate' ? estimateModel() : mode === 'ai' ? layoutModel() : null;
  a.walk = createWalk(scene, a.estimate ? estimateSolids(a.estimate) : a.labels.solids, a.estimate ? [{ id: 0, name: '推定した背景の面' }, ...(mode === 'ai' ? a.estimate.boxes.map((b) => ({ id: b.objectId, name: b.name })) : (data.cams.labels && data.cams.labels.objects) || [])] : a.labels.objects);
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
  await setupMoves(a, scene, movable);

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
  $('sJiggle').textContent = `${jiggle.size.join(' × ')} の浮動小数の画像 3 枚（1 粒 1 画素、1/120 秒刻み）`;
  const used = data.views.map((v) => colorOf(v, ui.colorSrc).key), missing = used.filter((k) => k !== ui.colorSrc).length;
  $('srcNote').textContent = missing ? `「${SOURCES[ui.colorSrc].name}」が無い視点が ${missing} / ${data.views.length} あります。その視点は「${SOURCES[used.find((k) => k !== ui.colorSrc)].name}」で置いています。` : '';
  $('srcNote').classList.toggle('warn', missing > 0);
  $('labelNote').hidden = data.hasLabels || data.hasTypes;
  showSharpInfo(); showLayerInfo(); showSurround(); showLayoutAi(); showWorld(); showObjects(); showParts();

  layout(); say('');
  let frames = 0, t0 = performance.now(), last = t0;
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (ui.nav === 'walk') walkStep(dt); else controls.update();
    tick(dt, now);
    brushTick(dt);
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
  window.__splat = { get inter() { return inter; }, mover, jiggle, brush, app: a, cloud, data, ui, sky, surround, refreshSky, paintSky, light, setLight, backend: gpu ? 'webgpu' : 'webgl2', jump, sunBusy: () => sunBusy, fx, clock, setHour, cpuSun, keys,
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
  if (inter) moveStep(dt, now);
  u.time.value += dt;
  if ($('windOn').checked && $('cloudOn').checked) uSkyYaw.value = (uSkyYaw.value + dt * Number($('cloudDrift').value) * Math.PI / 180 * Math.sign(Math.sin(Number($('windDir').value) * Math.PI / 180) || 1)) % (2 * Math.PI);
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
  const u = fx.u, moving = data.hasLabels || data.hasTypes;
  u.wind.value = moving && $('windOn').checked ? Number($('windK').value) : 0;
  u.windSpeed.value = Number($('windSpeed').value);
  const wa = Number($('windDir').value) * Math.PI / 180; u.windDir.value.set(Math.sin(wa), Math.cos(wa));
  u.part.value = moving && $('partOn').checked ? 0.45 : 0; u.partRadius.value = Number($('partR').value);
  u.foot.value = moving && $('footOn').checked ? 0.5 : 0; u.footShow.value = moving && $('footShow').checked ? 1 : 0;
  u.show.value = SHADER_SHOW[ui.mode] || 0; u.colorFx.value = COLOR_FX.has(ui.mode) ? 1 : 0;
  $('oWindK').textContent = `${Math.round(Number($('windK').value) * 100)} cm`; $('oWindSpeed').textContent = `${Number($('windSpeed').value).toFixed(1)} 倍`;
  $('oWindDir').textContent = `${$('windDir').value}°`; $('oPartR').textContent = `${Number($('partR').value).toFixed(1)} m`;
  // 種類ごとの風：草・木の葉（＋ふるえ）・幹・水面・雲
  const wOn = moving && $('windOn').checked;
  u.mGrass.value = Number($('mGrass').value); u.mLeaves.value = Number($('mLeaves').value); u.mFlutter.value = Number($('mFlutter').value); u.mTrunk.value = Number($('mTrunk').value);
  u.water.value = wOn && $('waterOn').checked ? Number($('waterK').value) : 0; u.waterSpeed.value = Number($('waterSpeed').value); u.waterGlint.value = Number($('waterGlint').value);
  u.cloud.value = wOn && $('cloudOn').checked ? Number($('cloudK').value) : 0; u.cloudSpeed.value = Number($('cloudSpeed').value);
  for (const [id, f] of [['mGrass', (v) => `${v.toFixed(2)} 倍`], ['mLeaves', (v) => `${v.toFixed(2)} 倍`], ['mFlutter', (v) => `${v.toFixed(2)} 倍`], ['mTrunk', (v) => `${v.toFixed(2)} 倍`], ['waterK', (v) => `${Math.round(v * 100)} cm`], ['waterSpeed', (v) => `${v.toFixed(1)} 倍`], ['waterGlint', (v) => v.toFixed(2)], ['cloudK', (v) => `粒の間隔の ${v.toFixed(1)} 倍`], ['cloudSpeed', (v) => `${v.toFixed(1)} 倍`], ['cloudDrift', (v) => v ? `${v.toFixed(2)}°/秒` : '止める']]) $('o' + id[0].toUpperCase() + id.slice(1)).textContent = f(Number($(id).value));
  applyJiggleUi();
  a.walk.shapes.visible = $('shapes').checked;
  a.walk.me.visible = ui.nav === 'walk' ? $('third').checked : $('shapes').checked; // 自分の体は、後ろから見るときと、回して見るときに当たりの形を出しているとき
  $('walkBox').hidden = ui.nav !== 'walk';
  $('hint').textContent = ui.nav === 'walk'
    ? (a.walk.wk.noclip ? '画面をクリックで視線を動かす（Esc で解除）・ W A S D で飛ぶ ・ E で上 ・ Q で下 ・ Shift で速く'
      : '画面をクリックで視線を動かす（Esc で解除）・ W A S D か矢印で歩く ・ Shift で走る ・ Space で跳ぶ ・ 左ボタンを押している間、真ん中の粒を押す')
    : brush.tool === 'brush' && $('brushOn').checked ? '左ドラッグで粒を押す ・ 右ドラッグで回す ・ ホイールで前後 ・ Shift＋右ドラッグで横に動く'
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
  if (!e.repeat && moveKey(e.code)) e.preventDefault();
  if (e.code === 'Space' && !e.repeat) jumpQueued = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// ---- 触って揺らす（ブラシ・体） ----
// 「回して見る」でマウスの役目を「ブラシ」にすると、左ドラッグで粒を押す（右ドラッグで回す・ホイールで前後）。
// 「歩く」では、視線を動かしているとき（Esc で解除する前）に左ボタンを押している間、画面の真ん中で押す。体は歩くだけで押す。
// 押す所の奥行きは、円の中の粒のうち手前から 1 割の粒の奥行き（CPU で間引いて調べる）。その前後 band m の粒だけを押す。
const brush = { tool: 'brush', mode: 'push', down: false, inside: false, x: 0, y: 0, lastX: NaN, lastY: NaN, hit: null, pickAt: 0, vel: new THREE.Vector3(), wasDown: false, steps: 0, lastPick: '' };
const _vp = new THREE.Matrix4(), _r = new THREE.Vector3(), _up = new THREE.Vector3(), _f = new THREE.Vector3();
function brushActive() {
  if (!app || !$('brushOn').checked) return false;
  if (ui.nav === 'walk') return brush.down && !!document.pointerLockElement;
  return brush.tool === 'brush' && brush.inside && (brush.down || $('brushHover').checked);
}
function brushTick(dt) {
  const a = app, u = jiggle.u; if (!a || !jiggle.ready) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  a.camera.updateMatrixWorld();
  _vp.multiplyMatrices(a.camera.projectionMatrix, a.camera.matrixWorldInverse);
  u.viewProj.value.copy(_vp); u.viewport.value.set(w, h);
  a.camera.matrixWorld.extractBasis(_r, _up, _f); _f.negate();
  u.camRight.value.copy(_r); u.camUp.value.copy(_up); u.camFwd.value.copy(_f);
  const locked = ui.nav === 'walk';
  const cx = locked ? w / 2 : brush.x, cy = locked ? h / 2 : brush.y;
  const active = brushActive();
  u.cursor.value.set(cx, cy);
  if (active) {
    // 当たりの奥行き：カーソルかカメラが動いたときだけ調べ直す（0.05 秒に 1 回まで）
    const key = `${Math.round(cx)},${Math.round(cy)},${a.camera.position.toArray().map((v) => v.toFixed(2))},${a.camera.quaternion.toArray().map((v) => v.toFixed(3))}`;
    const now = performance.now();
    if (key !== brush.lastPick && now - brush.pickAt > 50) {
      brush.pickAt = now; brush.lastPick = key;
      brush.hit = pickDepth(cloud.position, cloud.n, cloud.sky, _vp, { x: cx, y: cy }, Number($('brushR').value), { x: w, y: h });
    }
    // ブラシの動きの速さ（なでる用）：画面の上の動き × 当たりの奥行きでの 1 画素の大きさ
    if (!Number.isNaN(brush.lastX) && brush.hit) {
      const perPx = 2 * brush.hit.depth * Math.tan(THREE.MathUtils.degToRad(a.camera.fov) / 2) / h;
      const dx = (cx - brush.lastX) * perPx / Math.max(dt, 1e-3), dy = (cy - brush.lastY) * perPx / Math.max(dt, 1e-3);
      const target = _r.clone().multiplyScalar(dx).addScaledVector(_up, -dy);
      brush.vel.lerp(target, 0.5);
    } else brush.vel.set(0, 0, 0);
    if (locked && brush.hit) brush.vel.set(0, 0, 0);
  } else { brush.vel.multiplyScalar(0.5); }
  brush.lastX = active ? cx : NaN; brush.lastY = active ? cy : NaN;
  const band = Number($('brushBand').value);
  u.brushOn.value = active && (brush.hit || band <= 0) ? 1 : 0;
  u.hit.value = brush.hit ? brush.hit.depth : 1e9;
  u.brushVel.value.copy(brush.vel);
  if (active && !brush.wasDown) u.kick.value = 1; // 「はじく」は押した瞬間に 1 回
  brush.wasDown = active;
  // 体：歩いていて当たり判定があるとき
  const wk = a.walk.wk, body = ui.nav === 'walk' && $('bodyOn').checked;
  if (body) u.feet.value.set(wk.feet[0], wk.feet[1], wk.feet[2]); else u.feet.value.set(0, -1e4, 0);
  u.bodyR.value = wk.p.radius * Number($('bodyScale').value); u.bodyH.value = wk.p.height;
  u.bodyK.value = body ? 1 : 0; u.lift.value = $('bodyGround').checked ? -0.05 : 0.08;
  const moving = body && (keys.size > 0 || !wk.onGround);
  const steps = jiggle.step(dt, u.brushOn.value > 0 || moving, $('jigPause').checked);
  brush.steps += steps;
  // 円の表示
  const ring = $('brushRing'), show = $('brushOn').checked && (locked ? !!document.pointerLockElement : brush.tool === 'brush' && brush.inside);
  ring.hidden = !show;
  if (show) {
    const r = Number($('brushR').value);
    ring.style.width = ring.style.height = `${2 * r}px`; ring.style.transform = `translate(${cx - r}px, ${cy - r}px)`;
    ring.classList.toggle('on', u.brushOn.value > 0);
  }
  if ((brush.statAt = (brush.statAt || 0) + dt) > 0.25) {
    brush.statAt = 0;
    const hit = brush.hit;
    $('sBrush').textContent = `${active ? (hit ? `押している：奥行き ${hit.depth.toFixed(1)} m、円の中 約 ${hit.count.toLocaleString()} 粒` : '円の中に粒がない') : 'さわっていない'} ／ ${$('jigPause').checked ? '計算を止めている' : jiggle.settled ? '揺れが収まったので計算を休んでいる' : '揺れを計算中'}`;
  }
}
function applyJiggleUi() {
  const u = jiggle.u, hz = Number($('jigHz').value), z = Number($('jigDamp').value);
  u.on.value = $('brushOn').checked || $('bodyOn').checked ? 1 : 0;
  u.k.value = Math.pow(2 * Math.PI * hz, 2); u.zeta.value = z; u.spread.value = Number($('jigSpread').value);
  u.typeAware.value = $('jigType').checked ? 1 : 0; u.maxShift.value = Number($('jigMax').value);
  u.mode.value = BRUSH_MODES.indexOf(brush.mode || 'push'); u.radius.value = Number($('brushR').value); u.strength.value = Number($('brushK').value);
  u.band.value = Number($('brushBand').value);
  u.wobble.value = Number($('wobble').value); u.wobbleSpeed.value = Number($('wobbleSpeed').value);
  u.heatScale.value = Math.max(0.02, Number($('brushK').value));
  $('oJigHz').textContent = hz > 0 ? `${hz.toFixed(1)} 回/秒` : '戻らない（粘土）';
  $('oJigDamp').textContent = z <= 0 ? '揺れ続ける' : z >= 1 ? '揺れずに戻る' : z.toFixed(2);
  $('oJigSpread').textContent = `${Math.round(Number($('jigSpread').value) * 100)}%`;
  $('oJigMax').textContent = `${Number($('jigMax').value).toFixed(1)} m`;
  $('oBrushR').textContent = `${$('brushR').value} 画素`; $('oBrushK').textContent = `${Math.round(Number($('brushK').value) * 100)} cm`;
  $('oBrushBand').textContent = Number($('brushBand').value) > 0 ? `前後 ${Number($('brushBand').value).toFixed(1)} m` : '奥まで全部';
  $('oWobble').textContent = Number($('wobble').value) > 0 ? `粒の間隔の ${Number($('wobble').value).toFixed(2)} 倍` : 'なし';
  $('oWobbleSpeed').textContent = `${Number($('wobbleSpeed').value).toFixed(1)} 倍`;
  $('oBodyScale').textContent = `${Number($('bodyScale').value).toFixed(1)} 倍`;
  $('brushBox').hidden = !$('brushOn').checked;
  if (app) {
    const orbitButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    app.controls.mouseButtons = brush.tool === 'brush' && ui.nav === 'orbit' && $('brushOn').checked ? { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : orbitButtons;
  }
}
stage.addEventListener('pointermove', (e) => {
  const r = stage.getBoundingClientRect(); brush.x = e.clientX - r.left; brush.y = e.clientY - r.top;
  brush.inside = e.target.tagName === 'CANVAS';
});
stage.addEventListener('pointerleave', () => { brush.inside = false; });
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.tagName !== 'CANVAS') return;
  if (ui.nav === 'walk' && !document.pointerLockElement) return; // 最初のクリックは視線の固定だけ
  const r = stage.getBoundingClientRect(); brush.x = e.clientX - r.left; brush.y = e.clientY - r.top; brush.inside = true;
  brush.down = true;
});
window.addEventListener('pointerup', (e) => { if (e.button === 0) brush.down = false; });
window.addEventListener('mousedown', (e) => { if (e.button === 0 && document.pointerLockElement && ui.nav === 'walk') brush.down = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) brush.down = false; });

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
  { const b = document.createElement('button'); b.type = 'button'; b.dataset.v = String(worldViewIndex()); b.textContent = '（取り込んだ世界）だけ'; b.setAttribute('aria-pressed', 'false'); src.append(b); }
  { const b = document.createElement('button'); b.type = 'button'; b.dataset.v = String(objectViewIndex()); b.textContent = '（物体のモデル）だけ'; b.setAttribute('aria-pressed', 'false'); src.append(b); }
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
  $('lightBox').hidden = !data.hasLabels; $('moveBox').hidden = !(data.hasLabels || data.hasTypes);
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
$('objExport').addEventListener('click', () => { exportObjectCutouts().catch((e) => { console.error(e); objs.busy = ''; $('objInfo').textContent = `書き出せませんでした：${e.message}`; }); });
$('objPick').addEventListener('change', showObjects);
$('objFile').addEventListener('change', async () => {
  const file = $('objFile').files[0], id = Number($('objPick').value); if (!file || !id) return;
  objs.busy = '読み込んでいます…'; showObjects();
  try { await addObjectModel(id, file); objs.busy = ''; ui.objects.show = true; rebuild(); }
  catch (e) { console.error(e); objs.busy = ''; showObjects(); $('objInfo').textContent = `読めませんでした：${e.message}`; }
  $('objFile').value = '';
});
for (const [id, key] of [['objShow', 'show'], ['objReplace', 'replace'], ['objPaint', 'paint'], ['objInflate', 'inflate']]) $(id).addEventListener('change', () => { ui.objects[key] = $(id).checked; saveObjects(); rebuild(); });
for (const [id, set] of [['objYaw', (a, x) => { a.yaw = x; }], ['objScale', (a, x) => { a.scale = Math.round(2 ** x * 100) / 100; }]]) {
  const read = () => { const k = Number($('objPick').value), a = { ...objectAdjust(k) }; set(a, Number($(id).value)); ui.objects.adjust[k] = a; };
  $(id).addEventListener('input', () => { read(); showObjects(); });
  $(id).addEventListener('change', () => { read(); saveObjects(); rebuild(); });
}
$('objAuto').addEventListener('click', () => { delete ui.objects.adjust[Number($('objPick').value)]; saveObjects(); rebuild(); });
$('objForget').addEventListener('click', async () => { await forgetObjectModel(Number($('objPick').value)); rebuild(); });
seg('segPick', (v) => { ui.seg = v; saveParts(); data = null; objs.tried = false; objs.models.clear(); rebuild(); });
seg('obj3dMethod', (v) => { ui.objects.method = v; saveObjects(); objs.tried = false; objs.models.clear(); rebuild(); });
$('obj3dFull').addEventListener('change', () => { ui.objects.full = $('obj3dFull').checked; saveObjects(); });
$('obj3dTexture').addEventListener('change', () => { ui.objects.texture = $('obj3dTexture').checked; saveObjects(); });
$('segRun').addEventListener('click', () => runParts({ cmd: 'segment', prompts: $('segPrompts').value }, 'SAM 3 で切り抜いています'));
for (const [id, all] of [['obj3dOne', false], ['obj3dAll', true]]) $(id).addEventListener('click', () => {
  const ids = pickedIds(all); if (!ids.length) return;
  runParts({ cmd: 'make3d', seg: data.segUsed, method: ui.objects.method, ids, source: ui.objects.full ? 'full' : 'cut', texture: ui.objects.texture }, `${METHOD_NAMES[ui.objects.method]} で ${ids.length} 個の物を 3D にしています`);
});
for (const [id, all, dry] of [['fullOne', false, false], ['fullAll', true, false], ['fullDry', false, true]]) $(id).addEventListener('click', () => {
  const ids = pickedIds(all); if (!ids.length) return;
  runParts({ cmd: 'complete', seg: data.segUsed, ids, dryRun: dry }, dry ? '頼む文と絵を用意しています' : `Codex で ${ids.length} 個の物の全身を描いています`);
});
$('partsStop').addEventListener('click', () => { partsStop = true; });
$('moveOn').addEventListener('change', () => { ui.move.on = $('moveOn').checked; saveParts(); rebuild(); });
$('moveTrees').addEventListener('change', () => { ui.move.trees = $('moveTrees').checked; saveParts(); rebuild(); });
$('moveBoxes').addEventListener('change', () => { ui.move.boxes = $('moveBoxes').checked; saveParts(); if (inter) inter.boxes.visible = ui.move.boxes; });
$('moveReset').addEventListener('click', () => { if (inter) inter.resetAll(); });
stage.addEventListener('wheel', (e) => { if (inter && ui.nav === 'walk' && inter.holding() !== null) { inter.scroll(e.deltaY > 0 ? -0.4 : 0.4); e.preventDefault(); } }, { passive: false });
$('worldFile').addEventListener('change', async () => {
  const file = $('worldFile').files[0]; if (!file) return;
  $('worldInfo').textContent = '読み込んでいます…';
  try { setWorldPly(await file.arrayBuffer(), file.name); ui.world.show = true; rebuild(); }
  catch (e) { console.error(e); world.ply = null; world.error = e.message; showWorld(); }
});
$('worldShow').addEventListener('change', () => { ui.world.show = $('worldShow').checked; saveWorld(); rebuild(); });
seg('worldFrame', (v) => { ui.world.frame = v; saveWorld(); rebuild(); });
for (const [id, set] of [['worldScale', (x) => { ui.world.scale = 10 ** x; }], ['worldYaw', (x) => { ui.world.yaw = x; }], ['worldX', (x) => { ui.world.x = x; }], ['worldY', (x) => { ui.world.y = x; }], ['worldZ', (x) => { ui.world.z = x; }], ['worldPoint', (x) => { ui.world.point = x; }]]) {
  $(id).addEventListener('input', () => { set(Number($(id).value)); showWorld(); });
  $(id).addEventListener('change', () => { set(Number($(id).value)); saveWorld(); rebuild(); });
}
$('worldFit').addEventListener('click', () => {
  if (!world.ply || !data) return;
  const v = centerView(), k = fitWorldScale(world.ply, worldPlacement(), { W: v.W, H: v.H, z: v.z, w2c: v.w2c, intr: v.def.intrinsics });
  ui.world.scale = Math.max(0.001, Math.min(1000, ui.world.scale * k)); saveWorld(); rebuild();
});
$('worldReset').addEventListener('click', () => { Object.assign(ui.world, WORLD_DEFAULT); saveWorld(); rebuild(); });
$('worldForget').addEventListener('click', () => { world.ply = null; world.name = ''; world.kind = ''; world.bounds = null; world.tried = true; $('worldFile').value = ''; rebuild(); });
$('layoutRun').addEventListener('click', () => runLayoutAi({ fresh: true, fixes: Number($('layoutFixes').value), dryRun: false }));
$('layoutMore').addEventListener('click', () => runLayoutAi({ fresh: false, fixes: 1, dryRun: false }));
$('layoutDry').addEventListener('click', () => runLayoutAi({ fresh: !layoutAi.layout, fixes: layoutAi.layout ? 1 : 0, dryRun: true }));
$('layoutStopBtn').addEventListener('click', () => { layoutStop = true; });
$('layoutForget').addEventListener('click', forgetLayoutAi);
$('layoutFixes').addEventListener('change', showLayoutAi);
seg('backDepth', (v) => { ui.backDepth = v; rebuild(); });
showLayerUi();
seg('order', (v) => {
  ui.order = v; if (!app) return;
  requestSort(); applyUi();
});
$('jump').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { jump(b.dataset.v); if (ui.nav === 'walk') placeAtCamera(); } });
for (const id of ['size', 'edge', 'windK', 'windSpeed', 'windDir', 'partR', 'mGrass', 'mLeaves', 'mFlutter', 'mTrunk', 'waterK', 'waterSpeed', 'waterGlint', 'cloudK', 'cloudSpeed', 'cloudDrift', 'jigHz', 'jigDamp', 'jigSpread', 'jigMax', 'brushR', 'brushK', 'brushBand', 'wobble', 'wobbleSpeed', 'bodyScale']) $(id).addEventListener('input', applyUi);
seg('brushTool', (v) => { brush.tool = v; applyUi(); });
seg('brushMode', (v) => { brush.mode = v; applyUi(); });
$('jigReset').addEventListener('click', () => jiggle.clear());
for (const id of ['holes', 'wire', 'frusta', 'shapes', 'third', 'windOn', 'partOn', 'footOn', 'footShow', 'waterOn', 'cloudOn', 'brushOn', 'brushHover', 'bodyOn', 'bodyGround', 'jigType', 'jigPause']) $(id).addEventListener('change', applyUi);
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
