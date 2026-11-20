// 3D の形（三角形）を、絵画の筆跡の粒（ストローク）に変える。DOM も THREE も使わない（Web Worker でも node でも動く）。
//
// 流れ：
//   1. 参照の絵（絵画 1 枚以上と、そのカメラ）ごとに、形を CPU で描いて「画素ごとの奥行き・三角形・面の向き・種類・物体」を作る（rasterize）
//   2. 絵から筆跡を測る（shared/brushstats.js）：種類ごとの筆の幅・長さ・向きの分布・毛の筋の強さ
//   3. 絵から色の決まりを学ぶ（learnModels）：物体ごとに「面の向き → 色」の 1 次式（陰影）と、そこからのずれの見本（色の揺らぎ）
//   4. 空間を 8 分木に分け、箱ごとに、その箱の大きさに見合った太さの筆跡を表面にまく（generateNode）。
//      深い箱ほど細い筆。見る側（studio/strokes.js）は、画面の上での筆の太さが絵の筆と同じくらいになる深さの箱を選んで描く（LOD）。
//      そのため、近くでも遠くでも「画面の上で同じ大きさの筆跡」に見える（絵画と同じ）
//   5. 筆跡ごとに：絵に写っている所は絵の色と筆の向きを写し、写っていない所は学んだ決まりから作る（両者は写りの良さでなめらかにまぜる）
//   空は形が無いので、向きだけの球（天球）に同じやり方で筆跡をまく（generateSky）。
//
// カメラ：{ W, H, fx, fy, cx, cy, view（ワールド → カメラの 4×4、列ごと = THREE の matrixWorldInverse.elements）, pos }
//   カメラは -Z を向き、+Y が上。画素の y は下向き。
import { pullPush } from '../studio/layers.js';
import { measureStrokes, blur, blurColor, angleFromHist, ANGLE_BINS } from './brushstats.js';

export const SRC = { painted: 0, synth: 1 };
const UP = [0, 1, 0];

// ---- 小道具 ----
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash3(x, y, z, s) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(s | 0, 1274126177); h = Math.imul(h ^ (h >>> 13), 1103515245); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
const fade = (t) => t * t * (3 - 2 * t);
/** なめらかな 3D の値ノイズ（0〜1）。 */
function vnoise(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = fade(x - xi), fy = fade(y - yi), fz = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t, h = (i, j, k) => hash3(xi + i, yi + j, zi + k, s);
  return l(l(l(h(0, 0, 0), h(1, 0, 0), fx), l(h(0, 1, 0), h(1, 1, 0), fx), fy), l(l(h(0, 0, 1), h(1, 0, 1), fx), l(h(0, 1, 1), h(1, 1, 1), fx), fy), fz);
}
/** 決まった大きさ（m）の何段かのノイズを足したもの（0〜1 くらい）。minScale より細かい段は使わない（遠くの粗い筆跡でも模様が同じになるように）。 */
export function fbm(p, s, minScale, scales = [48, 16, 6, 2, 0.7, 0.25]) {
  let v = 0, w = 0, a = 1;
  for (const sc of scales) { if (sc < minScale) break; v += (vnoise(p[0] / sc, p[1] / sc, p[2] / sc, s + sc * 7) - 0.5) * a; w += a; a *= 0.75; }
  return w ? 0.5 + v / w * 1.7 : 0.5;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- カメラ ----
export function toCam(cam, p) {
  const m = cam.view;
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
/** ワールドの点 → [画素 x, 画素 y, 奥行き]。奥行きが 0 以下（カメラの後ろ）なら null。 */
export function project(cam, p) { const c = toCam(cam, p), d = -c[2]; if (d <= 1e-6) return null; return [cam.cx + cam.fx * c[0] / d, cam.cy - cam.fy * c[1] / d, d]; }
/** ワールドの向き → 画素（無限に遠い点）。後ろ向きなら null。 */
export function projectDir(cam, d) { const m = cam.view, c = [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]], z = -c[2]; if (z <= 1e-6) return null; return [cam.cx + cam.fx * c[0] / z, cam.cy - cam.fy * c[1] / z, z]; }
/** 画素を通る視線の向き（ワールド、長さ 1）。 */
export function rayDir(cam, x, y) {
  const c = [(x - cam.cx) / cam.fx, -(y - cam.cy) / cam.fy, -1], m = cam.view; // view の回転の転置を掛ける
  return norm([m[0] * c[0] + m[1] * c[1] + m[2] * c[2], m[4] * c[0] + m[5] * c[1] + m[6] * c[2], m[8] * c[0] + m[9] * c[1] + m[10] * c[2]]);
}
export function camRight(cam) { const m = cam.view; return norm([m[0], m[4], m[8]]); }

// ---- 1. 形を参照の絵のカメラで描く（CPU） ----
/**
 * tris = { n, pos（n × 9）, nrm（n × 9。頂点の面の向き）, type（n）, object（n） }
 * 返すもの：{ z（奥行き。0 = 何も無い = 空）, tri（三角形の番号。-1 = 空）, nrm（画素 × 3） }
 */
export function rasterize(tris, cam, near = 0.05) {
  const { W, H } = cam, z = new Float32Array(W * H), tri = new Int32Array(W * H).fill(-1), bary = new Float32Array(W * H * 2);
  for (let t = 0; t < tris.n; t++) {
    // カメラの座標へ。頂点ごとに [x, y, z, w0, w1, w2]（w = もとの 3 頂点の重み）
    let poly = [];
    for (let k = 0; k < 3; k++) { const c = toCam(cam, [tris.pos[t * 9 + k * 3], tris.pos[t * 9 + k * 3 + 1], tris.pos[t * 9 + k * 3 + 2]]); poly.push([c[0], c[1], c[2], k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]); }
    // 手前の面（z = -near）で切る
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ia = a[2] <= -near, ib = b[2] <= -near;
      if (ia) out.push(a);
      if (ia !== ib) { const s = (-near - a[2]) / (b[2] - a[2]); out.push(a.map((v, j) => v + (b[j] - v) * s)); }
    }
    if (out.length < 3) continue;
    poly = out.map((c) => { const d = -c[2]; return [cam.cx + cam.fx * c[0] / d, cam.cy - cam.fy * c[1] / d, 1 / d, c[3] / d, c[4] / d, c[5] / d]; });
    for (let i = 1; i + 1 < poly.length; i++) rasterTri(poly[0], poly[i], poly[i + 1], t, W, H, z, tri, bary);
  }
  const nrm = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const t = tri[i]; if (t < 0) continue;
    const b1 = bary[i * 2], b2 = bary[i * 2 + 1], b0 = 1 - b1 - b2, o = t * 9;
    const n = norm([b0 * tris.nrm[o] + b1 * tris.nrm[o + 3] + b2 * tris.nrm[o + 6], b0 * tris.nrm[o + 1] + b1 * tris.nrm[o + 4] + b2 * tris.nrm[o + 7], b0 * tris.nrm[o + 2] + b1 * tris.nrm[o + 5] + b2 * tris.nrm[o + 8]]);
    nrm[i * 3] = n[0]; nrm[i * 3 + 1] = n[1]; nrm[i * 3 + 2] = n[2];
  }
  return { z, tri, nrm };
}
function rasterTri(a, b, c, t, W, H, zbuf, tri, bary) {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-12) return;
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const l0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area, l1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area, l2 = 1 - l0 - l1;
    if (l0 < -1e-7 || l1 < -1e-7 || l2 < -1e-7) continue;
    const iz = l0 * a[2] + l1 * b[2] + l2 * c[2]; if (iz <= 0) continue;
    const d = 1 / iz, i = y * W + x;
    if (zbuf[i] && zbuf[i] <= d) continue;
    zbuf[i] = d; tri[i] = t;
    // もとの三角形での重み（遠近を正しく）
    bary[i * 2] = (l0 * a[4] + l1 * b[4] + l2 * c[4]) * d; bary[i * 2 + 1] = (l0 * a[5] + l1 * b[5] + l2 * c[5]) * d;
  }
}

