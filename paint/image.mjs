// PNG の読み書きと、比べるための簡単な絵の加工（外の道具に頼らない）。
import fs from 'node:fs';
import { PNG } from 'pngjs';

/** { width, height, data: Uint8Array RGBA } */
export function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

export function writePng(file, img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  fs.writeFileSync(file, PNG.sync.write(png));
}

export function blank(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** 双線形で大きさを合わせる（生成された絵の大きさが頼んだ大きさと違うとき用）。 */
export function resize(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const out = blank(width, height);
  const sx = img.width / width, sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c], b = img.data[(y0 * img.width + x1) * 4 + c];
        const d = img.data[(y1 * img.width + x0) * 4 + c], e = img.data[(y1 * img.width + x1) * 4 + c];
        out.data[(y * width + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return out;
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** 明るさの輪郭の強さ（0〜1）。Sobel。 */
export function edges(img) {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = (xx, yy) => lum(data, (yy * w + xx) * 4);
      const gx = -p(x - 1, y - 1) - 2 * p(x - 1, y) - p(x - 1, y + 1) + p(x + 1, y - 1) + 2 * p(x + 1, y) + p(x + 1, y + 1);
      const gy = -p(x - 1, y - 1) - 2 * p(x, y - 1) - p(x + 1, y - 1) + p(x - 1, y + 1) + 2 * p(x, y + 1) + p(x + 1, y + 1);
      out[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 400);
    }
  }
  return out;
}

/**
 * 重ね合わせの確かめ用の絵：生成した絵を少し暗くして、その上にプレビズの輪郭をシアンで描く。
 * 形がずれていれば、シアンの線と絵の境目が離れて見える。
 */
export function overlay(painted, previz) {
  const e = edges(previz);
  const out = blank(painted.width, painted.height);
  for (let i = 0; i < e.length; i++) {
    const k = Math.min(1, e[i] * 2.5);
    for (let c = 0; c < 3; c++) {
      const base = painted.data[i * 4 + c] * 0.7;
      const line = c === 0 ? 0 : 255;
      out.data[i * 4 + c] = Math.round(base * (1 - k) + line * k);
    }
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** 穴の印（白い所が穴）を、0/1 の並びにする。少し太らせて、穴の縁の切れ目を隠す。 */
export function holeMask(maskImg, grow = 2) {
  const { width: w, height: h, data } = maskImg;
  let m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = (data[i * 4 + 3] > 127 && lum(data, i * 4) > 127) ? 1 : 0;
  for (let g = 0; g < grow; g++) {
    const n = m.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (m[y * w + x]) continue;
      if ((x > 0 && m[y * w + x - 1]) || (x < w - 1 && m[y * w + x + 1]) || (y > 0 && m[(y - 1) * w + x]) || (y < h - 1 && m[(y + 1) * w + x])) n[y * w + x] = 1;
    }
    m = n;
  }
  return m;
}

/** 穴をマゼンタで塗った絵（Codex に「ここだけ描いて」と見せる用）。 */
export function paintHoles(img, mask, rgb = [255, 0, 255]) {
  const out = { width: img.width, height: img.height, data: Uint8Array.from(img.data) };
  for (let i = 0; i < mask.length; i++) if (mask[i]) { out.data.set(rgb, i * 4); out.data[i * 4 + 3] = 255; }
  return out;
}

/** 穴の所だけ生成した絵に置き換える。穴の外は元の絵のまま（1 画素も変えない）。 */
export function composite(original, generated, mask) {
  const out = { width: original.width, height: original.height, data: Uint8Array.from(original.data) };
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = generated.data[i * 4 + c];
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * 穴の縁の継ぎ目をなじませる。生成した絵は、穴の外も描き直されていて、色や明るさが元の絵から少しずれる。
 * そのずれ（元の絵 − 生成した絵。点描の粒を写さないよう、ぼかした色で比べる）を穴の縁で測り、穴の内側へ radius 画素かけて薄めながら足す。
 * 返すのは、穴の中の色を直した「生成した絵」。穴の外はさわらない（composite がどうせ元の絵に戻す）。
 * 縁で生成した絵が元の絵と大きく違う所（limit を超える。描き直されて別物になっている）は、合わせずにそのままにする。
 */
export function matchSeam(original, generated, mask, { radius = 40, blur = 6, limit = 48 } = {}) {
  const w = original.width, h = original.height, n = w * h, R = Math.max(1, Math.round(radius));
  // 分かっている所だけでぼかした差（積分画像で、(2·blur+1) 四方の平均）
  const W1 = w + 1, sum = [0, 1, 2].map(() => new Float64Array(W1 * (h + 1))), cnt = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = (y + 1) * W1 + x + 1, known = mask[i] ? 0 : 1;
    cnt[k] = known + cnt[k - 1] + cnt[k - W1] - cnt[k - W1 - 1];
    for (let c = 0; c < 3; c++) sum[c][k] = (known ? original.data[i * 4 + c] - generated.data[i * 4 + c] : 0) + sum[c][k - 1] + sum[c][k - W1] - sum[c][k - W1 - 1];
  }
  const box = (a, x, y) => { const x0 = Math.max(0, x - blur), y0 = Math.max(0, y - blur), x1 = Math.min(w, x + blur + 1), y1 = Math.min(h, y + blur + 1); return a[y1 * W1 + x1] - a[y0 * W1 + x1] - a[y1 * W1 + x0] + a[y0 * W1 + x0]; };
  // 穴の縁（穴のすぐ外の画素）から内側へ、いちばん近い縁の差を運ぶ（幅優先。dist = 縁からの歩数）
  const dist = new Int32Array(n).fill(-1), res = new Float32Array(n * 3);
  let queue = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i]) continue;
    if (!((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w]))) continue;
    const c = box(cnt, x, y); if (!c) continue;
    const d = [box(sum[0], x, y) / c, box(sum[1], x, y) / c, box(sum[2], x, y) / c];
    dist[i] = 0;
    if (Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) <= limit) res.set(d, i * 3); // 大きすぎる差は運ばない（0 のまま）
    queue.push(i);
  }
  const out = { width: w, height: h, data: Uint8Array.from(generated.data) };
  for (let step = 1; step <= R && queue.length; step++) {
    const next = [];
    for (const i of queue) {
      const x = i % w, y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || !mask[j] || dist[j] >= 0) continue;
        dist[j] = step; res[j * 3] = res[i * 3]; res[j * 3 + 1] = res[i * 3 + 1]; res[j * 3 + 2] = res[i * 3 + 2];
        next.push(j);
      }
    }
    queue = next;
  }
  // 運んだ差は縁ごとに段になるので、穴の中でならしてから足す（重みは縁で 1、radius で 0）
  const sm = Float32Array.from(res), tmp = new Float32Array(n * 3), k = 4; // 縁の画素（dist 0）は、測った差のまま
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? sm : res;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // 横
      const i = y * w + x; if (dist[i] < 1) continue;
      let a = 0, b = 0, c = 0, m = 0;
      for (let u = Math.max(0, x - k); u <= Math.min(w - 1, x + k); u++) { const j = y * w + u; if (dist[j] < 0) continue; a += src[j * 3]; b += src[j * 3 + 1]; c += src[j * 3 + 2]; m++; }
      tmp[i * 3] = a / m; tmp[i * 3 + 1] = b / m; tmp[i * 3 + 2] = c / m;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // 縦
      const i = y * w + x; if (dist[i] < 1) continue;
      let a = 0, b = 0, c = 0, m = 0;
      for (let v = Math.max(0, y - k); v <= Math.min(h - 1, y + k); v++) { const j = v * w + x; if (dist[j] < 1) continue; a += tmp[j * 3]; b += tmp[j * 3 + 1]; c += tmp[j * 3 + 2]; m++; }
      sm[i * 3] = a / m; sm[i * 3 + 1] = b / m; sm[i * 3 + 2] = c / m;
    }
  }
  for (let i = 0; i < n; i++) {
    if (dist[i] < 1) continue;
    const t = 1 - (dist[i] - 1) / R, wgt = t * t * (3 - 2 * t);
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(generated.data[i * 4 + c] + sm[i * 3 + c] * wgt)));
  }
  return out;
}

