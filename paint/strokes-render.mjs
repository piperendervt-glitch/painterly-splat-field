// 「筆跡の粒」を、画面（GPU）を使わずに計算だけで絵にする。確かめ用。
// studio/strokes.js と同じ材料・同じ決まり（shared/strokefield.js・studio/brushtex.js）で、同じ筆跡を同じ形に描く。
// 絵 1 枚の場面（scenes/<名前>/previz-export + paint-out/<視点>_painted.png）だけに対応。
//
//   node paint/strokes-render.mjs --scene scenes/jatte-s --out out/dir [--brush 1] [--views ref,right,left,back,up] [--modes color,source,level] [--scale 1]
//
// 視点：ref = 参照の絵と同じ。ほかは、参照のカメラを動かしたもの（--view "名前:前m,右m,上m,右回り度,下向き度" で足せる）
import fs from 'node:fs';
import path from 'node:path';
import { readPng, writePng, resize } from './image.mjs';
import { analyze, makeTree, generateNode, childLists, generateSky, nodeKey, nodeBox, nodeWidth, toCam, rasterize, modelFor, shadeColor } from '../shared/strokefield.js';
import { buildPaintingTris } from '../shared/paintscene.js';
import { typeByKey } from '../shared/labels.js';
import { brushAtlas, BRUSH_W, BRUSH_H, BRUSH_N } from '../studio/brushtex.js';

const args = {}; const extraViews = [];
for (let i = 2; i < process.argv.length; i++) { const k = process.argv[i].replace(/^--/, ''), v = process.argv[i + 1]; if (k === 'view') extraViews.push(v); else args[k] = v; i++; }
const sceneDir = args.scene, outDir = args.out || 'out/strokes-render';
if (!sceneDir) { console.error('--scene scenes/<名前> を指定してください'); process.exit(1); }
const brush = Number(args.brush) || 1, coverage = Number(args.cover) || 2.4, across = Number(args.across) || 48, layer = 0.3, scale = Number(args.scale) || 1;
const modes = (args.modes || 'color').split(','), viewNames = (args.views || 'ref').split(',');
fs.mkdirSync(outDir, { recursive: true });

const PAINT_TYPE_KEYS = { sky: 'sky', ground: 'grass', water: 'water', figure: 'figure', far: 'far', tree: 'leaves' };
const cams = JSON.parse(fs.readFileSync(path.join(sceneDir, 'previz-export', 'cameras.json'), 'utf8'));
const v = cams.views[0], W = v.width, H = v.height, { near, far } = cams.depth, intr = v.intrinsics;
const img = (f) => resize(readPng(path.join(sceneDir, 'previz-export', f)), W, H).data;
const depthPx = img(v.depth), labPx = img(v.labels), objPx = img(v.objects);
const remap = new Uint8Array(256); for (const t of cams.labels.types || []) remap[t.id] = PAINT_TYPE_KEYS[t.name] ? typeByKey(PAINT_TYPE_KEYS[t.name]).id : 0;
const z = new Float32Array(W * H), type = new Uint8Array(W * H), object = new Uint16Array(W * H);
for (let i = 0; i < W * H; i++) {
  const val = depthPx[i * 4] * 256 + depthPx[i * 4 + 1]; z[i] = val ? 1 / (val / 65535 * (1 / near - 1 / far) + 1 / far) : 0;
  type[i] = remap[labPx[i * 4]]; object[i] = objPx[i * 4] + objPx[i * 4 + 1] * 256;
}
const c2w = v.extrinsics.camera_to_world.flat(), GRASS = typeByKey('grass').id;
const typeOfObject = (o) => remap[((cams.labels.types || []).find((x) => x.name === o.type) || {}).id || 0] || typeByKey('figure').id;
let t0 = Date.now();
const { tris, made, baseY, objects: built } = buildPaintingTris({ W, H, z, type, object, c2w, intr }, cams.objects, { typeOfObject, grass: GRASS, volumeTypes: args.novol ? [] : [typeByKey('leaves').id], proxy: (args.proxy || '').split(',').filter(Boolean).map(Number), fit: !!args.fit });
for (const o of built) if (o.shape && (o.pixels > 5000 || o.vol)) console.log(`  物 ${o.id} 種類 ${o.type} 奥行き ${o.z.toFixed(1)} m 丸さ ${o.shape.round.toFixed(2)} でこぼこ ${(o.shape.bump * 100).toFixed(1)}% 1 周 ${o.shape.waves} 個${o.vol ? ` → かたまり 厚み ${o.vol.toFixed(2)} m でこぼこ ${o.bump.toFixed(2)} m 細かさ ${o.clump.toFixed(2)} m` : ''}`);
console.log(`形：三角形 ${tris.n} 枚、物 ${made} 個、土台 ${baseY.toFixed(2)} m（${Date.now() - t0} ms）`);

