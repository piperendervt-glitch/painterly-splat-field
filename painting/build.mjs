// 実在の絵 1 枚から、歩ける粒の空間の元データ（プレビズの書き出しと同じ形式）を作る。
//   node build.mjs --image <絵> --scene <名前> [--horizon 0.2] [--eye 1.6] [--hfov 60] [--crop 0.012] [--width 1536]
// 出力（../scenes/<名前>/）:
//   previz-export/cameras.json, J_depth.png（16bit 奥行き）, J_color.png（プレビズ＝種類ごとの色と陰）,
//   J_depth_view.png, J_labels.png（種類）, J_objects.png（物体番号）, J_overlay.png（絵とプレビズの輪郭）
//   paint-out/J_painted.png（絵そのもの）
// 考え方:
//   1. Depth Anything V2 Small（Apache-2.0）で「近さ」（視差。尺度とずれが不明）を得る
//   2. 地平線の高さと目の高さを決めると、地面の奥行きは行ごとに計算で決まる（1/z = (行 - 地平線) / (f * 目の高さ)）
//   3. 地面らしい画素の視差がその式に乗るように尺度とずれを合わせ、地面以外（人・木）の奥行きをメートルに直す
//   4. 人や木は、足もとの行から決まる奥行きに立つ板（ビルボード）にそろえる
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { disparity } from './depthmodel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEAR = 0.5, FAR = 2000, FAR_CLAMP = 400;

export const TYPES = [
  { id: 0, name: 'sky', ja: '空', color: [185, 199, 207] },
  { id: 1, name: 'ground', ja: '地面', color: [124, 154, 72] },
  { id: 2, name: 'water', ja: '水', color: [106, 140, 190] },
  { id: 3, name: 'figure', ja: '人・動物', color: [190, 120, 90] },
  { id: 4, name: 'far', ja: '遠景', color: [150, 170, 150] },
  { id: 5, name: 'tree', ja: '木', color: [70, 110, 60] },
];

function args() {
  const a = { horizon: 0.2, eye: 1.7, hfov: 60, crop: 0.012, width: 1536, scene: 'scene', sky: 0.8, edge: 0.05 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = isNaN(Number(v[i + 1])) ? v[i + 1] : Number(v[i + 1]);
  if (!a.image) { console.error('--image <絵のファイル> を指定してください'); process.exit(1); }
  return a;
}

// 連結成分（4近傍）。mask が 1 の画素に 1 からの番号を振る。
function components(mask, W, H, link) {
  const id = new Int32Array(W * H), stack = new Int32Array(W * H), list = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || id[s]) continue;
    const n = list.length + 1, c = { id: n, count: 0, x0: W, x1: 0, y0: H, y1: 0, footIndex: s };
    let top = 0; stack[top++] = s; id[s] = n;
    while (top) {
      const i = stack[--top], x = i % W, y = (i / W) | 0;
      c.count++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) { c.y1 = y; c.footIndex = i; }
      if (x > 0 && mask[i - 1] && !id[i - 1] && (!link || link(i, i - 1))) { id[i - 1] = n; stack[top++] = i - 1; }
      if (x + 1 < W && mask[i + 1] && !id[i + 1] && (!link || link(i, i + 1))) { id[i + 1] = n; stack[top++] = i + 1; }
      if (y > 0 && mask[i - W] && !id[i - W] && (!link || link(i, i - W))) { id[i - W] = n; stack[top++] = i - W; }
      if (y + 1 < H && mask[i + W] && !id[i + W] && (!link || link(i, i + W))) { id[i + W] = n; stack[top++] = i + W; }
    }
    list.push(c);
  }
  return { id, list };
}

// 奥行きの境目のぼけを取る：周りの最小と最大がはっきり違う画素は、近いほうの値に寄せる。
function sharpen(d, W, H, R) {
  const pass = (src, fn, horizontal) => {
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = src[y * W + x];
      for (let k = -R; k <= R; k++) { const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k; if (xx >= 0 && xx < W && yy >= 0 && yy < H) v = fn(v, src[yy * W + xx]); }
      out[y * W + x] = v;
    }
    return out;
  };
  const lo = pass(pass(d, Math.min, true), Math.min, false), hi = pass(pass(d, Math.max, true), Math.max, false), out = new Float32Array(W * H);
  let range = 0; for (let i = 0; i < W * H; i++) if (d[i] > range) range = d[i];
  for (let i = 0; i < W * H; i++) out[i] = hi[i] - lo[i] > range * 0.04 ? (d[i] - lo[i] < hi[i] - d[i] ? lo[i] : hi[i]) : d[i];
  return out;
}

