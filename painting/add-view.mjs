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
//       plain     モデルを呼ばない：穴を、まわりの背景の側の色でなめらかに埋める（--stipple を付けると、もとの絵の点の細かさを足す）。物の陰の細い穴向き
//       none      埋めない（写すところまで。後から画面で埋められる）
//     --nvs-model <名前>、--local-model <名前>、--refine <強さ>（nvs のとき、PC の画像生成モデルで仕上げ）、--seam <画素>
//     （--fill nvs に --refine を付けず --stipple だけ付けると、別視点のモデルの絵に点を足したものをそのまま使う。細い穴に、物を描き足されたくないとき）
//     --stipple [強さ]  PC のモデルで仕上げる前（--fill nvs --refine）や、背景を描く前（--plate --fill local）に、穴の中へ、もとの絵の点の細かさだけを足す
//       （モデルなしの計算。配置を保ったまま点描に戻すための下ごしらえ。強さを書かなければ、もとの絵と同じ細かさに合わせる）。点の見本は、もとの視点の絵の、人と空を除いた所
//     --objcloud <.ply>  物ごとの 3D を置いた点群（世界の座標で x y z、red green blue、object_id、radius〔m〕。バイナリ little endian）。
//       その物体は、もとの絵の画素を動かす代わりに、点群をこの視点から見た形で写す（横から見た形になる）
//       --objcloud-skip 10043,10037 で、点群のうちその番号の物体は使わない（絵の画素を動かす写し方のまま）
//       ファイルはコンマで並べられる。ファイル@10043+10045 と書くと、そのファイルからはその物体だけ使う。同じ物体は先に書いたファイルが優先
//       （例：--objcloud trellis.ply@10043,best.ply で、10043 だけ trellis、残りは best）
//       --objcloud-backfaces を付けると、向こうを向いた点（裏側の面）も写す（既定は写さない。面の向きが当てにならない点群のとき用）
//     --nvs-from <視点|auto>  別視点のモデルに渡すもとの絵を選ぶ（既定は、もとの視点）。足した視点の名前（例：R41）なら、その視点の絵と奥行きを渡す。
//       auto なら、足す視点にいちばん近い、描き終わった視点。その場で回る列（40° → 60°）は、ひとつ前の視点から作るほうがずれが小さい
//     --band <画素>  PC のモデルで描くとき（--fill local に --stipple か --strength、または --fill nvs --refine）、穴の縁の外側もその幅ぶん一緒に描き直し、
//       帯の中でもとの絵へなだらかに戻す。穴の縁で調子が段になるのを消す（例：--band 12）
//     --dot-match [割合]  描いてもらった穴の中の点が、穴の外より弱いとき（既定は 0.9 倍より下）、もとの絵の点の細かさを足して合わせる（ChatGPT の絵の点が弱い視点に）
//     --draft  --layout の絵が、この道具で作った下書き（--fill local --stipple などで仕上げた同じ視点の絵）のときに付ける。Codex への文が、広い穴には下書きを写さず背景を描く頼み方に変わる
//     --layout <絵>  すでにある下絵（穴を埋めた同じ視点の絵）を使って、Codex だけ動かす（--fill nvscodex のとき、別視点のモデルを呼ばない）
//     --dry-run  Codex を呼ばず、送る文と条件の絵だけ作る（利用枠は減らない。視点は「穴あり」で残る）
//   node add-view.mjs --scene jatte --plate --fill codex|local [--local-model <名前>] [--plate-grow 10] [--plate-types figure | --plate-mask <白い所を消す絵>] [--dry-run]
//     「物を消した背景」の視点を足す：もとの視点のまま、人や動物の所を穴にして、その後ろの背景（芝・水・遠くの木）だけを Codex に描いてもらう（絵 1 枚）。
//     --fill local なら PC の画像生成モデルで描く（利用枠なし）。--stipple を付けると、まわりの色でなめらかに埋めた絵に点を足し、そこから --strength（既定 0.35）の強さで描き直す
//     （人を描き戻しにくい）。--fill plain は、モデルを呼ばず、なめらかに埋めた絵（--stipple があれば点を足した絵）をそのまま使う。
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
const FLAGS = new Set(['dry-run', 'new-depth', 'plate', 'objcloud-backfaces', 'draft']), FILLS = ['nvs', 'nvscodex', 'codex', 'local', 'plain', 'none'];

