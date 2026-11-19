#!/usr/bin/env node
// 物ごとの 3D（paint/objects.mjs make3d の obj3d_<版>_<作り方>_<番号>.glb / .ply）を、絵の物の輪郭に合わせて置き、
// 全部の向きの点の集まり（点群）として 1 つのファイルに書き出す。ブラウザは使わない（PC でまとめて回せる）。
// 置き方は粒の空間と同じ（studio/objectmodel.js の fitContext・fitModel・modelSplats）。
//
//   node painting/objcloud.mjs --previz-export <dir> --paint-out <dir> [--seg depth|sam3] [--method hunyuanmv|hunyuan3d|trellismv|trellis|sam3d|best]
//                              [--ids 3,5] [--stride 1.5] [--near 5] [--min-pixels 50] [--min-iou 0] [--min-thick 0.1] [--back paint|model] [--out <file.ply>]
//
// 出すもの（paint-out に）：
//   objcloud_<版>_<作り方>.ply   点の ply（binary little endian）。世界座標（cameras.json の three.js の座標、m、+Y が上）
//                                x y z（float）、nx ny nz（面の向き、float）、red green blue（uchar。絵から見えている側は絵の色、裏はモデルの色か絵の物の平均色）、
//                                object_id（uint。物体の札）、radius（float。点の半径 m）
//   objcloud_<版>_<作り方>.json  物ごと：id、作り方、モデルのファイル、輪郭の重なり（iou）、色の近さ、向き、大きさ、高さ、点の数。モデルが無い物は missing
//
// --method best：物ごとに、ある作り方のうち輪郭の重なりがいちばん高いものを使う。
// --min-iou：輪郭の重なりがこれより低い物は点群に入れない（json の rejected に載る。受け取る側は、その物を絵からの点のままにする）
// --min-thick：薄すぎるモデル（背景ごと 1 枚の札になったもの）を外す。水平の奥行き ÷ 幅がこれより小さいか、高さが一番長い辺の 5% 未満なら外す。0 で外さない
// --back paint（既定）：点の色を、絵の視点から見てその点を通る画素の、物の絵の色にする（裏や横も、表の点描の色と筆致になる。
//                       その画素が物の外なら、同じ行のいちばん近い物の画素）。model：絵から見えない側はモデルの色（前のやり方）
// --near：これより近い物（m）は、点の間隔を半分にする（近くで点のすき間が見えないように）。0 で変えない
// --stride：点の間隔を、その物の距離での絵の画素いくつぶんにするか（1〜2 が目安。小さいほど点が多い）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { objectTargets, meshPoints, plyPoints, fitContext, fitModel, modelSplats } from '../studio/objectmodel.js';
import { parsePly } from '../studio/sharp.js';
import { frontTable } from '../studio/layers.js';
import { TYPES, typeByKey } from '../shared/labels.js';

export const METHODS = ['hunyuanmv', 'hunyuan3d', 'trellismv', 'trellis', 'sam3d'];
const PAINT_TYPE_KEYS = { sky: 'sky', ground: 'grass', water: 'water', figure: 'figure', far: 'far', tree: 'leaves' }; // studio/splat.js と同じ
const FRONT = frontTable(TYPES);

