#!/usr/bin/env node
// 確かめ用の、にせの SAM 3（PSF_SEG="node paint/test/fake-sam3.mjs"）。本物の切り抜きはしない。
// 仕事.json の image（…/paint-out/J_painted.png）の場面の、今の物体の絵（…/previz-export/J_objects.png）から、
// 大きい物体を 6 個と、四角い「umbrella」を 1 個、切り抜きとして書く。
import fs from 'node:fs';
import path from 'node:path';
import { readPng, writePng } from '../image.mjs';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const objPng = path.join(path.dirname(job.image), '..', 'previz-export', 'J_objects.png');
const img = readPng(objPng), W = img.width, H = img.height, id = new Uint16Array(W * H), cnt = new Map();
for (let i = 0; i < W * H; i++) { id[i] = img.data[i * 4] + img.data[i * 4 + 1] * 256; if (id[i]) cnt.set(id[i], (cnt.get(id[i]) || 0) + 1); }
const top = [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
const mask = (fn) => { const d = new Uint8Array(W * H * 4); let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let i = 0; i < W * H; i++) { const on = fn(i); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = on ? 255 : 0; d[i * 4 + 3] = 255; if (on) { const x = i % W, y = (i - x) / W; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } } return { img: { width: W, height: H, data: d }, bbox: [x0, y0, x1, y1] }; };
fs.mkdirSync(job.out_dir, { recursive: true });
const inst = [];
top.forEach((k, n) => { const m = mask((i) => id[i] === k), name = `mask_${String(n).padStart(3, '0')}.png`; writePng(path.join(job.out_dir, name), m.img); inst.push({ label: n === 0 ? 'tree' : 'person', score: +(0.95 - n * 0.05).toFixed(2), bbox: m.bbox, mask: name }); });
const box = mask((i) => { const x = i % W, y = (i - x) / W; return x >= 300 && x < 420 && y >= 600 && y < 700; });
writePng(path.join(job.out_dir, 'mask_100.png'), box.img); inst.push({ label: 'umbrella', score: 0.7, bbox: box.bbox, mask: 'mask_100.png' });
fs.writeFileSync(path.join(job.out_dir, 'instances.json'), JSON.stringify({ width: W, height: H, instances: inst }, null, 1));
console.log(`fake sam3: ${inst.length} instances (prompts: ${(job.prompts || []).join(',')})`);