// ---- 2・3. 参照の絵を調べて、決まりを学ぶ ----
/**
 * refs = [{ name, cam, rgba }]。tris は上と同じ。opts.types = 種類の一覧（id → { key, ... }）
 * 返すもの：analysis（決まりと、確かめ用の地図）
 */
export function analyze(tris, refs, opts = {}) {
  const out = { refs: [], types: new Map(), models: new Map(), sky: null };
  for (const ref of refs) {
    const { W, H } = ref.cam, r = rasterize(tris, ref.cam);
    const kind = new Uint8Array(W * H), object = new Uint16Array(W * H);
    for (let i = 0; i < W * H; i++) { const t = r.tri[i]; kind[i] = t < 0 ? 0 : tris.type[t]; object[i] = t < 0 ? 0 : tris.object[t]; }
    const strokes = measureStrokes(ref.rgba, W, H, kind);
    const col = blurColor(ref.rgba, W, H, strokes.all && strokes.all.dot > 0.5 ? 0.55 : 1.2); // 点描は、点ごとの色の違いが絵の持ち味なので、ほとんどぼかさない
    // 物の境目・奥行きの境目のそば（色が背景とまざっている）を印にする
    const edge = new Uint8Array(W * H), R = 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      for (const [dx, dy] of [[R, 0], [-R, 0], [0, R], [0, -R]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (object[j] !== object[i] || kind[j] !== kind[i] || (r.z[i] && Math.abs(r.z[j] - r.z[i]) > 0.03 * r.z[i] + 0.05)) { edge[i] = 1; break; }
      }
    }
    // 粗い色（点ごとの違いをならした色）と、背景だけの色（物の所を、まわりの背景の色からなめらかに埋めたもの。物に隠れた背景の色に使う）
    const coarse = col.map((ch) => blur(ch, W, H, 3));
    let plate = null;
    if (ref.mask) {
      const known = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) known[i] = ref.mask.object[i] === 0 && object[i] === 0 && r.tri[i] >= 0 ? 1 : 0;
      plate = col.map((ch) => blur(pullPush(ch, known, W, H), W, H, 3));
    }
    out.refs.push({ ...ref, ...r, kind, object, field: strokes.field, col, coarse, plate, edge, strokes });
  }
  // 種類ごとの筆跡（参照の絵が何枚かあれば、画素の多い絵の値を使う）
  for (const ref of out.refs) for (const [k, s] of ref.strokes.byKind) { const old = out.types.get(k); if (!old || old.count < s.count) out.types.set(k, { ...s }); }
  const all = out.refs[0].strokes.all;
  out.ref = { width: all ? all.width : 4, length: all ? all.length : 16, H: out.refs[0].cam.H };
  for (const s of out.types.values()) { s.scale = Math.min(3, Math.max(0.4, s.width / out.ref.width)); s.aspect = Math.min(8, Math.max(1, s.length / Math.max(0.5, s.width))); s.phiHist = new Float64Array(ANGLE_BINS); }
  learnModels(tris, out, opts);
  return out;
}