async function rgba(file, W, H) {
  const img = sharp(file).ensureAlpha();
  const meta = await img.metadata();
  if (W && (meta.width !== W || meta.height !== H)) throw new Error(`${path.basename(file)} の大きさ ${meta.width}x${meta.height} が ${W}x${H} と違います`);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

/** 絵から作った場面の、絵の視点（cameras.json の最初の視点）を読む。版（seg）が depth 以外なら J_seg_<版>.json の絵に替える */
export async function loadView(exportDir, paintOut, seg = 'depth') {
  const cams = JSON.parse(fs.readFileSync(path.join(exportDir, 'cameras.json'), 'utf8'));
  let v = cams.views[0], objectsMeta = cams.objects || [];
  if (seg !== 'depth') {
    const f = path.join(exportDir, `${v.name}_seg_${seg}.json`);
    if (!fs.existsSync(f)) throw new Error(`切り分けの版 ${seg} がありません（${path.basename(f)}）`);
    const doc = JSON.parse(fs.readFileSync(f, 'utf8')); v = { ...v, ...doc.files }; objectsMeta = doc.objects || objectsMeta;
  }
  if (!v.labels || !v.objects) throw new Error('絵から作った場面（種類と物体の絵）ではありません');
  const W = v.width, H = v.height, { near, far } = cams.depth;
  const dp = (await rgba(path.join(exportDir, v.depth), W, H)).data, z = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { const val = dp[i * 4] * 256 + dp[i * 4 + 1]; z[i] = val ? 1 / (val / 65535 * (1 / near - 1 / far) + 1 / far) : 0; }
  const lp = (await rgba(path.join(exportDir, v.labels), W, H)).data, op = (await rgba(path.join(exportDir, v.objects), W, H)).data;
  const remap = new Uint8Array(256);
  for (const t of (cams.labels && cams.labels.types) || []) remap[t.id] = PAINT_TYPE_KEYS[t.name] ? typeByKey(PAINT_TYPE_KEYS[t.name]).id : 0;
  const type = new Uint8Array(W * H), object = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) { type[i] = remap[lp[i * 4]]; object[i] = op[i * 4] + op[i * 4 + 1] * 256; }
  const painted = path.join(paintOut, `${v.name}_painted.png`), colorFile = fs.existsSync(painted) ? painted : path.join(exportDir, v.color);
  const px = (await rgba(colorFile, W, H)).data;
  return { name: v.name, W, H, z, type, object, px, near, far, c2w: v.extrinsics.camera_to_world.flat(), w2c: v.extrinsics.world_to_camera.flat(), intr: v.intrinsics, objectsMeta, colorFile };
}

