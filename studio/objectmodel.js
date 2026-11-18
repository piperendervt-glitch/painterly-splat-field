// 物体ごとの 3D モデルを、絵の中の物体の位置・大きさ・向きに合わせて置き、粒にする。DOM も THREE も使わない（node でも試せる）。
//
// もと：絵の中の物体を 1 つずつ 3D モデルにして、奥行きに合わせて場面に置く方式（MIDI、CAST、Gen3DSR など）。
// ここでは、モデルを作る所は外の道具（絵 1 枚から 3D モデルを作るもの）に任せ、次の 3 つを受け持つ。
//   1. 物体ごとの切り抜きの絵を作る（objectTargets、cutoutImage）。外の道具に渡す絵
//   2. できたモデルの表面に点をまき（meshPoints）、絵の物体の輪郭に重なるように、向き・大きさ・位置を探す（fitModel）
//   3. その点を粒の列にする（modelSplats）。絵から見えている側には絵の色を写し、裏側はモデルの色を使う
//
// モデルの座標：+Y が上、+Z が正面（glTF の決まり）。up = 'z' なら +Z が上（OBJ に多い）として読み替える。
import { surfelCov, SIGMA_K } from './layers.js';

const pctOf = (hist, total, p) => { let s = 0; const want = total * p; for (let i = 0; i < hist.length; i++) { s += hist[i]; if (s > want) return i; } return hist.length - 1; };

/**
 * 絵の中の「手前の物」を、物体の札ごとに拾う。
 *   view   { W, H, z, type, object }（画素ごと）、front = 種類 → 手前の物か
 * 返すもの：[{ id, typeId, count, x0, y0, x1, y1（輪郭の範囲。はみ出した 0.5% は除く）, bx0, by0, bx1, by1（全部を含む範囲）, depth（距離の中央値）, cut（絵の端で切れている） }]
 */
export function objectTargets(view, { front, minPixels = 1500, maxZ = 400 } = {}) {
  const { W, H, z, type, object } = view, by = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, id = object[i];
    if (!id || !front[type[i]] || !(z[i] > 0) || z[i] > maxZ) continue;
    let t = by.get(id);
    if (!t) by.set(id, (t = { id, count: 0, types: new Map(), xs: new Uint32Array(W), ys: new Uint32Array(H), zs: [], bx0: W, by0: H, bx1: 0, by1: 0 }));
    t.count++; t.xs[x]++; t.ys[y]++; t.types.set(type[i], (t.types.get(type[i]) || 0) + 1);
    if (x < t.bx0) t.bx0 = x; if (x > t.bx1) t.bx1 = x; if (y < t.by0) t.by0 = y; if (y > t.by1) t.by1 = y;
    if (((x ^ y) & 1) === 0) t.zs.push(z[i]);
  }
  const out = [];
  for (const t of by.values()) {
    if (t.count < minPixels) continue;
    const zs = Float32Array.from(t.zs).sort(), typeId = [...t.types].sort((a, b) => b[1] - a[1])[0][0];
    out.push({
      id: t.id, typeId, count: t.count, depth: zs[zs.length >> 1],
      x0: pctOf(t.xs, t.count, 0.005), x1: pctOf(t.xs, t.count, 0.995), y0: pctOf(t.ys, t.count, 0.005), y1: pctOf(t.ys, t.count, 0.995),
      bx0: t.bx0, by0: t.by0, bx1: t.bx1, by1: t.by1, cut: t.bx0 <= 1 || t.by0 <= 1 || t.bx1 >= W - 2 || t.by1 >= H - 2,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * 物体の切り抜きの絵（正方形、物体の外は透明）。絵 1 枚から 3D モデルを作る道具に渡す。
 *   px = 絵（RGBA、W × H）、size = できる絵の 1 辺、pad = まわりの余白（物体の大きいほうの辺に対する割合）
 */
export function cutoutImage(view, target, px, { size = 1024, pad = 0.12 } = {}) {
  const { W, H, object } = view, w = target.bx1 - target.bx0 + 1, h = target.by1 - target.by0 + 1, side = Math.max(w, h) * (1 + 2 * pad);
  const ox = (target.bx0 + target.bx1 + 1) / 2 - side / 2, oy = (target.by0 + target.by1 + 1) / 2 - side / 2, k = side / size, rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = ox + (x + 0.5) * k - 0.5, sy = oy + (y + 0.5) * k - 0.5, nx = Math.round(sx), ny = Math.round(sy), o = (y * size + x) * 4;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H || object[ny * W + nx] !== target.id) { rgba[o] = rgba[o + 1] = rgba[o + 2] = 255; continue; }
    // 色は、物体の中の画素だけでなめらかに拡大する（外の色を混ぜない）
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    let r = 0, g = 0, b = 0, ws = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const qx = x0 + i, qy = y0 + j; if (qx < 0 || qy < 0 || qx >= W || qy >= H || object[qy * W + qx] !== target.id) continue;
      const wt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) + 1e-4, q = (qy * W + qx) * 4;
      r += px[q] * wt; g += px[q + 1] * wt; b += px[q + 2] * wt; ws += wt;
    }
    if (ws > 0) { rgba[o] = r / ws; rgba[o + 1] = g / ws; rgba[o + 2] = b / ws; } else { const q = (ny * W + nx) * 4; rgba[o] = px[q]; rgba[o + 1] = px[q + 1]; rgba[o + 2] = px[q + 2]; }
    rgba[o + 3] = 255;
  }
  return { w: size, h: size, rgba };
}

