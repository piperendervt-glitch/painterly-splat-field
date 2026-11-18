// 外部の道具（Marble、HunyuanWorld、ほかの 3D ガウシアンの学習など）で作った世界の .ply を、この場面の粒として取り込む。
// DOM も THREE も使わない。読めるのは 2 種類：
//   gaussians  3D ガウシアンの .ply（x, y, z, f_dc_*, opacity, scale_*, rot_*）。形と不透明度もそのまま使う
//   points     色つきの点（x, y, z, red, green, blue）。メッシュの .ply なら頂点だけを点として使う（面は読まない）
//
// 置き方（placement）：外部の世界は座標の決まりも大きさもまちまちなので、次の順で合わせる。
//   1. 座標の決まり frame：'cv' = 原点が絵の視点で、y が下・z が前（OpenCV 流。絵 1 枚から作る道具に多い）、
//                         'gl' = 原点が絵の視点で、y が上・-z が前（OpenGL 流）、'world' = この場面の座標のまま
//   2. 大きさ scale（絵の視点を中心に掛ける）、縦軸まわりの回転 yawDeg（絵の視点を中心に回す）、平行移動 offset（m）
import { quatCov, roundCov } from './layers.js';

const C0 = 0.28209479177387814; // 球面調和の 0 次の係数
/** .ply から読む列（これ以外は読まない。球面調和の高次の列などは大きいので捨てる）。 */
export const WORLD_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'red', 'green', 'blue'];
export function worldKind(ply) {
  const P = ply.props, has = (...k) => k.every((n) => P[n]);
  if (!has('x', 'y', 'z')) throw new Error('.ply に x, y, z の列がありません');
  if (has('f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3')) return 'gaussians';
  if (has('red', 'green', 'blue')) return 'points';
  throw new Error('.ply に、3D ガウシアンの列（f_dc_*, opacity, scale_*, rot_*）も、点の色の列（red, green, blue）もありません');
}

/**
 * 置き方から、点の変換を作る：p' = M (p - P0) + T0。M は 3x3（行ごと 9 個、大きさ込み）。
 *   c2w  絵の中心の視点の camera_to_world（行ごとの 4x4）
 */
export function worldTransform({ frame = 'cv', c2w, scale = 1, yawDeg = 0, offset = [0, 0, 0] }) {
  const eye = [c2w[3], c2w[7], c2w[11]], a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // もとの座標 → この場面の向き（大きさと回転の前）
  const f = frame === 'cv' ? [1, -1, -1] : [1, 1, 1];
  const R = frame === 'world' ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [c2w[0] * f[0], c2w[1] * f[1], c2w[2] * f[2], c2w[4] * f[0], c2w[5] * f[1], c2w[6] * f[2], c2w[8] * f[0], c2w[9] * f[1], c2w[10] * f[2]];
  // 縦軸まわりの回転を前から掛ける
  const Y = [c, 0, s, 0, 1, 0, -s, 0, c], M = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] = (Y[i * 3] * R[j] + Y[i * 3 + 1] * R[3 + j] + Y[i * 3 + 2] * R[6 + j]) * scale;
  return { M, P0: frame === 'world' ? eye : [0, 0, 0], T0: [eye[0] + offset[0], eye[1] + offset[1], eye[2] + offset[2]], scale };
}
const apply = (t, x, y, z, out) => {
  const { M, P0, T0 } = t, dx = x - P0[0], dy = y - P0[1], dz = z - P0[2];
  out[0] = M[0] * dx + M[1] * dy + M[2] * dz + T0[0]; out[1] = M[3] * dx + M[4] * dy + M[5] * dz + T0[1]; out[2] = M[6] * dx + M[7] * dy + M[8] * dz + T0[2];
  return out;
};
function hash(i) {
  let h = Math.imul(i ^ (i >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 大きさを絵の奥行きに合わせる倍率を求める（いまの置き方に、あと何倍を掛ければよいか）。
 * 絵を 8 画素のます目に分け、ます目ごとに「いちばん手前の粒の距離」と「絵の奥行き」を比べ、比の中央値を返す。合わせられなければ 1。
 *   view { W, H, z, w2c（行ごとの 4x4）, intr }
 */
export function fitWorldScale(ply, t, view) {
  const P = ply.props, n = ply.count, { W, H, z, w2c: m, intr } = view, { fx, fy, cx, cy } = intr, B = 8, gw = Math.ceil(W / B), gh = Math.ceil(H / B);
  const near = new Float32Array(gw * gh).fill(Infinity), p = [0, 0, 0], step = Math.max(1, Math.floor(n / 400000));
  for (let i = 0; i < n; i += step) {
    apply(t, P.x[i], P.y[i], P.z[i], p);
    const xc = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], yc = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], d = -(m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]);
    if (!(d > 0.05)) continue;
    const u = Math.floor(cx + xc / d * fx), v = Math.floor(cy - yc / d * fy);
    if (u < 0 || v < 0 || u >= W || v >= H) continue;
    const o = Math.floor(v / B) * gw + Math.floor(u / B);
    if (d < near[o]) near[o] = d;
  }
  const ratios = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const d = near[gy * gw + gx], zz = z[Math.min(H - 1, gy * B + (B >> 1)) * W + Math.min(W - 1, gx * B + (B >> 1))];
    if (d < Infinity && zz > 0) ratios.push(zz / d);
  }
  if (ratios.length < 50) return 1;
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1];
}