// ---- glb を読む（node 用。three.js の GLTFLoader の代わり。圧縮した glb は読まない） ----
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
function mat4Mul(a, b) { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; } // 列優先（glTF と同じ）
function trs(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
export async function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('glb ではありません');
  let off = 12, json = null, bin = null;
  while (off < buf.length) { const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true), body = buf.subarray(off + 8, off + 8 + len); if (type === 0x4e4f534a) json = JSON.parse(Buffer.from(body).toString('utf8')); else if (type === 0x004e4942) bin = body; off += 8 + len; }
  if (!json) throw new Error('glb に JSON がありません');
  for (const e of json.extensionsRequired || []) throw new Error(`glb の拡張 ${e} は読めません（圧縮していない glb にしてください）`);
  const bufferBytes = (i) => { const b = json.buffers[i]; if (i === 0 && !b.uri) return bin; if (b.uri && b.uri.startsWith('data:')) return Buffer.from(b.uri.split(',')[1], 'base64'); throw new Error('外のファイルを指す glb は読めません'); };
  const viewBytes = (i) => { const bv = json.bufferViews[i], b = bufferBytes(bv.buffer || 0); return { bytes: b.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), stride: bv.byteStride || 0 }; };
  const accessor = (i, asFloat = true) => {
    const a = json.accessors[i], nc = NCOMP[a.type], T = COMP[a.componentType], out = asFloat ? new Float32Array(a.count * nc) : new Uint32Array(a.count * nc);
    if (a.bufferView === undefined) return out;
    const { bytes, stride } = viewBytes(a.bufferView), es = T.BYTES_PER_ELEMENT, st = stride || es * nc, base = a.byteOffset || 0, ddv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const get = { 5120: (o) => ddv.getInt8(o), 5121: (o) => ddv.getUint8(o), 5122: (o) => ddv.getInt16(o, true), 5123: (o) => ddv.getUint16(o, true), 5125: (o) => ddv.getUint32(o, true), 5126: (o) => ddv.getFloat32(o, true) }[a.componentType];
    const k = asFloat && a.normalized && NORM[a.componentType] ? 1 / NORM[a.componentType] : 1;
    for (let e = 0; e < a.count; e++) for (let c = 0; c < nc; c++) out[e * nc + c] = get(base + e * st + c * es) * k;
    return out;
  };
  const texCache = new Map();
  const texture = async (ti) => {
    if (ti === undefined || !json.textures || !json.textures[ti]) return null;
    if (texCache.has(ti)) return texCache.get(ti);
    let out = null;
    try {
      const im = json.images[json.textures[ti].source], data = im.bufferView !== undefined ? viewBytes(im.bufferView).bytes : im.uri && im.uri.startsWith('data:') ? Buffer.from(im.uri.split(',')[1], 'base64') : null;
      if (data) {
        const { data: px, info } = await sharp(Buffer.from(data)).ensureAlpha().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
        out = { w: info.width, h: info.height, data: new Uint8Array(px.buffer, px.byteOffset, px.length), flipY: false }; // glTF の UV は左上が原点（three.js の GLTFLoader も flipY = false）
      }
    } catch (e) { console.warn(`  モデルの絵を読めませんでした：${e.message}`); }
    texCache.set(ti, out); return out;
  };
  const meshes = [];
  const visit = async (ni, parent) => {
    const node = json.nodes[ni], m = mat4Mul(parent, trs(node));
    if (node.mesh !== undefined) {
      const nm = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]; // 面の向き：回転と大きさだけ（大きさが揃っていない時は少しずれるが、向きの推定には足りる）
      for (const pr of json.meshes[node.mesh].primitives) {
        if (pr.mode !== undefined && pr.mode !== 4) continue; // 三角形だけ
        const at = pr.attributes; if (at.POSITION === undefined) continue;
        const P = accessor(at.POSITION), positions = new Float32Array(P.length);
        for (let i = 0; i < P.length / 3; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; positions[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]; }
        let normals = null;
        if (at.NORMAL !== undefined) { const N = accessor(at.NORMAL); normals = new Float32Array(N.length); for (let i = 0; i < N.length / 3; i++) { const x = N[i * 3], y = N[i * 3 + 1], z = N[i * 3 + 2], a = nm[0] * x + nm[3] * y + nm[6] * z, b = nm[1] * x + nm[4] * y + nm[7] * z, c = nm[2] * x + nm[5] * y + nm[8] * z, l = Math.hypot(a, b, c) || 1; normals[i * 3] = a / l; normals[i * 3 + 1] = b / l; normals[i * 3 + 2] = c / l; } }
        const uvs = at.TEXCOORD_0 !== undefined ? accessor(at.TEXCOORD_0) : null;
        let colors = null;
        if (at.COLOR_0 !== undefined) { const C = accessor(at.COLOR_0), nc = NCOMP[json.accessors[at.COLOR_0].type], cnt = P.length / 3; colors = new Float32Array(cnt * 3); for (let i = 0; i < cnt; i++) for (let k = 0; k < 3; k++) colors[i * 3 + k] = C[i * nc + k]; }
        const indices = pr.indices !== undefined ? accessor(pr.indices, false) : null;
        const mat = pr.material !== undefined ? json.materials[pr.material] : null, pbr = (mat && mat.pbrMetallicRoughness) || {};
        const base = pbr.baseColorFactor ? pbr.baseColorFactor.slice(0, 3) : null, tex = uvs && pbr.baseColorTexture ? await texture(pbr.baseColorTexture.index) : null;
        meshes.push({ positions, normals, uvs, colors, colorSize: 3, indices, base, tex });
      }
    }
    for (const c of node.children || []) await visit(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], scene = json.scenes ? json.scenes[json.scene || 0] : { nodes: json.nodes.map((_, i) => i) };
  for (const ni of scene.nodes) await visit(ni, I);
  if (!meshes.length) throw new Error('モデルに面がありません');
  return meshes;
}

