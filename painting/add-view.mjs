#!/usr/bin/env node
// 絵 1 枚から作った場面に、画面を開かずに視点を 1 つ足す。「視点を足す」のタブと同じ計算（studio/dreamviews.js）を、同じ順で動かす：
//   1. すでにある絵を新しい視点へ写す（写した絵・穴の印・仮の奥行きを保存）
//   2. 穴を埋める（paint/paint.mjs fill。埋め方は --fill）
//   3. 埋めた絵の奥行きを推定して、すでにある面に合わせる（painting/depth.mjs → alignDepth）
//
//   node add-view.mjs --scene jatte [--right 0.75] [--forward 0] [--up 0] [--yaw 0] [--pitch 0] [--fill nvscodex] [--name R7]
//     視点の位置と向きは、もとの視点（絵のカメラ）から見た量で指定する：
//       --right / --forward / --up  動かす距離（m）。--yaw は右へ向ける角度（度）、--pitch は上へ向ける角度（度）
//       --orbit <度> --orbit-dist <m> を付けると、もとの視点の正面 orbit-dist（既定 8）m の点を中心に、右へ回り込む（上の量はその後に足す）
//     --fill   穴の埋め方：
//       nvs       別視点の絵を生成するモデル（/opt/psf-ext/nvs/run.sh。環境変数 PSF_NVS で差し替え）。利用枠なし
//       nvscodex  別視点のモデルの絵を下絵にして、Codex（ChatGPT）に、もとの絵の画風で描いてもらう。1 視点につき Codex を 1 回（絵 1 枚）使う
//       codex     Codex だけ。1 視点につき 1 回使う
//       local     PC の画像生成モデル（/opt/psf-ext/inpaint/run.sh、PSF_INPAINT）。利用枠なし
//       none      埋めない（写すところまで。後から画面で埋められる）
//     --nvs-model <名前>、--local-model <名前>、--refine <強さ>（nvs のとき、PC の画像生成モデルで仕上げ）、--seam <画素>
//     --objcloud <.ply>  物ごとの 3D を置いた点群（世界の座標で x y z、red green blue、object_id、radius〔m〕。バイナリ little endian）。
//       その物体は、もとの絵の画素を動かす代わりに、点群をこの視点から見た形で写す（横から見た形になる）
//     --layout <絵>  すでにある下絵（穴を埋めた同じ視点の絵）を使って、Codex だけ動かす（--fill nvscodex のとき、別視点のモデルを呼ばない）
//     --dry-run  Codex を呼ばず、送る文と条件の絵だけ作る（利用枠は減らない。視点は「穴あり」で残る）
//   node add-view.mjs --scene jatte --plate --fill codex|local [--local-model <名前>] [--plate-grow 10] [--plate-types figure | --plate-mask <白い所を消す絵>] [--dry-run]
//     「物を消した背景」の視点を足す：もとの視点のまま、人や動物の所を穴にして、その後ろの背景（芝・水・遠くの木）だけを Codex に描いてもらう（絵 1 枚）。
//     --fill local なら PC の画像生成モデルで描く（利用枠なし）。
//     物の後ろが粒になるので、横や前へ動いたときに物の陰に開く隙間が埋まる。もとの絵は動かさないので、物の縁が伸びたり割れたりしない。
//   node add-view.mjs --scene jatte --redo-depth R1 [--new-depth]
//     もうある視点 R1 の、穴の奥行きだけを決め直す（絵は描かない。利用枠も使わない）。奥行きの決め方を直したあとに使う。
//     前に推定した「近さ」の絵（R1_disp.png）をそのまま使う。--new-depth を付けると推定からやり直す
// できた視点は R1, R2, … の名前で added_views.json に加わる。取り消すときは「視点を足す」のタブの「取り消す」。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadScene, rgbaOf, savePng } from './import-views.mjs';
import * as dream from '../studio/dreamviews.js';
import { parsePly } from '../studio/sharp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const FLAGS = new Set(['dry-run', 'new-depth', 'plate']), FILLS = ['nvs', 'nvscodex', 'codex', 'local', 'none'];