function args() {
  const a = { scene: 'jatte', right: 0, forward: 0, up: 0, yaw: 0, pitch: 0, orbit: 0, 'orbit-dist': 8, fill: 'none' }, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i].replace(/^--/, '');
    if (FLAGS.has(k)) { a[k] = true; continue; }
    if (v[i + 1] === undefined || v[i + 1].startsWith('--')) { a[k] = true; continue; } // 値なしの印（--stipple など）
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
function readCloud(file, skip = null, only = null, taken = null) {
  const buf = fs.readFileSync(file), { count, props: p } = parsePly(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), ['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue', 'object_id', 'radius']);
  for (const k of ['x', 'y', 'z', 'red', 'green', 'blue']) if (!p[k]) throw new Error(`点群に ${k} の列がありません：${file}`);
  // 使う点：--objcloud-skip の物体、@ で選ばれていない物体、前のファイルでもう置いた物体の点は外す
  const keep = []; for (let i = 0; i < count; i++) { const id = p.object_id ? p.object_id[i] : 0; if ((skip && skip.has(id)) || (only && !only.has(id)) || (taken && taken.has(id))) continue; keep.push(i); }
  const m = keep.length, xyz = new Float32Array(m * 3), rgb = new Uint8Array(m * 3), object = new Uint16Array(m), radius = new Float32Array(m).fill(0.01), normal = new Float32Array(m * 3), hasN = !!(p.nx && p.ny && p.nz);
  keep.forEach((i, k) => {
    xyz[k * 3] = p.x[i]; xyz[k * 3 + 1] = p.y[i]; xyz[k * 3 + 2] = p.z[i]; rgb[k * 3] = p.red[i]; rgb[k * 3 + 1] = p.green[i]; rgb[k * 3 + 2] = p.blue[i];
    if (p.object_id) object[k] = p.object_id[i]; if (p.radius) radius[k] = p.radius[i];
    if (hasN) { normal[k * 3] = p.nx[i]; normal[k * 3 + 1] = p.ny[i]; normal[k * 3 + 2] = p.nz[i]; }
  });
  return { n: m, xyz, rgb, object, normal, radius };
}
// --objcloud の書き方：ファイルをコンマで並べる。ファイルの後ろに @番号+番号 を付けると、そのファイルからはその物体だけ使う。
// 同じ物体が 2 つのファイルにあれば、先に書いたファイルのものを使う（例：trellis.ply@10043,best.ply = 10043 だけ trellis、残りは best）
function readClouds(spec, skip) {
  const parts = [], taken = new Set();
  for (const item of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
    const at = item.lastIndexOf('@'), hasOnly = at > 0 && /^[0-9+]+$/.test(item.slice(at + 1)), file = hasOnly ? item.slice(0, at) : item;
    const c = readCloud(path.resolve(file), skip, hasOnly ? new Set(item.slice(at + 1).split('+').map(Number)) : null, taken);
    for (let i = 0; i < c.n; i++) taken.add(c.object[i]);
    parts.push(c);
  }
  if (parts.length === 1) return parts[0];
  const n = parts.reduce((t, c) => t + c.n, 0), out = { n, xyz: new Float32Array(n * 3), rgb: new Uint8Array(n * 3), object: new Uint16Array(n), normal: new Float32Array(n * 3), radius: new Float32Array(n) };
  let o = 0; for (const c of parts) { out.xyz.set(c.xyz, o * 3); out.rgb.set(c.rgb, o * 3); out.object.set(c.object, o); out.normal.set(c.normal, o * 3); out.radius.set(c.radius, o); o += c.n; }
  return out;
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
  for (const kind of ['painted', 'disp', 'layout', 'overlay', 'plateguide', 'guide', 'nodots']) fs.rmSync(path.join(S.P, `${name}_${kind}.png`), { force: true }); // 同じ名前の古い絵が残っていたら消す
  // 1. 写す（--plate のときは、もとの視点のまま、人や動物の所を穴にする）
  const P = (kind) => path.join(S.P, `${name}_${kind}.png`);
  // --stipple：点の見本（もとの視点の絵）と、見本に使わない所（人と空）の印を用意して、paint.mjs に渡す引数を作る
  const stippleArgs = async () => {
    if (a.stipple === undefined) return [];
    const b = dream.baseView(D), ids = Object.fromEntries(D.cams.labels.types.map((t) => [t.name, t.id])), no = new Uint8Array(b.W * b.H * 4);
    for (let i = 0; i < b.W * b.H; i++) { const v = b.type[i] === ids.figure || b.type[i] === ids.sky ? 255 : 0; no[i * 4] = no[i * 4 + 1] = no[i * 4 + 2] = v; no[i * 4 + 3] = 255; }
    await savePng(P('nodots'), no, b.W, b.H);
    return ['--stipple', ...(a.stipple === true ? [] : [String(a.stipple)]), '--stipple-source', path.join(S.P, `${b.name}_painted.png`), '--stipple-exclude', P('nodots')];
  };
  if (a.plate) {
    const types = String(a['plate-types'] || 'figure').split(',').map((t) => t.trim()).filter(Boolean), grow = a['plate-grow'] === undefined ? 10 : a['plate-grow'];
    let mask = null;
    if (typeof a['plate-mask'] === 'string') { const b = dream.baseView(D), m = (await rgbaOf(path.resolve(a['plate-mask']), b.W, b.H)).data; mask = new Uint8Array(b.W * b.H); for (let i = 0; i < mask.length; i++) mask[i] = m[i * 4] > 127 ? 1 : 0; }
    const { holes, pixels } = await dream.addPlateView(D, name, io, { grow, types, mask });
    console.log(`視点 ${name}：もとの視点のまま、${mask ? '渡された切り抜き' : types.join('・')} の所を穴にしました（輪郭から ${grow} 画素ぶん広げて、絵の ${(100 * holes / pixels).toFixed(1)}%）。穴には、物の後ろの背景だけを描きます。`);
    if (a.fill === 'none') { console.log('埋めずに終わります（--fill none）。'); return; }
    if (a.fill !== 'codex' && a.fill !== 'local' && a.fill !== 'plain') throw new Error('--plate の穴は、--fill codex（ChatGPT）か --fill local（PC の画像生成モデル）か --fill plain（モデルなし）か --fill none で埋めてください');
    const argv = [path.join(ROOT, 'paint', 'paint.mjs'), 'fill', '--plate', '--image', P('reproj'), '--mask', P('holes'), '--guide', P('plateguide'), '--out', P('painted'), '--grow', '0'];
    if (process.env.PAINT_CODEX) argv.push('--codex', process.env.PAINT_CODEX);
    if (a.fill === 'local') { // PC の画像生成モデル（利用枠なし）。画風と「背景だけ」の指示を文で渡す
      argv.push('--local', ...(process.env.PSF_INPAINT ? [process.env.PSF_INPAINT] : []), '--style', dream.fillStyle(D.cams).slice(0, 500), '--hint', dream.PLATE_HINT);
      if (a['local-model']) argv.push('--local-model', String(a['local-model']));
      if (a.stipple !== undefined || a.strength !== undefined) argv.push(...await stippleArgs(), '--init-strength', ...(Number.isFinite(a.strength) ? [String(a.strength)] : []));
    }
    if (a.band !== undefined && a.band !== true) argv.push('--band', String(a.band));
    if (a.fill === 'plain') argv.push('--plain', ...await stippleArgs()); // モデルなし：なめらかに埋めた絵（と点）をそのまま使う
    if (a['dry-run']) argv.push('--dry-run');
    const code = run(process.execPath, argv, path.join(ROOT, 'paint'));
    if (code !== 0) throw new Error(`穴を埋められませんでした（終了コード ${code}）。視点 ${name} は穴が残ったままです`);
    if (!fs.existsSync(P('painted'))) { console.log(`視点 ${name} は穴が残ったままです（Codex は呼んでいません）。「視点を足す」のタブで取り消せます。`); return; }
    await refine(dir, name); return;
  }
  const cand = candidate(D, a), cloud = typeof a.objcloud === 'string' ? readClouds(a.objcloud, new Set(String(a['objcloud-skip'] ?? '').split(',').map(Number).filter((x) => x > 0))) : null;
  const { holes, pixels, cloudPixels } = await dream.addView(D, cand, name, io, { cloud, backfaces: !!a['objcloud-backfaces'] });
  console.log(`視点 ${name}：位置 ${cand.position.join(', ')}、見る先 ${cand.target.join(', ')}。穴は絵の ${(100 * holes / pixels).toFixed(1)}%${cloud ? `（物の点群 ${cloud.n} 点を重ねて、絵の ${(100 * cloudPixels / pixels).toFixed(1)}% を埋めました）` : ''}`);
  if (!holes) { fs.copyFileSync(path.join(S.P, `${name}_reproj.png`), path.join(S.P, `${name}_painted.png`)); console.log('穴が無いので、描き足しません。'); return; }
  if (a.fill === 'none') { console.log('埋めずに終わります（--fill none）。「視点を足す」のタブの「2. 穴を埋める」で埋められます。'); return; }
  // 2. 埋める（画面のサーバーと同じ引数で paint.mjs を呼ぶ）
  const withLayout = a.fill === 'nvscodex';
  const argv = [path.join(ROOT, 'paint', 'paint.mjs'), 'fill', '--image', P('reproj'), '--mask', P('holes'), '--out', P('painted'), '--style', dream.fillStyle(D.cams).slice(0, 500), '--hint', withLayout ? dream.LAYOUT_HINT : dream.FILL_HINT];
  if (process.env.PAINT_CODEX) argv.push('--codex', process.env.PAINT_CODEX);
  if (a.fill === 'local') {
    argv.push('--local', ...(process.env.PSF_INPAINT ? [process.env.PSF_INPAINT] : [])); if (a['local-model']) argv.push('--local-model', String(a['local-model']));
    // --stipple か --strength があれば、まわりの背景の色でなめらかに埋めた絵（と点）から、その強さで描き直す
    if (a.stipple !== undefined || a.strength !== undefined) argv.push('--guide', P('guide'), ...await stippleArgs(), '--init-strength', ...(Number.isFinite(a.strength) ? [String(a.strength)] : []));
  }
  if (a.fill === 'plain') argv.push('--plain', '--guide', P('guide'), ...await stippleArgs()); // モデルなし：なめらかに埋めた絵（と点）をそのまま使う。細い穴向き
  if (a.fill === 'nvs' || withLayout) {
    if (withLayout && typeof a.layout === 'string') argv.push('--layout', path.resolve(a.layout), '--export-dir', S.E, '--view', name, ...(a.draft ? ['--draft'] : []));
    else {
      argv.push('--nvs', ...(process.env.PSF_NVS ? [process.env.PSF_NVS] : []), '--export-dir', S.E, '--view', name);
      if (a['nvs-model']) argv.push('--nvs-model', String(a['nvs-model']));
      if (a['nvs-from'] !== undefined && a['nvs-from'] !== true) argv.push('--nvs-from', String(a['nvs-from']));
      if (withLayout) argv.push('--repaint');
      else if (a.refine !== undefined) { argv.push('--refine', ...(a.refine === true ? [] : [String(a.refine)]), ...(process.env.PSF_INPAINT ? ['--local', process.env.PSF_INPAINT] : []), ...await stippleArgs()); if (a['local-model']) argv.push('--local-model', String(a['local-model'])); }
      else if (a.stipple !== undefined) argv.push(...await stippleArgs()); // 仕上げなし：別視点のモデルの絵に点を足すだけ（何も描き足されない）
    }
  }
  if (a.seam !== undefined) argv.push('--seam', String(a.seam));
  if (a['dot-match'] !== undefined) { const b = dream.baseView(D); argv.push('--dot-match', ...(a['dot-match'] === true ? [] : [String(a['dot-match'])]), ...(a.stipple === undefined ? ['--stipple-source', path.join(S.P, `${b.name}_painted.png`), '--export-dir', S.E] : [])); }
  if (a.band !== undefined && a.band !== true) argv.push('--band', String(a.band));
  if (a['dry-run']) argv.push('--dry-run');
  const code = run(process.execPath, argv, path.join(ROOT, 'paint'));
  if (code !== 0) throw new Error(`穴を埋められませんでした（終了コード ${code}）。視点 ${name} は穴が残ったままです`);
  if (a['dry-run'] || !fs.existsSync(P('painted'))) { console.log(`視点 ${name} は穴が残ったままです（Codex は呼んでいません）。「視点を足す」のタブで埋めるか、取り消してください。`); return; }
  await refine(dir, name);
}

main().catch((e) => { console.error(`止まりました：${e.message}`); process.exit(1); });
