// 絵画の筆跡を測る。DOM も THREE も使わない（Web Worker でも node でも動く）。
//
// 測るもの（画素ごと）：
//   theta  筆の向き（画像の上での角度。0 = 右、π/2 = 下。0〜π）。明るさの勾配の「構造テンソル」の、勾配と直交する向き
//   coh    向きのはっきりさ（0〜1）。1 に近いほど、一方向にそろった筆跡がある
// 測るもの（種類ごと。種類の地図 kind があれば）：
//   width / length  筆跡 1 本の幅と長さ（画素）。筆の向きに沿った方向と横切る方向で、細かい明暗の「自己相関」が半分に落ちる距離 × 2
//                   （長さ L の四角い筆跡なら、自己相関は距離 d で 1 − d / L になり、半分になるのが L / 2）
//   hist            筆の向きの分布（画像の上での角度、18 段。はっきりさで重み付け）
//   bristle         筆の中の毛の筋の強さ（細かい明暗 ÷ 筆跡の大きさの明暗）
//   curves          自己相関の曲線（確かめ用の表示）

export const ANGLE_BINS = 18;

/** sRGB の RGBA から明るさ（0〜1）。 */
export function luminance(rgba, W, H) {
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  return L;
}

/** ガウスぼかし（縦横に分けて）。端は端の値をのばす。 */
export function blur(src, W, H, sigma) {
  if (sigma <= 0) return src.slice();
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
  let s = 0; for (let i = -r; i <= r; i++) s += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= W ? W - 1 : x + i; a += src[row + xx] * k[i + r]; }
      tmp[row + x] = a;
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= H ? H - 1 : y + i; a += tmp[yy * W + x] * k[i + r]; }
    out[y * W + x] = a;
  }
  return out;
}

/** RGBA（sRGB）を、色ごとにぼかした 3 枚（0〜1）にする。筆跡 1 本ぶんの色を取るのに使う。 */
export function blurColor(rgba, W, H, sigma) {
  const out = [];
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) ch[i] = rgba[i * 4 + c] / 255;
    out.push(blur(ch, W, H, sigma));
  }
  return out;
}

/**
 * 筆の向きの地図。sigma = 勾配を取る前のぼかし、rho = テンソルをならす広さ（画素）。
 * 返すもの：{ theta, coh }（画素ごと）
 */
export function orientationField(L, W, H, { sigma = 1, rho = 5 } = {}) {
  const g = blur(L, W, H, sigma);
  const jxx = new Float32Array(W * H), jxy = new Float32Array(W * H), jyy = new Float32Array(W * H);
  const at = (x, y) => g[(y < 0 ? 0 : y >= H ? H - 1 : y) * W + (x < 0 ? 0 : x >= W ? W - 1 : x)];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // ソーベル
    const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
    const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
    const i = y * W + x; jxx[i] = gx * gx; jxy[i] = gx * gy; jyy[i] = gy * gy;
  }
  const a = blur(jxx, W, H, rho), b = blur(jxy, W, H, rho), c = blur(jyy, W, H, rho);
  const theta = new Float32Array(W * H), coh = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = a[i] - c[i], e = Math.sqrt(d * d + 4 * b[i] * b[i]), tr = a[i] + c[i];
    let t = 0.5 * Math.atan2(2 * b[i], d) + Math.PI / 2; // 勾配の向き + 90° = 筆の向き
    t %= Math.PI; if (t < 0) t += Math.PI;
    theta[i] = t; coh[i] = tr > 1e-7 ? (e / tr) * (e / tr) : 0;
  }
  return { theta, coh };
}

