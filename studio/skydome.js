// 空の天球。各視点の絵の「空の画素」を、位置ではなく向きだけで 1 枚の空の地図（全周の絵）にまとめる。
//   ・空は無限に遠いものとして扱う。視点どうしの位置の違いは無視し、歩いても空は動かない。
//   ・視点が重なる所は、絵の端から遠い視点ほど重く混ぜる（継ぎ目を作らない）。
//   ・どの絵にも無い向きは「穴」。ツール内の計算（fillSky）か、AI が描いた絵（ai の層）で埋める。
// 地図は正距円筒：横が方位（0〜360°、shared/light.js の太陽の方位と同じで 0 = +Z、90 = +X）、縦が高さ（上端 +90°、下端 -90°）。
// ここは計算だけ（three.js にも画面にも頼らない）。

export const EL_MIN = -25;          // 粒を置く下の端（度）。これより下は地面に隠れる前提で粒を置かない
export const AI_W = 4096, AI_H = 2048; // AI が描いた空の層（paint/out/sky_ai.png）の大きさ
const RAD = Math.PI / 180;

/** 方位・高さ（ラジアン）→ 向き */
const dirOf = (az, el, out) => { const c = Math.cos(el); out[0] = Math.sin(az) * c; out[1] = Math.sin(el); out[2] = Math.cos(az) * c; return out; };

/** 空の画素（0 = 空ではない）から、空でない画素までの距離（画素、max まで）。 */
export function skyDistance(isSky, W, H, max = 96) {
  const d = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = isSky[i] ? max : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i]; if (!v) continue;
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) v = Math.min(v, d[i - W] + 1);
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i]; if (!v) continue;
    if (x + 1 < W) v = Math.min(v, d[i + 1] + 1);
    if (y + 1 < H) v = Math.min(v, d[i + W] + 1);
    d[i] = v;
  }
  return d;
}

/**
 * 視点の絵から空の地図を作る。
 *   views = [{ W, H, fx, fy, cx, cy, m（camera_to_world、three.js の elements と同じ列優先 16 個）, dist（skyDistance の結果）, px（RGBA の絵）, fresh（Uint8Array か null。穴埋めで足した画素 = 1） }]
 *   opts.width  地図の横の画素数（縦はその半分）
 *   opts.margin 物の輪郭からこの画素数までの空は使わない（絵と形のずれで、輪郭の色が空ににじむのを避ける）
 * 戻り値：{ W, H, rgb（Float32Array、sRGB 0〜255）, a（Float32Array、0 = 穴、1 = 絵がある）, src（Uint8Array、いちばん効いた視点の番号 + 1。0 = なし） }
 */
