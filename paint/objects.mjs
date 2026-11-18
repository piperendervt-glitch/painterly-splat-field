#!/usr/bin/env node
// 絵の中の物を 1 つずつ切り出して、選んで動かせる 3D の物にするための下ごしらえ（「粒の空間」の「物を切り出して動かす」）。
// 手順と、外の道具との約束は docs/object-interaction.md。
//
//   node objects.mjs segment --paint-out <dir> --previz-export <dir> [--prompts "person,dog,..."] [--threshold 0.5] [--seg-mode both|masks] [--min-score 0.4]
//     1. 絵（J_painted.png）を SAM 3 に渡し、言葉で指定した物を 1 つずつ切り抜いてもらう（コマンド：環境変数 PSF_SEG）
//     2. painting/build.mjs --masks で、その切り抜きを物体にした版（J_*_sam3.png、J_seg_sam3.json）を足す。今の版は消さない
//
//   node objects.mjs cutouts --paint-out <dir> --previz-export <dir> --seg depth|sam3 [--ids 3,5 | --min-pixels 1500]
//     物体ごとに、切り抜きの絵（obj_<seg>_<番号>_cut.png、外は透明）と、絵と同じ大きさの印（obj_<seg>_<番号>_mask.png）を書く
//
//   node objects.mjs complete --paint-out <dir> --previz-export <dir> --seg depth|sam3 --ids 3,5 [--dry-run]
//     Codex に、物の隠れた所（手前の物に隠れた所、絵の端で切れた所）を描き足した「物の全身」を描いてもらう（1 つにつき 1 回）。
//     出すもの：obj_<seg>_<番号>_full.png（白い所は透明にしたもの）
//
//   node objects.mjs make3d --paint-out <dir> --previz-export <dir> --seg depth|sam3 --method trellis|hunyuan3d|sam3d --ids 3,5 [--source full|cut] [--texture]
//     外の道具（絵 1 枚から物の 3D を作るもの。コマンド：環境変数 PSF_OBJ3D）で、物ごとの 3D を作る。
//     出すもの：obj3d_<seg>_<method>_<番号>.glb / .ply / .json（paint-out に。粒の空間が読む）
//
// 共通：--codex <コマンド>（complete のとき。既定 codex）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPng, writePng, resize } from './image.mjs';
import { buildPrompt, generate } from './codex.mjs';
import { runJob, convertJob, WIN } from './extcmd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
export const DEFAULT_PROMPTS = ['person', 'woman', 'man', 'child', 'dog', 'monkey', 'umbrella', 'parasol', 'boat', 'sailboat', 'tree'];
export const METHODS = ['trellis', 'hunyuan3d', 'sam3d'];
const SEG_CMD = () => process.env.PSF_SEG || (WIN ? 'wsl -- /opt/psf-ext/sam3/run.sh' : '/opt/psf-ext/sam3/run.sh');
const OBJ3D_CMD = () => process.env.PSF_OBJ3D || (WIN ? 'wsl -- /opt/psf-ext/obj3d/run.sh' : '/opt/psf-ext/obj3d/run.sh');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function parseArgs(argv) {
  const [cmd, ...rest] = argv, o = { _: cmd };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const k = rest[i].slice(2), n = rest[i + 1];
    if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; }
  }
  return o;
}

/** 場面のカメラ（cameras.json）と、切り分けの版ごとの物体の絵 */
export function sceneInfo(previzExport, seg) {
  const cams = JSON.parse(fs.readFileSync(path.join(previzExport, 'cameras.json'), 'utf8')), v = cams.views[0];
  if (seg && seg !== 'depth') {
    const doc = JSON.parse(fs.readFileSync(path.join(previzExport, `${v.name}_seg_${seg}.json`), 'utf8'));
    return { cams, view: v, objectsPng: path.join(previzExport, doc.files.objects), objects: doc.objects };
  }
  return { cams, view: v, objectsPng: path.join(previzExport, v.objects), objects: cams.objects || [] };
}

