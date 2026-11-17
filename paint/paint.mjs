#!/usr/bin/env node
// プレビズの絵を下絵にして、ChatGPT の月額プラン（Codex CLI の画像生成）で絵画的な絵を作る。
//
//   node paint.mjs views --in <プレビズの書き出し> --out <出す所> [--views A,B] [--style "..."] [--dry-run]
//     各視点の色の絵と奥行きの絵を Codex に見せ、同じ構図のまま絵画にしてもらう。
//     2 枚目からは、1 枚目にできた絵も「画風の見本」として見せる（視点ごとに画風がばらつかないように）。
//     出すもの：<視点>_painted.png（頼んだ大きさに合わせたもの）、<視点>_overlay.png（プレビズの輪郭を重ねた確かめ用）
//
//   node paint.mjs fill --image <絵> --mask <穴の印（白が穴）> --out <出すファイル> [--style "..."] [--dry-run]
//                       [--previz <同じ視点のプレビズの色> --depth <その奥行きの絵> --overlay <確かめ用の絵>]
//     穴をマゼンタで塗った絵を見せて「マゼンタの所だけ描いて」と頼み、できた絵の穴の所だけを元の絵に貼る。
//     穴の外は 1 画素も変えない。
//
// 共通：--codex <コマンド>（既定 codex）、--timeout <秒>（既定 600）
// --dry-run は Codex を呼ばず、作業フォルダに送る文（prompt.txt）と条件の絵だけを作る。利用枠は減らない。
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, generate } from './codex.mjs';
import { readPng, writePng, resize, overlay, holeMask, paintHoles, composite, outsideChange } from './image.mjs';

const DEFAULT_STYLE = 'a loose, painterly oil painting with visible brush strokes, soft atmospheric perspective, warm late-afternoon light';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function viewInstructions({ style, hasStyleRef }) {
  return [
    `Repaint the scene shown in references/previz.png as ${style}.`,
    'previz.png is a plain 3D render (previsualization) of the scene from the exact camera we need. depth.png is its depth map (white = near, black = far / sky).',
    'Keep the composition EXACTLY: same camera position, same horizon height, same perspective, same position, size and silhouette of every object (ground, arch, tower, etc.).',
    'Do not crop, zoom, pan, mirror, or add a border. The painting must line up with previz.png when overlaid pixel for pixel.',
    'Do not add large new objects that are not in previz.png. Small surface details (stones, grass, cracks, clouds) are welcome.',
    'Areas that are empty / sky in depth.png must stay sky.',
    hasStyleRef ? 'style.png is another view of the same place that is already painted. Match its painting style, palette, lighting and materials exactly so the two views look like the same painting.' : '',
  ].filter(Boolean).join('\n');
}

function fillInstructions({ style, hasPreviz }) {
  return [
    `references/holes.png is ${style}. The bright magenta (#FF00FF) areas are holes with no paint yet.`,
    'Paint ONLY inside the magenta areas, continuing the surrounding scene naturally (same perspective, same light, same brush style).',
    'Everything outside the magenta areas must stay exactly as it is: same composition, same position of everything. Do not crop, zoom or shift the image.',
    'No magenta may remain in the result.',
    hasPreviz ? 'previz.png is a plain 3D render of the same scene from the same camera, and depth.png is its depth map (white = near, black = far / sky). Inside the magenta areas, follow previz.png exactly for the position, size and silhouette of every object, and keep sky where depth.png is black. Use previz.png only for layout, not for colour or style.' : '',
  ].filter(Boolean).join('\n');
}