const toLin = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const toByte = (l) => Math.round(255 * (l <= 0.0031308 ? 12.92 * Math.max(0, l) : 1.055 * Math.pow(Math.min(1, l), 1 / 2.4) - 0.055));
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * モデルの表面に、面積に比例して n 個の点をまく。まん中（箱の中心）が原点になるように移す。
 *   meshes  [{ positions（頂点 × 3）, indices（無ければ 3 頂点ずつ）, normals, uvs, colors（頂点の色。0〜1、リニア）, colorSize（3 か 4）,
 *              base [r, g, b]（材質の色。リニア）, tex { w, h, data（RGBA、sRGB）, flipY } }]
 *   up      'y'（+Y が上）か 'z'（+Z が上）
 * 返すもの：{ n, pos, nrm, col（sRGB の 0〜255）, hasColor, area（表面積）, size [幅, 高さ, 奥行き] }
 */
export function meshPoints(meshes, n, { up = 'y', seed = 1 } = {}) {
  const tris = []; let total = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const conv = up === 'z' ? (p, o, out) => { out[0] = p[o]; out[1] = p[o + 2]; out[2] = -p[o + 1]; } : (p, o, out) => { out[0] = p[o]; out[1] = p[o + 1]; out[2] = p[o + 2]; };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  let hasColor = false;
  meshes.forEach((m, mi) => {
    const P = m.positions, I = m.indices, nt = Math.floor((I ? I.length : P.length / 3) / 3);
    if (m.tex || m.colors || (m.base && (m.base[0] < 0.97 || m.base[1] < 0.97 || m.base[2] < 0.97))) hasColor = true;
    for (let v = 0; v < P.length / 3; v++) { conv(P, v * 3, a); for (let k = 0; k < 3; k++) { if (a[k] < min[k]) min[k] = a[k]; if (a[k] > max[k]) max[k] = a[k]; } }
    for (let t = 0; t < nt; t++) {
      const i0 = I ? I[t * 3] : t * 3, i1 = I ? I[t * 3 + 1] : t * 3 + 1, i2 = I ? I[t * 3 + 2] : t * 3 + 2;
      conv(P, i0 * 3, a); conv(P, i1 * 3, b); conv(P, i2 * 3, c);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (!(area > 0)) continue;
      total += area; tris.push(mi, i0, i1, i2, total);
    }
  });
  const nt = tris.length / 5;
  if (!nt || !(total > 0)) throw new Error('モデルに面がありません');
  const ctr = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Uint8Array(n * 3).fill(200), rand = rng(seed), na = [0, 0, 0], nb = [0, 0, 0], nc = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const want = (k + rand()) / n * total; // 面積の順に並べた上を、等間隔に少しずらして拾う（むらを減らす）
    let lo = 0, hi = nt - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (tris[mid * 5 + 4] < want) lo = mid + 1; else hi = mid; }
    const m = meshes[tris[lo * 5]], i0 = tris[lo * 5 + 1], i1 = tris[lo * 5 + 2], i2 = tris[lo * 5 + 3];
    const r1 = Math.sqrt(rand()), r2 = rand(), w0 = 1 - r1, w1 = r1 * (1 - r2), w2 = r1 * r2;
    conv(m.positions, i0 * 3, a); conv(m.positions, i1 * 3, b); conv(m.positions, i2 * 3, c);
    for (let j = 0; j < 3; j++) pos[k * 3 + j] = w0 * a[j] + w1 * b[j] + w2 * c[j] - ctr[j];
    // 面の向き：頂点の向きがあればそれ、無ければ面の向き
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (m.normals) {
      conv(m.normals, i0 * 3, na); conv(m.normals, i1 * 3, nb); conv(m.normals, i2 * 3, nc);
      const sx = w0 * na[0] + w1 * nb[0] + w2 * nc[0], sy = w0 * na[1] + w1 * nb[1] + w2 * nc[1], sz = w0 * na[2] + w1 * nb[2] + w2 * nc[2];
      if (Math.hypot(sx, sy, sz) > 1e-6) { nx = sx; ny = sy; nz = sz; }
    }
    const nl = Math.hypot(nx, ny, nz) || 1; nrm[k * 3] = nx / nl; nrm[k * 3 + 1] = ny / nl; nrm[k * 3 + 2] = nz / nl;
    // 色（リニアで掛け合わせてから sRGB に戻す）：材質の色 × 頂点の色 × 絵（テクスチャ）
    let r = m.base ? m.base[0] : 1, g = m.base ? m.base[1] : 1, bl = m.base ? m.base[2] : 1;
    if (m.colors) { const s = m.colorSize || 3, C = m.colors; r *= w0 * C[i0 * s] + w1 * C[i1 * s] + w2 * C[i2 * s]; g *= w0 * C[i0 * s + 1] + w1 * C[i1 * s + 1] + w2 * C[i2 * s + 1]; bl *= w0 * C[i0 * s + 2] + w1 * C[i1 * s + 2] + w2 * C[i2 * s + 2]; }
    if (m.tex && m.uvs) {
      const U = m.uvs, T = m.tex; let u = w0 * U[i0 * 2] + w1 * U[i1 * 2] + w2 * U[i2 * 2], v = w0 * U[i0 * 2 + 1] + w1 * U[i1 * 2 + 1] + w2 * U[i2 * 2 + 1];
      u -= Math.floor(u); v -= Math.floor(v); if (T.flipY) v = 1 - v;
      const o = (Math.min(T.h - 1, Math.floor(v * T.h)) * T.w + Math.min(T.w - 1, Math.floor(u * T.w))) * 4;
      r *= toLin[T.data[o]]; g *= toLin[T.data[o + 1]]; bl *= toLin[T.data[o + 2]];
    }
    col[k * 3] = toByte(r); col[k * 3 + 1] = toByte(g); col[k * 3 + 2] = toByte(bl);
  }
  return { n, pos, nrm, col, hasColor, area: total, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// ---- 絵の物体の輪郭に合わせて置く ----

/**
 * 合わせるための下ごしらえ：物体のまわりを粗います目に分け、ます目ごとに「物体か・手前に別の物があるか」と、絵の奥行き・色を持つ。
 *   view { W, H, z, type, object, c2w, w2c（行ごとの 4x4）, intr }、px = 絵（RGBA。無ければ色は比べない）、front = 種類 → 手前の物か
 */
export function fitContext(view, target, { px = null, front = null } = {}) {
  const { W, H, z, type, object } = view, cell = Math.max(1, Math.round(Math.sqrt(target.count / 1500)));
  const w = target.x1 - target.x0 + 1, h = target.y1 - target.y0 + 1, mx = Math.round(w * 0.6) + 4 * cell, my = Math.round(h * 0.6) + 4 * cell;
  const gx0 = Math.floor((target.x0 - mx) / cell), gy0 = Math.floor((target.y0 - my) / cell), gw = Math.ceil((target.x1 + mx) / cell) - gx0 + 1, gh = Math.ceil((target.y1 + my) / cell) - gy0 + 1;
  const mask = new Uint8Array(gw * gh), pz = new Float32Array(gw * gh), pc = new Uint8Array(gw * gh * 3);
  let cells = 0;
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let own = 0, other = 0, all = 0, sz = 0, r = 0, g = 0, b = 0;
    for (let y = (gy0 + gy) * cell; y < (gy0 + gy + 1) * cell; y++) for (let x = (gx0 + gx) * cell; x < (gx0 + gx + 1) * cell; x++) {
      all++;
      if (x < 0 || y < 0 || x >= W || y >= H) { other++; continue; } // 絵の外は「分からない」（手前に物があるのと同じ扱い）
      const i = y * W + x;
      if (object[i] === target.id) { own++; sz += z[i]; if (px) { r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; } }
      else if (z[i] > 0 && z[i] < target.depth && front && front[type[i]]) other++;
    }
    const o = gy * gw + gx;
    if (own * 2 >= all) { mask[o] = 1; cells++; pz[o] = sz / own; pc[o * 3] = r / own; pc[o * 3 + 1] = g / own; pc[o * 3 + 2] = b / own; }
    else if (other * 2 >= all) mask[o] = 2; // 手前の別の物に隠れているかもしれない所：重なりの点数には数えない
  }
  const m = view.c2w, eye = [m[3], m[7], m[11]];
  return { view, target, cell, gx0, gy0, gw, gh, mask, pz, pc, cells, hasPicture: !!px, eye, right: [m[0], m[4], m[8]], upc: [m[1], m[5], m[9]] };
}

