// 奥行き推定（Depth Anything V2 Small、Apache-2.0）。絵から「近さ」（視差。尺度とずれは不明、大きいほど近い）を得る。
// モデルは初回に GitHub から取得して models/ に置く（約 95 MB）。build.mjs（絵から場面を作る）と depth.mjs（足した視点の奥行き）が使う。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_URL = 'https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx';

async function model() {
  const file = path.join(HERE, 'models', 'depth_anything_v2_vits.onnx');
  if (!fs.existsSync(file)) {
    console.log('奥行き推定モデルを取得します（約 95 MB、初回のみ）…');
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`モデルを取得できませんでした: ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

// 視差（大きいほど近い）を W×H で返す。img は sharp の絵（RGB）。
export async function disparity(img, W, H) {
  const S = 518;
  const small = await img.clone().resize(S, S, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
  const x = new Float32Array(3 * S * S), mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) x[c * S * S + i] = (small[i * 3 + c] / 255 - mean[c]) / std[c];
  const session = await ort.InferenceSession.create(await model());
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const d = out[session.outputNames[0]].data, up = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(S - 1.001, Math.max(0, (y + 0.5) * S / H - 0.5)), y0 = fy | 0, ty = fy - y0;
    for (let xx = 0; xx < W; xx++) {
      const fx = Math.min(S - 1.001, Math.max(0, (xx + 0.5) * S / W - 0.5)), x0 = fx | 0, tx = fx - x0, i = y0 * S + x0;
      up[y * W + xx] = (d[i] * (1 - tx) + d[i + 1] * tx) * (1 - ty) + (d[i + S] * (1 - tx) + d[i + S + 1] * tx) * ty;
    }
  }
  return up;
}