/** 物体の番号の絵（R + G × 256）を読む */
export function readObjectIds(file) {
  const img = readPng(file), n = img.width * img.height, id = new Uint16Array(n);
  for (let i = 0; i < n; i++) id[i] = img.data[i * 4] + img.data[i * 4 + 1] * 256;
  return { W: img.width, H: img.height, id };
}

/** 物体ごとの範囲と画素の数 */
export function objectStats(ids) {
  const { W, H, id } = ids, by = new Map();
  for (let i = 0; i < W * H; i++) {
    const k = id[i]; if (!k) continue;
    let s = by.get(k); if (!s) by.set(k, (s = { id: k, count: 0, x0: W, y0: H, x1: 0, y1: 0 }));
    const x = i % W, y = (i - x) / W; s.count++;
    if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
  }
  return by;
}

/**
 * 物体の切り抜き（正方形、外は透明）。色は物体の中の画素だけで拡大する（外の色を混ぜない）。
 * 返すもの：{ width, height, data（RGBA） }
 */
export function cutout(px, ids, s, { size = 1024, pad = 0.12 } = {}) {
  const { W, H, id } = ids, w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1, side = Math.max(w, h) * (1 + 2 * pad);
  const ox = (s.x0 + s.x1 + 1) / 2 - side / 2, oy = (s.y0 + s.y1 + 1) / 2 - side / 2, k = side / size, out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = ox + (x + 0.5) * k - 0.5, sy = oy + (y + 0.5) * k - 0.5, o = (y * size + x) * 4;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    let r = 0, g = 0, b = 0, ws = 0, inside = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const qx = x0 + i, qy = y0 + j; if (qx < 0 || qy < 0 || qx >= W || qy >= H || id[qy * W + qx] !== s.id) continue;
      const wt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) + 1e-4, q = (qy * W + qx) * 4;
      r += px.data[q] * wt; g += px.data[q + 1] * wt; b += px.data[q + 2] * wt; ws += wt; inside += (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    }
    if (ws > 0 && inside >= 0.5) { out[o] = r / ws; out[o + 1] = g / ws; out[o + 2] = b / ws; out[o + 3] = 255; }
    else { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 0; }
  }
  return { width: size, height: size, data: out };
}

/** 絵と同じ大きさの印（物体 = 白） */
export function maskImage(ids, objectId) {
  const { W, H, id } = ids, out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = id[i] === objectId ? 255 : 0; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
  return { width: W, height: H, data: out };
}

/** 白い背景の絵の、外側から続く白っぽい所を透明にする（Codex が描いた「物の全身」用） */
export function whiteToAlpha(img, { tol = 28 } = {}) {
  const { width: W, height: H } = img, d = new Uint8Array(img.data), seen = new Uint8Array(W * H), stack = [];
  const white = (i) => d[i * 4] > 255 - tol && d[i * 4 + 1] > 255 - tol && d[i * 4 + 2] > 255 - tol;
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop(); if (seen[i] || !white(i)) continue;
    seen[i] = 1; d[i * 4 + 3] = 0;
    const x = i % W, y = (i - x) / W;
    if (x > 0) stack.push(i - 1); if (x + 1 < W) stack.push(i + 1); if (y > 0) stack.push(i - W); if (y + 1 < H) stack.push(i + W);
  }
  return { width: W, height: H, data: d };
}