/** 1 次式 rgb = c0 + C·x（x は 3 次元）を、すこし引き締め（リッジ）ながら当てはめる。 */
function fitLinear(rows, lam) {
  // 4 × 4 の正規方程式
  const A = Array.from({ length: 4 }, () => new Float64Array(4)), B = Array.from({ length: 4 }, () => new Float64Array(3));
  for (const r of rows) { const f = [1, r.x[0], r.x[1], r.x[2]]; for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) A[i][j] += f[i] * f[j]; for (let c = 0; c < 3; c++) B[i][c] += f[i] * r.c[c]; } }
  for (let i = 1; i < 4; i++) A[i][i] += lam * rows.length;
  // ガウスの消去
  const M = A.map((row, i) => [...row, ...B[i]]);
  for (let i = 0; i < 4; i++) {
    let p = i; for (let k = i + 1; k < 4; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i] || 1e-9;
    for (let k = 0; k < 4; k++) if (k !== i) { const f = M[k][i] / d; for (let j = i; j < 7; j++) M[k][j] -= f * M[i][j]; }
  }
  return Array.from({ length: 4 }, (_, i) => [M[i][4] / (M[i][i] || 1e-9), M[i][5] / (M[i][i] || 1e-9), M[i][6] / (M[i][i] || 1e-9)]); // [c0, Cx, Cy, Cz]
}
const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function makeModel(rows, lam, seed) {
  const coef = fitLinear(rows, lam), R = rng(seed), bank = [], lums = [];
  for (let k = 0; k < Math.min(4096, rows.length * 2); k++) {
    const r = rows[Math.floor(R() * rows.length)], g = evalLinear(coef, r.x);
    bank.push([r.c[0] - g[0], r.c[1] - g[1], r.c[2] - g[2]]); lums.push(lumOf(r.c));
  }
  bank.sort((a, b) => lumOf(a) - lumOf(b)); lums.sort((a, b) => a - b);
  // 点描用に、揺らぎを 2 つに分ける：粗い揺らぎ（日なた・日かげのような、広い範囲の色の違い。暗い順）と、細かい揺らぎ（点ごとの色の違い。順不同）
  const low = [], fine = [];
  if (rows[0] && rows[0].f) for (let k = 0; k < Math.min(4096, rows.length * 2); k++) {
    const r = rows[Math.floor(R() * rows.length)], g = evalLinear(coef, r.x);
    low.push([r.c[0] - r.f[0] - g[0], r.c[1] - r.f[1] - g[1], r.c[2] - r.f[2] - g[2]]); fine.push(r.f);
  }
  low.sort((a, b) => lumOf(a) - lumOf(b));
  return { coef, bank, low, fine, count: rows.length, lumLo: lums[Math.floor(lums.length * 0.01)] || 0, lumHi: lums[Math.floor(lums.length * 0.99)] || 1 };
}
export function evalLinear(coef, x) { return [0, 1, 2].map((c) => coef[0][c] + coef[1][c] * x[0] + coef[2][c] * x[1] + coef[3][c] * x[2]); }

/** 局所の向きの基準：面に沿って上へ向かう向き（ほぼ水平な面では、参照の絵の右の向き）。 */
export function surfaceFrame(n, right) {
  let e1;
  if (Math.abs(n[1]) < 0.95) { const u = dot(UP, n); e1 = norm([UP[0] - n[0] * u, UP[1] - n[1] * u, UP[2] - n[2] * u]); }
  else { const u = dot(right, n); e1 = norm([right[0] - n[0] * u, right[1] - n[1] * u, right[2] - n[2] * u]); }
  return [e1, cross(n, e1)];
}

/** 絵の筆の向き（画像の上の角度）を、その画素に写っている面の上の向き（ワールド）に直す。 */
export function paintedTangent(cam, x, y, theta, p, n) {
  const x2 = x + 4 * Math.cos(theta), y2 = y + 4 * Math.sin(theta), d = rayDir(cam, x2, y2), o = cam.pos;
  const den = dot(d, n); if (Math.abs(den) < 1e-5) return null;
  const s = dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], n) / den; if (s <= 0) return null;
  const q = [o[0] + d[0] * s - p[0], o[1] + d[1] * s - p[1], o[2] + d[2] * s - p[2]], u = dot(q, n);
  const t = [q[0] - n[0] * u, q[1] - n[1] * u, q[2] - n[2] * u], l = Math.hypot(t[0], t[1], t[2]);
  return l > 1e-9 ? [t[0] / l, t[1] / l, t[2] / l] : null;
}

