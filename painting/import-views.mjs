#!/usr/bin/env node
// 外の手法で作った「絵＋奥行き＋カメラ」の組を、絵 1 枚の場面に「足した視点」として取り込む。
//
// 使い方：
//   node import-views.mjs --scene jatte --run <views.json のあるフォルダ> [--prefix X] [--every 1] [--scale 1] [--all] [--no-carve] [--no-settle] [--no-flatten] [--min-conf 0] [--dry]
//
// 入力（<run>/views.json。docs/external-methods.md の「視点の組の形式」）：
//   camera_convention : OpenCV（+x 右、+y 下、+z 前）。c2w はカメラ → 世界。世界 = もとの絵（is_input が true のコマ）のカメラ座標
//   frames[]          : { image, depth（float32 の .npy、(H, W)、カメラの前方向の距離、0 = 無効・空）, confidence?, width, height, fx, fy, cx, cy, c2w（4×4）, is_input }
//
// すること：
//   1. カメラを、この道具の世界（もとの視点 J のカメラを基準、three.js の向き）へ直す。距離は --scale 倍する
//   2. すでにある絵（もとの絵と、先に足した視点）をそのコマのカメラへ写し、写らなかった所だけを「新しい粒にする画素」にする（--all で全画素）。
//      もとの視点から見て、絵に描かれた面より手前に来る点は、もとの絵と食い違うので捨てる（--no-carve で捨てない）
//      新しい画素の奥行きは、場面の形に合わせて整える：物の陰から現れた所は背景の側の奥行き、地面は平面の式（--no-settle でそのまま使う）。
//      傾いて推定された地面（絵の端で芝が斜めの板になって浮く所）も平面に載せる（--no-flatten でやらない）
//   3. 種類の札を、高さと色から付ける（studio/dream.js の labelHoles）
//   4. scenes/<場面>/paint-out と previz-export に、足した視点と同じ名前の付け方で保存し、added_views.json に書き足す
// 名前は <prefix>1, <prefix>2, …（初めは X。.gitignore が X<数字>_*.png を外してある）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { warp, compose, labelHoles, colorModel, inFreeSpace, settleHoleDepth, depthPng, depthViewPng, labelPngs, typeColorPng } from '../studio/dream.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');

function args() {
  const a = { scene: 'jatte', prefix: 'X', every: 1, scale: 1, 'min-conf': 0 }, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i].replace(/^--/, '');
    if (k === 'all' || k === 'dry' || k === 'no-carve' || k === 'no-settle' || k === 'no-flatten') { a[k] = true; continue; }
    const x = v[++i]; a[k] = x !== '' && !isNaN(Number(x)) ? Number(x) : x;
  }
  if (!a.run) { console.error('--run <views.json のあるフォルダ> を指定してください'); process.exit(1); }
  if (!/^[A-Z]$/.test(String(a.prefix)) || a.prefix === 'J') { console.error('--prefix は J 以外の大文字 1 字にしてください（例：X）'); process.exit(1); }
  if (!/^[A-Za-z0-9_-]+$/.test(String(a.scene))) { console.error('--scene の名前が使えません'); process.exit(1); }
  return a;
}

// .npy（float32 / float64 / float16 は不可、C 並び）を読む。返すのは { shape, data（Float32Array） }
export function readNpy(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 1, 6) !== 'NUMPY') throw new Error(`${file}：.npy ではありません`);
  const major = b[6], hl = major >= 2 ? b.readUInt32LE(8) : b.readUInt16LE(8), start = (major >= 2 ? 12 : 10), head = b.toString('latin1', start, start + hl);
  const descr = /'descr':\s*'([^']+)'/.exec(head)[1], fortran = /'fortran_order':\s*True/.test(head);
  const shape = /'shape':\s*\(([^)]*)\)/.exec(head)[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (fortran) throw new Error(`${file}：fortran 並びには対応していません`);
  const n = shape.reduce((p, q) => p * q, 1), body = b.subarray(start + hl), out = new Float32Array(n);
  if (descr === '<f4') for (let i = 0; i < n; i++) out[i] = body.readFloatLE(i * 4);
  else if (descr === '<f8') for (let i = 0; i < n; i++) out[i] = body.readDoubleLE(i * 8);
  else if (descr === '|u1') for (let i = 0; i < n; i++) out[i] = body[i];
  else if (descr === '<u2') for (let i = 0; i < n; i++) out[i] = body.readUInt16LE(i * 2);
  else throw new Error(`${file}：型 ${descr} には対応していません（float32 で保存してください）`);
  return { shape, data: out };
}