export function buildSkyMap(views, { width = 2048, margin = 10 } = {}) {
  const W = width, H = width >> 1, n = W * H;
  const rgb = new Float32Array(n * 3), a = new Float32Array(n), src = new Uint8Array(n);
  const wsum = new Float32Array(n), best = new Float32Array(n);
  const d = [0, 0, 0], FADE = 24, BORDER = 96;
  views.forEach((v, vi) => {
    const m = v.m, { W: w, H: h, fx, fy, cx, cy, px, dist, fresh } = v;
    // 視点が見ている向きの範囲だけ調べる（視線の中心からの角度で粗く絞る）
    const fwd = [-m[8], -m[9], -m[10]], half = Math.atan(Math.hypot(w / fx, h / fy) / 2) + 0.02, cosHalf = Math.cos(half);
    for (let j = 0; j < H; j++) {
      const el = (0.5 - (j + 0.5) / H) * Math.PI;
      for (let i = 0; i < W; i++) {
        dirOf((i + 0.5) / W * 2 * Math.PI, el, d);
        if (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2] < cosHalf) continue;
        // 向きをカメラの座標へ（回転だけ。空は無限に遠いので位置は使わない）
        const xc = m[0] * d[0] + m[1] * d[1] + m[2] * d[2], yc = m[4] * d[0] + m[5] * d[1] + m[6] * d[2], zc = -(m[8] * d[0] + m[9] * d[1] + m[10] * d[2]);
        if (zc <= 1e-4) continue;
        const x = cx + fx * xc / zc - 0.5, y = cy - fy * yc / zc - 0.5;
        if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue;
        const xi = Math.round(x), yi = Math.round(y), p = yi * w + xi;
        const ws = Math.min(1, (dist[p] - margin) / FADE);
        if (!(ws > 0)) continue;
        const edge = Math.min(x, y, w - 1 - x, h - 1 - y);                    // 絵の端までの距離
        let wt = ws * Math.max(0.002, Math.min(1, edge / BORDER));
        if (fresh && !fresh[p]) wt *= 0.3;                                    // 足した視点の、ほかの絵から写しただけの画素は軽く
        const alpha = ws * Math.min(1, (edge + 1) / FADE);
        // 色は双線形で読む
        const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), tx = x - x0, ty = y - y0;
        const o = j * W + i, q00 = (y0 * w + x0) * 4, q10 = (y0 * w + x1) * 4, q01 = (y1 * w + x0) * 4, q11 = (y1 * w + x1) * 4;
        for (let c = 0; c < 3; c++) {
          rgb[o * 3 + c] += wt * ((px[q00 + c] * (1 - tx) + px[q10 + c] * tx) * (1 - ty) + (px[q01 + c] * (1 - tx) + px[q11 + c] * tx) * ty);
        }
        wsum[o] += wt;
        if (alpha > a[o]) a[o] = alpha;
        if (wt > best[o]) { best[o] = wt; src[o] = vi + 1; }
      }
    }
  });
  for (let o = 0; o < n; o++) if (wsum[o] > 0) { rgb[o * 3] /= wsum[o]; rgb[o * 3 + 1] /= wsum[o]; rgb[o * 3 + 2] /= wsum[o]; }
  return { W, H, rgb, a, src };
}

// 絵が 1 枚も無いときの空（上が青、地平線が白っぽい）
const DEFAULT_SKY = (t) => [150 + 60 * t, 185 + 40 * t, 225 + 10 * t]; // t = 0 天頂、1 地平線より下

/**
 * 穴をツール内の計算で埋めた空を作る（地図の半分の細かさ。なめらかなので粗くてよい）。
 *   1. 高さごとの平均の色（地平線から天頂への色の移り変わり）を、絵のある所から取る。絵の無い高さは上下からつなぐ。
 *   2. そこからの差（雲など）を、絵のある所から穴へ、遠くなるほどぼかしながら広げる。絵から 20〜40° 離れると差は消え、高さごとの色だけになる。
 * known は絵の地図（AI の層があれば withAi で重ねたもの）。
 * 戻り値：{ W, H, rgb（Float32Array）, rough（絵のある所の色の細かいばらつき。埋めた所にムラを足す量の目安） }
 */
