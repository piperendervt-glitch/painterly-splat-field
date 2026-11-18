// 絵と奥行きから「推定したプレビズのモデル」を作る。three.js にも画面にも依存しない（node でも試せる）。
//
// もと：層に分けて 3D にする方式（HunyuanWorld 1.0 など）の「背景の層をメッシュにし、手前の物は別の形として置く」。
//   1. 背景の面：手前の物を消した背景の奥行き（背後の層）を、粗います目でメッシュにする。地面・水・遠景がつながった 1 枚の地形になる
//   2. 手前の物：物体の札ごとに、その画素を 3D に置いた点の集まりを、薄切りの箱の列で囲む（向きは水平面の中で、点の広がりに合わせる）
// 使い道：歩くときの当たり判定（プレビズの無い場面）、プレビズのモデルとしての書き出し（OBJ）、本物のプレビズとの見比べ。
import { pullPush } from './layers.js';

/**
 * 視点 1 つぶんの材料から、背景の面のメッシュを作る。
 *   W, H        絵の大きさ
 *   bz          背景の奥行き（画素ごと。0 = 空）。手前の物の所は、物を消した後ろの奥行き
 *   fill        1 = 背景の奥行きが決まらなかった所（まわりから埋める）。無ければ null
 *   btype       背景の種類の札（画素ごと）
 *   c2w         カメラ → 世界（行ごとに並んだ 4x4）、intr = { fx, fy, cx, cy }
 *   step        何画素おきに頂点を置くか、maxZ = これより遠い所は作らない（m）、edge = 隣との奥行きの比（対数）がこれを超えたら面を張らない
 * 返すもの：{ positions（頂点 × 3）, indices（三角形 × 3）, triType（三角形ごとの種類）, gw, gh }
 */
export function backgroundMesh({ W, H, bz, fill = null, btype, c2w, intr, step = 8, maxZ = 150, edge = 0.5 }) {
  const gw = Math.floor((W - 1) / step) + 1, gh = Math.floor((H - 1) / step) + 1, n = gw * gh;
  const lz = new Float32Array(n), known = new Uint8Array(n), hole = new Uint8Array(n), vt = new Uint8Array(n);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const i = Math.min(H - 1, gy * step) * W + Math.min(W - 1, gx * step), g = gy * gw + gx;
    vt[g] = btype[i];
    if (bz[i] > 0) { lz[g] = Math.log(bz[i]); known[g] = 1; } else if (fill && fill[i]) hole[g] = 1;
  }
  const filled = pullPush(lz, known, gw, gh); // 決まらなかった所（物の足もとなど）を、まわりの奥行きからなめらかに埋める
  const { fx, fy, cx, cy } = intr, m = c2w, positions = new Float32Array(n * 3), ok = new Uint8Array(n), zz = new Float32Array(n);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const g = gy * gw + gx; if (!known[g] && !hole[g]) continue;
    const z = Math.exp(filled[g]); if (!(z > 0) || z > maxZ) continue;
    const x = Math.min(W - 1, gx * step), y = Math.min(H - 1, gy * step), xc = (x + 0.5 - cx) / fx * z, yc = -(y + 0.5 - cy) / fy * z, zc = -z;
    positions[g * 3] = m[0] * xc + m[1] * yc + m[2] * zc + m[3]; positions[g * 3 + 1] = m[4] * xc + m[5] * yc + m[6] * zc + m[7]; positions[g * 3 + 2] = m[8] * xc + m[9] * yc + m[10] * zc + m[11];
    ok[g] = 1; zz[g] = z;
  }
  const eye = [m[3], m[7], m[11]], idx = [], triType = [];
  const tri = (a, b, c, t) => { // カメラの側を表にする（地面なら上向きになる）
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az, vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * (eye[0] - ax) + ny * (eye[1] - ay) + nz * (eye[2] - az) >= 0) idx.push(a, b, c); else idx.push(a, c, b);
    triType.push(t);
  };
  for (let gy = 0; gy + 1 < gh; gy++) for (let gx = 0; gx + 1 < gw; gx++) {
    const a = gy * gw + gx, b = a + 1, c = a + gw, d = c + 1;
    if (!(ok[a] && ok[b] && ok[c] && ok[d])) continue;
    const lo = Math.min(zz[a], zz[b], zz[c], zz[d]), hi = Math.max(zz[a], zz[b], zz[c], zz[d]);
    if (Math.log(hi / lo) > edge) continue; // 奥行きの段（手前の面と遠くの面の境目）には張らない
    tri(a, c, b, vt[c]); tri(b, c, d, vt[c]); // 種類は、手前（下）の頂点の札
  }
  return { positions, indices: new Uint32Array(idx), triType: new Uint8Array(triType), gw, gh };
}

