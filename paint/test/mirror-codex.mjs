#!/usr/bin/env node
// にせの codex その 2。穴（マゼンタ）を、同じ行のいちばん近い描いてある所を鏡写しにして埋める。
// 絵らしい模様が入るので、利用枠を使わずに「描き足した絵の奥行きを推定して合わせる」流れを確かめられる。
// 使い方：PAINT_CODEX=paint/test/mirror-codex.sh で道具を起動する。
import fs from 'node:fs';
import { readPng, writePng } from '../image.mjs';
import { mirrorFill } from './mirrorfill.mjs';
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  if (process.argv[2] !== 'exec') process.exit(3);
  if (process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY が渡された'); process.exit(4); }
  fs.writeFileSync('fake-saw-prompt.txt', prompt);
  const filled = mirrorFill(readPng('references/holes.png'));
  writePng('result.png', filled);
  console.log('done');
});