function bilinear(f, W, H, x, y) {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = x - x0, fy = y - y0;
  return (f[y0 * W + x0] * (1 - fx) + f[y0 * W + x1] * fx) * (1 - fy) + (f[y1 * W + x0] * (1 - fx) + f[y1 * W + x1] * fx) * fy;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * 筆跡の大きさと向きを、種類ごとに測る。
 *   rgba, W, H   絵（sRGB）
 *   kind         画素ごとの種類（Uint8Array。255 = 数えない）。null なら全体を 1 つ（種類 0）として測る
 *   field        orientationField() の戻り値（無ければ作る）
 * 返すもの：{ field, hp, byKind: Map<種類, { count, width, length, aspect, hist, bristle, cohMean, curves: { along, across } }> , all }
 */
export function measureStrokes(rgba, W, H, kind = null, { field = null, maxD = 48, samples = 5000, seed = 7, highpass = 10 } = {}) {
  const L = luminance(rgba, W, H);
  field = field || orientationField(L, W, H);
  const low = blur(L, W, H, highpass), fine = blur(L, W, H, 0.8), mid = blur(L, W, H, 2.5);
  const hp = new Float32Array(W * H), hf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { hp[i] = fine[i] - low[i]; hf[i] = L[i] - mid[i]; }
  const kinds = new Map();
  for (let i = 0; i < W * H; i++) { const k = kind ? kind[i] : 0; if (k === 255) continue; let e = kinds.get(k); if (!e) kinds.set(k, (e = [])); if (e.length < 400000) e.push(i); }
  const byKind = new Map(), R = rng(seed);
  const measure = (pix, k) => {
    const along = new Float64Array(maxD + 1), across = new Float64Array(maxD + 1), na = new Float64Array(maxD + 1), nc = new Float64Array(maxD + 1);
    const hist = new Float64Array(ANGLE_BINS);
    let cohSum = 0, var0 = 0, n0 = 0, vf = 0, vh = 0;
    for (let s = 0; s < Math.min(samples, pix.length * 2); s++) {
      const i = pix[Math.floor(R() * pix.length)], x = i % W, y = (i / W) | 0, t = field.theta[i], c = field.coh[i];
      hist[Math.min(ANGLE_BINS - 1, Math.floor(t / Math.PI * ANGLE_BINS))] += c;
      cohSum += c; vf += hf[i] * hf[i]; vh += hp[i] * hp[i];
      if (c < 0.15) continue; // 向きのはっきりしない所は、長さ・幅を測らない
      const h0 = hp[i], ux = Math.cos(t), uy = Math.sin(t);
      var0 += h0 * h0; n0++;
      for (let d = 1; d <= maxD; d++) {
        for (const sg of [1, -1]) {
          const ax = x + ux * d * sg, ay = y + uy * d * sg, ia = Math.round(ay) * W + Math.round(ax);
          if (ax >= 0 && ay >= 0 && ax <= W - 1 && ay <= H - 1 && (!kind || k < 0 || kind[ia] === k)) { along[d] += h0 * bilinear(hp, W, H, ax, ay); na[d]++; }
          const bx = x - uy * d * sg, by = y + ux * d * sg, ib = Math.round(by) * W + Math.round(bx);
          if (bx >= 0 && by >= 0 && bx <= W - 1 && by <= H - 1 && (!kind || k < 0 || kind[ib] === k)) { across[d] += h0 * bilinear(hp, W, H, bx, by); nc[d]++; }
        }
      }
    }
    const v = n0 ? var0 / n0 : 1e-9, ca = [1], cc = [1];
    for (let d = 1; d <= maxD; d++) { ca.push(na[d] ? along[d] / na[d] / v : 0); cc.push(nc[d] ? across[d] / nc[d] / v : 0); }
    const half = (curve) => { for (let d = 1; d < curve.length; d++) if (curve[d] < 0.5) { const a = curve[d - 1], b = curve[d]; return d - 1 + (a - 0.5) / Math.max(1e-6, a - b); } return curve.length - 1; };
    const length = 2 * half(ca), width = 2 * half(cc), hs = hist.reduce((a, b) => a + b, 0) || 1;
    return { kind: k, count: pix.length, measured: n0, width, length, aspect: length / Math.max(0.5, width), hist: Array.from(hist, (x) => x / hs), bristle: Math.sqrt(vf / Math.max(1e-9, vh)), cohMean: cohSum / Math.max(1, Math.min(samples, pix.length * 2)), curves: { along: ca, across: cc } };
  };
  const all = [];
  for (const [k, pix] of kinds) { if (pix.length < 200) continue; byKind.set(k, measure(pix, k)); for (let j = 0; j < pix.length; j += 7) all.push(pix[j]); }
  return { field, hp, byKind, all: all.length ? measure(all, -1) : null };
}

/** 角度の分布（ANGLE_BINS 段、0〜π）から、u（0〜1）に当たる角度を引く。 */
export function angleFromHist(hist, u) {
  let s = 0;
  for (let i = 0; i < hist.length; i++) { const p = hist[i]; if (s + p >= u && p > 0) return (i + (u - s) / p) / hist.length * Math.PI; s += p; }
  return Math.PI * (hist.length - 0.5) / hist.length;
}