function learnModels(tris, A, { lam = 0.15, seed = 3 } = {}) {
  const byObj = new Map(), byType = new Map(), all = [], sky = [];
  for (const ref of A.refs) {
    const { W, H } = ref.cam, right = camRight(ref.cam), fwd = camForward(ref.cam);
    for (let y = 1; y < H - 1; y += 2) for (let x = (y >> 1) & 1; x < W; x += 2) {
      const i = y * W + x;
      if (ref.edge[i]) continue;
      const c = [ref.col[0][i], ref.col[1][i], ref.col[2][i]], f = [c[0] - ref.coarse[0][i], c[1] - ref.coarse[1][i], c[2] - ref.coarse[2][i]];
      if (ref.tri[i] < 0) {
        const d = rayDir(ref.cam, x + 0.5, y + 0.5); sky.push({ x: d, c, f });
        const coh = ref.field.coh[i], st = A.types.get(0); if (coh < 0.15 || !st) continue;
        const th = ref.field.theta[i], d2 = rayDir(ref.cam, x + 0.5 + 4 * Math.cos(th), y + 0.5 + 4 * Math.sin(th)), nn = [-d[0], -d[1], -d[2]], u = dot(d2, nn);
        const t = norm([d2[0] - u * nn[0], d2[1] - u * nn[1], d2[2] - u * nn[2]]), [e1, e2] = surfaceFrame(nn, [1, 0, 0]);
        let phi = Math.atan2(dot(t, e2), dot(t, e1)); if (phi < 0) phi += Math.PI; if (phi >= Math.PI) phi -= Math.PI;
        st.phiHist[Math.min(ANGLE_BINS - 1, Math.floor(phi / Math.PI * ANGLE_BINS))] += coh;
        continue;
      }
      const n = [ref.nrm[i * 3], ref.nrm[i * 3 + 1], ref.nrm[i * 3 + 2]], row = { x: n, c, f };
      const o = ref.object[i], k = ref.kind[i];
      if (!byObj.has(o)) byObj.set(o, []); byObj.get(o).push(row);
      if (!byType.has(k)) byType.set(k, []); byType.get(k).push(row);
      all.push(row);
      // 筆の向きを面の上の向きに直し、局所の基準からの角度を数える（写っていない所の向きの決まり）
      const coh = ref.field.coh[i]; if (coh < 0.15) continue;
      const d = rayDir(ref.cam, x + 0.5, y + 0.5), s = ref.z[i] / dot(d, fwd), p = [ref.cam.pos[0] + d[0] * s, ref.cam.pos[1] + d[1] * s, ref.cam.pos[2] + d[2] * s];
      const t = paintedTangent(ref.cam, x + 0.5, y + 0.5, ref.field.theta[i], p, n); if (!t) continue;
      const [e1, e2] = surfaceFrame(n, right);
      let phi = Math.atan2(dot(t, e2), dot(t, e1)); if (phi < 0) phi += Math.PI; if (phi >= Math.PI) phi -= Math.PI;
      const st = A.types.get(k); if (st) st.phiHist[Math.min(ANGLE_BINS - 1, Math.floor(phi / Math.PI * ANGLE_BINS))] += coh;
    }
  }
  for (const st of A.types.values()) { const s = st.phiHist.reduce((a, b) => a + b, 0); if (s > 0) for (let i = 0; i < ANGLE_BINS; i++) st.phiHist[i] /= s; else st.phiHist.fill(1 / ANGLE_BINS); }
  for (const [o, rows] of byObj) if (rows.length > 300) A.models.set('o' + o, makeModel(rows, lam, seed + o));
  for (const [k, rows] of byType) if (rows.length > 300) A.models.set('t' + k, makeModel(rows, lam, seed + 1000 + k));
  if (all.length) A.models.set('all', makeModel(all, lam, seed + 5000));
  if (sky.length > 300) A.sky = makeModel(sky, 0.02, seed + 7000);
}
function camForward(cam) { const m = cam.view; return norm([-m[2], -m[6], -m[10]]); }

/** 物体 → 種類 → 全体 の順に、ある色の決まりを返す。 */
export function modelFor(A, object, type) { return (object ? A.models.get('o' + object) : null) || A.models.get('t' + type) || A.models.get('all'); }

/** 学んだ決まりからの色（写っていない所）：陰影の 1 次式 + 揺らぎの見本（u = 0〜1 で、暗い見本〜明るい見本） */
export function synthColor(model, x, u, out = [0, 0, 0], fineU = -1) {
  const two = fineU >= 0 && model.low && model.low.length > 0, src = two ? model.low : model.bank;
  const g = evalLinear(model.coef, x), b = src[Math.min(src.length - 1, Math.max(0, Math.floor(u * src.length)))] || [0, 0, 0];
  let c = [g[0] + b[0], g[1] + b[1], g[2] + b[2]];
  if (two) { const f = model.fine[Math.min(model.fine.length - 1, Math.floor(fineU * model.fine.length))]; c = [c[0] + f[0], c[1] + f[1], c[2] + f[2]]; }
  const L = lumOf(c), lo = model.lumLo, hi = model.lumHi;
  if (L > hi && L > 1e-4) c = c.map((v) => v * hi / L); else if (L < lo) c = c.map((v) => v + (lo - L));
  out[0] = Math.min(1, Math.max(0, c[0])); out[1] = Math.min(1, Math.max(0, c[1])); out[2] = Math.min(1, Math.max(0, c[2]));
  return out;
}
export function shadeColor(model, x) { const g = evalLinear(model.coef, x); return g.map((v) => Math.min(1, Math.max(0, v))); }