/** モデルのファイルを読み、点を拾う関数を返す（メッシュでも 3D の粒でも同じ形で） */
async function loadModel(file) {
  const buf = fs.readFileSync(file);
  if (/\.glb$/i.test(file)) { const meshes = await parseGlb(buf); return { ups: ['y'], points: (n, up, seed) => meshPoints(meshes, n, { up, seed }) }; }
  const ply = parsePly(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { ups: ['y', 'z'], points: (n, up, seed) => plyPoints(ply, n, { up, seed }) };
}

/** obj3d_<版>_<作り方>_<番号>.glb / .ply の一覧：番号 → { 作り方 → ファイル } */
export function modelFiles(paintOut, seg) {
  const out = new Map(), re = /^obj3d_([a-z0-9]+)_([a-z0-9]+)_(\d{1,5})\.(glb|ply)$/;
  for (const n of fs.readdirSync(paintOut).sort()) {
    const m = re.exec(n); if (!m || m[1] !== seg) continue;
    const id = Number(m[3]); if (!out.has(id)) out.set(id, {});
    const e = out.get(id); if (!e[m[2]] || m[4] === 'glb') e[m[2]] = path.join(paintOut, n); // 同じ作り方に両方あれば glb（色つきのメッシュ）
  }
  return out;
}

/** 1 つの物：向き・大きさ・位置を合わせる（上の向きが決まらないモデルは両方試す） */
function fitOne(model, cx) {
  let best = null;
  for (const up of model.ups) {
    const pts = model.points(12000, up, 1), f = fitModel(pts, cx);
    if (!best || f.auto.iou > best.auto.iou) best = { ...f, up, height: pts.size[1] * f.scale, hasColor: pts.hasColor, area: pts.area, size: pts.size };
  }
  const [sx, sy, sz] = best.size;
  best.thick = Math.min(sx, sz) / Math.max(1e-9, Math.max(sx, sz)); // 水平の薄さ（1 = 丸い、0 = 札）
  best.flat = sy / Math.max(1e-9, sx, sy, sz);                      // 高さの割合（0 に近い = 寝た札）
  return best;
}

/** 物の画素の、行ごとの x の一覧（色を引くため） */
function rowsOf(view, target) {
  const rows = new Map();
  for (let y = target.by0; y <= target.by1; y++) { const xs = []; for (let x = target.bx0; x <= target.bx1; x++) if (view.object[y * view.W + x] === target.id) xs.push(x); if (xs.length) rows.set(y, xs); }
  return rows;
}
/** 点の色を、絵の視点から見てその点を通る物の画素の色にする（--back paint） */
function paintThrough(cols, n, view, target, rows) {
  const { W, H, px } = view, w = view.w2c, { fx, fy, cx: icx, cy: icy } = view.intr, ys = [...rows.keys()];
  if (!ys.length) return;
  const nearestRow = (v) => { let lo = 0, hi = ys.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (ys[m] < v) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(ys[lo - 1] - v) <= Math.abs(ys[lo] - v) ? ys[lo - 1] : ys[lo]; };
  for (let i = 0; i < n; i++) {
    const x = cols.position[i * 3], y = cols.position[i * 3 + 1], z = cols.position[i * 3 + 2];
    const dd = -(w[8] * x + w[9] * y + w[10] * z + w[11]); if (!(dd > 0.01)) continue;
    let u = Math.floor(icx + (w[0] * x + w[1] * y + w[2] * z + w[3]) / dd * fx), v = Math.floor(icy - (w[4] * x + w[5] * y + w[6] * z + w[7]) / dd * fy);
    if (u < 0 || v < 0 || u >= W || v >= H || view.object[v * W + u] !== target.id) {
      // 物の外に写る点：いちばん近い物の縁で折り返して、物の内側（縁から少し入った所）の画素を使う。同じ縁の色が筋のように並ばないように
      if (!rows.has(v)) { const e = nearestRow(v), r = 2 * e - v + Math.sign(e - v) * 3; v = rows.has(r) ? r : nearestRow(r); }
      const xs = rows.get(v); if (!xs || !xs.length) continue;
      const near = (t) => { let lo = 0, hi = xs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < t) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(xs[lo - 1] - t) <= Math.abs(xs[lo] - t) ? xs[lo - 1] : xs[lo]; };
      const e = near(u); u = view.object[v * W + u] === target.id ? u : near(2 * e - u + Math.sign(e - u) * 3);
    }
    const q = (v * W + u) * 4; cols.color[i * 3] = px[q]; cols.color[i * 3 + 1] = px[q + 1]; cols.color[i * 3 + 2] = px[q + 2];
  }
}