/**
 * 物体の札ごとに、その画素を 3D に置いた点を囲む箱の列を作る。同じ物体が複数の視点に写っていれば、点をまとめる。
 * 1 つの物体を、絵の左右の向き（水平面で、視線に直角な向き）に沿って薄切り（slab）にし、切れごとに高さの範囲を取る。
 * こうすると、アーチの開口（まん中の切れは上のほうにしか点が無い）や、傘を持った人の形が残る。
 *   views      [{ W, H, z, type, object（もとの奥行き・種類・物体の札。画素ごと）, c2w, intr }]
 *   front      種類 → 手前の物か
 *   minPixels  これより少ない画素の物体は作らない（step おきに数えた数）
 *   depthRatio 見えていない裏側の厚みの見立て：物体の幅のこの割合までは、カメラから遠い側へ厚みを足す（maxDepth m まで）
 * 返すもの：[{ objectId, typeId, part（何番目の切れか）, center:[x,y,z], half:[幅の半分, 高さの半分, 厚みの半分], yaw（Y 軸まわりの向き。ラジアン）, count }]
 *   箱の幅の向きは (cos yaw, 0, -sin yaw)。three.js の rotation.y = yaw と同じ。
 */
export function objectBoxes(views, { front, step = 4, minPixels = 30, minHalf = 0.12, maxZ = 400, slabs = 16, depthRatio = 0.25, maxDepth = 8 }) {
  const by = new Map();
  for (const { W, H, z, type, object, c2w: m, intr: { fx, fy, cx, cy } } of views) {
    for (let y = step >> 1; y < H; y += step) for (let x = step >> 1; x < W; x += step) {
      const i = y * W + x, d = z[i]; if (!(d > 0) || d > maxZ || !front[type[i]]) continue;
      const key = object[i] * 256 + type[i]; // 物体の札が無い場面（0 ばかり）でも、種類ごとには分かれる
      let o = by.get(key); if (!o) by.set(key, (o = { objectId: object[i], typeId: type[i], pts: [], eye: [0, 0] }));
      const xc = (x + 0.5 - cx) / fx * d, yc = -(y + 0.5 - cy) / fy * d, zc = -d;
      o.pts.push(m[0] * xc + m[1] * yc + m[2] * zc + m[3], m[4] * xc + m[5] * yc + m[6] * zc + m[7], m[8] * xc + m[9] * yc + m[10] * zc + m[11]);
      o.eye[0] += m[3]; o.eye[1] += m[11];
    }
  }
  const out = [], pct = (a, p) => a[Math.max(0, Math.min(a.length - 1, Math.round(p * (a.length - 1))))];
  for (const o of by.values()) {
    const k = o.pts.length / 3; if (k < minPixels) continue;
    let mx = 0, mz = 0; for (let i = 0; i < k; i++) { mx += o.pts[i * 3]; mz += o.pts[i * 3 + 2]; } mx /= k; mz /= k;
    // 切る向き：水平面で、カメラからの視線に直角な向き（絵の左右）。奥行きの推定は視線の向きに荒れやすいので、点の広がり（主成分）では決めない
    // ただし、点の広がる向きがそれに近い（30° 以内）ときは、広がる向きに合わせる（正面から見た壁の向きが、より正しく出る）
    const vx = mx - o.eye[0] / k, vz = mz - o.eye[1] / k, vl = Math.hypot(vx, vz) || 1;
    let ux = vz / vl, uz = -vx / vl;
    let sxx = 0, sxz = 0, szz = 0; for (let i = 0; i < k; i++) { const dx = o.pts[i * 3] - mx, dz = o.pts[i * 3 + 2] - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
    const pa = 0.5 * Math.atan2(2 * sxz, sxx - szz), px = Math.cos(pa), pz = Math.sin(pa), dot = px * ux + pz * uz;
    if (Math.abs(dot) > Math.cos(Math.PI / 6)) { ux = dot > 0 ? px : -px; uz = dot > 0 ? pz : -pz; }
    const ang = Math.atan2(uz, ux);
    const along = new Float32Array(k), across = new Float32Array(k);
    for (let i = 0; i < k; i++) { const dx = o.pts[i * 3] - mx, dz = o.pts[i * 3 + 2] - mz; along[i] = dx * ux + dz * uz; across[i] = -dx * uz + dz * ux; }
    const sorted = Float32Array.from(along).sort(), a0 = pct(sorted, 0.02), a1 = pct(sorted, 0.98), extent = Math.max(a1 - a0, 2 * minHalf);
    const n = Math.max(1, Math.min(slabs, Math.round(extent / 0.25))), w = extent / n, bins = Array.from({ length: n }, () => []);
    for (let i = 0; i < k; i++) { const j = Math.floor((along[i] - a0) / w); if (j >= 0 && j < n) bins[j].push(i); }
    // 厚み（視線の向き）：見えているのは表だけなので、物体の幅の depthRatio 倍までは、カメラから遠い側へ足す。across の正の向きが遠い側
    const want = Math.min(maxDepth, depthRatio * extent);
    for (let j = 0; j < n; j++) {
      const ids = bins[j]; if (ids.length < Math.max(3, minPixels / 10)) continue;
      const ys = Float32Array.from(ids, (i) => o.pts[i * 3 + 1]).sort(), cs = Float32Array.from(ids, (i) => across[i]).sort();
      const y0 = pct(ys, 0.02), y1 = pct(ys, 0.98);
      let c0 = pct(cs, 0.25), c1 = pct(cs, 0.75);
      if (c1 - c0 < want) c1 = c0 + want;
      else if (c1 - c0 > Math.max(want, extent)) c1 = c0 + Math.max(want, extent); // 奥行きの荒れで厚くなりすぎない（幅より厚くはしない）
      const ca = a0 + (j + 0.5) * w, cc = (c0 + c1) / 2;
      out.push({
        objectId: o.objectId, typeId: o.typeId, part: j, count: ids.length,
        center: [mx + ux * ca - uz * cc, (y0 + y1) / 2, mz + uz * ca + ux * cc],
        half: [w / 2, Math.max(minHalf, (y1 - y0) / 2), Math.max(minHalf, (c1 - c0) / 2)],
        yaw: -ang,
      });
    }
  }
  return out.sort((p, q) => p.objectId - q.objectId || p.typeId - q.typeId || p.part - q.part);
}

/** 箱の 8 つの角（世界座標。x y z × 8）。並びは、下の 4 つ → 上の 4 つ。 */
export function boxCorners(b) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw), [hx, hy, hz] = b.half, out = new Float32Array(24);
  let k = 0;
  for (const sy of [-1, 1]) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const lx = sx * hx, lz = sz * hz;
    out[k++] = b.center[0] + lx * c + lz * s; out[k++] = b.center[1] + sy * hy; out[k++] = b.center[2] - lx * s + lz * c;
  }
  return out;
}
const BOX_FACES = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];