// ---- 4. 8 分木 ----
/** 形の全体を囲む立方体。 */
export function makeTree(tris, { across = 40, minWidth = 0.02 } = {}) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.n * 3; i++) for (let c = 0; c < 3; c++) { const v = tris.pos[i * 3 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.001 + 1e-3, c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const origin = c.map((v) => v - size / 2);
  let maxLevel = 0; while (size / 2 ** maxLevel / across > minWidth && maxLevel < 24) maxLevel++;
  return { origin, size, across, maxLevel, minWidth };
}
export const nodeKey = (l, x, y, z) => `${l}/${x}/${y}/${z}`;
export function nodeBox(tree, l, x, y, z) { const s = tree.size / 2 ** l; return { lo: [tree.origin[0] + x * s, tree.origin[1] + y * s, tree.origin[2] + z * s], s }; }
export const nodeWidth = (tree, l) => tree.size / 2 ** l / tree.across;

/** 三角形を箱で切った多角形（頂点ごとに [x, y, z, nx, ny, nz]）。 */
export function clipTriToBox(tris, t, lo, s) {
  let poly = [];
  for (let k = 0; k < 3; k++) { const o = t * 9 + k * 3; poly.push([tris.pos[o], tris.pos[o + 1], tris.pos[o + 2], tris.nrm[o], tris.nrm[o + 1], tris.nrm[o + 2]]); }
  for (let ax = 0; ax < 3 && poly.length; ax++) for (const side of [0, 1]) {
    const lim = lo[ax] + (side ? s : 0), inside = (p) => (side ? p[ax] <= lim : p[ax] >= lim), out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) { const f = (lim - a[ax]) / (b[ax] - a[ax]); out.push(a.map((v, j) => v + (b[j] - v) * f)); }
    }
    poly = out;
  }
  return poly.length >= 3 ? poly : null;
}
/** 箱に掛かるかもしれない三角形（外接箱で判定）。 */
export function trisInBox(tris, list, lo, s, margin = 0) {
  const out = [];
  for (const t of list) {
    let ok = true;
    for (let c = 0; c < 3 && ok; c++) {
      const o = t * 9 + c, a = tris.pos[o], b = tris.pos[o + 3], d = tris.pos[o + 6];
      if (Math.max(a, b, d) < lo[c] - margin || Math.min(a, b, d) > lo[c] + s + margin) ok = false;
    }
    if (ok) out.push(t);
  }
  return Int32Array.from(out);
}

// 1 本の筆跡の列（描画用。studio/strokes.js のシェーダーと同じ並び）
//   P = 位置 xyz、幅（m）            N = 面の向き xyz、長さ（m）
//   T = 筆の向き xyz（ワールド）、画面の上での筆の角度（ラジアン。「画面に合わせる」向きのとき）
//   K = 色 rgb（sRGB 0〜1）、塗る順番（0〜1。大きいほど上に重なる）
//   M = 種類、絵から来た割合（0〜1）、筆の形の番号（0〜7）、8 分木の深さ
//   G = 陰影だけの色 rgb（sRGB）、毛の筋の強さ
export const STROKE_ATTRS = ['P', 'N', 'T', 'K', 'M', 'G'];
export const OBJECT_ATTR = 'O'; // 物体の札（書き出し用。描画では使わない）

