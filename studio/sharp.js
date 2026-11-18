// SHARP（Apple の 1 枚絵から 3D ガウシアンを作るモデル）の .ply を、粒の列にする。
// .ply は sharp/psf_sharp.py が書き出したもの（この道具の世界座標。色は sRGB の f_dc）。
// 粒は丸い（形の向きは使わない）ので、ガウシアンの 3 軸のうち大きい 2 軸の幾何平均を粒の広がりにする。

const C0 = 0.28209479177387814; // 0 次の球面調和の係数
const PLY_TYPES = { float: 4, float32: 4, double: 8, float64: 8, uchar: 1, uint8: 1, char: 1, int8: 1, ushort: 2, uint16: 2, short: 2, int16: 2, uint: 4, uint32: 4, int: 4, int32: 4 };

/** バイナリ（little endian）の .ply から vertex の列を読む。戻り値は { count, props: { 名前: Float32Array } }。 */
export function parsePly(buffer) {
  const bytes = new Uint8Array(buffer);
  const tail = [101, 110, 100, 95, 104, 101, 97, 100, 101, 114]; // "end_header"
  let end = -1;
  for (let i = 0; i < Math.min(bytes.length, 1 << 16) && end < 0; i++) {
    let ok = true; for (let k = 0; k < tail.length; k++) if (bytes[i + k] !== tail[k]) { ok = false; break; }
    if (ok) { end = i + tail.length; while (bytes[end] !== 10) end++; end++; }
  }
  if (end < 0) throw new Error('.ply の見出しが読めませんでした');
  const header = new TextDecoder().decode(bytes.subarray(0, end)).split(/\r?\n/);
  if (!header.some((l) => l.startsWith('format binary_little_endian'))) throw new Error('.ply はバイナリ（little endian）だけ読めます');
  const elements = []; let el = null;
  for (const line of header) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'element') { el = { name: w[1], count: Number(w[2]), props: [] }; elements.push(el); }
    else if (w[0] === 'property' && el) {
      if (w[1] === 'list') throw new Error('.ply の list の列は読めません');
      el.props.push({ name: w[2], type: w[1], size: PLY_TYPES[w[1]] });
    }
  }
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex || elements[0] !== vertex) throw new Error('.ply の最初の要素が vertex ではありません');
  const stride = vertex.props.reduce((s, p) => s + p.size, 0);
  const view = new DataView(buffer, end), n = vertex.count, props = {};
  if (view.byteLength < n * stride) throw new Error('.ply が途中で切れています');
  let off = 0;
  for (const p of vertex.props) {
    const out = new Float32Array(n), get = getter(view, p.type);
    for (let i = 0, o = off; i < n; i++, o += stride) out[i] = get(o);
    props[p.name] = out; off += p.size;
  }
  return { count: n, props };
}
function getter(v, type) {
  switch (type) {
    case 'float': case 'float32': return (o) => v.getFloat32(o, true);
    case 'double': case 'float64': return (o) => v.getFloat64(o, true);
    case 'uchar': case 'uint8': return (o) => v.getUint8(o);
    case 'char': case 'int8': return (o) => v.getInt8(o);
    case 'ushort': case 'uint16': return (o) => v.getUint16(o, true);
    case 'short': case 'int16': return (o) => v.getInt16(o, true);
    case 'uint': case 'uint32': return (o) => v.getUint32(o, true);
    default: return (o) => v.getInt32(o, true);
  }
}

const NEED = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
export function checkSharp(ply) {
  const missing = NEED.filter((k) => !ply.props[k]);
  if (missing.length) throw new Error(`.ply に ${missing.join(', ')} の列がありません`);
}

/**
 * 視点 v（世界→カメラ、焦点距離、奥行き z）から見て、SHARP の粒の大きさを奥行きの絵に合わせる倍率を求める。
 * 画素を 8 × 8 のます目に分け、ます目ごとに「いちばん手前の SHARP の粒の奥行き」と「奥行きの絵」を比べ、比の中央値を返す。
 * 倍率はカメラの位置を中心に掛けるので、元の視点から見た絵は変わらない。
 */