/** 物体の画素のまわりを切り出した絵（Codex に見せる「絵の中のその物」）。物体の輪郭を赤で囲む */
function contextImage(px, ids, s, { size = 1024 } = {}) {
  const { W, H, id } = ids, w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1, side = Math.min(Math.max(W, H), Math.max(w, h) * 2.2);
  const ox = Math.max(0, Math.min(W - side, (s.x0 + s.x1) / 2 - side / 2)), oy = Math.max(0, Math.min(H - side, (s.y0 + s.y1) / 2 - side / 2)), k = side / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.min(W - 1, Math.max(0, Math.round(ox + x * k))), sy = Math.min(H - 1, Math.max(0, Math.round(oy + y * k))), q = sy * W + sx, o = (y * size + x) * 4;
    const inside = id[q] === s.id, edge = inside && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = Math.min(W - 1, Math.max(0, sx + dx * Math.ceil(k * 2))), ny = Math.min(H - 1, Math.max(0, sy + dy * Math.ceil(k * 2))); return id[ny * W + nx] !== s.id; });
    if (edge) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; } else { out[o] = px.data[q * 4]; out[o + 1] = px.data[q * 4 + 1]; out[o + 2] = px.data[q * 4 + 2]; }
    out[o + 3] = 255;
  }
  return { width: size, height: size, data: out };
}

const pickIds = (o, stats, minPixels = 1500) => {
  if (typeof o.ids === 'string' && o.ids.trim()) return o.ids.split(',').map(Number).filter((n) => stats.has(n));
  return [...stats.values()].filter((s) => s.count >= Number(o['min-pixels'] || minPixels)).map((s) => s.id);
};
const file = (dir, seg, id, kind) => path.join(dir, `obj_${seg}_${id}_${kind}.png`);

function load(o) {
  if (!o['paint-out'] || !o['previz-export']) throw new Error('--paint-out と --previz-export を指定してください');
  const seg = typeof o.seg === 'string' ? o.seg : 'depth';
  if (!/^[a-z0-9]+$/.test(seg)) throw new Error('--seg は depth か sam3 です');
  const info = sceneInfo(o['previz-export'], seg), ids = readObjectIds(info.objectsPng), px = readPng(path.join(o['paint-out'], `${info.view.name}_painted.png`));
  if (px.width !== ids.W || px.height !== ids.H) throw new Error(`絵（${px.width}x${px.height}）と物体の絵（${ids.W}x${ids.H}）の大きさが違います`);
  return { seg, info, ids, px, stats: objectStats(ids), out: o['paint-out'] };
}

function writeCutouts(ctx, list) {
  for (const id of list) {
    const s = ctx.stats.get(id);
    writePng(file(ctx.out, ctx.seg, id, 'cut'), cutout(ctx.px, ctx.ids, s));
    writePng(file(ctx.out, ctx.seg, id, 'mask'), maskImage(ctx.ids, id));
  }
}

async function runCutouts(o) {
  const ctx = load(o), list = pickIds(o, ctx.stats);
  writeCutouts(ctx, list);
  console.log(`切り抜きを ${list.length} 個書きました（obj_${ctx.seg}_<番号>_cut.png、_mask.png）`);
}

function completeInstructions(label) {
  return [
    `object.png shows ONE object cut out of a painting${label ? ` (it is: ${label})` : ''}; transparent / white areas are not part of it. context.png shows where it sits in the painting (red outline).`,
    'Paint this same single object again, COMPLETE and WHOLE, isolated on a plain pure white background (#FFFFFF), centred, filling about 80% of the square frame.',
    'Parts of it that are hidden behind other things in the painting, or cut off by the edge of the painting, must be completed in a natural, plausible way (for a person: the whole body including feet).',
    'Keep exactly the same pose, the same viewing direction, the same colours and the same painting style and brush texture as in object.png. Do not redesign it.',
    'Do not paint any other object, person, ground, floor, cast shadow, frame or text. Only this one object on white.',
  ].join('\n');
}

