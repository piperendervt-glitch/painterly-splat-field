// にせの codex で、views と fill の流れを確かめる（Codex も利用枠も使わない）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng, blank } from '../image.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const paint = path.join(here, '..', 'paint.mjs');
const fake = path.join(here, 'fake-codex.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-test-'));
const run = (...args) => execFileSync(process.execPath, [paint, ...args], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'sk-should-not-pass' } });

// 小さなプレビズの書き出しを作る
const inDir = path.join(tmp, 'previz');
fs.mkdirSync(inDir);
const W = 64, H = 96;
const views = [];
for (const name of ['A', 'B']) {
  const img = blank(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.data.set([x * 4, y * 2, name === 'A' ? 50 : 200, 255], (y * W + x) * 4);
  writePng(path.join(inDir, `${name}_color.png`), img);
  writePng(path.join(inDir, `${name}_depth_view.png`), img);
  writePng(path.join(inDir, `${name}_flat.png`), img);
  views.push({ name, color: `${name}_color.png`, depth_view: `${name}_depth_view.png`, flat: `${name}_flat.png`, lit: `${name}_lit.png`, width: W, height: H });
}
fs.writeFileSync(path.join(inDir, 'cameras.json'), JSON.stringify({ views }));

// views（dry-run）：Codex を呼ばずに文だけ
const dryOut = path.join(tmp, 'dry');
run('views', '--in', inDir, '--out', dryOut, '--codex', '/nonexistent/codex', '--dry-run');
const dryWork = fs.readdirSync(path.join(dryOut, 'work'));
assert.ok(fs.existsSync(path.join(dryOut, 'work', dryWork[0], 'A', 'prompt.txt')));
assert.ok(!fs.existsSync(path.join(dryOut, 'A_painted.png')));
console.log('ok dry-run は Codex を呼ばない');

// views：にせの codex で 2 視点
const out = path.join(tmp, 'out');
run('views', '--in', inDir, '--out', out, '--codex', fake);
for (const v of ['A', 'B']) {
  const p = readPng(path.join(out, `${v}_painted.png`));
  assert.equal(p.width, W); assert.equal(p.height, H);
  assert.ok(fs.existsSync(path.join(out, `${v}_overlay.png`)));
}
const work = path.join(out, 'work', fs.readdirSync(path.join(out, 'work'))[0]);
const promptB = fs.readFileSync(path.join(work, 'B', 'fake-saw-prompt.txt'), 'utf8');
assert.match(promptB, /style\.png/);
assert.ok(fs.existsSync(path.join(work, 'B', 'references', 'style.png')));
assert.doesNotMatch(fs.readFileSync(path.join(work, 'A', 'prompt.txt'), 'utf8'), /style\.png/);
console.log('ok views：大きさを合わせ、2 枚目に 1 枚目を画風の見本として渡す。API キーは渡さない');

// views --light：下絵と出すファイルの名前が替わり、光の指示が入る。下絵が無ければ止まる
const flatOut = path.join(tmp, 'flat');
run('views', '--in', inDir, '--out', flatOut, '--codex', fake, '--views', 'A', '--light', 'flat');
assert.ok(fs.existsSync(path.join(flatOut, 'A_painted_flat.png')) && fs.existsSync(path.join(flatOut, 'A_overlay_flat.png')));
assert.ok(!fs.existsSync(path.join(flatOut, 'A_painted.png')));
const flatWork = path.join(flatOut, 'work', fs.readdirSync(path.join(flatOut, 'work'))[0]);
assert.match(fs.readFileSync(path.join(flatWork, 'A', 'prompt.txt'), 'utf8'), /shadowless light/);
assert.doesNotMatch(fs.readFileSync(path.join(flatWork, 'A', 'prompt.txt'), 'utf8'), /late-afternoon/);
assert.doesNotMatch(fs.readFileSync(path.join(work, 'A', 'prompt.txt'), 'utf8'), /LIGHTING/);
assert.throws(() => run('views', '--in', inDir, '--out', path.join(tmp, 'lit'), '--codex', fake, '--light', 'previz', '--dry-run'), /Command failed/);
console.log('ok views --light：flat は _flat の下絵と名前で出す。下絵が無い previz は止まる');

// fill：穴の外は 1 画素も変わらない
const img = readPng(path.join(inDir, 'A_color.png'));
const mask = blank(W, H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask.data.set((x > 20 && x < 40 && y > 30 && y < 60) ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * W + x) * 4);
writePng(path.join(tmp, 'mask.png'), mask);
const filled = path.join(tmp, 'fill', 'A_filled.png');
fs.mkdirSync(path.dirname(filled));
run('fill', '--image', path.join(inDir, 'A_color.png'), '--mask', path.join(tmp, 'mask.png'), '--out', filled, '--codex', fake, '--grow', '0');
const f = readPng(filled);
let inside = 0, outsideSame = true;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  const hole = x > 20 && x < 40 && y > 30 && y < 60;
  if (hole) { if (f.data[i + 1] > f.data[i] + 60) inside++; } // 大きさの行き来で縁がにじむので、緑っぽい所を数える
  else if (f.data[i] !== img.data[i] || f.data[i + 1] !== img.data[i + 1] || f.data[i + 2] !== img.data[i + 2]) outsideSame = false;
}
assert.ok(outsideSame, '穴の外が変わった');
assert.ok(inside > 19 * 29 * 0.75, `穴が埋まっていない（${inside}）`);
console.log('ok fill：穴の所だけ置き換え、穴の外は元のまま');
fs.rmSync(tmp, { recursive: true, force: true });
