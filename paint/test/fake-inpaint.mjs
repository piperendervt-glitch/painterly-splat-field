#!/usr/bin/env node
// にせの「PC の生成モデル」。paint/localinpaint.mjs の約束どおりに呼ばれ、穴を鏡写しで埋める（GPU もモデルも要らない）。
// 使い方：PSF_INPAINT=paint/test/fake-inpaint.sh で道具を起動して、「PC の生成モデルで描き足す」を押す。
import fs from 'node:fs';
import { readPng, writePng } from '../image.mjs';
import { mirrorFill } from './mirrorfill.mjs';
const [holes, out, jobFile] = process.argv.slice(2);
if (!holes || !out || !jobFile) { console.error('usage: fake-inpaint <holes.png> <out.png> <job.json>'); process.exit(2); }
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
if (typeof job.style !== 'string' || !job.width || !job.height) { console.error('job.json に style / width / height がありません'); process.exit(3); }
console.log(`fake-inpaint: ${job.width}x${job.height} model=${job.model || '(default)'}`);
if (job.init) { // 仕上げ：渡された絵をそのまま返す（強さの値だけ確かめる）
  if (!(job.strength > 0 && job.strength <= 1)) { console.error('strength が 0〜1 ではありません'); process.exit(3); }
  console.log(`fake-inpaint: 仕上げ strength=${job.strength}`);
  writePng(out, readPng(job.init));
} else writePng(out, mirrorFill(readPng(holes)));
console.log('done');