const NEAR = []; for (let r = 1; r <= 6; r++) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) NEAR.push([a * r, b * r]); // 近い順に 8 方向
/** 参照の絵のうち、この点がいちばんよく写っているもの。[q（0〜1）, 色, 画像の上の筆の角度, はっきりさ, 面の上の筆の向き] */
export function paintedAt(A, p, n, out, object = -1) {
  let best = 0, wsum = 0; const c = [0, 0, 0]; out.theta = 0; out.coh = 0; out.t = null; out.q = 0; out.plate = null;
  for (const ref of A.refs) {
    const pr = project(ref.cam, p); if (!pr) continue;
    const [x, y, d] = pr, { W, H } = ref.cam; if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
    const i = Math.floor(y) * W + Math.floor(x), zr = ref.z[i];
    if (!zr) continue;
    if (ref.plate && object === 0 && ref.mask.object[i] !== 0 && d > zr - 0.02 * d - 0.08) { // 背景が、絵の上では物に隠れている
      let near = false; const fx = Math.floor(x), fy = Math.floor(y);
      for (const [dx, dy] of NEAR) { const xx = fx + dx, yy = fy + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && ref.mask.object[yy * W + xx] === 0) { near = true; break; } }
      if (!near) { out.plate = [ref.plate[0][i], ref.plate[1][i], ref.plate[2][i]]; continue; }
    }
    // 手前に別の物がある（隠れている）なら使わない。絵から組んだ物（札の絵がある）で、その画素のいちばん手前が同じ物なら、奥行きのずれは大目に見る（奥行きのがたつく物でも、表側は絵に写っている）
    const same = ref.mask && object > 0 && ref.object[i] === object;
    if (Math.abs(zr - d) > (same ? 0.1 * d + 0.5 : 0.02 * d + 0.08)) continue;
    // 絵のその画素が別の物（形と絵の輪郭のずれ）なら、すぐそばの同じ物の画素の色を借りる。無ければ使わない
    let ci = i, near = 1;
    if (ref.mask && object >= 0 && ref.mask.object[i] !== object) {
      ci = -1; const fx = Math.floor(x), fy = Math.floor(y);
      for (const [dx, dy] of NEAR) { const xx = fx + dx, yy = fy + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; if (ref.mask.object[yy * W + xx] === object) { ci = yy * W + xx; break; } }
      if (ci < 0) continue; near = 0.9;
    }
    const v = norm([ref.cam.pos[0] - p[0], ref.cam.pos[1] - p[1], ref.cam.pos[2] - p[2]]), cos = dot(v, n);
    let q = (ref.mask ? smooth(0.0005, 0.004, cos) : smooth(0.04, 0.3, cos)) * near; if (q <= 0) continue; // 絵から組んだ場面（札の絵がある）では、浅い角度で見えている面も写す（点描の 1 筆は絵の 1 点の色を取るだけ）。それ以外は、浅い角度の面は学んだ色へ寄せる
    if (ref.edge[i]) q *= ref.mask ? 0.85 : 0.35; // 境目のそば：色が背景とまざっている（物体の札の絵がある場面では、札で分けているので弱く）
    const w = q * q; wsum += w;
    c[0] += ref.col[0][ci] * w; c[1] += ref.col[1][ci] * w; c[2] += ref.col[2][ci] * w;
    if (q > best) { best = q; out.theta = ref.field.theta[i]; out.coh = ref.field.coh[i]; out.t = paintedTangent(ref.cam, x, y, out.theta, p, n); }
  }
  if (wsum > 0) { out.color = [c[0] / wsum, c[1] / wsum, c[2] / wsum]; out.q = best; }
  return out;
}

/**
 * 1 つの箱の筆跡を作る。
 *   list   箱に掛かるかもしれない三角形（trisInBox）
 *   opts   coverage（重ね塗りの厚さ）、orientMix（写っている所で絵の筆の向きをどれだけ使うか）、seed、fill（1 筆が四角を埋める割合）
 * 返すもの：{ count, arrays: { P, N, T, K, M, G, O } }
 */