async function runViews(o) {
  if (!o.in || !o.out) throw new Error('使い方：node paint.mjs views --in <プレビズの書き出し> --out <出す所> [--views A,B]');
  const cams = JSON.parse(fs.readFileSync(path.join(o.in, 'cameras.json'), 'utf8'));
  const wanted = typeof o.views === 'string' ? o.views.split(',').map((s) => s.trim()) : null;
  const views = cams.views.filter((v) => !wanted || wanted.includes(v.name));
  if (!views.length) throw new Error('視点が見つかりません');
  const style = typeof o.style === 'string' ? o.style : DEFAULT_STYLE;
  fs.mkdirSync(o.out, { recursive: true });
  const runDir = path.join(o.out, 'work', stamp());
  let styleRef = typeof o['style-ref'] === 'string' ? o['style-ref'] : null;
  const report = [];

  for (const v of views) {
    const workDir = path.join(runDir, v.name);
    fs.mkdirSync(workDir, { recursive: true });
    const references = [
      { name: 'previz.png', file: path.join(o.in, v.color), note: 'previz render from the target camera (layout to follow exactly)' },
      { name: 'depth.png', file: path.join(o.in, v.depth_view), note: 'depth of previz.png (white = near, black = far / sky)' },
    ];
    if (styleRef) references.push({ name: 'style.png', file: styleRef, note: 'already painted view of the same place (style to match)' });
    const prompt = buildPrompt({ width: v.width, height: v.height, references, instructions: viewInstructions({ style, hasStyleRef: !!styleRef }) });
    console.log(`視点 ${v.name}：${o['dry-run'] ? '文と条件の絵を用意します（Codex は呼びません）' : 'Codex で描いています（30 秒〜数分）'}`);
    const started = Date.now();
    const file = await generate({ workDir, prompt, references, command: o.codex || 'codex', timeoutSeconds: Number(o.timeout) || 600, dryRun: !!o['dry-run'] });
    if (!file) { console.log(`  → ${workDir}`); continue; }
    const raw = readPng(file);
    const painted = resize(raw, v.width, v.height);
    const out = path.join(o.out, `${v.name}_painted.png`);
    writePng(out, painted);
    writePng(path.join(o.out, `${v.name}_overlay.png`), overlay(painted, readPng(path.join(o.in, v.color))));
    fs.copyFileSync(file, path.join(workDir, `raw${path.extname(file)}`));
    const seconds = Math.round((Date.now() - started) / 1000);
    report.push({ view: v.name, painted: path.basename(out), raw_size: [raw.width, raw.height], size: [v.width, v.height], seconds });
    console.log(`  → ${out}（生成 ${raw.width}x${raw.height}${raw.width !== v.width || raw.height !== v.height ? ` を ${v.width}x${v.height} に合わせた` : ''}、${seconds} 秒）`);
    if (!styleRef) styleRef = out;
  }
  if (report.length) fs.writeFileSync(path.join(o.out, 'paint_report.json'), JSON.stringify({ style, cameras: 'cameras.json と同じ', views: report }, null, 2));
}

async function runFill(o) {
  if (!o.image || !o.mask || !o.out) throw new Error('使い方：node paint.mjs fill --image <絵> --mask <穴の印（白が穴）> --out <出すファイル>');
  const style = typeof o.style === 'string' ? o.style : DEFAULT_STYLE;
  const original = readPng(o.image);
  const maskImg = resize(readPng(o.mask), original.width, original.height);
  const mask = holeMask(maskImg, Number(o.grow ?? 2));
  const holes = mask.reduce((s, x) => s + x, 0);
  if (!holes) throw new Error('穴の印に白い所がありません');
  const workDir = path.join(path.dirname(path.resolve(o.out)), 'work', `fill-${stamp()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const holesFile = path.join(workDir, 'holes-input.png');
  writePng(holesFile, paintHoles(original, mask));
  const references = [{ name: 'holes.png', file: holesFile, note: 'painting with magenta holes to fill' }];
  const hasPreviz = typeof o.previz === 'string';
  if (hasPreviz) references.push({ name: 'previz.png', file: o.previz, note: 'previz render from the same camera (layout to follow inside the holes)' });
  if (hasPreviz && typeof o.depth === 'string') references.push({ name: 'depth.png', file: o.depth, note: 'depth of previz.png (white = near, black = far / sky)' });
  const prompt = buildPrompt({ width: original.width, height: original.height, references, instructions: fillInstructions({ style, hasPreviz }) });
  console.log(`穴 ${(100 * holes / mask.length).toFixed(1)}%：${o['dry-run'] ? '文と条件の絵を用意します（Codex は呼びません）' : 'Codex で描いています'}`);
  const file = await generate({ workDir, prompt, references, command: o.codex || 'codex', timeoutSeconds: Number(o.timeout) || 600, dryRun: !!o['dry-run'] });
  if (!file) { console.log(`  → ${workDir}`); return; }
  const generated = resize(readPng(file), original.width, original.height);
  const result = composite(original, generated, mask);
  writePng(o.out, result);
  if (hasPreviz && typeof o.overlay === 'string') writePng(o.overlay, overlay(result, resize(readPng(o.previz), original.width, original.height)));
  const drift = outsideChange(original, generated, mask);
  console.log(`  → ${o.out}（穴の外の変わり具合 ${drift.toFixed(1)}/255。${drift > 25 ? '大きい：Codex が絵全体を描き直したかも。継ぎ目を見てください' : '小さい：位置は合っていそう'}）`);
}

const o = parseArgs(process.argv.slice(2));
try {
  if (o._ === 'views') await runViews(o);
  else if (o._ === 'fill') await runFill(o);
  else { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(2); }
} catch (e) {
  console.error(`止まりました：${e.message}`);
  process.exit(1);
}