function args() {
  const a = { scene: 'jatte', right: 0, forward: 0, up: 0, yaw: 0, pitch: 0, orbit: 0, 'orbit-dist': 8, fill: 'none' }, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i].replace(/^--/, '');
    if (FLAGS.has(k)) { a[k] = true; continue; }
    const x = v[++i]; a[k] = x !== undefined && x !== '' && !isNaN(Number(x)) ? Number(x) : x;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(String(a.scene))) throw new Error('--scene の名前が使えません');
  if (!FILLS.includes(a.fill)) throw new Error(`--fill は ${FILLS.join(' / ')} のどれかです`);
  if (a.name !== undefined && !/^R[0-9]+$/.test(String(a.name))) throw new Error('--name は R と数字にしてください（例：R7）');
  for (const k of ['right', 'forward', 'up', 'yaw', 'pitch', 'orbit', 'orbit-dist']) if (!Number.isFinite(a[k])) throw new Error(`--${k} は数にしてください`);
  return a;
}

// 画面と同じ形の「場面」を作る（studio/dreamviews.js が読む形）
async function sceneData(dir) {
  const S = await loadScene(dir);
  const views = S.views.map((v) => ({ ...v, added: !!v.def.added, fresh: v.valid }));
  return { S, D: { cams: S.cams, views } };
}

// もとの視点から見た量（右・前・上、向き）を、世界での位置と見る先にする
function candidate(D, a) {
  const b = dream.baseView(D), m = b.c2w, pos = [m[3], m[7], m[11]], R = [m[0], m[4], m[8]], U = [m[1], m[5], m[9]], F = [-m[2], -m[6], -m[10]];
  const at = (p, r, u, f) => p.map((x, k) => x + R[k] * r + U[k] * u + F[k] * f);
  let position = pos, yaw = a.yaw;
  if (a.orbit) { // 正面 d m の点を中心に右へ回り込む：位置は中心から見て逆向きに回り、向きは中心を見る
    const d = a['orbit-dist'], t = a.orbit * Math.PI / 180;
    position = at(pos, d * Math.sin(t), 0, d * (1 - Math.cos(t))); yaw -= a.orbit;
  }
  position = at(position, a.right, a.up, a.forward);
  const y = yaw * Math.PI / 180, p = a.pitch * Math.PI / 180, dirv = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)]; // 右・上・前
  const target = at(position, dirv[0] * 10, dirv[1] * 10, dirv[2] * 10);
  return { position: position.map((x) => +x.toFixed(4)), target: target.map((x) => +x.toFixed(4)) };
}

// 物ごとの 3D を置いた点群（.ply。バイナリ little endian。世界の座標で x y z、red green blue、object_id、radius〔m〕）を読む
function readCloud(file) {
  const buf = fs.readFileSync(file), { count, props: p } = parsePly(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ['x', 'y', 'z', 'red', 'green', 'blue', 'object_id', 'radius']);
  for (const k of ['x', 'y', 'z', 'red', 'green', 'blue']) if (!p[k]) throw new Error(`点群に ${k} の列がありません：${file}`);
  const xyz = new Float32Array(count * 3), rgb = new Uint8Array(count * 3), object = p.object_id ? new Uint16Array(count) : null;
  for (let i = 0; i < count; i++) { xyz[i * 3] = p.x[i]; xyz[i * 3 + 1] = p.y[i]; xyz[i * 3 + 2] = p.z[i]; rgb[i * 3] = p.red[i]; rgb[i * 3 + 1] = p.green[i]; rgb[i * 3 + 2] = p.blue[i]; if (object) object[i] = p.object_id[i]; }
  return { n: count, xyz, rgb, object, radius: p.radius || 0.01 };
}