export function fillSky(known) {
  const W = known.W >> 1, H = known.H >> 1, n = W * H;
  const c = new Float32Array(n * 3), a = new Float32Array(n);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { // 2×2 をまとめる
    let s = 0, r = 0, g = 0, b = 0;
    for (let k = 0; k < 4; k++) {
      const o = (j * 2 + (k >> 1)) * known.W + i * 2 + (k & 1), w = known.a[o];
      s += w; r += w * known.rgb[o * 3]; g += w * known.rgb[o * 3 + 1]; b += w * known.rgb[o * 3 + 2];
    }
    const o = j * W + i; a[o] = s / 4;
    if (s > 0) { c[o * 3] = r / s; c[o * 3 + 1] = g / s; c[o * 3 + 2] = b / s; }
  }
  // 1. 高さごとの色
  const prof = new Float32Array(H * 3), has = new Uint8Array(H);
  for (let j = 0; j < H; j++) {
    let s = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < W; i++) { const o = j * W + i, w = a[o]; s += w; r += w * c[o * 3]; g += w * c[o * 3 + 1]; b += w * c[o * 3 + 2]; }
    if (s >= 3) { has[j] = 1; prof[j * 3] = r / s; prof[j * 3 + 1] = g / s; prof[j * 3 + 2] = b / s; }
  }
  const rows = []; for (let j = 0; j < H; j++) if (has[j]) rows.push(j);
  for (let j = 0; j < H; j++) {
    if (has[j]) continue;
    if (!rows.length) { prof.set(DEFAULT_SKY(Math.min(1, (j + 0.5) / (H / 2))), j * 3); continue; }
    let lo = -1, hi = -1;
    for (const r of rows) { if (r < j) lo = r; else { hi = r; break; } }
    if (lo < 0 || hi < 0) { const r = lo < 0 ? hi : lo; for (let k = 0; k < 3; k++) prof[j * 3 + k] = prof[r * 3 + k]; } // 端はいちばん近い高さの色のまま
    else { const t = (j - lo) / (hi - lo); for (let k = 0; k < 3; k++) prof[j * 3 + k] = prof[lo * 3 + k] * (1 - t) + prof[hi * 3 + k] * t; }
  }
  const smooth = new Float32Array(H * 3), R = Math.max(1, Math.round(H / 90)); // 上下 2° ほどでならす
  for (let j = 0; j < H; j++) for (let k = 0; k < 3; k++) {
    let s = 0, m = 0; for (let t = -R; t <= R; t++) { const q = Math.max(0, Math.min(H - 1, j + t)); s += prof[q * 3 + k]; m++; }
    smooth[j * 3 + k] = s / m;
  }
  // 2. 差を広げる（粗い絵を作って戻す、pull-push。横は一周つながる）
  const res = new Float32Array(n * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const o = j * W + i; if (a[o] > 0) for (let k = 0; k < 3; k++) res[o * 3 + k] = c[o * 3 + k] - smooth[j * 3 + k]; }
  const levels = [{ w: W, h: H, c: res, a }];
  while (levels.at(-1).w > 16) { // いちばん粗い段は 1 画素が 22° ほど。それより遠くへは広げない
    const p = levels.at(-1), w = Math.max(1, p.w >> 1), h = Math.max(1, p.h >> 1), cc = new Float32Array(w * h * 3), aa = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0, r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        const o = Math.min(p.h - 1, j * 2 + (k >> 1)) * p.w + Math.min(p.w - 1, i * 2 + (k & 1)), wt = p.a[o];
        s += wt; r += wt * p.c[o * 3]; g += wt * p.c[o * 3 + 1]; b += wt * p.c[o * 3 + 2];
      }
      const o = j * w + i; aa[o] = Math.min(1, s);
      if (s > 0) { cc[o * 3] = r / s; cc[o * 3 + 1] = g / s; cc[o * 3 + 2] = b / s; }
    }
    levels.push({ w, h, c: cc, a: aa });
  }
  { const top = levels.at(-1); for (let o = 0; o < top.a.length; o++) { for (let k = 0; k < 3; k++) top.c[o * 3 + k] *= top.a[o]; top.a[o] = 1; } } // 絵から遠い所は差 0（高さごとの色そのもの）へ戻す
  const rough = [0, 0, 0], roughN = [0, 0, 0]; // 絵の細かさ：細かい方から 3 段ぶんの、粗い絵との差
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], p = levels[l + 1];
    for (let j = 0; j < f.h; j++) {
      const y = Math.max(0, Math.min(p.h - 1, (j + 0.5) / 2 - 0.5)), y0 = Math.floor(y), y1 = Math.min(p.h - 1, y0 + 1), ty = y - y0;
      for (let i = 0; i < f.w; i++) {
        const x = (i + 0.5) / 2 - 0.5, xf = Math.floor(x), tx = x - xf, x0 = ((xf % p.w) + p.w) % p.w, x1 = (x0 + 1) % p.w;
        const o = j * f.w + i, wt = f.a[o];
        for (let k = 0; k < 3; k++) {
          const up = (p.c[(y0 * p.w + x0) * 3 + k] * (1 - tx) + p.c[(y0 * p.w + x1) * 3 + k] * tx) * (1 - ty) + (p.c[(y1 * p.w + x0) * 3 + k] * (1 - tx) + p.c[(y1 * p.w + x1) * 3 + k] * tx) * ty;
          if (l < 3 && k === 1 && wt > 0.99) { rough[l] += (f.c[o * 3 + k] - up) ** 2; roughN[l]++; }
          f.c[o * 3 + k] = f.c[o * 3 + k] * wt + up * (1 - wt);
        }
        f.a[o] = 1;
      }
    }
  }
  const rgb = new Float32Array(n * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const o = j * W + i; for (let k = 0; k < 3; k++) rgb[o * 3 + k] = smooth[j * 3 + k] + res[o * 3 + k]; }
  return { W, H, rgb, rough: Math.sqrt(rough.reduce((s, r, l) => s + (roughN[l] ? r / roughN[l] : 0), 0)) };
}