// カメラ（c2w は行ごと。列 0 = 右、1 = 上、2 = 後ろ、3 = 位置）
function camFrom(m, s = 1) {
  const R = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]], p = [m[3], m[7], m[11]], view = new Array(16).fill(0);
  for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) view[c * 4 + r] = R[r][c]; view[12 + r] = -(R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2]); }
  view[15] = 1;
  return { W: Math.round(W * s), H: Math.round(H * s), fx: intr.fx * s, fy: intr.fy * s, cx: intr.cx * s, cy: intr.cy * s, view, pos: p };
}
/** 参照のカメラを動かす：前・右・上へ（m）、右回り（度）、下向き（度） */
function moved(fwd, right, up, yawDeg, pitchDeg) {
  const m = c2w.slice(), col = (c) => [m[c], m[4 + c], m[8 + c]], set = (c, a) => { m[c] = a[0]; m[4 + c] = a[1]; m[8 + c] = a[2]; };
  const r0 = col(0), b0 = col(2), f = [-b0[0], 0, -b0[2]], fl = Math.hypot(f[0], f[2]) || 1;
  m[3] += f[0] / fl * fwd + r0[0] * right; m[7] += up; m[11] += f[2] / fl * fwd + r0[2] * right;
  const ya = -yawDeg * Math.PI / 180, cy = Math.cos(ya), sy = Math.sin(ya), rotY = (a) => [a[0] * cy + a[2] * sy, a[1], -a[0] * sy + a[2] * cy];
  for (let c = 0; c < 3; c++) set(c, rotY(col(c)));
  if (pitchDeg) { // 右の軸のまわりに下へ
    const a = -pitchDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), u = col(1), b = col(2);
    set(1, [0, 1, 2].map((i) => u[i] * ca + b[i] * sa)); set(2, [0, 1, 2].map((i) => -u[i] * sa + b[i] * ca));
  }
  return m;
}
const VIEWS = { ref: c2w, right: moved(0, 6, 0, -20, 0), left: moved(0, -6, 0, 20, 0), fwd: moved(12, 0, 0, 0, 0), turn: moved(8, 0, 0, 70, 0), back: moved(30, 0, 0, 180, 0), up: moved(-4, 0, 6, 0, 18), near: moved(9, 2, -0.3, 10, 0) };
for (const s of extraViews) { const [name, rest] = s.split(':'), n = rest.split(',').map(Number); VIEWS[name] = moved(n[0] || 0, n[1] || 0, n[2] || 0, n[3] || 0, n[4] || 0); viewNames.push(name); }

// 参照の絵を調べる
const refCam = camFrom(c2w), painted = resize(readPng(path.join(sceneDir, 'paint-out', `${v.name}_painted.png`)), W, H).data;
t0 = Date.now();
const A = analyze(tris, [{ name: v.name, cam: refCam, rgba: painted, mask: { object } }], {});
const tree = makeTree(tris, { across, minWidth: 0.015 });
console.log(`絵を調べた（${Date.now() - t0} ms）。筆の幅 ${A.ref.width.toFixed(2)} px、8 分木 ${tree.maxLevel} 段`);
for (const [k, s] of A.types) console.log(`  種類 ${k}: 幅 ${s.width.toFixed(2)} 長さ ${s.length.toFixed(2)} 点らしさ ${(s.dot || 0).toFixed(2)} 画素 ${s.count}`);