/**
 * 推定したモデルを OBJ の文字列にする（Blender などで開ける）。
 *   model  { grounds: [{ name, mesh }], boxes: [{ name, ...箱 }], baseY（土台の平面の高さ。無くてもよい） }、typeName(id) = 種類の名前
 * 面は種類ごと・物体ごとにグループ（g）に分ける。
 */
export function toObj(model, typeName = (t) => `type${t}`) {
  const lines = ['# painterly-splat-field: estimated previz model (metres, +Y up)'];
  let base = 1;
  for (const g of model.grounds) {
    const { positions, indices, triType } = g.mesh, used = new Int32Array(positions.length / 3).fill(-1);
    const types = [...new Set(triType)].sort((a, b) => a - b), vs = [], faces = new Map(types.map((t) => [t, []]));
    for (let t = 0; t < triType.length; t++) {
      const f = [];
      for (let k = 0; k < 3; k++) { const v = indices[t * 3 + k]; if (used[v] < 0) { used[v] = vs.length; vs.push(v); } f.push(used[v] + base); }
      faces.get(triType[t]).push(f);
    }
    for (const v of vs) lines.push(`v ${positions[v * 3].toFixed(3)} ${positions[v * 3 + 1].toFixed(3)} ${positions[v * 3 + 2].toFixed(3)}`);
    for (const t of types) { lines.push(`g ${g.name}_${typeName(t)}`); for (const f of faces.get(t)) lines.push(`f ${f[0]} ${f[1]} ${f[2]}`); }
    base += vs.length;
  }
  if (Number.isFinite(model.baseY)) { // 土台の平面（推定した面の外で落ちないための床）
    const y = (model.baseY - 0.02).toFixed(3);
    lines.push(`v -600 ${y} 600`, `v 600 ${y} 600`, `v 600 ${y} -600`, `v -600 ${y} -600`, 'g base_plane', `f ${base} ${base + 1} ${base + 2} ${base + 3}`);
    base += 4;
  }
  for (const b of model.boxes) {
    const c = boxCorners(b);
    for (let i = 0; i < 8; i++) lines.push(`v ${c[i * 3].toFixed(3)} ${c[i * 3 + 1].toFixed(3)} ${c[i * 3 + 2].toFixed(3)}`);
    lines.push(`g ${b.name}`);
    for (const f of BOX_FACES) lines.push(`f ${f.map((i) => i + base).join(' ')}`);
    base += 8;
  }
  return lines.join('\n') + '\n';
}
