#!/usr/bin/env node
// にせの「別視点の絵を生成するモデル」。paint/nvs.mjs の約束どおりに呼ばれるかを確かめるための物で、
// 仕事の中身を調べ、穴を鏡写しで埋めた絵を返す（GPU もモデルも要らない。絵の出来を見るための物ではない）。
// 使い方：PSF_NVS=paint/test/fake-nvs.sh で道具を起動して、「別視点の絵を生成するモデルで埋める」を押す。
import fs from 'node:fs';
import { readPng, writePng } from '../image.mjs';
import { mirrorFill } from './mirrorfill.mjs';
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fail = (m) => { console.error(m); process.exit(3); };
const k = job.source_intrinsics;
if (!fs.existsSync(job.source_image)) fail('source_image がありません');
if (!k || !(k.fx > 0) || !k.width || !k.height) fail('source_intrinsics がありません');
const npy = fs.readFileSync(job.source_depth);
if (npy.toString('latin1', 1, 6) !== 'NUMPY' || !npy.toString('latin1', 10, 120).includes(`(${k.height}, ${k.width})`)) fail('source_depth が (高さ, 幅) の .npy ではありません');
if (!Array.isArray(job.targets) || !job.targets.length) fail('targets がありません');
for (const t of job.targets) {
  const m = t.c2w; if (!Array.isArray(m) || m.length !== 4 || m.some((r) => r.length !== 4)) fail('c2w が 4×4 ではありません');
  // 回転の部分が直交で、行列式が +1 か（向きの取り違えを見つける）
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det - 1) > 1e-3) fail(`c2w の回転がおかしい（行列式 ${det}）`);
  const yaw = Math.atan2(m[0][2], m[2][2]) * 180 / Math.PI;
  console.log(`fake-nvs: ${t.name} model=${job.model || '(default)'} 位置 ${m.map((r) => r[3]).slice(0, 3).map((x) => x.toFixed(2)).join(', ')} 右へ ${yaw.toFixed(1)}°`);
  writePng(t.out, mirrorFill(readPng(t.render)));
}
console.log('done');
