// 外の道具（SAM 3 など）で切り抜いた物体を、絵から作る場面の「物体」に使う（painting/build.mjs --masks）。
//
// instances.json の形（/opt/psf-ext/sam3/run.sh が書く。docs/object-interaction.md）：
//   { "width", "height", "instances": [ { "label": "person", "score": 0.93, "bbox": [x0, y0, x1, y1], "mask": "mask_000.png" } ] }
//   mask は instances.json と同じフォルダの、8 ビットの白黒の絵（白 = 物体）。絵と大きさが違えば合わせる。
//
// 決め方：
//   1. 点数が minScore 未満、または 150 画素未満の切り抜きは使わない
//   2. 点数の高い順に見て、すでに使う切り抜きと大きく重なる（IoU > 0.6）もの、ほとんど（85%）が 1 つの使う切り抜きの中にあるもの
//      （帽子が人の中にある、など）は、その一部とみなして使わない
//   3. 2 つの切り抜きが重なる画素は、手前（奥行きの中央値が近い）の物体のもの
//   4. mode = 'both' なら、どの切り抜きにも入らなかった「立っているもの」（奥行きで見つけた人・木）も、今までどおり物体にする
//      mode = 'masks' なら切り抜きだけを物体にする（入らなかった所は呼ぶ側で地面・遠景に戻す）
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// 切り抜きの名前 → 種類（painting/build.mjs の TYPES の id）。木は 5、それ以外は「人・動物」と同じ扱いの立っている物（3）。
// 地平線より上にしか無いものは遠景（4）にする（build.mjs と同じ決まり）。
const TREE = /\b(tree|trees|trunk|palm|bush)\b/i;

async function readMask(file, W, H) {
  const { data, info } = await sharp(file).removeAlpha().greyscale().resize(W, H, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = data[i * info.channels] >= 128 ? 1 : 0;
  return m;
}

export async function applyMasks({ file, W, H, zm, stand, objId, list, horizonRow, mode = 'both', minScore = 0.4, components, typeOfComponent, link }) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')), dir = path.dirname(file);
  const raw = (doc.instances || []).filter((x) => x && x.mask && (x.score ?? 1) >= minScore).sort((p, q) => (q.score ?? 1) - (p.score ?? 1));
  const kept = [];
  let dropped = (doc.instances || []).length - raw.length;
  for (const inst of raw) {
    const m = await readMask(path.join(dir, inst.mask), W, H);
    let area = 0; for (let i = 0; i < W * H; i++) area += m[i];
    if (area < 150) { dropped++; continue; }
    let part = false;
    for (const k of kept) {
      let inter = 0; for (let i = 0; i < W * H; i++) if (m[i] && k.m[i]) inter++;
      if (inter / (area + k.area - inter) > 0.6 || inter / area > 0.85) { part = true; break; }
    }
    if (part) { dropped++; continue; }
    const zs = []; for (let i = 0; i < W * H; i += 3) if (m[i]) zs.push(zm[i]);
    zs.sort((p, q) => p - q);
    kept.push({ ...inst, m, area, depth: zs.length ? zs[zs.length >> 1] : 1e9 });
  }
  // 重なる画素は手前の物体のもの
  const owner = new Int32Array(W * H), depthAt = new Float32Array(W * H).fill(Infinity);
  kept.forEach((k, n) => { for (let i = 0; i < W * H; i++) if (k.m[i] && k.depth < depthAt[i]) { depthAt[i] = k.depth; owner[i] = n + 1; } });
  const out = [], id = new Int32Array(W * H);
  kept.forEach((k, n) => {
    const c = { id: out.length + 1, count: 0, x0: W, x1: 0, y0: H, y1: 0, footIndex: 0, label: String(k.label || 'object'), score: Math.round((k.score ?? 1) * 1000) / 1000, source: 'mask' };
    for (let i = 0; i < W * H; i++) {
      if (owner[i] !== n + 1) continue;
      const x = i % W, y = (i / W) | 0; id[i] = c.id; c.count++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) { c.y1 = y; c.footIndex = i; }
    }
    if (!c.count) { dropped++; return; }
    c.type = TREE.test(c.label) ? 5 : c.y1 <= horizonRow + 2 ? 4 : 3;
    out.push(c);
  });
  const used = out.length;
  // 切り抜きに入らなかった「立っているもの」
  let rest = 0;
  if (mode !== 'masks') {
    const left = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) left[i] = stand[i] && !id[i] ? 1 : 0;
    const r = components(left, W, H, link), base = out.length;
    for (const c of r.list) { c.type = typeOfComponent(c); c.source = 'depth'; c.id += base; out.push(c); rest++; }
    for (let i = 0; i < W * H; i++) if (r.id[i]) id[i] = r.id[i] + base;
  }
  return { objId: id, list: out, info: { used, dropped, rest, mode, minScore, labels: [...new Set(out.filter((c) => c.label).map((c) => c.label))] } };
}
