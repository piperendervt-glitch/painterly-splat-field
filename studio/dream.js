// 絵 1 枚から作った場面（プレビズの形が無い場面）で、視点を足すための計算。three.js にも画面にも依存しない（node でも試せる）。
//
// もと：LucidDreamer（Chung ほか 2023）の「Dreaming」の段。
//   1. すでにある絵の画素を、奥行きを使って 3D に置き、新しい視点へ写す。写らなかった所が穴
//   2. 穴を画像生成で埋める（このツールでは Codex）
//   3. 埋めた絵の奥行きを推定し、すでに位置の分かっている所で尺度を合わせる。残ったずれは、穴の縁での差を穴の中へなめらかに広げて消す
//   4. 穴だった画素だけを、新しい点として足す
// 本家は点を 1 つずつ写して間を補うが、ここでは奥行きの絵を細かい三角形の面として写す（すき間が出ず、手前の面が奥を隠す）。
// 行列はどれも、行ごとに並んだ 4x4（cameras.json と同じ）。
import { pullPush } from './layers.js';

const NEAR = 0.05;

/** 位置・右・上・前の向きから、カメラ → 世界 と 世界 → カメラ の行列を作る。 */
export function cameraMatrices(position, { r, u, f }) {
  const [px, py, pz] = position;
  const c2w = [r[0], u[0], -f[0], px, r[1], u[1], -f[1], py, r[2], u[2], -f[2], pz, 0, 0, 0, 1];
  const w2c = [r[0], r[1], r[2], -(r[0] * px + r[1] * py + r[2] * pz), u[0], u[1], u[2], -(u[0] * px + u[1] * py + u[2] * pz), -f[0], -f[1], -f[2], f[0] * px + f[1] * py + f[2] * pz, 0, 0, 0, 1];
  return { c2w, w2c };
}
const mul = (a, b) => { const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) o[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j]; return o; };

/**
 * すでにある視点（sources）の絵を、新しい視点（target）へ写す。
 *   target   { W, H, fx, fy, cx, cy, c2w, w2c }
 *   sources  [{ W, H, fx, fy, cx, cy, c2w, w2c, z（画素ごとの奥行き。0 = 空）, type, object（札。無ければ null）, valid（1 = 使う画素。null = 全部） }]
 *   step     何画素おきに面の頂点を置くか（1 = 全部。下見は粗くてよい）
 * 奥行きの段（手前の物と背景の境目）に張った面は、新しい視点で引き伸ばされるときだけ捨てる（そこが穴になる）。裏返った面も捨てる。
 * 返すもの（target の画素ごと）：inv = 1 / 奥行き（0 = 何も写らなかった）、src = どの視点から（-1 = 無し）、u・v = その視点の画素の位置、sky = 1 なら空だと分かった所
 */