const pctSorted = (a, p) => a[Math.max(0, Math.min(a.length - 1, Math.round(p * (a.length - 1))))];

/**
 * 向き yaw（世界の Y 軸まわり。ラジアン）を決めたときの、いちばん合う大きさと位置を求め、合い方を数える。
 * 返すもの：{ yaw, scale, center [x, y, z], iou（輪郭の重なり）, colorSim（重なった所の色の近さ。0〜1）, score }
 */
export function placeModel(pts, cx, yaw, { scaleMul = 1, rounds = 5 } = {}) {
  const { view, target, cell, gx0, gy0, gw, gh, mask, pz, pc, eye, right, upc } = cx, { fx, fy, cx: icx, cy: icy } = view.intr, w = view.w2c, n = pts.n, P = pts.pos;
  const cs = Math.cos(yaw), sn = Math.sin(yaw), u = new Float32Array(n), v = new Float32Array(n), d = new Float32Array(n);
  const mcx = (target.x0 + target.x1 + 1) / 2, mcy = (target.y0 + target.y1 + 1) / 2, mw = target.x1 - target.x0 + 1, mh = target.y1 - target.y0 + 1;
  // 最初の見立て：高さを輪郭の高さに合わせ、輪郭のまん中の向きの、絵の奥行きの所に置く
  let s = (mh * target.depth / fy) / Math.max(1e-6, pts.size[1]);
  const xc0 = (mcx - icx) / fx * target.depth, yc0 = -(mcy - icy) / fy * target.depth, zc0 = -target.depth, m = view.c2w;
  const center = [m[0] * xc0 + m[1] * yc0 + m[2] * zc0 + m[3], m[4] * xc0 + m[5] * yc0 + m[6] * zc0 + m[7], m[8] * xc0 + m[9] * yc0 + m[10] * zc0 + m[11]];
  const zb = new Float32Array(gw * gh), zi = new Int32Array(gw * gh), su = new Float32Array(n), sv = new Float32Array(n);
  const projectAll = () => {
    for (let i = 0; i < n; i++) {
      const x = center[0] + s * (cs * P[i * 3] + sn * P[i * 3 + 2]), y = center[1] + s * P[i * 3 + 1], z = center[2] + s * (-sn * P[i * 3] + cs * P[i * 3 + 2]);
      const xc = w[0] * x + w[1] * y + w[2] * z + w[3], yc = w[4] * x + w[5] * y + w[6] * z + w[7], dd = -(w[8] * x + w[9] * y + w[10] * z + w[11]);
      d[i] = dd; if (dd > 0.01) { u[i] = icx + xc / dd * fx; v[i] = icy - yc / dd * fy; } else { u[i] = v[i] = NaN; }
    }
  };
  const raster = () => { // ます目ごとに、いちばん手前の点
    zb.fill(Infinity); zi.fill(-1);
    for (let i = 0; i < n; i++) {
      if (!(d[i] > 0.01)) continue;
      const gx = Math.floor(u[i] / cell) - gx0, gy = Math.floor(v[i] / cell) - gy0; if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
      const o = gy * gw + gx; if (d[i] < zb[o]) { zb[o] = d[i]; zi[o] = i; }
    }
  };
  const ratios = [];
  for (let it = 0; it < rounds; it++) {
    projectAll();
    // 距離：物体の上のます目で「絵の奥行き ÷ モデルの手前の面の距離」の中央値を、視点を中心に掛ける（見え方は変わらない）
    raster(); ratios.length = 0;
    for (let o = 0; o < gw * gh; o++) if (mask[o] === 1 && zb[o] < Infinity) ratios.push(pz[o] / zb[o]);
    let k = 1;
    if (ratios.length >= 12) { ratios.sort((a, b) => a - b); k = ratios[ratios.length >> 1]; }
    if (k !== 1 && k > 0.05 && k < 20) { for (let j = 0; j < 3; j++) center[j] = eye[j] + (center[j] - eye[j]) * k; s *= k; for (let i = 0; i < n; i++) d[i] *= k; }
    if (it === rounds - 1) break;
    // 大きさと位置：写した点の範囲を、輪郭の範囲に合わせる（面積が同じになる倍率。縦横の比が違う向きでは、どちらにも寄せない）
    let cnt = 0; for (let i = 0; i < n; i++) if (d[i] > 0.01) { su[cnt] = u[i]; sv[cnt] = v[i]; cnt++; }
    if (cnt < 10) break;
    const au = su.subarray(0, cnt).sort(), av = sv.subarray(0, cnt).sort(), pu0 = pctSorted(au, 0.005), pu1 = pctSorted(au, 0.995), pv0 = pctSorted(av, 0.005), pv1 = pctSorted(av, 0.995);
    const pw = Math.max(1, pu1 - pu0), ph = Math.max(1, pv1 - pv0), r = Math.max(0.2, Math.min(5, Math.sqrt((mw * mh) / (pw * ph))));
    const dc = -(w[8] * center[0] + w[9] * center[1] + w[10] * center[2] + w[11]), cu = icx + (w[0] * center[0] + w[1] * center[1] + w[2] * center[2] + w[3]) / dc * fx, cv = icy - (w[4] * center[0] + w[5] * center[1] + w[6] * center[2] + w[7]) / dc * fy;
    const nu = cu + ((pu0 + pu1) / 2 - cu) * r, nv = cv + ((pv0 + pv1) / 2 - cv) * r, dx = (mcx - nu) * dc / fx, dy = -(mcy - nv) * dc / fy;
    s *= r; for (let j = 0; j < 3; j++) center[j] += right[j] * dx + upc[j] * dy;
  }
  if (scaleMul !== 1) { s *= scaleMul; projectAll(); raster(); }
  // 合い方：輪郭の重なり（重なった数 ÷ どちらかにある数。手前に別の物がある所は数えない）と、重なった所の色の近さ
  let inter = 0, uni = 0, diff = 0;
  for (let o = 0; o < gw * gh; o++) {
    const on = zb[o] < Infinity; if (mask[o] === 2) continue;
    if (on && mask[o] === 1) { inter++; uni++; const i = zi[o]; diff += Math.abs(pts.col[i * 3] - pc[o * 3]) + Math.abs(pts.col[i * 3 + 1] - pc[o * 3 + 1]) + Math.abs(pts.col[i * 3 + 2] - pc[o * 3 + 2]); }
    else if (on || mask[o] === 1) uni++;
  }
  const iou = uni ? inter / uni : 0, colorSim = inter ? 1 - diff / (inter * 765) : 0;
  return { yaw, scale: s, center, iou, colorSim, score: iou + (pts.hasColor && cx.hasPicture ? 0.25 * colorSim : 0) };
}