async function runComplete(o) {
  const ctx = load(o), list = pickIds(o, ctx.stats);
  if (!list.length) throw new Error('描き足す物体がありません（--ids）');
  const labels = new Map((ctx.info.objects || []).map((x) => [x.id, x.label || x.type]));
  console.log(`物の全身を描いてもらいます：${list.length} 個（Codex を ${list.length} 回呼びます）`);
  for (const [k, id] of list.entries()) {
    const s = ctx.stats.get(id), workDir = path.join(ctx.out, 'work', `objfull-${ctx.seg}-${id}-${stamp()}`);
    fs.mkdirSync(workDir, { recursive: true });
    const objFile = path.join(workDir, 'object-input.png'), ctxFile = path.join(workDir, 'context-input.png');
    writePng(objFile, cutout(ctx.px, ctx.ids, s)); writePng(ctxFile, contextImage(ctx.px, ctx.ids, s));
    const references = [{ name: 'object.png', file: objFile, note: 'the object cut out of the painting (transparent outside)' }, { name: 'context.png', file: ctxFile, note: 'the painting around the object, with the object outlined in red' }];
    const prompt = buildPrompt({ width: 1024, height: 1024, references, instructions: completeInstructions(labels.get(id)) });
    console.log(`(${k + 1}/${list.length}) 物体 ${id}${labels.get(id) ? `（${labels.get(id)}）` : ''}：${o['dry-run'] ? '文と条件の絵だけ用意します' : 'Codex で描いています'}`);
    const got = await generate({ workDir, prompt, references, command: o.codex || 'codex', timeoutSeconds: Number(o.timeout) || 600, dryRun: !!o['dry-run'] });
    if (!got) { console.log(`  → ${workDir}`); continue; }
    const img = resize(readPng(got), 1024, 1024);
    writePng(file(ctx.out, ctx.seg, id, 'full'), whiteToAlpha(img));
    console.log(`  → ${path.basename(file(ctx.out, ctx.seg, id, 'full'))}`);
  }
}

async function runMake3d(o) {
  const ctx = load(o), method = String(o.method || '');
  if (!METHODS.includes(method)) throw new Error(`--method は ${METHODS.join(' / ')} のどれかです`);
  const list = pickIds(o, ctx.stats);
  if (!list.length) throw new Error('3D にする物体がありません（--ids）');
  writeCutouts(ctx, list);
  const command = OBJ3D_CMD(), image = path.join(ctx.out, `${ctx.info.view.name}_painted.png`), failed = [];
  console.log(`${method} で ${list.length} 個の物を 3D にします（${command}）`);
  for (const [k, id] of list.entries()) {
    const full = file(ctx.out, ctx.seg, id, 'full'), useFull = o.source !== 'cut' && fs.existsSync(full);
    const outDir = path.join(ctx.out, 'work', 'obj3d', `${ctx.seg}-${method}-${id}`);
    fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
    const job = { method, image, mask: file(ctx.out, ctx.seg, id, 'mask'), cutout: useFull ? full : file(ctx.out, ctx.seg, id, 'cut'), cutout_is_completed: useFull, out_dir: outDir, seed: Number(o.seed) || 0, texture: !!o.texture };
    const jobFile = path.join(outDir, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify(/^\s*"?wsl/i.test(command) && WIN ? convertJob(job, ['image', 'mask', 'cutout', 'out_dir']) : job, null, 1));
    console.log(`(${k + 1}/${list.length}) 物体 ${id}：${useFull ? '描き足した全身' : '絵からの切り抜き'}から作ります`);
    const t0 = Date.now();
    try {
      await runJob({ command, jobFile, logFile: path.join(outDir, 'log.txt'), label: `${method}（物の 3D）`, envName: 'PSF_OBJ3D', timeoutSeconds: Number(o.timeout) || 7200 });
      const base = path.join(ctx.out, `obj3d_${ctx.seg}_${method}_${id}`);
      for (const ext of ['glb', 'ply']) { fs.rmSync(`${base}.${ext}`, { force: true }); if (fs.existsSync(path.join(outDir, `model.${ext}`))) fs.copyFileSync(path.join(outDir, `model.${ext}`), `${base}.${ext}`); }
      if (!fs.existsSync(`${base}.glb`) && !fs.existsSync(`${base}.ply`)) throw new Error('model.glb も model.ply もできませんでした');
      let info = {}; try { info = JSON.parse(fs.readFileSync(path.join(outDir, 'info.json'), 'utf8')); } catch { /* 無くてよい */ }
      fs.writeFileSync(`${base}.json`, JSON.stringify({ ...info, method, seg: ctx.seg, object: id, source: useFull ? 'full' : 'cut', seconds_total: Math.round((Date.now() - t0) / 100) / 10 }, null, 1));
      console.log(`  → ${path.basename(base)}（${Math.round((Date.now() - t0) / 1000)} 秒${info.peak_vram_gb ? `、GPU メモリ ${info.peak_vram_gb} GB` : ''}）`);
    } catch (e) { failed.push(id); console.log(`  × 物体 ${id}：${e.message}`); }
  }
  if (failed.length) throw new Error(`${failed.length} 個は作れませんでした（物体 ${failed.join(', ')}）。記録：paint-out/work/obj3d/`);
}

function runNode(script, args, cwd) {
  return new Promise((ok, ng) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, windowsHide: true });
    child.stdout.on('data', (c) => process.stdout.write(c)); child.stderr.on('data', (c) => process.stderr.write(c));
    child.on('error', ng); child.on('close', (code) => (code === 0 ? ok() : ng(new Error(`${path.basename(script)} が失敗しました（終了コード ${code}）`))));
  });
}