const run = (cmd, argv, cwd) => { const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', windowsHide: true }); if (r.error) throw new Error(`${path.basename(argv[0])} を起動できません：${r.error.message}`); return r.status; };

// 3. 埋めた絵の奥行きを推定して、すでにある面に合わせる（reuse = true なら、前に推定した「近さ」の絵があればそれを使う）
async function refine(dir, name, reuse = false) {
  const { S, D } = await sceneData(dir), P = (kind) => path.join(S.P, `${name}_${kind}.png`);
  const v = D.views.find((x) => x.name === name);
  if (!v || !v.added) throw new Error(`足した視点 ${name} がありません`);
  if (!fs.existsSync(P('painted')) || !fs.existsSync(P('holes'))) throw new Error(`視点 ${name} の埋めた絵（または穴の印）がありません`);
  if (!(reuse && fs.existsSync(P('disp')))) {
    if (!fs.existsSync(path.join(HERE, 'node_modules', 'onnxruntime-node'))) { console.log('奥行き推定の用意がまだ無いので、穴の奥行きは仮の値のままです（painting フォルダで npm install）。'); return; }
    if (run(process.env.PSF_DEPTH_NODE || process.execPath, [path.join(HERE, 'depth.mjs'), '--image', P('painted'), '--out', P('disp')], HERE) !== 0) { console.log('奥行きを推定できませんでした。穴の奥行きは仮の値のままです。'); return; }
  }
  const io = { saveExport: (file, rgba, W, H) => savePng(path.join(S.E, file), rgba, W, H), savePaint: (file, rgba, W, H) => savePng(path.join(S.P, file), rgba, W, H) };
  const holesImg = (await rgbaOf(P('holes'), v.W, v.H)).data, dp = (await rgbaOf(P('disp'), v.W, v.H)).data, disp = new Float32Array(v.W * v.H);
  for (let i = 0; i < disp.length; i++) disp[i] = (dp[i * 4] * 256 + dp[i * 4 + 1]) / 65535;
  const r = await dream.refineDepth(D, v, holesImg, disp, io);
  console.log(r ? `埋めた絵の奥行きを推定して、すでにある面に合わせました（${r.samples} 点で合わせ、穴のうち空にした画素 ${r.skyHoles}、もとの絵の手前に来たので粒にしない画素 ${r.carved}、物の陰で背景の奥行きにした画素 ${r.slivers}、地面の平面に載せた画素 ${r.snapped}、傾いていたので地面に直した画素 ${r.flattened}）。`
    : '奥行きを合わせる手がかりが足りないので、穴の奥行きは仮の値のままです。');
  console.log(`終わりました。「粒の空間」で「ファイルを読み直す」を押すと、視点 ${name} が${reuse ? '新しい奥行きになります' : '加わります'}。`);
}

async function main() {
  const a = args(), dir = path.join(ROOT, 'scenes', String(a.scene));
  if (a['redo-depth'] !== undefined) { await refine(dir, String(a['redo-depth']), !a['new-depth']); return; } // もうある視点の、穴の奥行きだけを決め直す（何も描かない）
  let { S, D } = await sceneData(dir);
  if (!dream.baseView(D)) throw new Error('もとの視点の絵がありません');
  const used = new Set([...S.cams.views, ...S.added].map((v) => v.name));
  let name = a.name; if (name === undefined) for (let i = 1; ; i++) if (!used.has(`R${i}`)) { name = `R${i}`; break; }
  if (used.has(name)) throw new Error(`視点 ${name} はもうあります`);
  const io = {
    saveExport: (file, rgba, W, H) => savePng(path.join(S.E, file), rgba, W, H),
    savePaint: (file, rgba, W, H) => savePng(path.join(S.P, file), rgba, W, H),
    loadAdded: async () => (fs.existsSync(S.addedFile) ? JSON.parse(fs.readFileSync(S.addedFile, 'utf8')) : []),
    saveAdded: async (list) => fs.writeFileSync(S.addedFile, JSON.stringify(list, null, 1)),
  };
  for (const kind of ['painted', 'disp', 'layout', 'overlay', 'plateguide']) fs.rmSync(path.join(S.P, `${name}_${kind}.png`), { force: true }); // 同じ名前の古い絵が残っていたら消す
  // 1. 写す（--plate のときは、もとの視点のまま、人や動物の所を穴にする）
  const P = (kind) => path.join(S.P, `${name}_${kind}.png`);
  if (a.plate) {
    const types = String(a['plate-types'] || 'figure').split(',').map((t) => t.trim()).filter(Boolean), grow = a['plate-grow'] === undefined ? 10 : a['plate-grow'];
    let mask = null;
    if (typeof a['plate-mask'] === 'string') { const b = dream.baseView(D), m = (await rgbaOf(path.resolve(a['plate-mask']), b.W, b.H)).data; mask = new Uint8Array(b.W * b.H); for (let i = 0; i < mask.length; i++) mask[i] = m[i * 4] > 127 ? 1 : 0; }
    const { holes, pixels } = await dream.addPlateView(D, name, io, { grow, types, mask });
    console.log(`視点 ${name}：もとの視点のまま、${mask ? '渡された切り抜き' : types.join('・')} の所を穴にしました（輪郭から ${grow} 画素ぶん広げて、絵の ${(100 * holes / pixels).toFixed(1)}%）。穴には、物の後ろの背景だけを描きます。`);
    if (a.fill === 'none') { console.log('埋めずに終わります（--fill none）。'); return; }
    if (a.fill !== 'codex' && a.fill !== 'local') throw new Error('--plate の穴は、--fill codex（ChatGPT）か --fill local（PC の画像生成モデル）か --fill none で埋めてください');
    const argv = [path.join(ROOT, 'paint', 'paint.mjs'), 'fill', '--plate', '--image', P('reproj'), '--mask', P('holes'), '--guide', P('plateguide'), '--out', P('painted'), '--grow', '0'];
    if (process.env.PAINT_CODEX) argv.push('--codex', process.env.PAINT_CODEX);
    if (a.fill === 'local') { // PC の画像生成モデル（利用枠なし）。画風と「背景だけ」の指示を文で渡す
      argv.push('--local', ...(process.env.PSF_INPAINT ? [process.env.PSF_INPAINT] : []), '--style', dream.fillStyle(D.cams).slice(0, 500), '--hint', dream.PLATE_HINT);
      if (a['local-model']) argv.push('--local-model', String(a['local-model']));
    }
    if (a['dry-run']) argv.push('--dry-run');
    const code = run(process.execPath, argv, path.join(ROOT, 'paint'));
    if (code !== 0) throw new Error(`穴を埋められませんでした（終了コード ${code}）。視点 ${name} は穴が残ったままです`);
    if (a['dry-run'] || !fs.existsSync(P('painted'))) { console.log(`視点 ${name} は穴が残ったままです（Codex は呼んでいません）。「視点を足す」のタブで取り消せます。`); return; }
    await refine(dir, name); return;
  }
  const cand = candidate(D, a), cloud = typeof a.objcloud === 'string' ? readCloud(path.resolve(a.objcloud)) : null;
  const { holes, pixels, cloudPixels } = await dream.addView(D, cand, name, io, { cloud });
  console.log(`視点 ${name}：位置 ${cand.position.join(', ')}、見る先 ${cand.target.join(', ')}。穴は絵の ${(100 * holes / pixels).toFixed(1)}%${cloud ? `（物の点群 ${cloud.n} 点を重ねて、絵の ${(100 * cloudPixels / pixels).toFixed(1)}% を埋めました）` : ''}`);
  if (!holes) { fs.copyFileSync(path.join(S.P, `${name}_reproj.png`), path.join(S.P, `${name}_painted.png`)); console.log('穴が無いので、描き足しません。'); return; }
  if (a.fill === 'none') { console.log('埋めずに終わります（--fill none）。「視点を足す」のタブの「2. 穴を埋める」で埋められます。'); return; }
  // 2. 埋める（画面のサーバーと同じ引数で paint.mjs を呼ぶ）
  const withLayout = a.fill === 'nvscodex';
  const argv = [path.join(ROOT, 'paint', 'paint.mjs'), 'fill', '--image', P('reproj'), '--mask', P('holes'), '--out', P('painted'), '--style', dream.fillStyle(D.cams).slice(0, 500), '--hint', withLayout ? dream.LAYOUT_HINT : dream.FILL_HINT];
  if (process.env.PAINT_CODEX) argv.push('--codex', process.env.PAINT_CODEX);
  if (a.fill === 'local') { argv.push('--local', ...(process.env.PSF_INPAINT ? [process.env.PSF_INPAINT] : [])); if (a['local-model']) argv.push('--local-model', String(a['local-model'])); }
  if (a.fill === 'nvs' || withLayout) {
    if (withLayout && typeof a.layout === 'string') argv.push('--layout', path.resolve(a.layout), '--export-dir', S.E, '--view', name);
    else {
      argv.push('--nvs', ...(process.env.PSF_NVS ? [process.env.PSF_NVS] : []), '--export-dir', S.E, '--view', name);
      if (a['nvs-model']) argv.push('--nvs-model', String(a['nvs-model']));
      if (withLayout) argv.push('--repaint');
      else if (a.refine !== undefined) { argv.push('--refine', String(a.refine), ...(process.env.PSF_INPAINT ? ['--local', process.env.PSF_INPAINT] : [])); if (a['local-model']) argv.push('--local-model', String(a['local-model'])); }
    }
  }
  if (a.seam !== undefined) argv.push('--seam', String(a.seam));
  if (a['dry-run']) argv.push('--dry-run');
  const code = run(process.execPath, argv, path.join(ROOT, 'paint'));
  if (code !== 0) throw new Error(`穴を埋められませんでした（終了コード ${code}）。視点 ${name} は穴が残ったままです`);
  if (a['dry-run'] || !fs.existsSync(P('painted'))) { console.log(`視点 ${name} は穴が残ったままです（Codex は呼んでいません）。「視点を足す」のタブで埋めるか、取り消してください。`); return; }
  await refine(dir, name);
}

main().catch((e) => { console.error(`止まりました：${e.message}`); process.exit(1); });
