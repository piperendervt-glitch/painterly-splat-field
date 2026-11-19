// 「視点を足す」の、絵 1 枚から作った場面（プレビズの形が無い場面）のための部分。計算は studio/dream.js、ここはファイルの読み書きとの橋渡し。
// 流れ（LucidDreamer の Dreaming の段と同じ）：すでにある絵を新しい視点へ写す → 穴を埋める（Codex かツール内）→ 埋めた絵の奥行きを推定して、分かっている所に合わせる。
import { pullPush } from './layers.js';
import { lookBasis as cameraBasis, cameraMatrices, warp, compose, extendDepth, alignDepth, labelHoles, colorModel, inFreeSpace, depthPng, depthViewPng, labelPngs, typeColorPng } from './dream.js';

/** この場面は、絵 1 枚から作った物か（cameras.json の source.kind）。 */
export const isPainting = (cams) => !!(cams && cams.source && cams.source.kind === 'painting');

// 種類ごとの下絵の色（painting/build.mjs と同じ）。名前で引く
const TYPE_COLORS = { sky: [185, 199, 207], ground: [124, 154, 72], water: [106, 140, 190], figure: [190, 120, 90], far: [150, 170, 150], tree: [70, 110, 60] };
function typeTable(cams) {
  const types = (cams.labels && cams.labels.types) || [], id = (name, alt) => { const t = types.find((x) => x.name === name); return t ? t.id : alt; };
  const colors = []; for (const t of types) colors[t.id] = TYPE_COLORS[t.name] || [140, 140, 140];
  const sky = id('sky', 0), ground = id('ground', 1);
  return { ids: { sky, ground, far: id('far', ground), water: id('water', undefined), tree: id('tree', undefined), figure: id('figure', undefined) }, colors };
}

/** 穴を描いてもらうときの画風の文。cameras.json の source.style があればそれ、無ければ「まわりと同じ画風」。 */
export const fillStyle = (cams) => (cams.source && typeof cams.source.style === 'string' && cams.source.style.trim()) || 'a painting; match the technique, brushwork, palette and light of the painted parts around the holes exactly';
/** 穴の中に描く物についての指示。奥行きを後から推定するので、絵の外へ続く地面・水・木・空を描いてもらい、人や動物は増やさない。 */
export const FILL_HINT = 'The magenta areas are parts of the same place that lie outside or behind what the original painting shows. Continue the ground, water, trees, far bank and sky that are already there, with the same horizon line and the same scale. Do not add any new people, animals, boats or buildings: only complete a figure or object that is cut off at the edge of a magenta area.';
// 別視点のモデルの絵を下絵にして Codex に頼むとき：何を描くかは下絵が決めるので、「人を増やさない」とは言わず、つながりだけを頼む
export const LAYOUT_HINT = 'The magenta areas are parts of the same place that lie outside or behind what the original painting shows. Keep the same horizon line, the same scale and the same eye height as the painted parts, so that ground, water and far bank continue without a seam.';

// 物を消した背景（addPlateView の穴）を PC の画像生成モデルで描くとき：穴は人や動物のあった所で、その後ろの背景だけを描く
export const PLATE_HINT = 'The magenta areas are where people, animals and boats were removed from the picture. Paint only the empty background that lies behind them: continue the lawn and its shadows, the water, the far bank and the trees straight through every hole. No people, no animals, no umbrellas, no boats, no new objects.';

/** もとの視点（足した視点ではない、最初の視点）。 */
export const baseView = (D) => D.views.find((v) => !v.added) || D.views[0];