export function generateNode(tris, A, tree, key, list, opts = {}) {
  const [l, ix, iy, iz] = key.split('/').map(Number), { lo, s } = nodeBox(tree, l, ix, iy, iz), w0 = nodeWidth(tree, l);
  const { coverage = 2.4, fill = 0.62, seed = 1, orientMix = 1, paintedMix = 1, maxCount = 400000 } = opts;
  const R = rng(hash3(ix, iy, iz, l * 131 + seed) * 4294967296);
  const right = camRight(A.refs[0].cam);
  const cols = { P: [], N: [], T: [], K: [], M: [], G: [], O: [] };
  const pa = {}, syn = [0, 0, 0];
  let count = 0, dabs = 0;
  for (const t of list) {
    const poly = clipTriToBox(tris, t, lo, s); if (!poly) continue;
    const type = tris.type[t], object = tris.object[t], st = A.types.get(type) || A.types.get(1) || [...A.types.values()][0];
    const width = w0 * st.scale, length = width * st.aspect, density = coverage / (width * length * fill);
    const model = modelFor(A, object, type);
    for (let f = 1; f + 1 < poly.length; f++) {
      const a = poly[0], b = poly[f], c = poly[f + 1];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], cr = cross(e1, e2), area = Math.hypot(cr[0], cr[1], cr[2]) / 2;
      const m = area * density, k = Math.floor(m) + (R() < m - Math.floor(m) ? 1 : 0);
      for (let j = 0; j < k && count < maxCount; j++) {
        let u = R(), v = R(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const p = [0, 1, 2].map((q) => a[q] + e1[q] * u + e2[q] * v);
        const n = norm([0, 1, 2].map((q) => a[q + 3] * (1 - u - v) + b[q + 3] * u + c[q + 3] * v));
        const [f1, f2] = surfaceFrame(n, right);
        // 写っていない所の向き：種類ごとの向きの分布から、場所でなめらかに変わる値で引く（隣どうしがそろって流れる）
        const ua = fbm(p, 11, length * 2), phi = angleFromHist(st.phiHist, Math.min(0.999, Math.max(0, ua + (R() - 0.5) * 0.12)));
        let tw = [f1[0] * Math.cos(phi) + f2[0] * Math.sin(phi), f1[1] * Math.cos(phi) + f2[1] * Math.sin(phi), f1[2] * Math.cos(phi) + f2[2] * Math.sin(phi)];
        let screen = angleFromHist(st.hist, Math.min(0.999, Math.max(0, fbm(p, 23, length * 2) + (R() - 0.5) * 0.12)));
        // 色：学んだ決まりから
        // 点描（dot が 1 に近い）ほど、隣どうしの色をばらばらにする（点ごとに違う色を置く塗り方）
        // 点描（dot が 1 に近い）：広い範囲の色（日なた・日かげ）は場所でなめらかに選び、点ごとの色の違いは別の見本からばらばらに足す
        const isDot = (st.dot || 0) > 0.5, fineU = isDot ? R() : -1;
        if (isDot) synthColor(model, n, Math.min(1, Math.max(0, fbm(p, 37, 0.7) + (R() - 0.5) * 0.1)), syn, fineU);
        else synthColor(model, n, Math.min(1, Math.max(0, fbm(p, 37, length) + (R() - 0.5) * 0.25)), syn);
        let col = syn, q = 0;
        paintedAt(A, p, n, pa, object);
        if (pa.q === 0 && pa.plate && paintedMix > 0) { // 物に隠れた背景：まわりの背景の色からなめらかに埋めた色に、点ごとの色の違いを足す
          const f = isDot && model.fine && model.fine.length ? model.fine[Math.floor(fineU * model.fine.length)] : [0, 0, 0];
          col = [0, 1, 2].map((i) => Math.min(1, Math.max(0, syn[i] + (pa.plate[i] + f[i] - syn[i]) * paintedMix))); q = 0.5 * paintedMix;
        } else if (pa.q > 0 && paintedMix > 0) {
          q = pa.q * paintedMix;
          col = [0, 1, 2].map((i) => syn[i] + (pa.color[i] - syn[i]) * q);
          const wt = q * smooth(0.1, 0.4, pa.coh) * orientMix;
          if (pa.t && wt > 0) {
            const sg = dot(pa.t, tw) < 0 ? -1 : 1;
            tw = norm([0, 1, 2].map((i) => tw[i] * (1 - wt) + pa.t[i] * sg * wt));
            screen = pa.theta;
          }
        }
        // 形の角のそば：筆を角に沿わせ、幅の半分より角に近ければ内へずらす（筆跡が形の外へはみ出さないように）
        if (tris.sharp && tris.sharp[t]) {
          let best = Infinity, dir = null, away = null;
          for (let e = 0; e < 3; e++) {
            if (!(tris.sharp[t] & (1 << e))) continue;
            const o0 = t * 9 + e * 3, o1 = t * 9 + ((e + 1) % 3) * 3, A0 = [tris.pos[o0], tris.pos[o0 + 1], tris.pos[o0 + 2]], ab = [tris.pos[o1] - A0[0], tris.pos[o1 + 1] - A0[1], tris.pos[o1 + 2] - A0[2]];
            const L2 = dot(ab, ab) || 1e-12, f = Math.min(1, Math.max(0, dot([p[0] - A0[0], p[1] - A0[1], p[2] - A0[2]], ab) / L2));
            const cpt = [A0[0] + ab[0] * f, A0[1] + ab[1] * f, A0[2] + ab[2] * f], dv = [p[0] - cpt[0], p[1] - cpt[1], p[2] - cpt[2]], d = Math.hypot(dv[0], dv[1], dv[2]);
            if (d < best) { best = d; dir = norm(ab); away = d > 1e-9 ? [dv[0] / d, dv[1] / d, dv[2] / d] : null; }
          }
          if (dir && best < length / 2) {
            const wgt = smooth(0, 1, 1 - best / (length / 2)), sg = dot(dir, tw) < 0 ? -1 : 1;
            tw = norm([0, 1, 2].map((i) => tw[i] * (1 - wgt) + dir[i] * sg * wgt));
            if (away && best < width / 2) for (let i = 0; i < 3; i++) p[i] += away[i] * (width / 2 - best);
          }
        }
        const sh = shadeColor(model, n);
        cols.P.push(p[0], p[1], p[2], width); cols.N.push(n[0], n[1], n[2], length); cols.T.push(tw[0], tw[1], tw[2], screen);
        cols.K.push(col[0], col[1], col[2], R()); cols.M.push(type, q, Math.floor(R() * 8) + ((st.dot || 0) > 0.5 ? 8 : 0), l); cols.G.push(sh[0], sh[1], sh[2], st.bristle); cols.O.push(object);
        count++; if ((st.dot || 0) > 0.5) dabs++;
      }
    }
  }
  // 筆跡の順番をまぜる（先頭から何割かだけ描いても、箱の中で一様な間引きになるように）
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)), t = order[i]; order[i] = order[j]; order[j] = t; }
  const arrays = {};
  for (const k of STROKE_ATTRS) { const src = cols[k], a = new Float32Array(count * 4); for (let i = 0; i < count; i++) { const o = order[i] * 4; a[i * 4] = src[o]; a[i * 4 + 1] = src[o + 1]; a[i * 4 + 2] = src[o + 2]; a[i * 4 + 3] = src[o + 3]; } arrays[k] = a; }
  arrays.O = new Uint16Array(count); for (let i = 0; i < count; i++) arrays.O[i] = cols.O[order[i]];
  // 箱の面の向きのそろい方（平均の向きと、その長さ。1 に近いほど平ら）。見る側が、斜めに見る平らな面を粗くするのに使う
  let nx = 0, ny = 0, nz = 0; for (let i = 0; i < count; i++) { nx += arrays.N[i * 4]; ny += arrays.N[i * 4 + 1]; nz += arrays.N[i * 4 + 2]; }
  const nl = Math.hypot(nx, ny, nz);
  return { count, arrays, flat: count ? { n: [nx / (nl || 1), ny / (nl || 1), nz / (nl || 1)], k: nl / count, dab: dabs / count } : null }; // dab = 点（いつもカメラの方を向く筆）の割合
}