export function sharpScale(ply, v, inv) {
  const { W, H, z } = v, { fx, fy, cx, cy } = v.def.intrinsics, G = 8, gw = Math.ceil(W / G), gh = Math.ceil(H / G);
  const near = new Float32Array(gw * gh).fill(Infinity), e = inv.elements, P = ply.props;
  for (let i = 0; i < ply.count; i++) {
    const x = P.x[i], y = P.y[i], zz = P.z[i];
    const cxm = e[0] * x + e[4] * y + e[8] * zz + e[12], cym = e[1] * x + e[5] * y + e[9] * zz + e[13], d = -(e[2] * x + e[6] * y + e[10] * zz + e[14]);
    if (!(d > 0.05)) continue;
    const u = fx * cxm / d + cx, w = -fy * cym / d + cy;
    if (u < 0 || w < 0 || u >= W || w >= H) continue;
    const g = ((w / G) | 0) * gw + ((u / G) | 0);
    if (d < near[g]) near[g] = d;
  }
  const ratios = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const g = gy * gw + gx, px = Math.min(W - 1, gx * G + (G >> 1)), py = Math.min(H - 1, gy * G + (G >> 1)), zz = z[py * W + px];
    if (zz > 0 && zz < 200 && Number.isFinite(near[g])) ratios.push(zz / near[g]);
  }
  if (ratios.length < 20) return 1;
  ratios.sort((p, q) => p - q);
  return ratios[ratios.length >> 1];
}

/**
 * SHARP の粒を、粒の列（studio/splat.js の COLUMNS）にする。
 *   v      視点（札・奥行き・カメラ）。札は、粒をこの視点へ映した画素から取る
 *   vi     粒の「視点」の番号（視点別の表示と、視点ごとの出し入れに使う）
 *   keep   何個に 1 個使うか（粗くするとき）。並びに縞が出ないよう、番号のハッシュで散らして選び、残した粒を √keep 倍に広げる
 *   scale  大きさの倍率（sharpScale）。カメラの位置を中心に掛ける
 *   inv    世界→カメラの行列（THREE.Matrix4）
 *   cam    カメラの位置 [x, y, z]
 *   typeOf 種類の札 t から { sway } を引く関数
 *   skyZ   空の粒（映した画素が空）を置き直さない代わりに、空として扱う奥行きの下限（m）
 * 札は「映した画素の奥行きと粒の奥行きが合う」ときだけ取る。合わないのは手前の物の後ろに SHARP が描き足した粒なので、
 * 同じ行の左右 64 画素の中で奥行きが合う画素の札を使う（無ければ、映した画素の札のまま、札が怪しい粒として数える）。
 */