export function warp(target, sources, { step = 1 } = {}) {
  const { W, H } = target, n = W * H;
  const inv = new Float32Array(n), src = new Int16Array(n).fill(-1), U = new Float32Array(n), V = new Float32Array(n), sky = new Uint8Array(n);
  const limit = 2.5 * step + 1.5; // 段の面は、これより伸びたら捨てる（画素）
  sources.forEach((s, si) => {
    const M = mul(target.w2c, s.c2w), gw = Math.floor((s.W - 1) / step) + 1, gh = Math.floor((s.H - 1) / step) + 1, g = gw * gh;
    const tx = new Float32Array(g), ty = new Float32Array(g), ti = new Float32Array(g), lz = new Float32Array(g), ok = new Uint8Array(g), use = new Uint8Array(g), lab = new Int32Array(g);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(s.W - 1, gx * step), y = Math.min(s.H - 1, gy * step), i = y * s.W + x, k = gy * gw + gx, z = s.z[i];
      use[k] = s.valid ? s.valid[i] : 1; lab[k] = s.type ? s.type[i] * 65536 + (s.object ? s.object[i] : 0) : 0;
      if (!(z > 0)) continue;
      const xc = (x + 0.5 - s.cx) / s.fx * z, yc = -(y + 0.5 - s.cy) / s.fy * z, zc = -z;
      const X = M[0] * xc + M[1] * yc + M[2] * zc + M[3], Y = M[4] * xc + M[5] * yc + M[6] * zc + M[7], Z = -(M[8] * xc + M[9] * yc + M[10] * zc + M[11]);
      if (Z < NEAR) continue;
      tx[k] = target.cx + X / Z * target.fx - 0.5; ty[k] = target.cy - Y / Z * target.fy - 0.5; ti[k] = 1 / Z; lz[k] = Math.log(z); ok[k] = 1;
    }
    const tri = (a, b, c, loose) => {
      const ax = tx[a], ay = ty[a], bx = tx[b], by = ty[b], cx = tx[c], cy = ty[c];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(area > 1e-9)) return; // 裏返った面・つぶれた面（もとの視点では、この並びで area が正）
      const x0f = Math.min(ax, bx, cx), x1f = Math.max(ax, bx, cx), y0f = Math.min(ay, by, cy), y1f = Math.max(ay, by, cy);
      if (loose && (x1f - x0f > limit || y1f - y0f > limit)) return;
      const x0 = Math.max(0, Math.ceil(x0f)), x1 = Math.min(W - 1, Math.floor(x1f)), y0 = Math.max(0, Math.ceil(y0f)), y1 = Math.min(H - 1, Math.floor(y1f));
      if (x0 > x1 || y0 > y1) return;
      const ia = ti[a], ib = ti[b], ic = ti[c], k = 1 / area;
      const ua = (a % gw) * step, va = Math.floor(a / gw) * step, ub = (b % gw) * step, vb = Math.floor(b / gw) * step, uc = (c % gw) * step, vc = Math.floor(c / gw) * step;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * k, w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * k, w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const iz = w0 * ia + w1 * ib + w2 * ic, o = y * W + x;
        if (iz <= inv[o]) continue;
        inv[o] = iz; src[o] = si;
        U[o] = Math.min(s.W - 1, (w0 * ia * ua + w1 * ib * ub + w2 * ic * uc) / iz); V[o] = Math.min(s.H - 1, (w0 * ia * va + w1 * ib * vb + w2 * ic * vc) / iz);
      }
    };
    for (let gy = 0; gy + 1 < gh; gy++) for (let gx = 0; gx + 1 < gw; gx++) {
      const a = gy * gw + gx, b = a + 1, c = a + gw, d = c + 1;
      if (!(ok[a] && ok[b] && ok[c] && ok[d]) || !(use[a] || use[b] || use[c] || use[d])) continue;
      const lo = Math.min(lz[a], lz[b], lz[c], lz[d]), ratio = Math.max(lz[a], lz[b], lz[c], lz[d]) - lo;
      const loose = ratio > 0.3 || (ratio > 0.04 && !(lab[a] === lab[b] && lab[a] === lab[c] && lab[a] === lab[d]));
      tri(a, c, b, loose); tri(b, c, d, loose); // 画面では y が下向きなので、この並びで area が正
    }
  });
  // 何も写らなかった所：その向きが、どれかの視点で空なら、空だと分かる
  const m = target.c2w;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * W + x; if (inv[o] > 0) continue;
    const a = (x + 0.5 - target.cx) / target.fx, b = -(y + 0.5 - target.cy) / target.fy;
    const dx = m[0] * a + m[1] * b - m[2], dy = m[4] * a + m[5] * b - m[6], dz = m[8] * a + m[9] * b - m[10];
    for (let si = 0; si < sources.length; si++) {
      const s = sources[si], q = s.w2c;
      const zc = -(q[8] * dx + q[9] * dy + q[10] * dz); if (zc <= 1e-6) continue;
      const px = s.cx + (q[0] * dx + q[1] * dy + q[2] * dz) / zc * s.fx - 0.5, py = s.cy - (q[4] * dx + q[5] * dy + q[6] * dz) / zc * s.fy - 0.5;
      const ix = Math.round(px), iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= s.W || iy >= s.H) continue;
      const j = iy * s.W + ix; if (s.z[j] !== 0 || (s.valid && !s.valid[j])) continue;
      sky[o] = 1; src[o] = si; U[o] = Math.max(0, Math.min(s.W - 1, px)); V[o] = Math.max(0, Math.min(s.H - 1, py)); break;
    }
  }
  return { W, H, inv, src, U, V, sky };
}

/** warp の結果を数える（下見用）。covered = 絵が写った画素、holes = 穴。 */
export function warpStats(w) {
  let covered = 0; for (let i = 0; i < w.W * w.H; i++) if (w.src[i] >= 0) covered++;
  return { covered, holes: w.W * w.H - covered, pixels: w.W * w.H };
}