/**
 * 取り込んだ世界を、粒の列にする。
 *   t        worldTransform の結果、viewId 「使う視点」の番号、keep 何粒に 1 粒使うか（間引き。残した粒は広げる）
 *   pointSize 点の .ply のときの粒の間隔（m。変換の後の大きさ）
 * 返すもの：{ columns, count, kind, bounds: { min, max } }
 */
export function splatsFromWorld(ply, t, viewId, { keep = 1, pointSize = 0.05, layerId = 3, edgeMax = 7, labelEdgeMax = 7 } = {}) {
  const kind = worldKind(ply), P = ply.props, n = ply.count, max = keep > 1 ? Math.ceil(n / keep * 1.1) + 64 : n, { M, scale } = t;
  const col = {
    position: new Float32Array(max * 3), size: new Float32Array(max), color: new Uint8Array(max * 3), edge: new Uint8Array(max).fill(edgeMax), view: new Uint16Array(max).fill(viewId),
    depthGray: new Uint8Array(max).fill(128), opacity: new Uint8Array(max).fill(255), normal: new Int8Array(max * 3), labelEdge: new Uint8Array(max).fill(labelEdgeMax),
    cov: new Float32Array(max * 6), layer: new Uint8Array(max).fill(layerId),
  };
  const grow = Math.sqrt(keep), cut = keep > 1 ? Math.floor(4294967296 / keep) : 4294967296, k6 = 6 / 2.6, p = [0, 0, 0], c = new Float32Array(6);
  const min = [Infinity, Infinity, Infinity], maxB = [-Infinity, -Infinity, -Infinity];
  const bytes = P.red && kind === 'points' ? (() => { let hi = 0; for (let i = 0; i < Math.min(n, 5000); i++) hi = Math.max(hi, P.red[i], P.green[i], P.blue[i]); return hi > 1.5 ? 1 : 255; })() : 1; // 色が 0〜1 の点もある
  let k = 0;
  for (let s = 0; s < n; s++) {
    if (keep > 1 && hash(s) >= cut) continue;
    if (k >= max) break;
    apply(t, P.x[s], P.y[s], P.z[s], p);
    if (!Number.isFinite(p[0] + p[1] + p[2])) continue;
    col.position[k * 3] = p[0]; col.position[k * 3 + 1] = p[1]; col.position[k * 3 + 2] = p[2];
    for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > maxB[a]) maxB[a] = p[a]; }
    if (kind === 'gaussians') {
      const s0 = Math.exp(P.scale_0[s]), s1 = Math.exp(P.scale_1[s]), s2 = Math.exp(P.scale_2[s]), a = [s0, s1, s2].sort((x, y) => y - x);
      col.size[k] = Math.sqrt(a[0] * a[1]) * scale * k6 * grow;
      // 形：もとのガウシアンの共分散 C を、置き方の行列で回す（M C Mᵀ。M は大きさ込み）。間引いたぶんは広げる
      quatCov(c, 0, P.rot_0[s], P.rot_1[s], P.rot_2[s], P.rot_3[s], s0 * grow, s1 * grow, s2 * grow);
      const C = [c[0], c[1], c[2], c[1], c[3], c[4], c[2], c[4], c[5]], MC = new Array(9);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) MC[i * 3 + j] = M[i * 3] * C[j] + M[i * 3 + 1] * C[3 + j] + M[i * 3 + 2] * C[6 + j];
      const e = (i, j) => MC[i * 3] * M[j * 3] + MC[i * 3 + 1] * M[j * 3 + 1] + MC[i * 3 + 2] * M[j * 3 + 2];
      const o = k * 6; col.cov[o] = e(0, 0); col.cov[o + 1] = e(0, 1); col.cov[o + 2] = e(0, 2); col.cov[o + 3] = e(1, 1); col.cov[o + 4] = e(1, 2); col.cov[o + 5] = e(2, 2);
      for (let a2 = 0; a2 < 3; a2++) col.color[k * 3 + a2] = Math.max(0, Math.min(255, Math.round((0.5 + C0 * P[`f_dc_${a2}`][s]) * 255)));
      col.opacity[k] = Math.round(255 / (1 + Math.exp(-P.opacity[s])));
    } else {
      col.size[k] = pointSize * grow;
      roundCov(col.cov, k * 6, pointSize * grow / k6);
      col.color[k * 3] = Math.max(0, Math.min(255, P.red[s] * bytes)); col.color[k * 3 + 1] = Math.max(0, Math.min(255, P.green[s] * bytes)); col.color[k * 3 + 2] = Math.max(0, Math.min(255, P.blue[s] * bytes));
    }
    col.normal[k * 3 + 1] = 127;
    k++;
  }
  return { columns: col, count: k, kind, bounds: { min, max: maxB } };
}