/** 穴の外で、生成した絵が元の絵からどれだけ変わったか（0〜255 の平均）。大きいほど、絵全体を描き直されている。 */
export function outsideChange(original, generated, mask) {
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs(original.data[i * 4 + c] - generated.data[i * 4 + c]);
    n += 3;
  }
  return n ? sum / n : 0;
}

// ガウスぼかし（縦横に分けて掛ける）。a は 1 色ぶんの Float32Array（w×h）。端は端の画素をくり返す。
function gauss(a, w, h, sigma) {
  if (!(sigma > 0)) return Float32Array.from(a);
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const t = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let i = -r; i <= r; i++) v += a[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]; t[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let i = -r; i <= r; i++) v += t[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]; out[y * w + x] = v; }
  return out;
}
const channels = (img) => [0, 1, 2].map((c) => { const a = new Float32Array(img.width * img.height); for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + c]; return a; });

/**
 * 点描の細かさの目安：灰色にした絵と、それを 2 画素ぼかした絵の差の平均（0〜255）。mask（1 の所だけ測る）は無くてもよい。
 * 点描の絵は 5〜6、ぼけた絵や写真のようになめらかな絵は 1〜3 になる。
 */
export function dotTexture(img, mask = null) {
  const w = img.width, h = img.height, g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  const b = gauss(g, w, h, 2); let sum = 0, n = 0;
  for (let i = 0; i < g.length; i++) if (!mask || mask[i]) { sum += Math.abs(g[i] - b[i]); n++; }
  return n ? sum / n : 0;
}

