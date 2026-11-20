// 絵 1 枚の場面（実在の絵。painting/build.mjs・relabel.mjs の書き出し）から、「筆跡の粒」に渡す 3D の形を組む。DOM も THREE も使わない（node でも動く）。
//   背景の面（奥行きの絵から、物体を除いてなめらかに埋めたメッシュ）＋ 物ごとの形（絵の輪郭をふくらませた、表と裏のある丸みのある形）＋ 絵の外まで続く土台の平面
import { backgroundMesh } from '../studio/estimate.js';

export class TriList {
  constructor() { this.pos = []; this.nrm = []; this.type = []; this.object = []; }
  /** 頂点の列と三角形の番号から足す。頂点の面の向きは、三角形の面積で重み付けして平均する。 */
  addIndexed(positions, indices, typeOf, objectId) {
    const nv = positions.length / 3, vn = new Float32Array(nv * 3);
    for (let k = 0; k < indices.length; k += 3) {
      const a = indices[k] * 3, b = indices[k + 1] * 3, c = indices[k + 2] * 3;
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2], vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const o of [a, b, c]) { vn[o] += nx; vn[o + 1] += ny; vn[o + 2] += nz; }
    }
    for (let k = 0; k < indices.length; k += 3) {
      for (let j = 0; j < 3; j++) {
        const o = indices[k + j] * 3, l = Math.hypot(vn[o], vn[o + 1], vn[o + 2]) || 1;
        this.pos.push(positions[o], positions[o + 1], positions[o + 2]); this.nrm.push(vn[o] / l, vn[o + 1] / l, vn[o + 2] / l);
      }
      this.type.push(typeof typeOf === 'function' ? typeOf(k / 3) : typeOf); this.object.push(objectId);
    }
  }
  done() { return { n: this.type.length, pos: Float32Array.from(this.pos), nrm: Float32Array.from(this.nrm), type: Uint8Array.from(this.type), object: Uint16Array.from(this.object) }; }
}

/** 輪郭をふくらませた形：物体の画素を粗います目にし、縁からの距離 d と幅の半分 w から厚みの半分 = thick × √(d (2w − d))（断面が円に近い）。表と裏の 2 枚。 */
export function inflateMesh(o, { W, H, z, object, c2w, intr }, { step = 2, thick = 0.7, maxHalf = 1.2, far = 280 } = {}) {
  const [x0, y0, x1, y1] = o.bbox, gx0 = Math.floor(x0 / step) - 1, gy0 = Math.floor(y0 / step) - 1, gw = Math.ceil(x1 / step) - gx0 + 3, gh = Math.ceil(y1 / step) - gy0 + 3;
  const inside = new Uint8Array(gw * gh), dep = new Float32Array(gw * gh);
  const zs = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = (gx0 + gx) * step, y = (gy0 + gy) * step; if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x; if (object[i] === o.id) { inside[gy * gw + gx] = 1; dep[gy * gw + gx] = Math.min(far, z[i]); if (z[i] > 0) zs.push(Math.min(far, z[i])); }
  }
  if (zs.length < 6) return null;
  zs.sort((a, b) => a - b); const zm = zs[zs.length >> 1];
  for (let g = 0; g < gw * gh; g++) if (inside[g] && !(dep[g] > 0)) dep[g] = zm; // 奥行きの無い画素（空と見なされた所）は、物のまん中の奥行きに置く
  // 奥行きをならす（物の中だけで、となりとの平均を 3 回）。画素ごとのがたつきが、とげとげの面にならないように
  for (let it = 0; it < 3; it++) {
    const src = Float32Array.from(dep);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const g = y * gw + x; if (!inside[g]) continue;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh || !inside[yy * gw + xx]) continue; sum += src[yy * gw + xx]; n++; }
      dep[g] = sum / n;
    }
  }
  // 縁からの距離（ます目の数。2 回なめる）
  const d = new Float32Array(gw * gh); for (let i = 0; i < gw * gh; i++) d[i] = inside[i] ? 1e6 : 0;
  const relax = (i, j, c) => { if (d[j] + c < d[i]) d[i] = d[j] + c; };
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { const i = y * gw + x; if (!inside[i]) continue; if (x > 0) relax(i, i - 1, 1); else d[i] = 1; if (y > 0) relax(i, i - gw, 1); else d[i] = Math.min(d[i], 1); if (x > 0 && y > 0) relax(i, i - gw - 1, 1.414); if (x < gw - 1 && y > 0) relax(i, i - gw + 1, 1.414); }
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) { const i = y * gw + x; if (!inside[i]) continue; if (x < gw - 1) relax(i, i + 1, 1); else d[i] = Math.min(d[i], 1); if (y < gh - 1) relax(i, i + gw, 1); else d[i] = Math.min(d[i], 1); if (x < gw - 1 && y < gh - 1) relax(i, i + gw + 1, 1.414); if (x > 0 && y < gh - 1) relax(i, i + gw - 1, 1.414); }
  // 幅の半分：横の行ごとの、つながった区間の長さの半分（人の腕や足のように細い所は薄く）
  const half = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw;) {
    if (!inside[y * gw + x]) { x++; continue; }
    let e = x; while (e < gw && inside[y * gw + e]) e++;
    for (let k = x; k < e; k++) half[y * gw + k] = (e - x) / 2;
    x = e;
  }
  const mPerCell = step * zm / intr.fx, m = c2w, front = new Float32Array(gw * gh * 3), back = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const g = gy * gw + gx; if (!inside[g]) continue;
    const dd = Math.max(0, d[g] - 0.5), w = Math.max(half[g], dd), t = Math.min(maxHalf, thick * Math.sqrt(Math.max(0, dd * (2 * w - dd))) * mPerCell);
    const px = (gx0 + gx) * step + 0.5, py = (gy0 + gy) * step + 0.5;
    for (const [arr, zz] of [[front, dep[g] - t], [back, dep[g] + t]]) {
      const xc = (px - intr.cx) / intr.fx * zz, yc = -(py - intr.cy) / intr.fy * zz, zc = -zz;
      arr[g * 3] = m[0] * xc + m[1] * yc + m[2] * zc + m[3]; arr[g * 3 + 1] = m[4] * xc + m[5] * yc + m[6] * zc + m[7]; arr[g * 3 + 2] = m[8] * xc + m[9] * yc + m[10] * zc + m[11];
    }
  }
  const positions = new Float32Array(gw * gh * 6); positions.set(front, 0); positions.set(back, gw * gh * 3);
  const indices = [], B = gw * gh;
  for (let gy = 0; gy + 1 < gh; gy++) for (let gx = 0; gx + 1 < gw; gx++) {
    const a = gy * gw + gx, b = a + 1, c = a + gw, e = c + 1; if (!(inside[a] && inside[b] && inside[c] && inside[e])) continue;
    indices.push(a, c, b, b, c, e);                 // 表（カメラの方を向く）
    indices.push(B + a, B + b, B + c, B + b, B + e, B + c); // 裏
  }
  return indices.length ? { positions, indices, half: half.reduce((a, b) => Math.max(a, b), 0) * thick * mPerCell } : null;
}