export function splatsFromSharp(ply, v, vi, { keep = 1, scale = 1, inv, cam, typeOf, edgeMax, labelEdgeMax }) {
  const P = ply.props, n = ply.count, max = keep > 1 ? Math.ceil(n / keep * 1.1) + 64 : n;
  const { W, H, z } = v, { fx, fy, cx, cy } = v.def.intrinsics, e = inv.elements;
  const col = {
    position: new Float32Array(max * 3), size: new Float32Array(max), color: new Uint8Array(max * 3), edge: new Uint8Array(max).fill(edgeMax),
    sky: new Uint8Array(max), view: new Uint8Array(max).fill(vi), depthGray: new Uint8Array(max), opacity: new Uint8Array(max),
    type: new Uint8Array(max), object: new Uint16Array(max), normal: new Int8Array(max * 3), sunVis0: new Uint8Array(max).fill(255),
    sway: new Uint8Array(max), labelEdge: new Uint8Array(max).fill(labelEdgeMax), lift: new Float32Array(max).fill(0.05),
  };
  const stats = { count: 0, outside: 0, behind: 0, guessed: 0 };
  const near = v.near, far = v.far, k6 = 6 / 2.6; // 粒の絵は「一辺 = 間隔 × 2.6」の中に σ = 一辺 / 6 のぼかし（studio/splat.js の makeMaterials）
  const match = (i, d) => z[i] > 0 && Math.abs(Math.log(d / z[i])) < 0.12;
  const grow = Math.sqrt(keep), cut = keep > 1 ? Math.floor(4294967296 / keep) : 4294967296;
  let k = 0;
  for (let s = 0; s < n; s++) {
    if (keep > 1 && hash(s) >= cut) continue;
    if (k >= max) break;
    const x = cam[0] + (P.x[s] - cam[0]) * scale, y = cam[1] + (P.y[s] - cam[1]) * scale, zz = cam[2] + (P.z[s] - cam[2]) * scale;
    col.position[k * 3] = x; col.position[k * 3 + 1] = y; col.position[k * 3 + 2] = zz;
    // 大きさ：3 軸の広がりのうち大きい 2 軸の幾何平均
    const a = [Math.exp(P.scale_0[s]), Math.exp(P.scale_1[s]), Math.exp(P.scale_2[s])].sort((p, q) => q - p);
    col.size[k] = Math.sqrt(a[0] * a[1]) * scale * k6 * grow;
    for (let c = 0; c < 3; c++) col.color[k * 3 + c] = Math.max(0, Math.min(255, Math.round((0.5 + C0 * P[`f_dc_${c}`][s]) * 255)));
    col.opacity[k] = Math.round(255 / (1 + Math.exp(-P.opacity[s])));
    // 面の向き：いちばん薄い軸。カメラの側を向くように裏返す
    const nrm = thinAxis(P.rot_0[s], P.rot_1[s], P.rot_2[s], P.rot_3[s], P.scale_0[s], P.scale_1[s], P.scale_2[s]);
    if (nrm[0] * (cam[0] - x) + nrm[1] * (cam[1] - y) + nrm[2] * (cam[2] - zz) < 0) { nrm[0] = -nrm[0]; nrm[1] = -nrm[1]; nrm[2] = -nrm[2]; }
    for (let c = 0; c < 3; c++) col.normal[k * 3 + c] = Math.round(nrm[c] * 127);
    // この視点へ映して札を取る
    const cxm = e[0] * x + e[4] * y + e[8] * zz + e[12], cym = e[1] * x + e[5] * y + e[9] * zz + e[13], d = -(e[2] * x + e[6] * y + e[10] * zz + e[14]);
    col.depthGray[k] = d > 0 ? Math.max(0, Math.min(255, (1 - Math.log(Math.max(d, near) / near) / Math.log(far / near)) * 255)) : 0;
    const u = d > 0 ? Math.floor(fx * cxm / d + cx) : -1, w = d > 0 ? Math.floor(-fy * cym / d + cy) : -1;
    if (u < 0 || w < 0 || u >= W || w >= H) { stats.outside++; }
    else {
      let i = w * W + u;
      if (z[i] === 0) col.sky[k] = 1;       // 映した画素が空なら空の粒（「空も粒にする」で出し入れ）
      else if (!match(i, d)) {
        stats.behind++;
        let found = -1;
        for (let r = 1; r <= 64 && found < 0; r++) {
          if (u - r >= 0 && match(i - r, d)) found = i - r;
          else if (u + r < W && match(i + r, d)) found = i + r;
        }
        if (found >= 0) i = found; else stats.guessed++;
      }
      if (v.hasTypes) {
        col.type[k] = v.type[i]; col.object[k] = v.object[i];
        col.labelEdge[k] = v.labelEdge[i];
        col.sway[k] = Math.round(((typeOf(v.type[i]) || {}).sway || 0) * 255);
      }
      if (v.hasLabels) { col.sunVis0[k] = v.sunPx[i * 4]; col.lift[k] = 0.05 + d * d * (1 / v.near - 1 / v.far) / 65535; }
    }
    k++;
  }
  stats.count = k;
  return { columns: col, count: k, stats };
}

// 番号を散らす（murmur3 の最後の混ぜ方）。0〜2^32−1。
function hash(i) {
  let h = Math.imul(i ^ (i >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// 四元数（w, x, y, z）と対数の広がりから、いちばん薄い軸の向き（単位ベクトル）。
function thinAxis(qw, qx, qy, qz, s0, s1, s2) {
  const l = Math.hypot(qw, qx, qy, qz) || 1; qw /= l; qx /= l; qy /= l; qz /= l;
  const axis = s0 <= s1 && s0 <= s2 ? 0 : s1 <= s2 ? 1 : 2;
  // 回転行列の列 axis
  if (axis === 0) return [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)];
  if (axis === 1) return [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)];
  return [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
}