/**
 * 向きを 1 周ぶん試して、いちばん合う置き方を返す。
 * 向きの 0 は「モデルの正面（+Z）が、絵の視点のほうを向く」（絵 1 枚から作ったモデルは、ふつうその絵の向きが正面）。
 * 返すもの：placeModel の結果に、face（視点を向く向き）、offset（face からの回転。ラジアン）を足したもの
 */
export function fitModel(pts, cx, { steps = 24, manual = 0, scaleMul = 1 } = {}) {
  const { view, target, eye } = cx, { fx, cx: icx } = view.intr, m = view.c2w;
  // 物体から視点へ向かう水平の向き
  const xc = (((target.x0 + target.x1 + 1) / 2) - icx) / fx, dir = [m[0] * xc - m[2], m[8] * xc - m[10]], face = Math.atan2(-dir[0], -dir[1]);
  let best = null;
  const tryAt = (off) => { const r = placeModel(pts, cx, face + off); r.offset = off; r.score += 0.02 * Math.cos(off); if (!best || r.score > best.score) best = r; };
  for (let k = 0; k < steps; k++) tryAt((k / steps) * 2 * Math.PI);
  for (let h = Math.PI / steps; h > 0.02; h /= 2) { const c = best.offset; tryAt(c - h); tryAt(c + h); }
  const auto = best;
  if (manual || scaleMul !== 1) { best = placeModel(pts, cx, face + auto.offset + manual, { scaleMul }); best.offset = auto.offset + manual; }
  return { ...best, face, auto: { offset: auto.offset, iou: auto.iou, colorSim: auto.colorSim }, eye };
}

