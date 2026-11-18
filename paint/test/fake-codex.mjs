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
  if (/write a file named layout\.json/.test(prompt)) { // 形の配置：最初は箱 2 つと円柱 1 つ。直しの回は、今の配置を少し動かして 1 つ足す
    const prev = fs.existsSync('references/layout.json') ? JSON.parse(fs.readFileSync('references/layout.json', 'utf8')) : null;
    const objects = prev ? [...prev.objects.map((b) => ({ ...b, center: [b.center[0], b.center[1], b.center[2] + 1] })), { name: 'added', shape: 'box', center: [-6, 0.5, 20], size: [1, 1, 1], yaw_deg: 30 }]
      : [{ name: 'Left Leg', shape: 'box', center: [-9, 15, 46], size: [6, 30, 6], yaw_deg: 0 }, { name: 'right_leg', shape: 'box', center: [9, 15, 46], size: [6, 30, 6] }, { name: 'tower', shape: 'cylinder', center: [0, 30, 120], radius: 6, height: 60 }, { name: 'broken', shape: 'box', center: [0, 'x', 1] }];
    fs.writeFileSync('layout.json', '```json\n' + JSON.stringify({ objects }) + '\n```\n');
    console.log('done');
    return;
  }
  const src = fs.existsSync('references/holes.png') ? 'references/holes.png' : 'references/previz.png';
  const img = readPng(src);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 255) img.data.set([40, 160, 60], i);
    else { img.data[i] = Math.min(255, img.data[i] + 20); }
  }
  writePng('result.png', resize(img, 1024, 1024));
  console.log('done');
});
