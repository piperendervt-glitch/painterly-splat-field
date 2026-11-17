#!/usr/bin/env node
// にせの codex。実物の代わりに、条件の絵を少し色を変えて result.png に置く（大きさはわざと変える）。
import fs from 'node:fs';
import { readPng, writePng, resize } from '../image.mjs';
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  if (process.argv[2] !== 'exec') process.exit(3);
  if (process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY が渡された'); process.exit(4); }
  fs.writeFileSync('fake-saw-prompt.txt', prompt);
  const src = fs.existsSync('references/holes.png') ? 'references/holes.png' : 'references/previz.png';
  const img = readPng(src);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 255) img.data.set([40, 160, 60], i);
    else { img.data[i] = Math.min(255, img.data[i] + 20); }
  }
  writePng('result.png', resize(img, 1024, 1024));
  console.log('done');
});