/** 地図（{ W, H, rgb か rgba, a }）を、方位 u（0〜1）・高さ v（0 = 上端、1 = 下端）で双線形に読む。out = [r, g, b, a] */
export function sampleMap(map, u, v, out) {
  const { W, H } = map, x = u * W - 0.5, y = Math.max(0, Math.min(H - 1, v * H - 0.5));
  const xf = Math.floor(x), tx = x - xf, x0 = ((xf % W) + W) % W, x1 = (x0 + 1) % W, y0 = Math.floor(y), y1 = Math.min(H - 1, y0 + 1), ty = y - y0;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  const o00 = y0 * W + x0, o10 = y0 * W + x1, o01 = y1 * W + x0, o11 = y1 * W + x1;
  if (map.rgba) { // 8bit の層（AI の空）：色は不透明度で重みを付ける
    const d = map.rgba, a00 = d[o00 * 4 + 3] / 255 * w00, a10 = d[o10 * 4 + 3] / 255 * w10, a01 = d[o01 * 4 + 3] / 255 * w01, a11 = d[o11 * 4 + 3] / 255 * w11, s = a00 + a10 + a01 + a11;
    out[3] = s;
    for (let k = 0; k < 3; k++) out[k] = s > 0 ? (d[o00 * 4 + k] * a00 + d[o10 * 4 + k] * a10 + d[o01 * 4 + k] * a01 + d[o11 * 4 + k] * a11) / s : 0;
    return out;
  }
  const c = map.rgb;
  if (!map.a) { for (let k = 0; k < 3; k++) out[k] = c[o00 * 3 + k] * w00 + c[o10 * 3 + k] * w10 + c[o01 * 3 + k] * w01 + c[o11 * 3 + k] * w11; out[3] = 1; return out; }
  const a00 = map.a[o00] * w00, a10 = map.a[o10] * w10, a01 = map.a[o01] * w01, a11 = map.a[o11] * w11, s = a00 + a10 + a01 + a11;
  out[3] = s;
  for (let k = 0; k < 3; k++) out[k] = s > 0 ? (c[o00 * 3 + k] * a00 + c[o10 * 3 + k] * a10 + c[o01 * 3 + k] * a01 + c[o11 * 3 + k] * a11) / s : 0;
  return out;
}

/** 絵の地図に AI の層を重ねた地図（絵が上）を作る。AI の層が無ければ絵の地図をそのまま返す。 */
export function withAi(map, ai) {
  if (!ai) return map;
  const { W, H } = map, n = W * H, rgb = new Float32Array(n * 3), a = new Float32Array(n), s = [0, 0, 0, 0];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const o = j * W + i, wa = map.a[o];
    sampleMap(ai, (i + 0.5) / W, (j + 0.5) / H, s);
    const wb = (1 - wa) * Math.min(1, s[3]), t = wa + wb;
    a[o] = t;
    if (t > 0) for (let k = 0; k < 3; k++) rgb[o * 3 + k] = (map.rgb[o * 3 + k] * wa + s[k] * wb) / t;
  }
  return { W, H, rgb, a, src: map.src };
}

// ---- 粒の並び ----
/** 天球の粒の向き。高さごとの輪に、ほぼ等間隔（step 度）で並べる。戻り値：{ n, dir（Float32Array n×3）, u, v（地図を読む位置） } */
export function domeDirections(stepDeg) {
  const rings = [];
  let n = 0;
  for (let el = EL_MIN + stepDeg / 2; el < 90; el += stepDeg) { const count = Math.max(1, Math.round(360 * Math.cos(el * RAD) / stepDeg)); rings.push({ el, count }); n += count; }
  const dir = new Float32Array(n * 3), u = new Float32Array(n), v = new Float32Array(n), d = [0, 0, 0];
  let k = 0;
  rings.forEach(({ el, count }, r) => {
    for (let i = 0; i < count; i++, k++) {
      const az = (i + (r & 1 ? 0.5 : 0)) / count; // 隣の輪と半分ずらす
      dirOf(az * 2 * Math.PI, el * RAD, d); dir.set(d, k * 3);
      u[k] = az % 1; v[k] = 0.5 - el / 180;
    }
  });
  return { n, dir, u, v, step: stepDeg };
}