/** 候補（位置と見る先）から、新しい視点のカメラを作る。絵の大きさと画角は、もとの視点と同じ。 */
export function targetCamera(D, cand) {
  const b = baseView(D);
  return { W: b.W, H: b.H, fx: b.fx, fy: b.fy, cx: b.cx, cy: b.cy, ...cameraMatrices(cand.position, cameraBasis(cand.position, cand.target)) };
}
// 写すもとになる視点：絵のある視点すべて。足した視点は、新しく描いた画素だけを使う
function sources(D, except) {
  return D.views.filter((v) => v.painted && v.name !== except && !(v.added && !v.fresh)).map((v) => ({
    name: v.name, W: v.W, H: v.H, fx: v.fx, fy: v.fy, cx: v.cx, cy: v.cy, c2w: v.c2w, w2c: v.w2c, z: v.z, type: v.type, object: v.object, valid: v.added ? v.fresh : null, painted: v.painted,
  }));
}

/** 最初の候補：もとの視点の位置から、絵のまん中あたりの奥行きの所を見る。 */
export function defaultCandidate(D) {
  const b = baseView(D), ex = b.def.extrinsics, zs = [];
  for (let y = Math.floor(b.H * 0.35); y < b.H; y += 16) for (let x = 8; x < b.W; x += 16) { const z = b.z[y * b.W + x]; if (z > 0 && z < 150) zs.push(z); }
  zs.sort((p, q) => p - q);
  const d = zs.length ? zs[zs.length >> 1] : 10, f = cameraBasis(ex.position, ex.target).f;
  return { position: [...ex.position], target: [ex.position[0] + f[0] * d, ex.position[1] + f[1] * d, ex.position[2] + f[2] * d] };
}

/** 候補の視点から見た今の状態（粗い下見）。mode = 'source' なら、どの視点の絵で埋まるかの色。 */
export function preview(D, cand, w, tints, mode = 'painted') {
  const t = targetCamera(D, cand), k = w / t.W, h = Math.max(1, Math.round(t.H * k));
  const src = sources(D, null), small = { ...t, W: w, H: h, fx: t.fx * k, fy: t.fy * k, cx: t.cx * k, cy: t.cy * k };
  const c = compose(warp(small, src, { step: Math.max(2, Math.round(1.5 / k)) }), src);
  let holes = 0, sky = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (c.hole[i]) { holes++; c.rgba[o] = 255; c.rgba[o + 1] = 0; c.rgba[o + 2] = 255; continue; }
    if (!(c.z[i] > 0)) sky++;
  }
  if (mode === 'source') {
    const again = warp(small, src, { step: Math.max(2, Math.round(1.5 / k)) });
    for (let i = 0; i < w * h; i++) {
      if (c.hole[i] || again.src[i] < 0) continue;
      const o = i * 4, tint = tints[D.views.findIndex((v) => v.name === src[again.src[i]].name) % tints.length], l = 0.35 + 0.65 * (0.2126 * c.rgba[o] + 0.7152 * c.rgba[o + 1] + 0.0722 * c.rgba[o + 2]) / 255;
      c.rgba[o] = tint[0] * l; c.rgba[o + 1] = tint[1] * l; c.rgba[o + 2] = tint[2] * l;
    }
  }
  return { rgba: c.rgba, w, h, holes, sky, covered: w * h - holes, pixels: w * h };
}

function viewDef(D, name, cand, cam) {
  const b = baseView(D), rows = (m) => [m.slice(0, 4), m.slice(4, 8), m.slice(8, 12), m.slice(12, 16)].map((r) => r.map((x) => +x.toFixed(8)));
  return {
    name, added: true, color: `${name}_color.png`, depth: `${name}_depth.png`, depth_view: `${name}_depth_view.png`, labels: `${name}_labels.png`, objects: `${name}_objects.png`,
    width: b.W, height: b.H, intrinsics: JSON.parse(JSON.stringify(b.def.intrinsics)),
    extrinsics: { position: cand.position.map((x) => +x.toFixed(4)), target: cand.target.map((x) => +x.toFixed(4)), camera_to_world: rows(cam.c2w), world_to_camera: rows(cam.w2c) },
  };
}
const groundY = (D) => { const b = baseView(D), p = D.cams.source && D.cams.source.params; return b.def.extrinsics.position[1] - (p && Number.isFinite(p.eye) ? p.eye : 1.7); };