/**
 * 絵 base の mask の所（1 = 穴）に、見本の絵 source の「点の細かさ」だけを足す（生成モデルは使わない）。
 * 別視点のモデルの絵や、ぼかして埋めた絵は、配置は合っていても点描になっていない。そこへ、もとの絵の点の層を足してから
 * PC の画像生成モデルで弱く描き直すと、配置を保ったまま点描に戻る（強く描き直すと配置が変わり、弱いだけだとなめらかなまま）。
 *   点の層 = source −（source を sigma 画素ぼかした絵）。色ごと、正負あり。平均は 0 なので、足しても色は変わらない。
 *   source を tile 画素四方の区画に切り（左上は grid 画素おき）、exclude（1 = 使わない。人や空）を含まない区画だけを候補にする。
 *   base を tile 画素の升目に分け、升ごとに候補から candidates 個を無作為に引き、ぼかした色が升の色にいちばん近い区画の点の層を足す
 *   （芝には芝の点、水には水の点が来やすい）。
 *   形の入った区画（影の縁、枝、ひび）は候補から外す（keep = 残す割合）。
 *   結果 =（base を pre 画素ぼかした絵）+ gain × 点の層。穴の外は変えない。
 * 返すもの：{ image, tiles（候補の区画の数） }
 */
export function stipple(base, mask, source, { exclude = null, tile = 48, grid = 8, sigma = 2, pre = 1.2, gain = 1.1, candidates = 8, keep = 0.5, seed = 0 } = {}) {
  const w = base.width, h = base.height, sw = source.width, sh = source.height;
  if (sw < tile || sh < tile) throw new Error(`点の見本の絵が小さすぎます（${sw}x${sh}）`);
  const src = channels(source), low = src.map((a) => gauss(a, sw, sh, sigma));
  // 候補の区画：使わない画素を含まないもの。区画のぼかした色の平均も持つ
  const W1 = sw + 1, bad = new Float64Array(W1 * (sh + 1)), sums = low.map(() => new Float64Array(W1 * (sh + 1)));
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = y * sw + x, k = (y + 1) * W1 + x + 1;
    bad[k] = (exclude && exclude[i] ? 1 : 0) + bad[k - 1] + bad[k - W1] - bad[k - W1 - 1];
    for (let c = 0; c < 3; c++) sums[c][k] = low[c][i] + sums[c][k - 1] + sums[c][k - W1] - sums[c][k - W1 - 1];
  }
  const box = (a, x, y) => a[(y + tile) * W1 + x + tile] - a[y * W1 + x + tile] - a[(y + tile) * W1 + x] + a[y * W1 + x];
  const tiles = [];
  for (let y = 0; y + tile <= sh; y += grid) for (let x = 0; x + tile <= sw; x += grid) if (!box(bad, x, y)) tiles.push([x, y, box(sums[0], x, y) / (tile * tile), box(sums[1], x, y) / (tile * tile), box(sums[2], x, y) / (tile * tile)]);
  if (!tiles.length) throw new Error('点の見本にできる区画がありません（人や空を除くと、何も残りません）');
  // 形の入った区画（影の縁、枝、絵のひび）を外す：点の層に線が混ざると、足した所に線の切れ端が出る。
  //   区画ごとに、ぼかした明るさのばらつき（大きな形）と、点の層の飛び抜けた画素の割合（細い線）を測り、合わせた点数の低い順に keep の割合だけ残す
  if (keep < 1 && tiles.length > 20) {
    const grey = (a, i) => 0.299 * a[0][i] + 0.587 * a[1][i] + 0.114 * a[2][i];
    let all = 0; for (let i = 0; i < sw * sh; i++) all += Math.abs(grey(src, i) - grey(low, i));
    const lim = 3 * all / (sw * sh), sd = new Float32Array(tiles.length), out2 = new Float32Array(tiles.length);
    tiles.forEach((t, k) => {
      let m = 0, m2 = 0, far = 0;
      for (let y = t[1]; y < t[1] + tile; y++) for (let x = t[0]; x < t[0] + tile; x++) { const i = y * sw + x, g = grey(low, i); m += g; m2 += g * g; if (Math.abs(grey(src, i) - g) > lim) far++; }
      m /= tile * tile; sd[k] = Math.sqrt(Math.max(0, m2 / (tile * tile) - m * m)); out2[k] = far / (tile * tile);
    });
    const med = (a) => { const b = Float32Array.from(a).sort(); return b[b.length >> 1] || 1e-6; }, ms = med(sd), mo = med(out2);
    const order = tiles.map((t, k) => [sd[k] / ms + out2[k] / mo, t]).sort((p, q) => p[0] - q[0]);
    tiles.length = 0; for (let k = 0; k < Math.max(20, Math.round(order.length * keep)); k++) tiles.push(order[k][1]);
  }
  let state = (seed >>> 0) + 0x9e3779b9;
  const rand = () => { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const b = channels(base), soft = b.map((a) => gauss(a, w, h, pre));
  const out = { width: w, height: h, data: Uint8Array.from(base.data) };
  for (let cy = 0; cy < h; cy += tile) for (let cx = 0; cx < w; cx += tile) {
    const x1 = Math.min(w, cx + tile), y1 = Math.min(h, cy + tile); let any = 0; const mean = [0, 0, 0];
    for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) { const i = y * w + x; if (mask[i]) { any++; mean[0] += soft[0][i]; mean[1] += soft[1][i]; mean[2] += soft[2][i]; } }
    if (!any) continue;
    let best = null, bd = Infinity;
    for (let k = 0; k < Math.max(1, candidates); k++) { const t = tiles[Math.floor(rand() * tiles.length)], d = (t[2] - mean[0] / any) ** 2 + (t[3] - mean[1] / any) ** 2 + (t[4] - mean[2] / any) ** 2; if (d < bd) { bd = d; best = t; } }
    for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
      const i = y * w + x; if (!mask[i]) continue;
      const j = (best[1] + y - cy) * sw + best[0] + x - cx;
      for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(soft[c][i] + gain * (src[c][j] - low[c][j]))));
      out.data[i * 4 + 3] = 255;
    }
  }
  return { image: out, tiles: tiles.length };
}
