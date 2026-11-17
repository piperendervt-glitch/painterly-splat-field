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