export const rgbaOf = async (file, W, H) => { // 絵を RGBA（W×H。大きさが違えば合わせる）で読む
  let s = sharp(file).removeAlpha().ensureAlpha();
  if (W && H) s = s.resize(W, H, { fit: 'fill' });
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), W: info.width, H: info.height };
};
export const savePng = (file, rgba, W, H) => sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: W, height: H, channels: 4 } }).png().toFile(file);

// 4×4（行ごとの 16 個）の掛け算と、回転＋平行移動の行列の逆
const mul = (a, b) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]; return o; };
const rigidInverse = (m) => {
  const o = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  for (let r = 0; r < 3; r++) o[r * 4 + 3] = -(o[r * 4] * m[3] + o[r * 4 + 1] * m[7] + o[r * 4 + 2] * m[11]);
  return o;
};
const rows = (m) => [0, 4, 8, 12].map((i) => m.slice(i, i + 4).map((x) => +x.toFixed(8)));

// 場面の視点（もとの絵と、すでに足した視点）を、写す計算の形で読む
export async function loadScene(dir) {
  const E = path.join(dir, 'previz-export'), P = path.join(dir, 'paint-out');
  const cams = JSON.parse(fs.readFileSync(path.join(E, 'cameras.json'), 'utf8'));
  if (!cams.source || cams.source.kind !== 'painting') throw new Error('この場面は絵 1 枚から作った場面ではありません');
  const addedFile = path.join(E, 'added_views.json'), added = fs.existsSync(addedFile) ? JSON.parse(fs.readFileSync(addedFile, 'utf8')) : [];
  const { near, far } = cams.depth, views = [];
  for (const def of [...cams.views, ...added]) {
    const W = def.width, H = def.height, n = W * H, painted = path.join(P, `${def.name}_painted.png`);
    if (!fs.existsSync(painted) || !fs.existsSync(path.join(E, def.depth))) continue;
    const dp = (await rgbaOf(path.join(E, def.depth), W, H)).data, z = new Float32Array(n), type = new Uint8Array(n), object = new Uint16Array(n);
    for (let i = 0; i < n; i++) { const v = dp[i * 4] * 256 + dp[i * 4 + 1]; z[i] = v ? 1 / (v / 65535 * (1 / near - 1 / far) + 1 / far) : 0; }
    if (def.labels && fs.existsSync(path.join(E, def.labels))) { const lp = (await rgbaOf(path.join(E, def.labels), W, H)).data; for (let i = 0; i < n; i++) type[i] = lp[i * 4]; }
    if (def.objects && fs.existsSync(path.join(E, def.objects))) { const op = (await rgbaOf(path.join(E, def.objects), W, H)).data; for (let i = 0; i < n; i++) object[i] = op[i * 4] + op[i * 4 + 1] * 256; }
    let valid = null;
    if (def.added) { // 足した視点は、新しく粒にした画素だけを写す元にする
      const f = path.join(P, `${def.name}_new.png`); if (!fs.existsSync(f)) continue;
      const m = (await rgbaOf(f, W, H)).data; valid = new Uint8Array(n); for (let i = 0; i < n; i++) valid[i] = m[i * 4] > 127 ? 1 : 0;
    }
    const k = def.intrinsics;
    views.push({ name: def.name, def, W, H, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, c2w: def.extrinsics.camera_to_world.flat(), w2c: def.extrinsics.world_to_camera.flat(), z, type, object, valid, painted: (await rgbaOf(painted, W, H)).data });
  }
  return { cams, added, addedFile, views, E, P };
}