const png = (buf, W, H, ch, file) => sharp(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), { raw: { width: W, height: H, channels: ch } }).png().toFile(file);

async function main() {
  const a = args();
  const outP = path.join(HERE, '..', 'scenes', String(a.scene), 'previz-export'), outQ = path.join(HERE, '..', 'scenes', String(a.scene), 'paint-out');
  fs.mkdirSync(outP, { recursive: true }); fs.mkdirSync(outQ, { recursive: true });

  // ---- 絵を読む（額縁代わりの点描の縁を切り落とす） ----
  const meta = await sharp(a.image).metadata();
  const cx0 = Math.round(meta.width * a.crop), cy0 = Math.round(meta.height * a.crop * meta.width / meta.height);
  const cw = meta.width - 2 * cx0, chh = meta.height - 2 * cy0;
  const W = a.width, H = Math.round(W * chh / cw / 2) * 2;
  const img = sharp(a.image).extract({ left: cx0, top: cy0, width: cw, height: chh }).resize(W, H, { fit: 'fill' }).removeAlpha();
  const rgb = await img.clone().raw().toBuffer();
  console.log(`絵: ${meta.width}x${meta.height} → ${W}x${H}`);

  const disp = sharpen(await disparity(img, W, H), W, H, 4);

  // ---- カメラ：水平に向け、地平線の行を光学中心にする（絵の中の地平線は中央より上にある） ----
  const f = W / 2 / Math.tan(a.hfov * Math.PI / 360), cx = W / 2, cy = a.horizon * H, eye = a.eye;
  const zPlaneRaw = (y) => f * eye / (y + 0.5 - cy); // 地面の画素（行 y）の奥行き
  let zCap = FAR_CLAMP; const zPlane = (y) => Math.min(zPlaneRaw(y), zCap); // 地平線の近くは最遠で頭打ち

  // ---- 地面の視差を「行に比例」の式に合わせる ----
  // 各行の低いほう（25%点）を地面とみなし、直線 disp = s * (行 - 地平線) + b を合わせる。外れを落として 3 回くり返す。
  const rows = [];
  for (let y = Math.ceil(cy + H * 0.04); y < H; y += 2) {
    const r = Array.from(disp.subarray(y * W, y * W + W)).sort((p, q) => p - q);
    rows.push([y + 0.5 - cy, r[(W * 0.25) | 0]]);
  }
  let s = 0, b = 0, use = rows;
  for (let it = 0; it < 3; it++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = use.length;
    for (const [x, y] of use) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    s = (n * sxy - sx * sy) / (n * sxx - sx * sx); b = (sy - s * sx) / n;
    const res = use.map(([x, y]) => Math.abs(y - s * x - b)).sort((p, q) => p - q), lim = res[(res.length * 0.8) | 0] * 1.5 + 1e-6;
    use = use.filter(([x, y]) => Math.abs(y - s * x - b) <= lim);
  }
  const scale = s * f * eye; // disp = scale / z + b
  const zModel = (d) => (d - b > scale / FAR_CLAMP ? scale / (d - b) : FAR_CLAMP);
  // モデルが「無限に遠い」とした所（視差 0）は、この合わせでは zInf メートルになる。それに近い所を空・遠景とする。
  const zInf = b < 0 ? Math.min(FAR_CLAMP, scale / -b) : FAR_CLAMP, skyZ = zInf * a.sky;
  zCap = zInf * 0.9;
  console.log(`地面の合わせ: 傾き ${s.toFixed(5)} ずれ ${b.toFixed(3)} 最遠 ${zInf.toFixed(0)}m / 焦点距離 ${f.toFixed(0)}px 地平線の行 ${cy.toFixed(0)}`);

  // ---- 種類分け ----
  // 点描なので、色で見分けるときは周りをならした色を使う。
  const soft = await img.clone().blur(6).raw().toBuffer();
  const type = new Uint8Array(W * H), z = new Float32Array(W * H), horizonRow = Math.floor(cy);
  const stand = new Uint8Array(W * H); // 地面から立っているもの（人・動物・木）
  const blue = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, r = soft[i * 3], g = soft[i * 3 + 1], bl = soft[i * 3 + 2], zm = zModel(disp[i]);
    const bluish = bl > g * 0.97 && bl > r * 1.02, pale = r + g + bl > 500 && Math.max(r, g, bl) - Math.min(r, g, bl) < 50;
    if (y <= horizonRow + 2) {
      if (zm >= skyZ && (bluish || pale)) { type[i] = 0; z[i] = 0; }  // 空
      else if (zm < skyZ) stand[i] = 1;                                // 木・人の頭など
      else { type[i] = 4; z[i] = Math.min(zm, 150); }                    // 遠景
    } else {
      const zp = zPlane(y);
      if (zm < zp * 0.85 && zp - zm > 0.2) stand[i] = 1;
      else { type[i] = 1; z[i] = Math.min(zp, FAR_CLAMP); blue[i] = bluish && zp > 5 ? 1 : 0; }
    }
  }
  // 立っているものを、足もと（その奥行きが地面の式と交わる行）まで下へ伸ばす。
  for (let x = 0; x < W; x++) {
    let zObj = 0;
    for (let y = horizonRow + 3; y < H; y++) {
      const i = y * W + x, zm = zModel(disp[i]);
      if (stand[i]) { zObj = zm; continue; }
      if (zObj && zm < zObj * 1.04 && zPlane(y) > zObj * 0.97) { stand[i] = 1; blue[i] = 0; } else zObj = 0;
    }
  }
  // 水：青い地面のうち、いちばん大きなかたまりだけ（草の上の青い影を水にしない）。
  {
    const { id, list } = components(blue, W, H, null);
    const big = list.reduce((m, c) => (c.count > m.count ? c : m), { count: 0, id: -1 });
    for (let i = 0; i < W * H; i++) if (blue[i] && id[i] === big.id) type[i] = 2;
  }

  // ---- 立っているものを物体に分ける（奥行きが急に変わる所では繋げない） ----
  const zm = new Float32Array(W * H); for (let i = 0; i < W * H; i++) zm[i] = zModel(disp[i]);
  const { id: objId, list } = components(stand, W, H, (i, j) => Math.abs(Math.log(zm[i] / zm[j])) < a.edge);
  const objects = [];
  for (const c of list) {
    const tree = c.y0 <= H * 0.03 && c.y1 - c.y0 > H * 0.3;
    c.type = tree ? 5 : c.y1 <= horizonRow + 2 ? 4 : 3;
    if (c.count >= 150) objects.push({ id: c.id, type: TYPES[c.type].name, pixels: c.count, bbox: [c.x0, c.y0, c.x1, c.y1], z_foot: +zm[c.footIndex].toFixed(2) });
  }
  for (let i = 0; i < W * H; i++) if (stand[i]) { type[i] = list[objId[i] - 1].type; z[i] = Math.max(NEAR * 1.5, Math.min(zm[i], 150)); }
  console.log(`物体 ${list.length} 個（150 画素以上は ${objects.length} 個）`);

  // ---- 書き出し ----
  const depthPng = new Uint8Array(W * H * 3), view = new Uint8Array(W * H), labels = new Uint8Array(W * H), objPng = new Uint8Array(W * H * 3);
  const previz = new Uint8Array(W * H * 3), overlay = new Uint8Array(W * H * 3);
  const k0 = 1 / NEAR - 1 / FAR;
  for (let i = 0; i < W * H; i++) {
    const zz = z[i], v = zz ? Math.max(1, Math.min(65535, Math.round((1 / zz - 1 / FAR) / k0 * 65535))) : 0;
    depthPng[i * 3] = v >> 8; depthPng[i * 3 + 1] = v & 255;
    const gray = zz ? Math.max(0, Math.min(1, 1 - Math.log(zz / 1) / Math.log(FAR_CLAMP / 1))) : 0;
    view[i] = gray * 255; labels[i] = type[i];
    const o = stand[i] ? objId[i] : 0;
    objPng[i * 3] = o & 255; objPng[i * 3 + 1] = (o >> 8) & 255;
    const col = TYPES[type[i]].color, shade = type[i] === 0 ? 1 : 0.55 + 0.45 * gray;
    for (let c = 0; c < 3; c++) previz[i * 3 + c] = col[c] * shade;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { // 絵に、種類の境目を線で重ねる
    const i = y * W + x, edge = (x + 1 < W && (type[i] !== type[i + 1] || objId[i] !== objId[i + 1])) || (y + 1 < H && (type[i] !== type[i + W] || objId[i] !== objId[i + W]));
    const col = TYPES[type[i]].color;
    for (let c = 0; c < 3; c++) overlay[i * 3 + c] = edge ? 255 : rgb[i * 3 + c] * 0.6 + col[c] * 0.4;
  }
  await png(depthPng, W, H, 3, path.join(outP, 'J_depth.png'));
  await png(view, W, H, 1, path.join(outP, 'J_depth_view.png'));
  await png(labels, W, H, 1, path.join(outP, 'J_labels.png'));
  await png(objPng, W, H, 3, path.join(outP, 'J_objects.png'));
  await png(previz, W, H, 3, path.join(outP, 'J_color.png'));
  await png(overlay, W, H, 3, path.join(outP, 'J_overlay.png'));
  await img.clone().png().toFile(path.join(outQ, 'J_painted.png'));

  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const cams = {
    generator: 'painterly-splat-field painting/build.mjs',
    source: { kind: 'painting', image: path.basename(String(a.image)), crop: a.crop, params: { horizon: a.horizon, eye: a.eye, hfov: a.hfov } },
    units: 'meters', world: 'right-handed, +Y up',
    camera_axes: 'three.js / OpenGL: +X right, +Y up, camera looks down -Z',
    pixel_coords: 'origin at top-left, +x right, +y down, pixel centers at +0.5',
    projection: 'x_cam = (px - cx) / fx * z, y_cam = -(py - cy) / fy * z, z_cam = -z, then world = camera_to_world * [x_cam, y_cam, z_cam, 1]',
    depth: {
      encoding: 'normalized_inverse_z_uint16', png: 'value = R * 256 + G (B is unused), d = value / 65535',
      d_from_z: 'd = (1/z - 1/far) / (1/near - 1/far)', z_from_d: 'z = 1 / (d * (1/near - 1/far) + 1/far)',
      z_meaning: 'distance along the camera forward axis in meters (not ray length)', background: 'value 0 = sky / nothing rendered', near: NEAR, far: FAR,
    },
    labels: { png: 'J_labels.png: 8bit gray = type id', objects_png: 'J_objects.png: object id = R + G * 256 (0 = none)', types: TYPES.map(({ id, name, ja }) => ({ id, name, ja })) },
    views: [{
      name: 'J', color: 'J_color.png', depth: 'J_depth.png', depth_view: 'J_depth_view.png', labels: 'J_labels.png', objects: 'J_objects.png',
      width: W, height: H,
      intrinsics: { fx: r6(f), fy: r6(f), cx: r6(cx), cy: r6(cy), fov_y_deg: r6(2 * Math.atan(H / 2 / f) * 180 / Math.PI), K: [[r6(f), 0, r6(cx)], [0, r6(f), r6(cy)], [0, 0, 1]] },
      extrinsics: {
        position: [0, eye, 0], target: [0, eye, -10],
        camera_to_world: [[1, 0, 0, 0], [0, 1, 0, eye], [0, 0, 1, 0], [0, 0, 0, 1]],
        world_to_camera: [[1, 0, 0, 0], [0, 1, 0, -eye], [0, 0, 1, 0], [0, 0, 0, 1]],
      },
    }],
    objects,
  };
  fs.writeFileSync(path.join(outP, 'cameras.json'), JSON.stringify(cams, null, 1));
  console.log(`書き出しました: ${path.relative(process.cwd(), path.join(outP, '..'))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
