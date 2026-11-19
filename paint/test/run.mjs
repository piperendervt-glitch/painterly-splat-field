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

// 継ぎ目：生成した絵が全体に 20 明るいとき、穴の縁ではその分だけ引かれ、穴の奥（幅より内側）と穴の外は変わらない
{
  const { matchSeam, composite } = await import('../image.mjs');
  const w = 120, h = 80, orig = blank(w, h), gen = blank(w, h), m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, hole = x >= 30 && x < 100 && y >= 10 && y < 70;
    m[i] = hole ? 1 : 0;
    orig.data.set([100, 120, 90, 255], i * 4);
    gen.data.set(hole ? [150, 150, 150, 255] : [120, 140, 110, 255], i * 4);
  }
  const res = composite(orig, matchSeam(orig, gen, m, { radius: 10 }), m), at = (x, y) => Array.from(res.data.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
  assert.deepEqual(at(30, 40), [130, 130, 130], '穴の縁で、色のずれが引かれていない');
  assert.deepEqual(at(65, 40), [150, 150, 150], '穴の奥まで変わった');
  assert.deepEqual(at(29, 40), [100, 120, 90], '穴の外が変わった');
  const mid = at(35, 40)[0]; assert.ok(mid > 130 && mid < 150, `縁から奥へ、なだらかに戻っていない（${mid}）`);
  // 縁で元の絵とまるで違う絵（別物に描き直された）は、合わせない
  for (let i = 0; i < w * h; i++) if (!m[i]) gen.data.set([250, 20, 20, 255], i * 4);
  const res2 = composite(orig, matchSeam(orig, gen, m, { radius: 10 }), m);
  assert.deepEqual(Array.from(res2.data.slice((40 * w + 30) * 4, (40 * w + 30) * 4 + 3)), [150, 150, 150], '大きすぎる差まで合わせた');
  console.log('ok 継ぎ目：縁の色のずれを穴の内側へ薄めて足す。穴の外と奥は変えない');
}