// 向きから決まるなめらかな乱数（-1〜1）。埋めた所に、絵と同じくらいの色のムラを足すのに使う。
function hash(x, y, z) { let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), s = (t) => t * t * (3 - 2 * t), tx = s(x - xi), ty = s(y - yi), tz = s(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(hash(xi, yi, zi), hash(xi + 1, yi, zi), tx), l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), tx), ty),
    l(l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), tx), l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), tx), ty), tz) * 2 - 1;
}
export const skyNoise = (dx, dy, dz) => 0.6 * noise3(dx * 40, dy * 40, dz * 40) + 0.4 * noise3(dx * 130 + 7, dy * 130 + 3, dz * 130 + 5);

/**
 * 天球の粒の色を決める。
 *   map   絵の地図（buildSkyMap）  ai  AI の層（{ W, H, rgba } か null）  fill  ツール内で埋めた空（fillSky か null）
 *   mottle 埋めた所に足すムラ（0〜2。1 で絵と同じくらい）
 * 戻り値：{ color（Uint8Array n×3、sRGB）, from（Uint8Array n。0 = 穴、1 = 絵、2 = AI、3 = ツール内）, view（Uint8Array n。絵の視点の番号 + 1）, counts }
 */
export function colorDome(dome, { map, ai = null, fill = null, mottle = 1 }) {
  const { n, u, v, dir } = dome, color = new Uint8Array(n * 3), from = new Uint8Array(n), view = new Uint8Array(n);
  const s = [0, 0, 0, 0], t = [0, 0, 0, 0], f = [0, 0, 0, 0], counts = [0, 0, 0, 0];
  const amp = fill ? fill.rough * mottle : 0;
  for (let i = 0; i < n; i++) {
    sampleMap(map, u[i], v[i], s);
    const wa = Math.min(1, s[3]);
    let wb = 0;
    if (ai && wa < 1) { sampleMap(ai, u[i], v[i], t); wb = (1 - wa) * Math.min(1, t[3]); }
    const wf = 1 - wa - wb;
    let r = s[0] * wa + t[0] * wb, g = s[1] * wa + t[1] * wb, b = s[2] * wa + t[2] * wb, total = wa + wb;
    if (fill && wf > 0.001) {
      sampleMap(fill, u[i], v[i], f);
      const j = amp ? skyNoise(dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2]) * amp * 1.6 : 0;
      r += (f[0] + j) * wf; g += (f[1] + j) * wf; b += (f[2] + j) * wf; total = 1;
    }
    const we = fill ? wf : 0, kind = total < 0.5 ? 0 : wa >= wb && wa >= we ? 1 : wb >= we ? 2 : 3;
    from[i] = kind; counts[kind]++;
    if (!kind) continue;
    color[i * 3] = Math.max(0, Math.min(255, r / total)); color[i * 3 + 1] = Math.max(0, Math.min(255, g / total)); color[i * 3 + 2] = Math.max(0, Math.min(255, b / total));
    if (kind === 1) view[i] = map.src[Math.min(map.H - 1, Math.floor(v[i] * map.H)) * map.W + Math.min(map.W - 1, Math.floor(u[i] * map.W))];
  }
  return { color, from, view, counts };
}

// ---- AI に描いてもらう向き（4 枚で上半分を覆う） ----
// 縦長の絵 4 枚。水平に 90° ずつ回し、30° 見上げる。横の画角 104°（縦は約 125°）で、隣どうしと天頂が重なる。
export const FACE = { w: 1024, h: 1536, pitch: 30, hfov: 104, count: 4 };
export function faceCamera(k) {
  const yaw = k * 90 * RAD, p = FACE.pitch * RAD, f = FACE.w / 2 / Math.tan(FACE.hfov / 2 * RAD);
  const fwd = dirOf(yaw, p, [0, 0, 0]), right = [-Math.cos(yaw), 0, Math.sin(yaw)]; // 右手系で +Y が上、+Z を向くと右は -X
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]]; // 上 = 右 × 前
  return { fwd, right, up, f, w: FACE.w, h: FACE.h, name: `方位 ${k * 90}°`, yawDeg: k * 90 };
}
const faceDir = (cam, x, y, out) => {
  const a = (x + 0.5 - cam.w / 2) / cam.f, b = -(y + 0.5 - cam.h / 2) / cam.f, l = Math.hypot(a, b, 1);
  for (let k = 0; k < 3; k++) out[k] = (cam.right[k] * a + cam.up[k] * b + cam.fwd[k]) / l;
  return out;
};
const uvOf = (d, out) => { let az = Math.atan2(d[0], d[2]) / (2 * Math.PI); if (az < 0) az += 1; out[0] = az; out[1] = 0.5 - Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI; return out; };

