#!/usr/bin/env node
// 絵 1 枚から作った場面の、もとの視点の「物の切り抜き」を、外で作った正確な切り抜きに取り替える。
// build.mjs の切り抜きは奥行きの推定から作るので粗い（人なのに木や地面の札になる、日傘が半分だけ人になる、足もとが四角くなる）。
// そのまま視点を動かすと、札の付いていない人が背景と一緒に伸びたり、物が割れたりする。
//
//   node relabel.mjs --scene jatte --instances <instances.png> --json <instances.json> [--dry]
//     instances.png   画素ごとの物の番号（0 = 物なし）。16bit の灰色、または 8bit の RGB（番号 = R + G × 256）
//     instances.json  [{ id, class }]（または { instances: [...] }）。class に trunk を含む物は木の幹、ほかは人・動物・舟など
//
// やること：
//   1. 切り抜きの中：種類を「人・動物」（幹は「木」）にして、物ごとに 1 枚の立った板の奥行きにそろえる。
//      板の奥行きは、切り抜きのいちばん下（足もと）が地面に着く所の奥行き（地面の平面の式）。
//      足もとが絵の下の端で切れている物・ほかの物に隠れている物は、今の奥行き（中央の値）を使い、隠している物より手前には置かない。
//      どの物も、まわりに見えている背景より奥には置かない（遠くの舟や岸の人は、地面の式だと奥へ行きすぎる）。
//      幹は、今の奥行きが「立っている」値ならそのまま（上の葉と離れないように）、地面に寝ていたら足もとの奥行きにする。
//   2. 切り抜きの外で、今まで「人・動物」だった所（四角い足もとなど）：地平線より下は地面に、上はまわりの背景に戻す。
//      ただし、立っている物にはさまれた細い線（傘の柄、杖）は、地面ではなく、その物の奥行きにする（遠い芝の筋が物を横切らないように）。
//   3. 前の奥行き・札は <名前>_v1.png に残す（もうあれば上書きしない）。cameras.json の labels.objects も書き直す。
// 足した視点（R…、X…）の絵は変えない。もとの視点の形が変わるので、足した視点は奥行きを決め直す（add-view --redo-depth、import-views のやり直し）とよい。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadScene, savePng } from './import-views.mjs';
import { depthPng, depthViewPng, labelPngs, typeColorPng } from '../studio/dream.js';
import { pullPush } from '../studio/layers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const TYPE_COLORS = { sky: [185, 199, 207], ground: [124, 154, 72], water: [106, 140, 190], figure: [190, 120, 90], far: [150, 170, 150], tree: [70, 110, 60] };
const OBJECT_BASE = 10000; // 新しい物の番号 = OBJECT_BASE + 切り抜きの番号（build.mjs の番号、足した視点の番号 20000〜 と重ならない）

function args() {
  const a = { scene: 'jatte' }, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) { const k = v[i].replace(/^--/, ''); if (k === 'dry') { a[k] = true; continue; } a[k] = v[++i]; }
  if (!/^[A-Za-z0-9_-]+$/.test(String(a.scene))) throw new Error('--scene の名前が使えません');
  if (!a.instances || !a.json) throw new Error('--instances <instances.png> と --json <instances.json> を指定してください');
  return a;
}

// 物の番号の絵を読む（大きさが違えば、番号が混ざらないように最近傍で合わせる）
async function readIds(file, W, H) {
  const meta = await sharp(file).metadata();
  let s = sharp(file); if (meta.width !== W || meta.height !== H) s = s.resize(W, H, { fit: 'fill', kernel: 'nearest' });
  const ids = new Uint16Array(W * H);
  if (meta.depth === 'ushort') {
    const { data, info } = await s.toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    const px = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
    for (let i = 0; i < W * H; i++) ids[i] = px[i * info.channels];
  } else {
    const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < W * H; i++) ids[i] = info.channels >= 3 ? data[i * info.channels] + data[i * info.channels + 1] * 256 : data[i * info.channels];
  }
  return ids;
}

const median = (a) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