// 視点の奥行き・札・下絵を previz-export に書く
// rgba（埋めた後の絵）を渡すと、穴の種類を色でも見分ける（地面か水か、木か遠景か）
const models = new WeakMap(); // もとの視点ごとの、種類の色の傾向
function typeModel(D) {
  const b = baseView(D); if (!b || !b.painted || !b.type) return null;
  if (!models.has(b)) models.set(b, colorModel({ W: b.W, H: b.H, painted: b.painted, type: b.type, z: b.z }));
  return models.get(b);
}
// 足した視点で新しく見つけた木の番号の始まり（視点 R<n> ごとに 200 個ぶん）
const objectBase = (name) => { const k = /^R(\d+)$/.exec(name); return k ? 20000 + Math.min(220, Number(k[1])) * 200 : 0; };
async function saveGeometry(D, name, c, z, cam, io, rgba = null) {
  const n = c.W * c.H, { near, far } = D.cams.depth, T = typeTable(D.cams);
  labelHoles(c, z, cam, { ids: T.ids, groundY: groundY(D), rgba, model: rgba ? typeModel(D) : null, objectBase: objectBase(name) });
  const lab = labelPngs(c.type, c.object, n);
  await io.saveExport(`${name}_depth.png`, depthPng(z, n, near, far), c.W, c.H);
  await io.saveExport(`${name}_depth_view.png`, depthViewPng(z, n), c.W, c.H);
  await io.saveExport(`${name}_labels.png`, lab.type, c.W, c.H);
  await io.saveExport(`${name}_objects.png`, lab.object, c.W, c.H);
  await io.saveExport(`${name}_color.png`, typeColorPng(c.type, z, n, T.colors), c.W, c.H);
}

/**
 * 「物を消した背景」の視点を足す：もとの視点と同じカメラで、人や動物（types の札）の所を穴にする。
 * この穴を「物の後ろの背景」として埋めると（paint.mjs fill --plate）、物の後ろの芝や水が粒になり、横や前へ動いたときに物の陰から現れる。
 * 立つ場所を動かした視点と違って、もとの絵は 1 画素も動かさないので、物の縁が伸びたり割れたりしない。
 *   grow = 穴を外へ広げる画素数（輪郭ににじんだ物の色を残さないため）。mask（画素ごとに 1 = 消す）を渡すと、札の代わりにそれを使う（外で作った切り抜き）
 * 保存する物は addView と同じ（写した絵 = 穴を灰色にしたもとの絵）と、穴をまわりの色でなめらかに埋めた目安の絵（<name>_plateguide.png）。返すのは { holes, pixels }。
 */