// 下塗りに使う形：かたまりとして描く物と、輪郭を絵に寄せる物（形が絵と違う）は除く（点が面から離れるので、面を塗ると形が透けて見える）
const proxyIds = new Set((args.proxy || '').split(',').filter(Boolean).map(Number)), keep = [];
for (let t = 0; t < tris.n; t++) if (!(tris.vol[t] > 0) && !(args.fit && proxyIds.has(tris.object[t]))) keep.push(t);
const underMap = Int32Array.from(keep), underTris = { n: keep.length, pos: new Float32Array(keep.length * 9), nrm: new Float32Array(keep.length * 9), type: new Uint8Array(keep.length), object: new Uint16Array(keep.length) };
keep.forEach((t, k) => { underTris.pos.set(tris.pos.subarray(t * 9, t * 9 + 9), k * 9); underTris.nrm.set(tris.nrm.subarray(t * 9, t * 9 + 9), k * 9); underTris.type[k] = tris.type[t]; underTris.object[k] = tris.object[t]; });
const atlas = brushAtlas(), STAND_TYPE = GRASS;
const gen = new Map(); // 箱 → 作った筆跡（視点をまたいで使い回す）
const opts = { coverage, paintedMix: 1, orientMix: 1, fit: !!args.fit };
const allList = Int32Array.from({ length: tris.n }, (_, i) => i);
const hueRgb = (h) => [0, 2 / 3, 1 / 3].map((o) => Math.min(1, Math.max(0, Math.abs(((h + o) % 1) * 6 - 3) - 1)));