async function runSegment(o) {
  if (!o['paint-out'] || !o['previz-export']) throw new Error('--paint-out と --previz-export を指定してください');
  const { cams, view } = sceneInfo(o['previz-export'], 'depth'), params = (cams.source && cams.source.params) || {};
  if (!cams.source || cams.source.kind !== 'painting') throw new Error('物の切り分けは、絵から作った場面（painting/build.mjs）だけで使えます');
  const image = path.join(o['paint-out'], `${view.name}_painted.png`), outDir = path.join(o['paint-out'], 'work', 'seg-sam3');
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const prompts = typeof o.prompts === 'string' && o.prompts.trim() ? o.prompts.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_PROMPTS;
  const job = { image, out_dir: outDir, prompts, threshold: Number(o.threshold) || 0.5 }, command = SEG_CMD(), jobFile = path.join(outDir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(/^\s*"?wsl/i.test(command) && WIN ? convertJob(job, ['image', 'out_dir']) : job, null, 1));
  console.log(`SAM 3 で切り抜きます（${prompts.join(', ')}）`);
  await runJob({ command, jobFile, logFile: path.join(outDir, 'log.txt'), label: 'SAM 3（物の切り抜き）', envName: 'PSF_SEG', timeoutSeconds: Number(o.timeout) || 1800 });
  const inst = path.join(outDir, 'instances.json');
  if (!fs.existsSync(inst)) throw new Error('instances.json ができませんでした');
  console.log(`切り抜き ${JSON.parse(fs.readFileSync(inst, 'utf8')).instances.length} 個。場面の物体を作り直します`);
  const scene = path.basename(path.dirname(path.resolve(o['previz-export'])));
  await runNode(path.join(ROOT, 'painting', 'build.mjs'), ['--image', image, '--crop', '0', '--scene', scene, '--width', String(view.width),
    '--horizon', String(params.horizon ?? 0.2), '--eye', String(params.eye ?? 1.7), '--hfov', String(params.hfov ?? 60),
    '--masks', inst, '--variant', 'sam3', '--seg', o['seg-mode'] === 'masks' ? 'masks' : 'both', '--minscore', String(o['min-score'] ?? 0.4)], path.join(ROOT, 'painting'));
}

const COMMANDS = { segment: runSegment, cutouts: runCutouts, complete: runComplete, make3d: runMake3d };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  for (const k of ['paint-out', 'previz-export']) if (typeof o[k] === 'string') o[k] = path.resolve(o[k]);
  const fn = COMMANDS[o._];
  if (!fn) { console.error(`使い方：node objects.mjs ${Object.keys(COMMANDS).join('|')} ...（くわしくはファイルの頭）`); process.exit(1); }
  fn(o).then(() => console.log('終わりました')).catch((e) => { console.error(`止まりました：${e.message}`); process.exit(1); });
}
