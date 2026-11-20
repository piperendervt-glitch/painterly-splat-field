// 絵 1 枚の「近さ」（視差）を推定して、16bit の絵に書き出す。「視点を足す」で、描き足した絵の奥行きを決めるのに使う（studio/dream.js の alignDepth）。
//   node depth.mjs --image <絵.png> --out <近さ.png>
// 出力：R = 上の桁、G = 下の桁（0〜65535。絵の中でいちばん遠い所が 0、いちばん近い所が 65535）。尺度とずれは、読む側で合わせる。
import sharp from 'sharp';
import { disparity } from './depthmodel.mjs';

const v = process.argv.slice(2), a = {};
for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
if (!a.image || !a.out) { console.error('使い方：node depth.mjs --image <絵.png> --out <近さ.png>'); process.exit(1); }

const started = Date.now();
const img = sharp(a.image).removeAlpha().toColourspace('srgb'), { width: W, height: H } = await img.metadata();
console.log(`奥行きを推定しています（${W}x${H}）`);
const d = await disparity(img, W, H);
let lo = Infinity, hi = -Infinity; for (let i = 0; i < d.length; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
const out = Buffer.alloc(W * H * 3), k = hi > lo ? 65535 / (hi - lo) : 0;
for (let i = 0; i < W * H; i++) { const q = Math.round((d[i] - lo) * k); out[i * 3] = q >> 8; out[i * 3 + 1] = q & 255; }
await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(a.out);
console.log(`  → ${a.out}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