function render(name, m) {
  const cam = camFrom(m, scale), { W: w, H: h } = cam, target = A.ref.width * (cam.fy / refCam.fy) * brush * Math.SQRT2;
  const t1 = Date.now(), draw = [];
  const planes = [(c) => -c[2] > 0.05, (c) => cam.fx * c[0] + cam.cx * -c[2] >= 0, (c) => -cam.fx * c[0] + (w - cam.cx) * -c[2] >= 0, (c) => cam.fy * c[1] + (h - cam.cy) * -c[2] >= 0, (c) => -cam.fy * c[1] + cam.cy * -c[2] >= 0];
  const visit = (key, list) => {
    const [l, x, y, zz] = key.split('/').map(Number), { lo, s } = nodeBox(tree, l, x, y, zz), pad = nodeWidth(tree, l) * 6;
    const cs = []; for (let c = 0; c < 8; c++) cs.push(toCam(cam, [lo[0] + (c & 1 ? s + pad : -pad), lo[1] + (c & 2 ? s + pad : -pad), lo[2] + (c & 4 ? s + pad : -pad)]));
    if (planes.some((f) => cs.every((c) => !f(c)))) return;
    let n = gen.get(key);
    if (!n) { const g = generateNode(tris, A, tree, key, list, opts); n = { key, l, g, kids: l < tree.maxLevel ? childLists(tris, tree, key, list).children : [] }; gen.set(key, n); }
    const dx = [0, 1, 2].map((i) => Math.max(lo[i] - pad - cam.pos[i], 0, cam.pos[i] - lo[i] - s - pad)), d = Math.max(0.05, Math.hypot(dx[0], dx[1], dx[2]));
    let tilt = 1, frac = 1;
    if (n.g.flat && n.g.flat.k > 0.85) {
      const c = [0, 1, 2].map((i) => lo[i] + s / 2 - cam.pos[i]), cl = Math.hypot(c[0], c[1], c[2]) || 1, cos = Math.abs((c[0] * n.g.flat.n[0] + c[1] * n.g.flat.n[1] + c[2] * n.g.flat.n[2]) / cl);
      if (n.g.flat.dab > 0.5) { if (d > s) frac = Math.min(1, Math.max(0.12, cos * 1.6)); } else tilt = Math.max(0.2, Math.sqrt(cos));
    }
    if (n.kids.length && nodeWidth(tree, l) * cam.fy / d * tilt > target) { for (const k of n.kids) visit(k.key, k.list); return; }
    draw.push({ ...n, n: Math.max(1, Math.round(n.g.count * frac)) });
  };
  visit(nodeKey(0, 0, 0, 0), allList);
  let total = 0; const levels = []; for (const n of draw) { total += n.n; levels[n.l] = (levels[n.l] || 0) + n.n; }
  console.log(`${name}: 箱 ${draw.length} 個、筆跡 ${(total / 1e6).toFixed(2)} 百万（段ごと ${levels.map((c, i) => c ? `${i}:${(c / 1000).toFixed(0)}k` : '').filter(Boolean).join(' ')}）選ぶのに ${Date.now() - t1} ms`);

  const sky = generateSky(A, opts), skyCol = A.sky ? shadeColor(A.sky, [0, 0.148, -0.989]) : null; // 空の地の色（画面と同じ決め方）
  // 下塗り（形を陰影だけの色で）
  const ras = rasterize(underTris, cam), zb = new Float32Array(w * h).fill(Infinity);
  const under = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const t0 = ras.tri[i], t = t0 < 0 ? -1 : underMap[t0]; if (t < 0) { const c = skyCol || [0.55, 0.57, 0.58]; under[i * 3] = c[0]; under[i * 3 + 1] = c[1]; under[i * 3 + 2] = c[2]; continue; }
    const c = shadeColor(modelFor(A, tris.object[t], tris.type[t]), [tris.nrm[t * 9], tris.nrm[t * 9 + 1], tris.nrm[t * 9 + 2]]);
    under[i * 3] = c[0]; under[i * 3 + 1] = c[1]; under[i * 3 + 2] = c[2]; zb[i] = ras.z[i];
  }

  const V = cam.view, right = [V[0], V[4], V[8]], up = [V[1], V[5], V[9]];
  const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }, dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const SKY_R = 3000;
  for (const mode of modes) {
    const col = Float32Array.from(under), zz = Float32Array.from(zb);
    let drawn = 0;
    const strokes = (arr, count, isSky) => {
      const { P, N, T, K, M, G } = arr;
      for (let s = 0; s < count; s++) {
        const o = s * 4, n = nrm([N[o], N[o + 1], N[o + 2]]);
        const center = isSky ? [cam.pos[0] + P[o] * SKY_R, cam.pos[1] + P[o + 1] * SKY_R, cam.pos[2] + P[o + 2] * SKY_R] : [P[o], P[o + 1], P[o + 2]];
        const width = (isSky ? P[o + 3] * SKY_R : P[o + 3]) * brush, len = (isSky ? N[o + 3] * SKY_R : N[o + 3]) * brush;
        const toC = nrm([cam.pos[0] - center[0], cam.pos[1] - center[1], cam.pos[2] - center[2]]), facing = dt(n, toC);
        const variant = M[o + 2], stand = !isSky && M[o] === STAND_TYPE && variant < 7.5;
        if (!isSky && !stand && facing < -0.05) continue;
        let t = nrm([T[o], T[o + 1], T[o + 2]]), b, lenS = len, base = [0, 0, 0];
        if (stand) {
          const th = T[o + 3], D = [0, 1, 2].map((i) => right[i] * Math.cos(th) - up[i] * Math.sin(th)), sg = dt(D, n) >= 0 ? 1 : -1;
          t = nrm([0, 1, 2].map((i) => D[i] * sg + n[i] * 0.35)); b = nrm(cr(t, toC));
          lenS = len * Math.min(1, Math.max(0.12, Math.sqrt(Math.abs(facing)) * 1.8)); base = t.map((x) => x * lenS * 0.5);
        } else if (!isSky && variant > 7.5) { t = nrm(cr(up, toC)); b = cr(toC, t); base = n.map((x) => x * width * 0.5); }
        else { b = nrm(cr(n, t)); t = cr(b, n); }
        const lift = isSky ? 0 : K[o + 3] * width * layer;
        const c0 = [0, 1, 2].map((i) => center[i] + base[i] + toC[i] * lift);
        // 四すみを画面へ
        const pc = toCam(cam, c0), d0 = -pc[2]; if (d0 <= 0.05) continue;
        const px = cam.cx + cam.fx * pc[0] / d0, py = cam.cy - cam.fy * pc[1] / d0;
        const tc = [V[0] * t[0] + V[4] * t[1] + V[8] * t[2], V[1] * t[0] + V[5] * t[1] + V[9] * t[2], V[2] * t[0] + V[6] * t[1] + V[10] * t[2]];
        const bc = [V[0] * b[0] + V[4] * b[1] + V[8] * b[2], V[1] * b[0] + V[5] * b[1] + V[9] * b[2], V[2] * b[0] + V[6] * b[1] + V[10] * b[2]];
        // 画面の上での、筆の進む向き・幅の向きの 1 筆ぶんのずれ（小さい筆なので、まん中での傾きで近似する）
        const ax = cam.fx * (tc[0] * d0 + pc[0] * tc[2]) / (d0 * d0) * lenS, ay = -cam.fy * (tc[1] * d0 + pc[1] * tc[2]) / (d0 * d0) * lenS, az = -tc[2] * lenS;
        const bx = cam.fx * (bc[0] * d0 + pc[0] * bc[2]) / (d0 * d0) * width, by = -cam.fy * (bc[1] * d0 + pc[1] * bc[2]) / (d0 * d0) * width, bz = -bc[2] * width;
        const det = ax * by - ay * bx; if (Math.abs(det) < 1e-6) continue;
        const ex = (Math.abs(ax) + Math.abs(bx)) / 2, ey = (Math.abs(ay) + Math.abs(by)) / 2;
        const x0 = Math.max(0, Math.floor(px - ex)), x1 = Math.min(w - 1, Math.ceil(px + ex)), y0 = Math.max(0, Math.floor(py - ey)), y1 = Math.min(h - 1, Math.ceil(py + ey));
        if (x0 > x1 || y0 > y1 || (x1 - x0) > 400 || (y1 - y0) > 400) continue;
        let c;
        if (mode === 'source') { const q = M[o + 1]; c = [0.95 + (0.25 - 0.95) * q, 0.55 + (0.85 - 0.55) * q, 0.15 + (0.35 - 0.15) * q]; }
        else if (mode === 'level') c = hueRgb(M[o + 3] / 12);
        else if (mode === 'shade') c = [G[o], G[o + 1], G[o + 2]];
        else c = [K[o], K[o + 1], K[o + 2]];
        const vrow = Math.floor(variant) * BRUSH_H, bristle = mode === 'color' || mode === 'shade' ? G[o + 3] : 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const qx = x + 0.5 - px, qy = y + 0.5 - py, u = (qx * by - qy * bx) / det, vv = (ax * qy - ay * qx) / det;
          if (u < -0.5 || u >= 0.5 || vv < -0.5 || vv >= 0.5) continue;
          const bo = ((vrow + Math.floor((vv + 0.5) * BRUSH_H)) * BRUSH_W + Math.floor((u + 0.5) * BRUSH_W)) * 4;
          if (atlas.data[bo] < 128) continue;
          const i = y * w + x, dz = isSky ? Infinity : d0 + u * az + vv * bz;
          if (!isSky && dz > zz[i]) continue;
          if (!isSky) zz[i] = dz; else if (zz[i] !== Infinity) continue;
          const k = Math.pow(Math.max(0.05, 1 + (atlas.data[bo + 1] / 255 - 0.5) * bristle * 0.9), 1 / 2.2);
          col[i * 3] = c[0] * k; col[i * 3 + 1] = c[1] * k; col[i * 3 + 2] = c[2] * k;
        }
        drawn++;
      }
    };
    if (sky.count) strokes(sky.arrays, sky.count, true);
    for (const n of draw) strokes(n.g.arrays, n.n, false);
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(Math.min(1, Math.max(0, col[i * 3 + c])) * 255); out[i * 4 + 3] = 255; }
    const file = path.join(outDir, `${name}_${mode}.png`); writePng(file, { width: w, height: h, data: out });
    console.log(`  ${file}（描いた筆跡 ${(drawn / 1e6).toFixed(2)} 百万、${Date.now() - t1} ms）`);
  }
}
for (const name of viewNames) { if (!VIEWS[name]) { console.error(`視点 ${name} はありません`); continue; } render(name, VIEWS[name]); }