async function main() {
  const a = args(), dir = path.join(ROOT, 'scenes', String(a.scene)), run = path.resolve(String(a.run));
  const spec = JSON.parse(fs.readFileSync(path.join(run, 'views.json'), 'utf8'));
  const S = await loadScene(dir), base = S.views.find((v) => !v.def.added);
  if (!base) throw new Error('もとの視点の絵がありません');
  const types = (S.cams.labels && S.cams.labels.types) || [], id = (name) => { const t = types.find((x) => x.name === name); return t ? t.id : undefined; };
  const ids = { sky: id('sky') ?? 0, ground: id('ground') ?? 1, far: id('far') ?? id('ground') ?? 1, water: id('water'), tree: id('tree'), figure: id('figure') };
  const COLORS = { sky: [185, 199, 207], ground: [124, 154, 72], water: [106, 140, 190], figure: [190, 120, 90], far: [150, 170, 150], tree: [70, 110, 60] }, colors = [];
  for (const t of types) colors[t.id] = COLORS[t.name] || [140, 140, 140];
  const model = colorModel({ W: base.W, H: base.H, painted: base.painted, type: base.type, z: base.z });
  const eye = S.cams.source.params && Number.isFinite(S.cams.source.params.eye) ? S.cams.source.params.eye : 1.7, groundY = base.def.extrinsics.position[1] - eye;
  const { near, far } = S.cams.depth, FLIP = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]; // OpenCV のカメラの向き ↔ three.js のカメラの向き
  // 入力のコマ（もとの絵）のカメラ座標が世界。無ければ単位行列とみなす
  const input = spec.frames.find((f) => f.is_input), inC2w = input ? input.c2w.flat() : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], inInv = rigidInverse(inC2w);
  const used = new Set([...S.cams.views, ...S.added].map((v) => v.name)); let next = 1;
  const frames = spec.frames.filter((f) => !f.is_input).filter((_, k) => k % Math.max(1, a.every) === 0);
  console.log(`${path.basename(run)}：${spec.frames.length} コマのうち ${frames.length} コマを取り込みます（生成：${spec.generator || '?'}、復元：${spec.reconstructor || 'なし'}、距離の倍率 ${a.scale}）`);
  const sources = S.views.slice(), added = S.added.slice();
  for (const f of frames) {
    if (!f.depth) { console.log(`  ${f.image}：奥行きが無いので飛ばします`); continue; }
    while (used.has(`${a.prefix}${next}`)) next++;
    const name = `${a.prefix}${next}`; used.add(name);
    const W = f.width, H = f.height, n = W * H, img = await rgbaOf(path.join(run, f.image), W, H), dep = readNpy(path.join(run, f.depth));
    if (dep.data.length !== n) throw new Error(`${f.depth}：大きさが ${dep.shape.join('×')} で、絵（${H}×${W}）と合いません`);
    const conf = f.confidence && a['min-conf'] > 0 ? readNpy(path.join(run, f.confidence)).data : null;
    const z = new Float32Array(n); for (let i = 0; i < n; i++) { const v = dep.data[i] * a.scale; z[i] = Number.isFinite(v) && v > 0 && (!conf || conf[i] >= a['min-conf']) ? Math.min(far * 0.99, Math.max(near * 1.01, v)) : 0; }
    // カメラ：入力のコマから見た位置（OpenCV）→ この道具の世界（three.js の向き）
    const rel = mul(inInv, f.c2w.flat()); rel[3] *= a.scale; rel[7] *= a.scale; rel[11] *= a.scale;
    const c2w = mul(mul(base.c2w, FLIP), mul(rel, FLIP)), w2c = rigidInverse(c2w), cam = { W, H, fx: f.fx, fy: f.fy, cx: f.cx, cy: f.cy, c2w, w2c };
    // すでにある絵をこのカメラへ写す。写らなかった所が、新しく粒にする画素
    const c = compose(warp(cam, sources), sources, { skyType: ids.sky }), fresh = new Uint8Array(n);
    // 穴の奥行きを場面の形に合わせて整える：物の陰から現れた所は背景の側の奥行き、地面は平面の式（studio/dream.js の settleHoleDepth）
    const settled = a['no-settle'] || a.all ? null : settleHoleDepth({ W, H, hole: c.hole, z: Float32Array.from(c.z, (v, i) => (c.hole[i] ? 0 : v)) }, z, { cam, groundY, maxSlope: a['no-flatten'] ? 0 : 35 });
    let count = 0, carved = 0;
    for (let i = 0; i < n; i++) {
      fresh[i] = (a.all || c.hole[i]) && z[i] > 0 ? 1 : 0;
      // もとの絵と食い違う点は捨てる：もとの視点から見て、絵に描かれた面より手前（何も無いはずの所）に来る点
      if (fresh[i] && !a['no-carve'] && inFreeSpace(base, cam, i % W, (i - i % W) / W, z[i])) { fresh[i] = 0; carved++; }
      count += fresh[i];
    }
    const lab = { W, H, hole: fresh, type: new Uint8Array(c.type), object: new Uint16Array(c.object) };
    labelHoles(lab, z, cam, { ids, groundY, rgba: img.data, model, objectBase: 40000 + Math.min(120, next) * 200 });
    const pos = [c2w[3], c2w[7], c2w[11]], fwd = [-c2w[2], -c2w[6], -c2w[10]];
    const def = {
      name, added: true, imported: { run: path.basename(run), image: f.image, generator: spec.generator || null, reconstructor: spec.reconstructor || null },
      color: `${name}_color.png`, depth: `${name}_depth.png`, depth_view: `${name}_depth_view.png`, labels: `${name}_labels.png`, objects: `${name}_objects.png`,
      width: W, height: H, intrinsics: { fx: f.fx, fy: f.fy, cx: f.cx, cy: f.cy, fov_y_deg: +(2 * Math.atan(H / 2 / f.fy) * 180 / Math.PI).toFixed(6), K: [[f.fx, 0, f.cx], [0, f.fy, f.cy], [0, 0, 1]] },
      extrinsics: { position: pos.map((x) => +x.toFixed(4)), target: pos.map((x, k) => +(x + fwd[k] * 10).toFixed(4)), camera_to_world: rows(c2w), world_to_camera: rows(w2c) },
    };
    console.log(`  ${name} ← ${f.image}：${W}×${H}、位置 ${def.extrinsics.position.join(', ')}、新しく粒にする画素 ${(100 * count / n).toFixed(1)}%（もとの絵と食い違うので捨てた画素 ${(100 * carved / n).toFixed(1)}%${settled ? `、背景の奥行きにした画素 ${(100 * settled.slivers / n).toFixed(1)}%、地面の平面に載せた画素 ${(100 * settled.snapped / n).toFixed(1)}%、傾いていたので地面に直した画素 ${(100 * settled.flattened / n).toFixed(1)}%` : ''}）`);
    if (a.dry) continue;
    const mask = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = fresh[i] ? 255 : 0; mask[i * 4 + 3] = 255; }
    const L = labelPngs(lab.type, lab.object, n);
    await savePng(path.join(S.P, `${name}_painted.png`), img.data, W, H);
    await savePng(path.join(S.P, `${name}_reproj.png`), c.rgba, W, H);
    await savePng(path.join(S.P, `${name}_holes.png`), mask, W, H);
    await savePng(path.join(S.P, `${name}_new.png`), mask, W, H);
    await savePng(path.join(S.E, def.depth), depthPng(z, n, near, far), W, H);
    await savePng(path.join(S.E, def.depth_view), depthViewPng(z, n), W, H);
    await savePng(path.join(S.E, def.labels), L.type, W, H);
    await savePng(path.join(S.E, def.objects), L.object, W, H);
    await savePng(path.join(S.E, def.color), typeColorPng(lab.type, z, n, colors), W, H);
    added.push(def);
    fs.writeFileSync(S.addedFile, JSON.stringify(added, null, 1));
    // 次のコマからは、このコマも「すでにある絵」に入れる（同じ所を二重に粒にしない）
    sources.push({ name, def, W, H, fx: f.fx, fy: f.fy, cx: f.cx, cy: f.cy, c2w, w2c, z, type: lab.type, object: lab.object, valid: fresh, painted: img.data });
  }
  console.log(a.dry ? '（--dry：何も書いていません）' : `終わりました。「粒の空間」で「ファイルを読み直す」を押すと加わります。取り消すときは「視点を足す」のタブの「取り消す」。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