export async function objectCloud({ exportDir, paintOut, seg = 'depth', method = 'best', ids = null, stride = 1.5, near = 5, minPixels = 50, minIou = 0, minThick = 0.1, back = 'paint', log = console.log }) {
  const view = await loadView(exportDir, paintOut, seg);
  const targets = objectTargets(view, { front: FRONT, minPixels }).filter((t) => !ids || ids.includes(t.id));
  const files = modelFiles(paintOut, seg), labelOf = new Map((view.objectsMeta || []).map((o) => [o.id, o.label || o.class || o.name || o.type]));
  const parts = [], report = [];
  for (const target of targets) {
    const have = files.get(target.id) || {}, cands = method === 'best' ? METHODS.filter((m) => have[m]) : have[method] ? [method] : [];
    const entry = { id: target.id, label: labelOf.get(target.id) || null, pixels: target.count, depth: +target.depth.toFixed(3) };
    if (!cands.length) { report.push({ ...entry, missing: true }); continue; }
    const cx = fitContext(view, target, { px: view.px, front: FRONT });
    let best = null;
    for (const m of cands) {
      try {
        const model = await loadModel(have[m]), fit = fitOne(model, cx), thin = minThick > 0 && (fit.thick < minThick || fit.flat < 0.05);
        if (!best || (best.thin && !thin) || (best.thin === thin && fit.auto.iou > best.fit.auto.iou)) best = { m, model, fit, thin }; // 薄くない物を先に、その中で輪郭がよく合う物
      } catch (e) { log(`  物体 ${target.id}：${path.basename(have[m])} を読めませんでした（${e.message}）`); }
    }
    if (!best) { report.push({ ...entry, missing: true, error: 'モデルを読めませんでした' }); continue; }
    const { m, model, fit } = best;
    if (best.thin) { report.push({ ...entry, rejected: true, reason: 'thin', method: m, iou: +fit.iou.toFixed(3), thick: +fit.thick.toFixed(3), flat: +fit.flat.toFixed(3) }); log(`  物体 ${target.id}：${m} のモデルが薄すぎる（奥行き ÷ 幅 ${fit.thick.toFixed(2)}、高さの割合 ${fit.flat.toFixed(2)}）ので入れません`); continue; }
    if (fit.iou < minIou) { report.push({ ...entry, rejected: true, reason: 'iou', method: m, iou: +fit.iou.toFixed(3) }); log(`  物体 ${target.id}：${m} の輪郭の重なり ${Math.round(fit.iou * 100)}% が --min-iou より低いので入れません`); continue; }
    let r = 0, g = 0, b = 0, k = 0; // 物の絵の色の平均（モデルに色が無いときの、見えていない側の色）
    for (let o = 0; o < cx.mask.length; o++) if (cx.mask[o] === 1) { r += cx.pc[o * 3]; g += cx.pc[o * 3 + 1]; b += cx.pc[o * 3 + 2]; k++; }
    const fallback = k ? [r / k, g / k, b / k] : [128, 128, 128];
    const spacing = target.depth / view.intr.fx * stride * (near > 0 && target.depth < near ? 0.5 : 1), n = Math.max(2000, Math.min(1500000, Math.round(fit.area * fit.scale * fit.scale / (spacing * spacing))));
    const p = modelSplats(model.points(n, fit.up, 2), fit, view, target, { spacing, px: view.px, paint: true, fallback });
    if (back === 'paint') paintThrough(p.columns, p.count, view, target, rowsOf(view, target));
    parts.push({ id: target.id, cols: p.columns, n: p.count, radius: spacing * 0.7 });
    report.push({ ...entry, method: m, file: path.basename(have[m]), iou: +fit.iou.toFixed(3), colorSim: fit.hasColor ? +fit.colorSim.toFixed(3) : null, yawDeg: Math.round(fit.offset * 180 / Math.PI), up: fit.up,
      thick: +fit.thick.toFixed(3), scale: +fit.scale.toFixed(4), center: fit.center.map((x) => +x.toFixed(3)), height: +fit.height.toFixed(3), points: p.count, seenFromPainting: p.seen, radius: +(spacing * 0.7).toFixed(4) });
    log(`  物体 ${target.id}${entry.label ? `（${entry.label}）` : ''}：${m}、輪郭の重なり ${Math.round(fit.iou * 100)}%、高さ ${fit.height.toFixed(2)} m、点 ${p.count.toLocaleString()}`);
  }
  return { view, parts, report };
}