export async function addPlateView(D, name, io, { grow = 10, types = ['figure'], mask: given = null } = {}) {
  const b = baseView(D), T = typeTable(D.cams), n = b.W * b.H, W = b.W, H = b.H;
  const want = new Set(types.map((t) => T.ids[t]).filter((t) => t !== undefined && t !== T.ids.sky && t !== T.ids.ground));
  if (!b.painted || (!given && (!b.type || !want.size))) throw new Error('この場面には、消す物の札（' + types.join('・') + '）がありません');
  let hole = new Uint8Array(n); for (let i = 0; i < n; i++) if (given ? given[i] : want.has(b.type[i])) hole[i] = 1;
  for (let pass = 0; pass < 2 && grow > 0; pass++) { // 横、縦の順に広げる
    const out = new Uint8Array(n), len = pass ? H : W, lines = pass ? W : H, at = pass ? (l, t) => t * W + l : (l, t) => l * W + t;
    for (let l = 0; l < lines; l++) { let last = -1e9; for (let t = 0; t < len; t++) { if (hole[at(l, t)]) last = t; if (t - last <= grow) out[at(l, t)] = 1; } last = 1e9; for (let t = len - 1; t >= 0; t--) { if (hole[at(l, t)]) last = t; if (last - t <= grow) out[at(l, t)] = 1; } }
    hole = out;
  }
  const c = { W, H, rgba: new Uint8ClampedArray(b.painted), hole, holeCount: 0, z: new Float32Array(b.z), known: new Uint8Array(n), type: new Uint8Array(b.type), object: new Uint16Array(b.object || n) };
  const keep = new Uint8Array(n), guide = new Uint8ClampedArray(b.painted), mask = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    keep[i] = hole[i] ? 0 : 1; c.known[i] = keep[i]; mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = hole[i] ? 255 : 0; mask[i * 4 + 3] = 255;
    if (hole[i]) { c.holeCount++; c.z[i] = 0; c.type[i] = 0; c.object[i] = 0; c.rgba[i * 4] = c.rgba[i * 4 + 1] = c.rgba[i * 4 + 2] = 128; }
  }
  if (!c.holeCount) throw new Error('消す物が見つかりませんでした');
  for (let ch = 0; ch < 3; ch++) { const v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = b.painted[i * 4 + ch]; const f = pullPush(v, keep, W, H); for (let i = 0; i < n; i++) if (hole[i]) guide[i * 4 + ch] = f[i]; }
  const ex = b.def.extrinsics, cand = { position: [...ex.position], target: [...ex.target] }, cam = { W, H, fx: b.fx, fy: b.fy, cx: b.cx, cy: b.cy, c2w: b.c2w, w2c: b.w2c };
  await io.savePaint(`${name}_reproj.png`, c.rgba, W, H);
  await io.savePaint(`${name}_holes.png`, mask, W, H);
  await io.savePaint(`${name}_new.png`, mask, W, H);
  await io.savePaint(`${name}_plateguide.png`, guide, W, H);
  await saveGeometry(D, name, c, extendDepth(c, { cam, groundY: groundY(D) }), cam, io);
  await io.saveAdded([...(await io.loadAdded()).filter((v) => v.name !== name), { ...viewDef(D, name, cand, cam), plate: { types: given ? ['mask'] : types, grow } }]);
  return { holes: c.holeCount, pixels: n };
}

/**
 * 候補の視点を足す：すでにある絵を写し、写した絵・穴の印・仮の奥行き（穴は、まわりからなめらかに伸ばした値）を保存する。
 * io = { saveExport(name, rgba, W, H), savePaint(name, rgba, W, H), loadAdded(), saveAdded(list) }。返すのは { holes, pixels }。
 */
export async function addView(D, cand, name, io) {
  const cam = targetCamera(D, cand), src = sources(D, name);
  if (!src.length) throw new Error('写せる絵がありませんでした');
  const c = compose(warp(cam, src), src, { skyType: typeTable(D.cams).ids.sky }), n = c.W * c.H;
  const mask = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = c.hole[i] ? 255 : 0; mask[i * 4 + 3] = 255; }
  await io.savePaint(`${name}_reproj.png`, c.rgba, c.W, c.H);
  await io.savePaint(`${name}_holes.png`, mask, c.W, c.H);
  await io.savePaint(`${name}_new.png`, mask, c.W, c.H); // 粒にするのは穴だった画素だけ
  await saveGeometry(D, name, c, extendDepth(c, { cam, groundY: groundY(D) }), cam, io);
  await io.saveAdded([...(await io.loadAdded()).filter((v) => v.name !== name), viewDef(D, name, cand, cam)]);
  return { holes: c.holeCount, pixels: n };
}

/**
 * 埋めた絵から推定した近さ（disp。画素ごと、大きいほど近い）で、視点 v の穴の奥行きを決め直して保存する。
 * holes = 穴の印（RGBA。白が穴）。返すのは alignDepth の結果（合わせられなければ null で、仮の奥行きのまま）。
 */