/**
 * view = { W, H, z, type（shared/labels.js の番号）, object, c2w（行ごとの 4x4）, intr }、objects = cameras.json の objects（id, bbox, type）、
 * typeOfObject(o) = 物体の種類の番号、grass = 地面の種類の番号
 * 返すもの：{ tris, bg（背景の面）, baseY, by（土台の高さ）, made, size（土台の半分の長さ） }
 */
export function buildPaintingTris(view, objects, { typeOfObject, grass, size = 300, minPixels = 60, far = 280 }) {
  const { W, H, z, type, object, c2w, intr } = view, list = new TriList(), GRASS = grass, S = size;
  const bz = new Float32Array(W * H), fill = new Uint8Array(W * H), bt = new Uint8Array(W * H).fill(GRASS);
  // far より遠い物（対岸など）は、far の距離の壁として置く
  const behind = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { if (object[i]) { fill[i] = 1; behind[i] = z[i] > 0 ? Math.min(z[i], far) + 0.15 : 0; } else { bz[i] = Math.min(z[i], far); bt[i] = type[i] || GRASS; } }
  const bg = backgroundMesh({ W, H, bz, fill, behind, btype: bt, c2w, intr, step: 6, maxZ: far + 2, edge: 1 }) // 奥行きが 2.7 倍をこえて変わる段差では面を切る（つなぐと、横から見たときに、のびた幕になる）;
  list.addIndexed(bg.positions, bg.indices, (k) => bg.triType[k], 0);
  const ys = []; for (let k = 0; k < bg.triType.length; k += 5) if (bg.triType[k] === GRASS) ys.push(bg.positions[bg.indices[k * 3] * 3 + 1]);
  ys.sort((a, b) => a - b); const baseY = ys.length ? ys[Math.floor(ys.length * 0.5)] : 0, by = baseY - 0.12;
  list.addIndexed(new Float32Array([-S, by, -S, S, by, -S, S, by, S, -S, by, S]), [0, 2, 1, 0, 3, 2], GRASS, 0);
  let made = 0;
  // 物の一覧は、物体の札の絵そのものから作る（cameras.json の一覧は、札を付け直した後では番号が合わないことがある）
  const found = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const id = object[y * W + x]; if (!id) continue;
    let o = found.get(id); if (!o) { o = { id, pixels: 0, bbox: [x, y, x, y], votes: new Map() }; found.set(id, o); }
    o.pixels++; if (x < o.bbox[0]) o.bbox[0] = x; if (x > o.bbox[2]) o.bbox[2] = x; if (y > o.bbox[3]) o.bbox[3] = y;
    const t = type[y * W + x]; o.votes.set(t, (o.votes.get(t) || 0) + 1);
  }
  const listed = new Map((objects || []).map((o) => [o.id, o])), used = [];
  for (const o of found.values()) {
    if (o.pixels < minPixels) continue;
    const m = inflateMesh(o, view, { far }); if (!m) continue;
    let best = 0, bn = 0; for (const [t, n] of o.votes) if (t && n > bn) { bn = n; best = t; }
    const typeId = best || (listed.has(o.id) ? typeOfObject(listed.get(o.id)) : typeOfObject({}));
    list.addIndexed(m.positions, m.indices, typeId, o.id); made++; used.push({ id: o.id, type: typeId, pixels: o.pixels, bbox: o.bbox });
  }
  return { tris: list.done(), bg, baseY, by, made, objects: used, size: S };
}