async function main() {
  const a = args(), dir = path.join(ROOT, 'scenes', String(a.scene));
  const S = await loadScene(dir), b = S.views.find((v) => !v.def.added);
  if (!b) throw new Error('もとの視点の絵がありません');
  const { W, H } = b, n = W * H, name = b.name, types = (S.cams.labels && S.cams.labels.types) || [];
  const tid = (nm) => { const t = types.find((x) => x.name === nm); if (!t) throw new Error(`この場面には種類「${nm}」がありません`); return t.id; };
  const T = { sky: tid('sky'), ground: tid('ground'), figure: tid('figure'), tree: tid('tree') };
  const eye = S.cams.source.params && Number.isFinite(S.cams.source.params.eye) ? S.cams.source.params.eye : 1.7, groundY = b.def.extrinsics.position[1] - eye, m = b.c2w;
  const zPlane = (x, y) => { const dy = m[4] * ((x + 0.5 - b.cx) / b.fx) + m[5] * (-(y + 0.5 - b.cy) / b.fy) - m[6]; return dy < -1e-6 ? (groundY - m[7]) / dy : 0; };
  const ids = await readIds(path.resolve(a.instances), W, H);
  const raw = JSON.parse(fs.readFileSync(path.resolve(a.json), 'utf8')), list = Array.isArray(raw) ? raw : raw.instances || raw.objects || [];
  const classOf = new Map(list.map((o) => [Number(o.id), String(o.class ?? o.label ?? o.name ?? 'thing')]));

  // ---- 切り抜きごとの形を集める ----
  const inst = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const id = ids[y * W + x]; if (!id) continue;
    let o = inst.get(id); if (!o) inst.set(id, o = { id, cls: classOf.get(id) || 'thing', count: 0, x0: x, x1: x, y0: y, y1: y, rows: new Uint32Array(H) });
    o.count++; o.rows[y]++; if (x < o.x0) o.x0 = x; if (x > o.x1) o.x1 = x; if (y > o.y1) o.y1 = y;
  }
  for (const o of inst.values()) {
    o.trunk = /trunk/i.test(o.cls);
    // 足もとの行：下から数えて、画素の 1% を越えた行（下にはみ出した数画素に引きずられない）
    let acc = 0, yb = o.y1; for (let y = o.y1; y >= o.y0; y--) { acc += o.rows[y]; if (acc >= Math.max(3, o.count * 0.01)) { yb = y; break; } } o.foot = yb;
    // 足もとの下に何があるか：下の端の画素（すぐ下が自分でない画素）ごとに、すぐ下の画素の物の番号を数える
    const below = new Map(); let edge = 0, cut = 0; const olds = [], planes = [];
    for (let y = Math.max(o.y0, yb - 6); y <= o.y1; y++) for (let x = o.x0; x <= o.x1; x++) {
      const i = y * W + x; if (ids[i] !== o.id) continue;
      if (y + 1 >= H) { edge++; cut++; continue; }
      const j = ids[i + W]; if (j === o.id) continue;
      edge++; if (j) below.set(j, (below.get(j) || 0) + 1); else planes.push(zPlane(x, y + 0.5));
    }
    let occ = 0, occN = 0; for (const [j, c] of below) if (c > occN) { occ = j; occN = c; }
    o.cut = cut > edge * 0.3; o.occluder = occN > edge * 0.5 ? occ : 0;
    o.zContact = median(planes.filter((z) => z > 0));
    for (let y = o.y0; y <= o.y1; y++) for (let x = o.x0; x <= o.x1; x++) { const i = y * W + x; if (ids[i] !== o.id) continue; const z = b.z[i], zp = zPlane(x, y); if (z > 0 && (!(zp > 0) || z < zp * 0.85)) olds.push(z); }
    o.zOld = median(olds); o.standing = olds.length / o.count;
    // まわりの背景の奥行き：切り抜きを囲む帯（物でない画素）の中央の値。物は、自分の後ろに見えている背景より奥には置けない
    const ring = [], pad = Math.max(6, Math.round(Math.min(o.x1 - o.x0, o.y1 - o.y0) * 0.25));
    for (let y = Math.max(0, o.y0 - pad); y <= Math.min(H - 1, o.y1 + pad); y += 2) for (let x = Math.max(0, o.x0 - pad); x <= Math.min(W - 1, o.x1 + pad); x += 2) {
      const i = y * W + x; if (ids[i] || !(b.z[i] > 0) || b.type[i] === T.figure) continue;
      if (x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1 && y > o.foot) continue; // 足もとより下（手前の地面）は背景ではない
      if (y > o.foot) continue;
      ring.push(b.z[i]);
    }
    o.zBack = median(ring);
  }
  // ---- 板の奥行きを決める（手前の物から。隠している物より手前には置かない） ----
  const order = [...inst.values()].sort((p, q) => q.foot - p.foot), zOf = new Map();
  const far = Math.min(150, S.cams.depth.far * 0.5);
  for (const o of order) {
    let z, rule;
    if (o.trunk && o.standing > 0.5) { z = 0; rule = '幹：今の奥行きのまま'; }
    else if (o.count < 300 && o.zOld > 0) { z = o.zOld; rule = '小さい物：今の奥行き'; } // 小さなかけら（手に持った物など）は、地面に着いているとは限らない
    else if (!o.cut && !o.occluder && o.zContact > 0) { z = o.zContact; rule = '足もとが地面に着く所'; }
    else if (o.zOld > 0) { z = o.zOld; rule = o.cut ? '下の端で切れている：今の奥行き' : o.occluder ? '隠れている：今の奥行き' : '今の奥行き'; }
    else if (o.occluder && zOf.get(o.occluder) > 0) { z = zOf.get(o.occluder) + 0.5; rule = '隠れている：隠している物の少し奥'; }
    else if (o.zContact > 0) { z = o.zContact; rule = '足もとが地面に着く所（切れているかもしれない）'; }
    else { z = far; rule = '手がかりなし：遠く'; }
    if (z > 0 && o.zBack > 0 && z > o.zBack) { z = o.zBack * 0.97; rule += '、後ろの背景より奥にならないように'; } // 地平線の近くでは、数行の違いで地面の式の奥行きが大きく変わる（遠くの舟や岸の人）
    if (z > 0 && o.cut) { const zb = zPlane((o.x0 + o.x1) / 2, H - 1); if (zb > 0 && z > zb) { z = zb * 0.95; rule += '、下の端の地面より手前に'; } }
    if (z > 0 && o.occluder && zOf.get(o.occluder) > 0 && z < zOf.get(o.occluder) + 0.2) { z = zOf.get(o.occluder) + 0.2; rule += '、隠している物の奥に'; }
    if (z > 0) z = Math.max(0.8, Math.min(far, z));
    o.z = z; o.rule = rule; zOf.set(o.id, z || o.zOld);
  }
  // ---- 画素を書き直す ----
  const z = new Float32Array(b.z), type = new Uint8Array(b.type), object = new Uint16Array(b.object);
  let cleared = 0, lifted = 0;
  const lost = new Uint8Array(n); // 切り抜きの外で、今まで「人・動物」だった所
  for (let i = 0; i < n; i++) if (!ids[i] && b.type[i] === T.figure) lost[i] = 1;
  { // 背景に戻す：地平線より下は地面の平面。上は、まわり（物でない所）の奥行きをなめらかに伸ばし、種類はいちばん近い画素のもの
    const known = new Uint8Array(n), lz = new Float32Array(n), near = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) if (!lost[i] && !ids[i] && b.z[i] > 0) { known[i] = 1; lz[i] = Math.log(b.z[i]); }
    const f = pullPush(lz, known, W, H);
    for (let y = 0; y < H; y++) { let last = -1; for (let x = 0; x < W; x++) { const i = y * W + x; if (!lost[i] && !ids[i]) last = i; else near[i] = last; } last = -1; for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (!lost[i] && !ids[i]) last = i; else if (last >= 0 && (near[i] < 0 || last - i < i - near[i])) near[i] = last; } }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!lost[i]) continue;
      const zp = zPlane(x, y); cleared++; object[i] = 0;
      if (zp > 0 && zp < far * 2) { type[i] = T.ground; z[i] = zp; continue; }
      const j = near[i]; type[i] = j >= 0 ? b.type[j] : T.sky; z[i] = j >= 0 && b.z[j] > 0 ? Math.exp(f[i]) : 0;
      if (type[i] === T.figure) type[i] = T.tree;
    }
  }
  for (let i = 0; i < n; i++) {
    const id = ids[i]; if (!id) continue; const o = inst.get(id);
    type[i] = o.trunk ? T.tree : T.figure; object[i] = OBJECT_BASE + id;
    if (o.z > 0) { z[i] = o.z; lifted++; }
    else if (!(z[i] > 0)) z[i] = o.zOld > 0 ? o.zOld : far; // 幹で今の奥行きを使うとき、空だった画素だけ埋める
  }
  // 切り抜きの外に残った細い線（傘の柄、杖など）：上の決まりでは地面の奥行きになるが、線の両側が立っている物（人、幹、遠くの群れ）なら、
  // 線だけが遠い芝の奥行きになって、横から見ると物を横切る筋になる。細い所（幅 thin 画素まで）で両側が立っている物なら、近い側の奥行き・種類・番号にする
  let joined = 0;
  {
    const thin = Math.max(6, Math.round(W / 128)), standing = (i, x, y) => { if (lost[i]) return false; if (type[i] === T.ground || type[i] === T.water || type[i] === T.sky || !(z[i] > 0)) return false; const zp = zPlane(x, y); return !(zp > 0) || z[i] < zp * 0.9; };
    const side = (x, y, dx, dy) => { for (let k = 1; k <= thin; k++) { const xx = x + dx * k, yy = y + dy * k; if (xx < 0 || yy < 0 || xx >= W || yy >= H) return null; const j = yy * W + xx; if (!lost[j]) return { j, k, x: xx, y: yy }; } return null; };
    const set = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!lost[i]) continue;
      let best = null;
      for (const [dx, dy] of [[0, 1], [1, 0]]) {
        const p = side(x, y, -dx, -dy), q = side(x, y, dx, dy);
        if (!p || !q || p.k + q.k > thin + 1 || !standing(p.j, p.x, p.y) || !standing(q.j, q.x, q.y)) continue;
        if (!best || p.k + q.k < best.span) best = { span: p.k + q.k, j: p.k <= q.k ? p.j : q.j };
      }
      if (best) set.push(i, best.j);
    }
    for (let k = 0; k < set.length; k += 2) { const i = set[k], j = set[k + 1]; z[i] = z[j]; type[i] = type[j]; object[i] = object[j]; joined++; }
  }
  // ---- 報告 ----
  console.log(`場面 ${a.scene}：切り抜き ${inst.size} 個（人・動物など ${order.filter((o) => !o.trunk).length}、幹 ${order.filter((o) => o.trunk).length}）。板の奥行きにそろえた画素 ${(100 * lifted / n).toFixed(1)}%、物から背景に戻した画素 ${(100 * cleared / n).toFixed(1)}%（そのうち、立っている物にはさまれた細い線なので、その物の奥行きにした画素 ${joined}）`);
  for (const o of order) console.log(`  ${String(o.id).padStart(4)} ${o.cls.padEnd(12)} ${String(o.count).padStart(7)} px  足もとの行 ${String(o.foot).padStart(4)}  今 ${o.zOld ? o.zOld.toFixed(2) : '  - '} m（立っている画素 ${(100 * o.standing).toFixed(0)}%）→ ${o.z ? o.z.toFixed(2) + ' m' : 'そのまま'}  ${o.rule}`);
  if (a.dry) { console.log('--dry：何も書き換えていません。'); return; }
  // ---- 書き出し（前の物は _v1 に残す） ----
  const E = S.E, def = b.def, files = [def.depth, def.depth_view, def.labels, def.objects, def.color].filter(Boolean);
  for (const f of files) { const src = path.join(E, f), keep = path.join(E, f.replace(/\.png$/, '_v1.png')); if (fs.existsSync(src) && !fs.existsSync(keep)) fs.copyFileSync(src, keep); }
  const camsFile = path.join(E, 'cameras.json'); if (!fs.existsSync(camsFile.replace(/\.json$/, '_v1.json'))) fs.copyFileSync(camsFile, camsFile.replace(/\.json$/, '_v1.json'));
  const { near, far: farClip } = S.cams.depth, lab = labelPngs(type, object, n), colors = []; for (const t of types) colors[t.id] = TYPE_COLORS[t.name] || [140, 140, 140];
  await savePng(path.join(E, def.depth), depthPng(z, n, near, farClip), W, H);
  if (def.depth_view) await savePng(path.join(E, def.depth_view), depthViewPng(z, n), W, H);
  await savePng(path.join(E, def.labels), lab.type, W, H);
  await savePng(path.join(E, def.objects), lab.object, W, H);
  if (def.color) await savePng(path.join(E, def.color), typeColorPng(type, z, n, colors), W, H);
  { // 絵に、物の輪郭を線で重ねた絵（確かめる用）
    const out = new Uint8ClampedArray(n * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, edge = (x + 1 < W && (type[i] !== type[i + 1] || object[i] !== object[i + 1])) || (y + 1 < H && (type[i] !== type[i + W] || object[i] !== object[i + W])), c = colors[type[i]] || [140, 140, 140];
      for (let k = 0; k < 3; k++) out[i * 4 + k] = edge ? 255 : b.painted[i * 4 + k] * 0.6 + c[k] * 0.4; out[i * 4 + 3] = 255;
    }
    await savePng(path.join(E, `${name}_overlay.png`), out, W, H);
  }
  const cams = JSON.parse(fs.readFileSync(camsFile, 'utf8'));
  if (cams.labels) {
    const still = new Set(); for (let i = 0; i < n; i++) if (object[i] && object[i] < OBJECT_BASE) still.add(object[i]);
    const figureName = types.find((t) => t.id === T.figure).name, treeName = types.find((t) => t.id === T.tree).name;
    cams.labels.objects = [...(cams.labels.objects || []).filter((o) => still.has(o.id)), ...order.map((o) => ({ id: OBJECT_BASE + o.id, type: o.trunk ? treeName : figureName, class: o.cls, pixels: o.count, bbox: [o.x0, o.y0, o.x1, o.y1], z_foot: +(o.z || o.zOld).toFixed(2) }))];
    cams.labels.relabeled = { instances: path.basename(String(a.instances)), things: order.filter((o) => !o.trunk).length, trunks: order.filter((o) => o.trunk).length };
    fs.writeFileSync(camsFile, JSON.stringify(cams, null, 1));
  }
  console.log(`書き直しました：${files.join('、')}、${name}_overlay.png、cameras.json（前の物は _v1 に残してあります）。`);
}

main().catch((e) => { console.error(`止まりました：${e.message}`); process.exit(1); });