export async function refineDepth(D, v, holes, disp, io) {
  const n = v.W * v.H, c = { W: v.W, H: v.H, z: new Float32Array(v.z), hole: new Uint8Array(n), type: new Uint8Array(v.type || n), object: new Uint16Array(v.object || n) };
  for (let i = 0; i < n; i++) if (holes[i * 4] > 127) { c.hole[i] = 1; c.z[i] = 0; }
  const r = alignDepth(c, disp, { cam: { cx: v.cx, cy: v.cy, fx: v.fx, fy: v.fy, c2w: v.c2w }, groundY: groundY(D) });
  if (!r) return null;
  // もとの視点から見て、絵に描かれた面より手前に来た穴の画素は、もとの絵と食い違うので粒にしない（絵の前に浮いて隠してしまうため）
  const cam = { cx: v.cx, cy: v.cy, fx: v.fx, fy: v.fy, c2w: v.c2w }, bases = D.views.filter((b) => !b.added && b.z), mask = new Uint8ClampedArray(n * 4);
  r.carved = 0;
  for (let i = 0; i < n; i++) {
    let keep = c.hole[i];
    if (keep && r.z[i] > 0) for (const b of bases) if (inFreeSpace(b, cam, i % v.W, (i - i % v.W) / v.W, r.z[i])) { keep = 0; r.carved++; break; }
    mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = keep ? 255 : 0; mask[i * 4 + 3] = 255;
  }
  await io.savePaint(`${v.name}_new.png`, mask, v.W, v.H);
  await saveGeometry(D, v.name, c, r.z, { cx: v.cx, cy: v.cy, fx: v.fx, fy: v.fy, c2w: v.c2w }, io, v.painted || null);
  return r;
}

/** 3D の画面と地図に出す、もとの絵の形：奥行きの絵を粗い面にした物（頂点の色は絵の色。遠すぎる所と奥行きの段は張らない）。 */
export function sceneMesh(D, { step = 6, maxZ = 90 } = {}) {
  const positions = [], colors = [], indices = [];
  for (const v of D.views) {
    if (!v.painted || (v.added && !v.fresh)) continue;
    const gw = Math.floor((v.W - 1) / step) + 1, gh = Math.floor((v.H - 1) / step) + 1, at = new Int32Array(gw * gh).fill(-1), zz = new Float32Array(gw * gh), m = v.c2w;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(v.W - 1, gx * step), y = Math.min(v.H - 1, gy * step), i = y * v.W + x, z = v.z[i];
      if (!(z > 0) || z > maxZ || (v.added && !v.fresh[i])) continue;
      const xc = (x + 0.5 - v.cx) / v.fx * z, yc = -(y + 0.5 - v.cy) / v.fy * z;
      at[gy * gw + gx] = positions.length / 3; zz[gy * gw + gx] = z;
      positions.push(m[0] * xc + m[1] * yc - m[2] * z + m[3], m[4] * xc + m[5] * yc - m[6] * z + m[7], m[8] * xc + m[9] * yc - m[10] * z + m[11]);
      colors.push(v.painted[i * 4] / 255, v.painted[i * 4 + 1] / 255, v.painted[i * 4 + 2] / 255);
    }
    for (let gy = 0; gy + 1 < gh; gy++) for (let gx = 0; gx + 1 < gw; gx++) {
      const a = gy * gw + gx, b = a + 1, c = a + gw, d = c + 1;
      if (at[a] < 0 || at[b] < 0 || at[c] < 0 || at[d] < 0) continue;
      if (Math.log(Math.max(zz[a], zz[b], zz[c], zz[d]) / Math.min(zz[a], zz[b], zz[c], zz[d])) > 0.25) continue;
      indices.push(at[a], at[c], at[b], at[b], at[c], at[d]);
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), indices: new Uint32Array(indices) };
}