export function writePointPly(file, parts) {
  const total = parts.reduce((s, p) => s + p.n, 0), REC = 4 * 6 + 3 + 4 + 4;
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\ncomment painterly-splat-field objcloud: world frame of cameras.json (three.js, metres, +Y up)\nelement vertex ${total}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uint object_id\nproperty float radius\nend_header\n`);
  const body = Buffer.alloc(total * REC); let o = 0;
  for (const p of parts) {
    const c = p.cols;
    for (let i = 0; i < p.n; i++) {
      body.writeFloatLE(c.position[i * 3], o); body.writeFloatLE(c.position[i * 3 + 1], o + 4); body.writeFloatLE(c.position[i * 3 + 2], o + 8);
      body.writeFloatLE(c.normal[i * 3] / 127, o + 12); body.writeFloatLE(c.normal[i * 3 + 1] / 127, o + 16); body.writeFloatLE(c.normal[i * 3 + 2] / 127, o + 20);
      body[o + 24] = c.color[i * 3]; body[o + 25] = c.color[i * 3 + 1]; body[o + 26] = c.color[i * 3 + 2];
      body.writeUInt32LE(p.id, o + 27); body.writeFloatLE(p.radius, o + 31); o += REC;
    }
  }
  fs.writeFileSync(file, Buffer.concat([head, body]));
  return total;
}

function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2), n = argv[i + 1]; if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; } } return o; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  const run = async () => {
    if (!o['previz-export'] || !o['paint-out']) throw new Error('--previz-export と --paint-out を指定してください');
    const seg = typeof o.seg === 'string' ? o.seg : 'depth', method = typeof o.method === 'string' ? o.method : 'best';
    if (!/^[a-z0-9]+$/.test(seg)) throw new Error('--seg は depth か sam3 などです');
    if (method !== 'best' && !METHODS.includes(method)) throw new Error(`--method は ${METHODS.join(' / ')} / best のどれかです`);
    const ids = typeof o.ids === 'string' ? o.ids.split(',').map(Number).filter((n) => n > 0) : null, paintOut = path.resolve(o['paint-out']);
    console.log(`物の点群を作ります（切り分け ${seg}、作り方 ${method}）`);
    const t0 = Date.now(), { view, parts, report } = await objectCloud({ exportDir: path.resolve(o['previz-export']), paintOut, seg, method, ids, stride: Number(o.stride) || 1.5, near: o.near !== undefined ? Number(o.near) : 5, minPixels: Number(o['min-pixels']) || 50, minIou: Number(o['min-iou']) || 0, minThick: o['min-thick'] !== undefined ? Number(o['min-thick']) : 0.1, back: o.back === 'model' ? 'model' : 'paint' });
    const base = o.out ? path.resolve(String(o.out)).replace(/\.ply$/i, '') : path.join(paintOut, `objcloud_${seg}_${method}`);
    const total = writePointPly(`${base}.ply`, parts);
    const missing = report.filter((r) => r.missing).map((r) => r.id), rejected = report.filter((r) => r.rejected).map((r) => ({ id: r.id, reason: r.reason, method: r.method, iou: r.iou, thick: r.thick }));
    fs.writeFileSync(`${base}.json`, JSON.stringify({ seg, method, view: view.name, color: path.basename(view.colorFile), frame: 'world frame of cameras.json (three.js, metres, +Y up)', stride: Number(o.stride) || 1.5, near: o.near !== undefined ? Number(o.near) : 5, back: o.back === 'model' ? 'model' : 'paint', minThick: o['min-thick'] !== undefined ? Number(o['min-thick']) : 0.1, points: total, minIou: Number(o['min-iou']) || 0, objects: report.filter((r) => !r.missing && !r.rejected), missing, rejected }, null, 1));
    console.log(`→ ${path.basename(base)}.ply（物 ${parts.length} 個、点 ${total.toLocaleString()}）と .json。モデルが無い物 ${missing.length} 個、合わずに外した物 ${rejected.length} 個。${Math.round((Date.now() - t0) / 1000)} 秒`);
  };
  run().catch((e) => { console.error(`止まりました：${e.message}`); process.exit(1); });
}