function bilinear(img, W, H, px, py, out) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(px))), y0 = Math.max(0, Math.min(H - 1, Math.floor(py))), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, px - x0)), fy = Math.max(0, Math.min(1, py - y0));
  for (let c = 0; c < 3; c++) out[c] = (img[(y0 * W + x0) * 4 + c] * (1 - fx) + img[(y0 * W + x1) * 4 + c] * fx) * (1 - fy) + (img[(y1 * W + x0) * 4 + c] * (1 - fx) + img[(y1 * W + x1) * 4 + c] * fx) * fy;
}

/**
 * warp の結果から、新しい視点の絵と材料を作る。sources には painted（RGBA）が要る。
 * 返すもの：rgba（写した絵。穴は灰色）、hole（1 = 穴）、holeCount、z（分かっている奥行き。空と穴は 0）、known（1 = 面か空だと分かった）、type・object（札。穴は 0）
 * 細い線や点だけの穴（面の継ぎ目の誤差）は、まわりから埋めて穴から外す。
 */
export function compose(w, sources, { skyType = 0 } = {}) {
  const { W, H } = w, n = W * H;
  const rgba = new Uint8ClampedArray(n * 4), hole = new Uint8Array(n), z = new Float32Array(n), type = new Uint8Array(n), object = new Uint16Array(n), col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * 4; rgba[o + 3] = 255;
    if (w.src[i] < 0) { hole[i] = 1; rgba[o] = rgba[o + 1] = rgba[o + 2] = 128; continue; }
    const s = sources[w.src[i]];
    bilinear(s.painted, s.W, s.H, w.U[i], w.V[i], col); rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
    if (w.sky[i]) { type[i] = skyType; continue; }
    z[i] = 1 / w.inv[i];
    const j = Math.round(w.V[i]) * s.W + Math.round(w.U[i]);
    if (s.type) type[i] = s.type[j]; if (s.object) object[i] = s.object[j];
  }
  for (let pass = 0; pass < 2; pass++) {
    const before = hole.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (!before[i]) continue;
      let near = 0, r = 0, g = 0, b = 0, k = 0, pick = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy * W + dx; if (before[j]) near++; else { r += rgba[j * 4]; g += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; k++; if (pick < 0 || z[j] > z[pick]) pick = j; }
      }
      if (near > 3 || !k) continue; // 奥行きと札は、まわりでいちばん奥の画素のもの（継ぎ目の奥に見えるのは背景）
      hole[i] = 0; rgba[i * 4] = r / k; rgba[i * 4 + 1] = g / k; rgba[i * 4 + 2] = b / k; z[i] = z[pick]; type[i] = type[pick]; object[i] = object[pick];
    }
  }
  const known = new Uint8Array(n); let holeCount = 0;
  for (let i = 0; i < n; i++) { known[i] = hole[i] ? 0 : 1; holeCount += hole[i]; }
  return { W, H, rgba, hole, holeCount, z, known, type, object };
}

/** 穴の奥行きを、分かっている面の奥行きからなめらかに広げて埋める（奥行きの推定が使えないときの代わり）。z を書き換える。 */
export function extendDepth(c) {
  const n = c.W * c.H, lz = new Float32Array(n), k = new Uint8Array(n); let any = false;
  for (let i = 0; i < n; i++) if (c.z[i] > 0) { lz[i] = Math.log(c.z[i]); k[i] = 1; any = true; }
  if (!any) { for (let i = 0; i < n; i++) if (c.hole[i]) c.z[i] = 10; return c.z; }
  const f = pullPush(lz, k, c.W, c.H);
  for (let i = 0; i < n; i++) if (c.hole[i]) c.z[i] = Math.exp(f[i]);
  return c.z;
}

/**
 * 埋めた絵から推定した「近さ」（disp。尺度とずれが不明。大きいほど近い）を、分かっている奥行きに合わせて、穴の奥行きを決める。
 *   1. 分かっている面で、1/z = a × disp + b に合わせる（外れ値を除きながら）
 *   2. 残った差（1/z − (a × disp + b)）を、穴の中へなめらかに広げて足す。穴の縁で、すでにある面とつながる
 *   3. とても遠い所（skyZ より遠い）と、近さがほぼ 0 の所は空にする
 * 返すもの：{ z（穴も埋まった奥行き。空は 0）, a, b, samples, skyHoles } または null（合わせられなかった）
 */