/**
 * 向き k の絵を作る。known = 絵（と、これまでの AI の層）を重ねた地図、fill = ツール内で埋めた空。
 * 戻り値：{ image（RGBA。穴の所はツール内で埋めた色）, mask（RGBA。白 = 穴 = AI に描いてほしい所）, holes（穴の割合 0〜1） }
 */
export function renderFace(k, known, fill) {
  const cam = faceCamera(k), { w, h } = cam, image = new Uint8ClampedArray(w * h * 4), mask = new Uint8ClampedArray(w * h * 4);
  const d = [0, 0, 0], uv = [0, 0], s = [0, 0, 0, 0], f = [0, 0, 0, 0];
  let holes = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    uvOf(faceDir(cam, x, y, d), uv);
    sampleMap(known, uv[0], uv[1], s); sampleMap(fill, uv[0], uv[1], f);
    const wa = Math.min(1, s[3]), o = (y * w + x) * 4, hole = wa < 0.98;
    for (let c = 0; c < 3; c++) image[o + c] = s[c] * wa + f[c] * (1 - wa);
    image[o + 3] = 255;
    mask[o] = mask[o + 1] = mask[o + 2] = hole ? 255 : 0; mask[o + 3] = 255;
    if (hole) holes++;
  }
  return { image, mask, holes: holes / (w * h), cam };
}

/** 向き k の絵のうち、穴の割合（0〜1）。粗く数える（頼む前に、何枚ぶん頼むことになるかを見せる用）。 */
export function faceHoles(k, known, every = 8) {
  const cam = faceCamera(k), d = [0, 0, 0], uv = [0, 0], s = [0, 0, 0, 0];
  let holes = 0, n = 0;
  for (let y = every >> 1; y < cam.h; y += every) for (let x = every >> 1; x < cam.w; x += every, n++) {
    uvOf(faceDir(cam, x, y, d), uv); sampleMap(known, uv[0], uv[1], s);
    if (s[3] < 0.98) holes++;
  }
  return holes / n;
}

/** 描いてもらった向き k の絵（RGBA）を、AI の層（{ W, H, rgba }）に貼る。mask が白の所だけ。 */
export function pasteFace(ai, k, painted, mask) {
  const cam = faceCamera(k), { w, h, f } = cam, { W, H, rgba } = ai, d = [0, 0, 0];
  const cosHalf = Math.cos(Math.atan(Math.hypot(w, h) / 2 / f) + 0.01);
  let pasted = 0;
  for (let j = 0; j < H; j++) {
    const el = (0.5 - (j + 0.5) / H) * Math.PI;
    for (let i = 0; i < W; i++) {
      dirOf((i + 0.5) / W * 2 * Math.PI, el, d);
      const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
      if (z < cosHalf) continue;
      const x = (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2]) / z * f + w / 2 - 0.5;
      const y = -(d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2]) / z * f + h / 2 - 0.5;
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue;
      const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), tx = x - x0, ty = y - y0;
      if (mask[(Math.round(y) * w + Math.round(x)) * 4] < 128) continue;
      const o = (j * W + i) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[o + c] = (painted[(y0 * w + x0) * 4 + c] * (1 - tx) + painted[(y0 * w + x1) * 4 + c] * tx) * (1 - ty) + (painted[(y1 * w + x0) * 4 + c] * (1 - tx) + painted[(y1 * w + x1) * 4 + c] * tx) * ty;
      }
      rgba[o + 3] = 255; pasted++;
    }
  }
  return pasted;
}
