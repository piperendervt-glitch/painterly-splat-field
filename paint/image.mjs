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