/**
 * 置いたモデルを粒の列にする。
 *   pts      meshPoints の結果（粒の数ぶん）、fit = fitModel の結果
 *   spacing  粒の間隔（m）、px = 絵（RGBA）、paint = 絵から見えている側に絵の色を写すか
 *   typeId, sway（0〜255）, viewId, layerId, fallback [r, g, b]（モデルに色が無いときの、見えていない側の色）
 */
export function modelSplats(pts, fit, view, target, { spacing, px = null, paint = true, typeId = target.typeId, sway = 0, viewId = 0, layerId = 4, fallback = [128, 128, 128], edgeMax = 7, labelEdgeMax = 12 }) {
  const n = pts.n, { W, H, object, near, far } = view, { fx, fy, cx: icx, cy: icy } = view.intr, w = view.w2c, cs = Math.cos(fit.yaw), sn = Math.sin(fit.yaw), s = fit.scale, c = fit.center, P = pts.pos, N = pts.nrm;
  const col = {
    position: new Float32Array(n * 3), size: new Float32Array(n), color: new Uint8Array(n * 3), edge: new Uint8Array(n).fill(edgeMax), view: new Uint16Array(n).fill(viewId), depthGray: new Uint8Array(n),
    type: new Uint8Array(n).fill(typeId), object: new Uint16Array(n).fill(target.id), normal: new Int8Array(n * 3), sway: new Uint8Array(n).fill(sway), labelEdge: new Uint8Array(n).fill(labelEdgeMax),
    cov: new Float32Array(n * 6), layer: new Uint8Array(n).fill(layerId),
  };
  const sigma = spacing * 0.7, eye = fit.eye, d = new Float32Array(n), uu = new Int32Array(n), vv = new Int32Array(n);
  // 絵の視点から見て、いちばん手前の点（ます目は粒の間隔より少し粗く）
  const cell = Math.max(1, Math.ceil(spacing * 1.5 / (target.depth / fx))), gw = Math.ceil(W / cell), gh = Math.ceil(H / cell), zb = new Float32Array(gw * gh).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const x = c[0] + s * (cs * P[i * 3] + sn * P[i * 3 + 2]), y = c[1] + s * P[i * 3 + 1], z = c[2] + s * (-sn * P[i * 3] + cs * P[i * 3 + 2]);
    col.position[i * 3] = x; col.position[i * 3 + 1] = y; col.position[i * 3 + 2] = z;
    const xc = w[0] * x + w[1] * y + w[2] * z + w[3], yc = w[4] * x + w[5] * y + w[6] * z + w[7], dd = -(w[8] * x + w[9] * y + w[10] * z + w[11]);
    d[i] = dd; uu[i] = vv[i] = -1;
    if (dd > 0.01) { const u = Math.floor(icx + xc / dd * fx), v = Math.floor(icy - yc / dd * fy); if (u >= 0 && v >= 0 && u < W && v < H) { uu[i] = u; vv[i] = v; const o = Math.floor(v / cell) * gw + Math.floor(u / cell); if (dd < zb[o]) zb[o] = dd; } }
  }
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const nx = cs * N[i * 3] + sn * N[i * 3 + 2], ny = N[i * 3 + 1], nz = -sn * N[i * 3] + cs * N[i * 3 + 2];
    col.normal[i * 3] = Math.round(nx * 127); col.normal[i * 3 + 1] = Math.round(ny * 127); col.normal[i * 3 + 2] = Math.round(nz * 127);
    col.size[i] = sigma / SIGMA_K;
    surfelCov(col.cov, i * 6, nx, ny, nz, nx, ny, nz, sigma); // 面に寝た丸
    const dist = Math.max(d[i], near || 0.1);
    col.depthGray[i] = near && far ? Math.max(0, Math.min(255, (1 - Math.log(dist / near) / Math.log(far / near)) * 255)) : 128;
    let r = pts.hasColor ? pts.col[i * 3] : fallback[0], g = pts.hasColor ? pts.col[i * 3 + 1] : fallback[1], b = pts.hasColor ? pts.col[i * 3 + 2] : fallback[2];
    if (paint && px && uu[i] >= 0) {
      // 絵から見えている点：その画素が同じ物体で、点がいちばん手前で、面が視点のほうを向いている。面が横を向くほど、モデルの色へ寄せる
      const q = vv[i] * W + uu[i], ex = eye[0] - col.position[i * 3], ey = eye[1] - col.position[i * 3 + 1], ez = eye[2] - col.position[i * 3 + 2], facing = (nx * ex + ny * ey + nz * ez) / (Math.hypot(ex, ey, ez) || 1);
      if (object[q] === target.id && d[i] <= zb[Math.floor(vv[i] / cell) * gw + Math.floor(uu[i] / cell)] + spacing * 2 + d[i] * 0.01 && facing > 0.05) {
        const t = Math.max(0, Math.min(1, (facing - 0.05) / 0.3)), k = t * t * (3 - 2 * t);
        r += (px[q * 4] - r) * k; g += (px[q * 4 + 1] - g) * k; b += (px[q * 4 + 2] - b) * k; seen++;
      }
    }
    col.color[i * 3] = r; col.color[i * 3 + 1] = g; col.color[i * 3 + 2] = b;
  }
  return { columns: col, count: n, seen };
}