export function alignDepth(c, disp, { skyZ = 400, minZ = 0.3 } = {}) {
  const { W, H } = c, n = W * H;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { if (disp[i] < lo) lo = disp[i]; if (disp[i] > hi) hi = disp[i]; }
  if (!(hi > lo)) return null;
  const xs = [], ys = [];
  for (let y = 1; y < H; y += 3) for (let x = 1; x < W; x += 3) { const i = y * W + x; if (c.z[i] > 0 && !c.hole[i]) { xs.push(disp[i]); ys.push(1 / c.z[i]); } }
  if (xs.length < 200) return null;
  let a = 0, b = 0, keep = xs.map(() => true);
  for (let round = 0; round < 4; round++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
    for (let i = 0; i < xs.length; i++) if (keep[i]) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; k++; }
    const det = k * sxx - sx * sx; if (!(Math.abs(det) > 1e-12) || k < 100) return null;
    a = (k * sxy - sx * sy) / det; b = (sy - a * sx) / k;
    const res = xs.map((x, i) => Math.abs(ys[i] - (a * x + b))), sorted = Float64Array.from(res).sort(), cut = 2.5 * sorted[sorted.length >> 1] + 1e-9;
    keep = res.map((r) => r <= cut);
  }
  if (!(a > 0)) return null;
  const r = new Float32Array(n), k = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (c.z[i] > 0 && !c.hole[i]) { r[i] = 1 / c.z[i] - (a * disp[i] + b); k[i] = 1; }
  const f = pullPush(r, k, W, H), z = new Float32Array(c.z);
  let skyHoles = 0;
  for (let i = 0; i < n; i++) {
    if (!c.hole[i]) continue;
    const iz = a * disp[i] + b + f[i];
    if (iz < 1 / skyZ || disp[i] - lo < 0.01 * (hi - lo)) { z[i] = 0; skyHoles++; } else z[i] = Math.max(minZ, 1 / iz);
  }
  return { z, a, b, samples: xs.length, skyHoles };
}

/**
 * 穴だった画素に札を付ける：空（z = 0）は空、地面の高さより上に出ている所は遠景（当たらない・揺れない）、それ以外は地面。
 * ids = { sky, ground, far }（場面の種類の番号）。type を書き換える。
 */
export function labelHoles(c, z, target, { ids, groundY = 0, rise = 0.6 }) {
  const { W, H } = c, m = target.c2w;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!c.hole[i]) continue;
    if (!(z[i] > 0)) { c.type[i] = ids.sky; continue; }
    const yc = -(y + 0.5 - target.cy) / target.fy * z[i], xc = (x + 0.5 - target.cx) / target.fx * z[i];
    const wy = m[4] * xc + m[5] * yc - m[6] * z[i] + m[7];
    c.type[i] = wy > groundY + rise ? ids.far : ids.ground;
  }
  return c.type;
}

/** 奥行きを、書き出しと同じ 16bit の絵（R = 上の桁、G = 下の桁。0 = 空）にする。RGBA。 */
export function depthPng(z, n, near, far) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = z[i] > 0 ? Math.max(1, Math.min(65535, Math.round((1 / z[i] - 1 / far) / (1 / near - 1 / far) * 65535))) : 0;
    out[i * 4] = v >> 8; out[i * 4 + 1] = v & 255; out[i * 4 + 3] = 255;
  }
  return out;
}
/** 奥行きの見るための絵（白 = 近い、黒 = 遠い・空）。RGBA。 */
export function depthViewPng(z, n) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { const g = z[i] > 0 ? Math.max(8, Math.min(255, 255 * Math.sqrt(1.5 / Math.max(1.5, z[i])))) : 0; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255; }
  return out;
}
/** 種類の絵（8bit の灰色 = 種類の番号）と、物体の絵（番号 = R + G × 256）。RGBA。 */
export function labelPngs(type, object, n) {
  const t = new Uint8ClampedArray(n * 4), o = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { t[i * 4] = t[i * 4 + 1] = t[i * 4 + 2] = type[i]; t[i * 4 + 3] = 255; o[i * 4] = object[i] & 255; o[i * 4 + 1] = object[i] >> 8; o[i * 4 + 3] = 255; }
  return { type: t, object: o };
}
/** 種類ごとの色と、近いほど明るい陰で塗った絵（プレビズの代わり）。colors = 種類の番号 → [r, g, b]。RGBA。 */
export function typeColorPng(type, z, n, colors) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = colors[type[i]] || [140, 140, 140], s = z[i] > 0 ? 0.55 + 0.45 * Math.sqrt(1.5 / Math.max(1.5, z[i])) : 1;
    out[i * 4] = c[0] * s; out[i * 4 + 1] = c[1] * s; out[i * 4 + 2] = c[2] * s; out[i * 4 + 3] = 255;
  }
  return out;
}