// fill --plate：手前の物を消した背景の絵。文は「物の後ろの背景だけ」を頼み、目安の絵（guide.png）を見せる。穴の外は元のまま
const plate = path.join(tmp, 'fill', 'A_plate.png');
run('fill', '--plate', '--image', path.join(inDir, 'A_color.png'), '--mask', path.join(tmp, 'mask.png'), '--guide', path.join(inDir, 'A_color.png'), '--out', plate, '--codex', fake, '--grow', '0');
const plateWork = path.join(tmp, 'fill', 'work', fs.readdirSync(path.join(tmp, 'fill', 'work')).sort().pop());
const platePrompt = fs.readFileSync(path.join(plateWork, 'fake-saw-prompt.txt'), 'utf8');
assert.match(platePrompt, /EMPTY background plate/);
assert.match(platePrompt, /guide\.png/);
assert.doesNotMatch(platePrompt, /previz\.png/);
assert.ok(fs.existsSync(path.join(plateWork, 'references', 'guide.png')), 'guide.png が渡っていない');
const pl = readPng(plate);
let plateInside = 0, plateOutsideSame = true;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  if (x > 20 && x < 40 && y > 30 && y < 60) { if (pl.data[i + 1] > pl.data[i] + 60) plateInside++; }
  else if (pl.data[i] !== img.data[i] || pl.data[i + 1] !== img.data[i + 1] || pl.data[i + 2] !== img.data[i + 2]) plateOutsideSame = false;
}
assert.ok(plateOutsideSame && plateInside > 19 * 29 * 0.75, '背景の絵の貼り方がおかしい');
console.log('ok fill --plate：物の後ろの背景だけを頼み、穴の所だけ置き換える');
// fill --ground：周囲の地面。文は「地面だけ」を頼み、目安の絵と画風の見本を見せる
const ground = path.join(tmp, 'fill', 'ground.png');
run('fill', '--ground', '--image', path.join(inDir, 'A_color.png'), '--mask', path.join(tmp, 'mask.png'), '--guide', path.join(inDir, 'A_color.png'), '--style-ref', path.join(inDir, 'A_color.png'), '--out', ground, '--codex', fake);
const groundWork = path.join(tmp, 'fill', 'work', fs.readdirSync(path.join(tmp, 'fill', 'work')).sort().pop());
const groundPrompt = fs.readFileSync(path.join(groundWork, 'fake-saw-prompt.txt'), 'utf8');
assert.match(groundPrompt, /EMPTY GROUND ONLY/);
assert.match(groundPrompt, /this ground belongs to/);
assert.doesNotMatch(groundPrompt, /SKY ONLY/);
assert.ok(fs.existsSync(path.join(groundWork, 'references', 'guide.png')) && fs.existsSync(path.join(groundWork, 'references', 'style.png')), '目安の絵か画風の見本が渡っていない');
assert.ok(fs.existsSync(ground), '周囲の地面の絵ができていない');
console.log('ok fill --ground：地面だけを頼み、目安の絵と画風の見本を渡す');
// layout：形の配置（箱と円柱の一覧）を書いてもらう。絵は作らない。直しの回は、今の配置・重ねた絵・見比べの文を渡す
const layoutOut = path.join(tmp, 'fill', 'layout_ai.json'), brief = path.join(tmp, 'brief.txt'), report = path.join(tmp, 'report.txt');
fs.writeFileSync(brief, 'Image 96 x 64 pixels. Camera height 1.7 m.\n');
fs.writeFileSync(report, '1 left_leg : 40% of this shape lands on sky.\n');
run('layout', '--image', path.join(inDir, 'A_color.png'), '--depth', path.join(inDir, 'A_depth_view.png'), '--brief', brief, '--out', layoutOut, '--codex', fake);
const lay1 = JSON.parse(fs.readFileSync(layoutOut, 'utf8'));
assert.deepEqual(lay1.objects.map((b) => b.name), ['left_leg', 'right_leg', 'tower'], '形の名前の整え方か、読めない形の捨て方がおかしい');
assert.equal(lay1.objects[1].yaw_deg, 0);
assert.equal(lay1.objects[2].shape, 'cylinder');
const layWork = () => path.join(tmp, 'fill', 'work', fs.readdirSync(path.join(tmp, 'fill', 'work')).filter((d) => d.startsWith('layout-')).sort().pop());
assert.match(fs.readFileSync(path.join(layWork(), 'fake-saw-prompt.txt'), 'utf8'), /Camera height 1\.7 m/);
assert.doesNotMatch(fs.readFileSync(path.join(layWork(), 'fake-saw-prompt.txt'), 'utf8'), /correction round/);
await new Promise((r) => setTimeout(r, 1100)); // 作業フォルダの名前は秒まで
run('layout', '--image', path.join(inDir, 'A_color.png'), '--brief', brief, '--prev', layoutOut, '--overlay', path.join(inDir, 'A_color.png'), '--report', report, '--out', layoutOut, '--codex', fake);
const lay2 = JSON.parse(fs.readFileSync(layoutOut, 'utf8')), prompt2 = fs.readFileSync(path.join(layWork(), 'fake-saw-prompt.txt'), 'utf8');
assert.equal(lay2.objects.length, 4);
assert.equal(lay2.objects[0].center[2], 47);
assert.match(prompt2, /correction round/);
assert.match(prompt2, /40% of this shape lands on sky/);
assert.ok(fs.existsSync(path.join(layWork(), 'references', 'overlay.png')) && fs.existsSync(path.join(layWork(), 'references', 'layout.json')), '直しの回に、重ねた絵か今の配置が渡っていない');
console.log('ok layout：形の配置を書いてもらい、直しの回は今の配置・重ねた絵・見比べの文を渡す');
fs.rmSync(tmp, { recursive: true, force: true });