/**
 * モデルが無い物体の代わり：絵の輪郭をふくらませた形（丸みのある表と裏）を粒にする。外の道具は要らない。
 * 輪郭の縁からの距離 d と、その辺りの幅の半分 w（縁から尾根まで登った先の d）から、厚みの半分を √(d (2w − d)) とする（断面が円になる）。
 *   board = true   物体が 1 枚の板として置かれている場面（絵から作った場面）。板の前後へ半分ずつふくらませ、表と裏の粒を作る
 *   board = false  奥行きが本物に近い場面。表は絵の粒のままにして、裏の粒だけを作る
 *   thick  幅に対する厚みの割合（1 で断面が円）、maxHalf = 厚みの半分の上限（m）
 * 返すもの：{ columns, count, half（厚みの半分の最大。m） }
 */
export function inflateSplats(view, target, px, { stride = 2, board = true, thick = 0.8, maxHalf = 3, typeId = target.typeId, sway = 0, viewId = 0, layerId = 4, maxStretch = 16, edgeMax = 7, labelEdgeMax = 12 } = {}) {
  const { W, H, z, object, near, far } = view, { fx, fy, cx: icx, cy: icy } = view.intr, m = view.c2w, eye = [m[3], m[7], m[11]];
  const x0 = Math.max(0, target.bx0 - 1), y0 = Math.max(0, target.by0 - 1), w = Math.min(W - 1, target.bx1 + 1) - x0 + 1, h = Math.min(H - 1, target.by1 + 1) - y0 + 1, n = w * h;
  const on = new Uint8Array(n), d = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (object[(y0 + y) * W + x0 + x] === target.id && z[(y0 + y) * W + x0 + x] > 0) { on[y * w + x] = 1; d[y * w + x] = 1e9; }
  // 縁からの距離（画素）。絵の端で切れている所は縁にしない（その先にも物体が続いているとみなす）
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? (x0 + x < 0 || y0 + y < 0 || x0 + x >= W || y0 + y >= H ? 1e9 : 0) : d[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (on[i]) d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414); }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (on[i]) d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414); }
  // その辺りの幅の半分：距離の大きい画素から順に、自分より低い隣へ値を渡す（尾根の値が、ふもとまで下りてくる）
  const ids = []; for (let i = 0; i < n; i++) if (on[i]) { if (d[i] > 1e8) d[i] = Math.max(w, h); ids.push(i); }
  ids.sort((a, b) => d[b] - d[a]);
  const wl = Float32Array.from(d);
  for (const i of ids) {
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const qx = x + dx, qy = y + dy; if ((!dx && !dy) || qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx; if (on[q] && d[q] < d[i] && wl[q] < wl[i]) wl[q] = wl[i];
    }
  }
  // 厚みの半分（m）。少しならして、段を消す
  let hm = new Float32Array(n), half = 0;
  for (const i of ids) { const zz = z[(y0 + ((i - (i % w)) / w)) * W + x0 + (i % w)]; hm[i] = Math.min(maxHalf, thick * Math.sqrt(Math.max(0, d[i] * (2 * wl[i] - d[i]))) * zz / fx); }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(n);
    for (const i of ids) { const x = i % w, y = (i - x) / w; let s = 0, k = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const qx = x + dx, qy = y + dy; if (qx < 0 || qy < 0 || qx >= w || qy >= h || !on[qy * w + qx]) continue; s += hm[qy * w + qx]; k++; } next[i] = Math.min(hm[i] * 1.5, s / k); }
    hm = next;
  }
  const sides = board ? 2 : 1, cap = Math.ceil(w / stride) * Math.ceil(h / stride) * sides;
  const col = {
    position: new Float32Array(cap * 3), size: new Float32Array(cap), color: new Uint8Array(cap * 3), edge: new Uint8Array(cap).fill(edgeMax), view: new Uint16Array(cap).fill(viewId), depthGray: new Uint8Array(cap),
    type: new Uint8Array(cap).fill(typeId), object: new Uint16Array(cap).fill(target.id), normal: new Int8Array(cap * 3), sway: new Uint8Array(cap).fill(sway), labelEdge: new Uint8Array(cap).fill(labelEdgeMax),
    cov: new Float32Array(cap * 6), layer: new Uint8Array(cap).fill(layerId),
  };
  const off = stride >> 1, hv = (x, y, fb) => (x < 0 || y < 0 || x >= w || y >= h || !on[y * w + x] ? fb : hm[y * w + x]);
  let k = 0;
  for (let y = off; y < h; y += stride) for (let x = off; x < w; x += stride) {
    const i = y * w + x; if (!on[i]) continue;
    const q = (y0 + y) * W + x0 + x, zz = z[q], hh = hm[i]; half = Math.max(half, hh);
    // 厚みの傾き（カメラの右・上の向きに、1 m あたり何 m）
    const gx = (hv(x + 1, y, 0) - hv(x - 1, y, 0)) / 2 * fx / zz, gy = -(hv(x, y + 1, 0) - hv(x, y - 1, 0)) / 2 * fy / zz;
    for (let side = board ? 0 : 1; side < 2; side++) {
      const depth = board ? (side ? zz + hh : zz - hh) : zz + 2 * hh, slope = board ? 1 : 2;
      const xc = (x0 + x + 0.5 - icx) / fx * depth, yc = -(y0 + y + 0.5 - icy) / fy * depth, zc = -depth;
      const px3 = m[0] * xc + m[1] * yc + m[2] * zc + m[3], py3 = m[4] * xc + m[5] * yc + m[6] * zc + m[7], pz3 = m[8] * xc + m[9] * yc + m[10] * zc + m[11];
      // 面の向き（カメラの座標）：表は (−gx, −gy, 1)、裏は (gx, gy, −1) × 傾き
      let nx = side ? gx * slope : -gx, ny = side ? gy * slope : -gy, nz = side ? -1 : 1; const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      const wx = m[0] * nx + m[1] * ny + m[2] * nz, wy = m[4] * nx + m[5] * ny + m[6] * nz, wz = m[8] * nx + m[9] * ny + m[10] * nz;
      col.position[k * 3] = px3; col.position[k * 3 + 1] = py3; col.position[k * 3 + 2] = pz3;
      col.normal[k * 3] = Math.round(wx * 127); col.normal[k * 3 + 1] = Math.round(wy * 127); col.normal[k * 3 + 2] = Math.round(wz * 127);
      col.size[k] = depth * stride / fy;
      const rx = px3 - eye[0], ry = py3 - eye[1], rz = pz3 - eye[2], rl = Math.hypot(rx, ry, rz) || 1;
      surfelCov(col.cov, k * 6, wx, wy, wz, rx / rl, ry / rl, rz / rl, col.size[k] * SIGMA_K, maxStretch);
      col.color[k * 3] = px[q * 4]; col.color[k * 3 + 1] = px[q * 4 + 1]; col.color[k * 3 + 2] = px[q * 4 + 2];
      col.depthGray[k] = near && far ? Math.max(0, Math.min(255, (1 - Math.log(Math.max(depth, near) / near) / Math.log(far / near)) * 255)) : 128;
      k++;
    }
  }
  return { columns: col, count: k, half };
}