/** 子の箱のうち、形が掛かっているもの（8 bit）と、それぞれの三角形の一覧。 */
export function childLists(tris, tree, key, list) {
  const [l, ix, iy, iz] = key.split('/').map(Number), out = [];
  let mask = 0;
  for (let c = 0; c < 8; c++) {
    const cx = ix * 2 + (c & 1), cy = iy * 2 + ((c >> 1) & 1), cz = iz * 2 + ((c >> 2) & 1), { lo, s } = nodeBox(tree, l + 1, cx, cy, cz);
    const sub = trisInBox(tris, list, lo, s);
    let any = false; for (const t of sub) if (clipTriToBox(tris, t, lo, s)) { any = true; break; }
    if (any) { mask |= 1 << c; out.push({ key: nodeKey(l + 1, cx, cy, cz), list: sub }); }
  }
  return { mask, children: out };
}

/**
 * 空の筆跡。向きだけの球の上にまく（描くときは、いつもカメラが中心）。
 *   P.xyz = 向き（長さ 1）、P.w = 幅（ラジアン）。N = 球の内向きの面の向き（-向き）、N.w = 長さ（ラジアン）
 */
export function generateSky(A, opts = {}) {
  const { coverage = 2.4, fill = 0.62, seed = 5, scale = 1, minElev = -0.12, orientMix = 1, paintedMix = 1, maxCount = 1500000 } = opts;
  const st = A.types.get(0), model = A.sky;
  if (!st || !model) return { count: 0, arrays: Object.fromEntries([...STROKE_ATTRS.map((k) => [k, new Float32Array(0)]), ['O', new Uint16Array(0)]]) };
  const ref0 = A.refs[0], width = st.width / ref0.cam.fy * scale, length = width * st.aspect;
  const yLo = Math.sin(minElev), area = 2 * Math.PI * (1 - yLo), n = Math.min(maxCount, Math.round(area * coverage / (width * length * fill)));
  const R = rng(seed * 7919), cols = { P: [], N: [], T: [], K: [], M: [], G: [], O: [] }, syn = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    const y = yLo + (1 - yLo) * R(), az = R() * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), d = [r * Math.sin(az), y, r * Math.cos(az)];
    const nn = [-d[0], -d[1], -d[2]], [f1, f2] = surfaceFrame(nn, [1, 0, 0]);
    const p = [d[0] * 40, d[1] * 40, d[2] * 40]; // ノイズ用の場所（半径 40 の球の上として）
    const phi = angleFromHist(st.phiHist, Math.min(0.999, Math.max(0, fbm(p, 11, 0) + (R() - 0.5) * 0.12)));
    let tw = [0, 1, 2].map((i) => f1[i] * Math.cos(phi) + f2[i] * Math.sin(phi)), screen = angleFromHist(st.hist, Math.min(0.999, Math.max(0, fbm(p, 23, 0) + (R() - 0.5) * 0.12)));
    synthColor(model, d, Math.min(1, Math.max(0, fbm(p, 37, 0) + (R() - 0.5) * (0.25 + 0.75 * (st.dot || 0)))), syn);
    let col = syn.slice(), q = 0;
    for (const ref of A.refs) { // 絵に写っている空（形の無い画素）なら、その色と筆の向き
      const pr = projectDir(ref.cam, d); if (!pr) continue;
      const [x, yy] = pr, { W, H } = ref.cam; if (x < 1 || yy < 1 || x >= W - 1 || yy >= H - 1) continue;
      const i = Math.floor(yy) * W + Math.floor(x); if (ref.tri[i] >= 0) continue;
      const qq = (ref.edge[i] ? 0.35 : 1) * paintedMix; if (qq <= q) continue;
      q = qq; col = [0, 1, 2].map((c) => syn[c] + (ref.col[c][i] - syn[c]) * q);
      const th = ref.field.theta[i], wt = q * smooth(0.1, 0.4, ref.field.coh[i]) * orientMix;
      const d2 = rayDir(ref.cam, x + 4 * Math.cos(th), yy + 4 * Math.sin(th)), u = dot(d2, nn), t = norm([d2[0] - u * nn[0] - d[0] * 0, d2[1] - u * nn[1], d2[2] - u * nn[2]]);
      if (wt > 0) { const sg = dot(t, tw) < 0 ? -1 : 1; tw = norm([0, 1, 2].map((c) => tw[c] * (1 - wt) + t[c] * sg * wt)); screen = th; }
    }
    const sh = shadeColor(model, d);
    cols.P.push(d[0], d[1], d[2], width); cols.N.push(nn[0], nn[1], nn[2], length); cols.T.push(tw[0], tw[1], tw[2], screen);
    cols.K.push(col[0], col[1], col[2], R()); cols.M.push(0, q, Math.floor(R() * 8) + ((st.dot || 0) > 0.5 ? 8 : 0), 0); cols.G.push(sh[0], sh[1], sh[2], st.bristle); cols.O.push(0);
  }
  const arrays = {}; for (const k of STROKE_ATTRS) arrays[k] = Float32Array.from(cols[k]); arrays.O = Uint16Array.from(cols.O);
  return { count: n, arrays, width, length };
}
