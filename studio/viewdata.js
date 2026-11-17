// 「視点を足す」で使う計算：書き出した視点の読み込み、プレビズの形への当たり判定、
// 「ある点がすでに描かれた視点から見えているか」の判定。3D の描画は使わず、すべて CPU で計算する。
import * as THREE from 'three/webgpu';
import { buildScene } from '../previz/scene.js';

export async function loadImage(url, w, h) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} を読めませんでした`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

/** cameras.json と各視点の奥行き・絵画を読む。 */
export async function loadViews() {
  const [camsRes, stateRes] = await Promise.all([fetch('/files/previz-export/cameras.json', { cache: 'no-store' }), fetch('/api/state', { cache: 'no-store' })]);
  if (!camsRes.ok) throw new Error('プレビズの書き出しがまだありません。「プレビズ」のタブで「previz-export に保存」を押してください。');
  const cams = await camsRes.json(), state = await stateRes.json();
  const { near, far } = cams.depth;
  const views = [];
  for (const def of cams.views) {
    const st = state.views.find((s) => s.name === def.name) || {};
    const W = def.width, H = def.height;
    const depthPx = await loadImage(`/files/previz-export/${def.depth}`, W, H);
    const z = new Float32Array(W * H); // 0 = 空
    for (let i = 0; i < W * H; i++) {
      const value = depthPx[i * 4] * 256 + depthPx[i * 4 + 1];
      z[i] = value ? 1 / (value / 65535 * (1 / near - 1 / far) + 1 / far) : 0;
    }
    views.push({
      def, name: def.name, W, H, z, st,
      added: !!st.new_mask || !!st.reproj, // 「視点を足す」で足した視点
      painted: st.painted ? await loadImage(`/files/paint-out/${def.name}_painted.png`, W, H) : null,
      c2w: def.extrinsics.camera_to_world.flat(), w2c: def.extrinsics.world_to_camera.flat(), // 行ごとに並んだ 4x4
      ...def.intrinsics,
    });
  }
  return { cams, state, views };
}

/** 位置と見る先から、カメラの向き（右・上・前）を作る。three.js の lookAt と同じで、傾きは付けない。 */
export function cameraBasis(position, target) {
  const f = new THREE.Vector3().fromArray(target).sub(new THREE.Vector3().fromArray(position)).normalize();
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
  if (r.lengthSq() < 1e-8) r.set(1, 0, 0);
  r.normalize();
  const u = new THREE.Vector3().crossVectors(r, f);
  return { r: r.toArray(), u: u.toArray(), f: f.toArray() };
}

/** プレビズの形を三角形の並びにする（ワールド座標）。形ごとに範囲と外接の箱も持つ。 */
export function sceneTriangles() {
  const scene = buildScene(); scene.updateMatrixWorld(true);
  const meshes = [], v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position, index = o.geometry.index, n = index ? index.count : pos.count;
    const tri = new Float32Array(n * 3), box = new THREE.Box3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(o.matrixWorld);
      tri[i * 3] = v.x; tri[i * 3 + 1] = v.y; tri[i * 3 + 2] = v.z; box.expandByPoint(v);
    }
    let name = o.name; for (let p = o.parent; !name && p; p = p.parent) name = p.name;
    meshes.push({ name, tri, min: box.min.toArray(), max: box.max.toArray(), ground: name === 'ground' });
  });
  return meshes;
}

// 光線（原点 o、向き d。d の長さはそのまま）と形の当たり。いちばん手前の t を返す（無ければ Infinity）。
export function castRay(meshes, ox, oy, oz, dx, dy, dz) {
  let best = Infinity; castRay.hit = null; // castRay.hit に、当たった形を残す
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  for (const m of meshes) {
    // 外接の箱に当たらなければ飛ばす
    let t0 = (m.min[0] - ox) * ix, t1 = (m.max[0] - ox) * ix; if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    let a = (m.min[1] - oy) * iy, b = (m.max[1] - oy) * iy; if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a; if (b < t1) t1 = b;
    a = (m.min[2] - oz) * iz; b = (m.max[2] - oz) * iz; if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a; if (b < t1) t1 = b;
    if (!(t1 >= Math.max(t0, 0) - 1e-6) || t0 > best) continue;
    const T = m.tri;
    for (let i = 0; i < T.length; i += 9) {
      const e1x = T[i + 3] - T[i], e1y = T[i + 4] - T[i + 1], e1z = T[i + 5] - T[i + 2];
      const e2x = T[i + 6] - T[i], e2y = T[i + 7] - T[i + 1], e2z = T[i + 8] - T[i + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det, sx = ox - T[i], sy = oy - T[i + 1], sz = oz - T[i + 2];
      const u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const w = (dx * qx + dy * qy + dz * qz) * inv; if (w < 0 || u + w > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-4 && t < best) { best = t; castRay.hit = m; }
    }
  }
  return best;
}

const TOL = 0.03; // 奥行きがこの割合まで合っていれば「同じ面が見えている」とみなす

/** ワールドの点 (x,y,z) が、絵のある視点 v から見えているか。見えていれば画素の位置 [px, py] を out に入れて true。 */
export function seenBy(v, x, y, z, out) {
  const m = v.w2c;
  const cx = m[0] * x + m[1] * y + m[2] * z + m[3], cy = m[4] * x + m[5] * y + m[6] * z + m[7], zc = -(m[8] * x + m[9] * y + m[10] * z + m[11]);
  if (zc <= 0.05) return false;
  const px = v.cx + cx / zc * v.fx - 0.5, py = v.cy - cy / zc * v.fy - 0.5;
  const ix = Math.round(px), iy = Math.round(py);
  if (ix < 0 || iy < 0 || ix >= v.W || iy >= v.H) return false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { // 縁のずれを許すため、隣の画素も見る
    const qx = ix + dx, qy = iy + dy; if (qx < 0 || qy < 0 || qx >= v.W || qy >= v.H) continue;
    const zk = v.z[qy * v.W + qx];
    if (zk !== 0 && Math.abs(zk - zc) < TOL * zc + 0.02) { out[0] = px; out[1] = py; return true; }
  }
  return false;
}
/** 空の向き (dx,dy,dz) が、視点 v の絵の空の所に写っているか。 */
export function skySeenBy(v, dx, dy, dz, out) {
  const m = v.w2c;
  const cx = m[0] * dx + m[1] * dy + m[2] * dz, cy = m[4] * dx + m[5] * dy + m[6] * dz, zc = -(m[8] * dx + m[9] * dy + m[10] * dz);
  if (zc <= 1e-6) return false;
  const px = v.cx + cx / zc * v.fx - 0.5, py = v.cy - cy / zc * v.fy - 0.5;
  const ix = Math.round(px), iy = Math.round(py);
  if (ix < 1 || iy < 1 || ix >= v.W - 1 || iy >= v.H - 1 || v.z[iy * v.W + ix] !== 0) return false;
  out[0] = px; out[1] = py; return true;
}
/** 絵の (px,py) の色を、隣の画素となめらかに混ぜて取る。 */
export function sample(img, W, H, px, py, out, o) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(px))), y0 = Math.max(0, Math.min(H - 1, Math.floor(py)));
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = Math.max(0, Math.min(1, px - x0)), fy = Math.max(0, Math.min(1, py - y0));
  for (let c = 0; c < 3; c++) {
    const a = img[(y0 * W + x0) * 4 + c], b = img[(y0 * W + x1) * 4 + c], d = img[(y1 * W + x0) * 4 + c], e = img[(y1 * W + x1) * 4 + c];
    out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
}

export const HOLE = [255, 0, 255], SKY_HOLE = [150, 0, 190];
export const VIEW_TINTS = [[255, 162, 58], [79, 210, 255], [199, 140, 255], [153, 230, 102], [255, 111, 145], [255, 224, 102]];

/**
 * 候補のカメラから低い解像度で光線を飛ばし、見える面のうち、まだどの絵にも描かれていない所（穴）を調べる。
 * 戻り値：{ rgba（穴はマゼンタ。mode='source' なら、どの視点の絵で埋まるかの色）, w, h, surface, holes, solidHoles（地面以外の穴）, sky, skyHoles, covered }
 */
export function analyze({ meshes, views, position, target, fovY, w, h, maxDist = 250, mode = 'painted', wantImage = true }) {
  const { r, u, f } = cameraBasis(position, target);
  const fy = (h / 2) / Math.tan(fovY * Math.PI / 360), cx = w / 2, cy = h / 2;
  const painted = views.filter((v) => v.painted);
  const rgba = wantImage ? new Uint8ClampedArray(w * h * 4) : null, at = [0, 0], col = [0, 0, 0];
  let surface = 0, holes = 0, sky = 0, skyHoles = 0, covered = 0, solidHoles = 0;
  const [ox, oy, oz] = position;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (x + 0.5 - cx) / fy, b = -(y + 0.5 - cy) / fy;
    const dx = r[0] * a + u[0] * b + f[0], dy = r[1] * a + u[1] * b + f[1], dz = r[2] * a + u[2] * b + f[2];
    const t = castRay(meshes, ox, oy, oz, dx, dy, dz); // 向きの「前」成分が 1 なので、t はそのままカメラの向きに沿った距離
    const isSky = !(t < 2000), onGround = !isSky && castRay.hit.ground;
    let by = -1;
    for (let k = 0; k < painted.length && by < 0; k++) {
      if (isSky ? skySeenBy(painted[k], dx, dy, dz, at) : seenBy(painted[k], ox + dx * t, oy + dy * t, oz + dz * t, at)) by = k;
    }
    if (isSky) { sky++; if (by < 0) skyHoles++; } else if (t <= maxDist) { surface++; if (by < 0) { holes++; if (!onGround) solidHoles++; } }
    if (by >= 0) covered++;
    if (!rgba) continue;
    const o = (y * w + x) * 4;
    if (by < 0) { const c = isSky ? SKY_HOLE : HOLE; rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; }
    else {
      const v = painted[by]; sample(v.painted, v.W, v.H, at[0], at[1], col, 0);
      if (mode === 'source') { const tint = VIEW_TINTS[views.indexOf(v) % VIEW_TINTS.length], l = 0.35 + 0.65 * (0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2]) / 255; rgba[o] = tint[0] * l; rgba[o + 1] = tint[1] * l; rgba[o + 2] = tint[2] * l; }
      else { rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]; }
    }
    rgba[o + 3] = 255;
  }
  return { rgba, w, h, surface, holes, solidHoles, sky, skyHoles, covered };
}

/**
 * 足した視点 v（奥行きは書き出し済み）へ、すでにある絵を写す。写せなかった画素が穴。
 * 戻り値：{ reproj（写した絵。穴は灰色）, holes（白＝穴）, holeCount }
 */
export function warpInto(v, sources) {
  const { W, H, z, c2w: m } = v, n = W * H;
  const reproj = new Uint8ClampedArray(n * 4), hole = new Uint8Array(n), at = [0, 0], col = [0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, zz = z[i], a = (x + 0.5 - v.cx) / v.fx, b = -(y + 0.5 - v.cy) / v.fy;
    let src = null;
    if (zz === 0) { // 空：向きだけで探す
      const dx = m[0] * a + m[1] * b - m[2], dy = m[4] * a + m[5] * b - m[6], dz = m[8] * a + m[9] * b - m[10];
      for (const s of sources) if (skySeenBy(s, dx, dy, dz, at)) { src = s; break; }
    } else {
      const xc = a * zz, yc = b * zz, zc = -zz;
      const wx = m[0] * xc + m[1] * yc + m[2] * zc + m[3], wy = m[4] * xc + m[5] * yc + m[6] * zc + m[7], wz = m[8] * xc + m[9] * yc + m[10] * zc + m[11];
      for (const s of sources) if (seenBy(s, wx, wy, wz, at)) { src = s; break; }
    }
    const o = i * 4; reproj[o + 3] = 255;
    if (src) { sample(src.painted, src.W, src.H, at[0], at[1], col, 0); reproj[o] = col[0]; reproj[o + 1] = col[1]; reproj[o + 2] = col[2]; }
    else { hole[i] = 1; reproj[o] = reproj[o + 1] = reproj[o + 2] = 128; }
  }
  // 1〜2 画素だけの穴（奥行きの誤差で出る点々）は、まわりの色で埋めて穴から外す
  const cleaned = hole.slice();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!hole[i]) continue;
    let near = 0, r = 0, g = 0, b = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = i + dy * W + dx; if (hole[j]) near++; else { r += reproj[j * 4]; g += reproj[j * 4 + 1]; b += reproj[j * 4 + 2]; k++; }
    }
    if (near <= 3 && k) { cleaned[i] = 0; reproj[i * 4] = r / k; reproj[i * 4 + 1] = g / k; reproj[i * 4 + 2] = b / k; }
  }
  const holes = new Uint8ClampedArray(n * 4); let holeCount = 0;
  for (let i = 0; i < n; i++) { const c = cleaned[i] ? 255 : 0; holes[i * 4] = holes[i * 4 + 1] = holes[i * 4 + 2] = c; holes[i * 4 + 3] = 255; holeCount += cleaned[i]; }
  return { reproj, holes, holeCount };
}

// ---- ツール内の穴埋め ----
const BINS = 8;
// 画素 (x,y) の、ワールドでの点（空なら向き）を out に入れる。空なら false。
function worldAt(v, x, y, out) {
  const m = v.c2w, zz = v.z[y * v.W + x], a = (x + 0.5 - v.cx) / v.fx, b = -(y + 0.5 - v.cy) / v.fy;
  if (zz === 0) { out[0] = m[0] * a + m[1] * b - m[2]; out[1] = m[4] * a + m[5] * b - m[6]; out[2] = m[8] * a + m[9] * b - m[10]; return false; }
  const xc = a * zz, yc = b * zz, zc = -zz;
  out[0] = m[0] * xc + m[1] * yc + m[2] * zc + m[3]; out[1] = m[4] * xc + m[5] * yc + m[6] * zc + m[7]; out[2] = m[8] * xc + m[9] * yc + m[10] * zc + m[11];
  return true;
}
// 点がどの形の上にあるか（形の名前ごとの箱で判断）と、その中での高さの段。空は見上げる角度の段。
function classify(boxes, isSurface, p) {
  if (!isSurface) { const e = p[1] / Math.hypot(p[0], p[1], p[2]); return `sky:${Math.max(0, Math.min(BINS - 1, Math.floor((e + 0.2) / 1.2 * BINS)))}`; }
  for (const b of boxes) {
    if (p[0] < b.min[0] - 0.3 || p[0] > b.max[0] + 0.3 || p[1] < b.min[1] - 0.3 || p[1] > b.max[1] + 0.3 || p[2] < b.min[2] - 0.3 || p[2] > b.max[2] + 0.3) continue;
    const t = (p[1] - b.min[1]) / Math.max(1e-6, b.max[1] - b.min[1]);
    return `${b.name}:${Math.max(0, Math.min(BINS - 1, Math.floor(t * BINS)))}`;
  }
  return 'other:0';
}
function nameBoxes(meshes) {
  const by = new Map();
  for (const m of meshes) {
    const b = by.get(m.name) || { name: m.name, ground: m.ground, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < 3; i++) { b.min[i] = Math.min(b.min[i], m.min[i]); b.max[i] = Math.max(b.max[i], m.max[i]); }
    by.set(m.name, b);
  }
  return [...by.values()].sort((a, b) => a.ground - b.ground); // 地面は最後に見る
}
// すでにある絵から「形ごと・高さの段ごとの平均の色」を集める。
function buildPalette(boxes, sources) {
  const sum = new Map(), p = [0, 0, 0];
  for (const s of sources) for (let y = 4; y < s.H; y += 8) for (let x = 4; x < s.W; x += 8) {
    const key = classify(boxes, worldAt(s, x, y, p), p), o = (y * s.W + x) * 4;
    const e = sum.get(key) || [0, 0, 0, 0]; e[0] += s.painted[o]; e[1] += s.painted[o + 1]; e[2] += s.painted[o + 2]; e[3]++; sum.set(key, e);
  }
  const lookup = (key) => {
    let e = sum.get(key);
    if (!e) { // 同じ形のいちばん近い段、無ければ全体の平均
      const [name, bin] = key.split(':'); let bestD = Infinity;
      for (const [k, v] of sum) { const [n2, b2] = k.split(':'); const d = n2 === name ? Math.abs(b2 - bin) : Infinity; if (d < bestD) { bestD = d; e = v; } }
      if (!e) { e = [0, 0, 0, 0]; for (const [k, v] of sum) if (k.startsWith('sky') === key.startsWith('sky')) { e[0] += v[0]; e[1] += v[1]; e[2] += v[2]; e[3] += v[3]; } }
      if (!e[3]) e = [128, 128, 128, 1];
      sum.set(key, e);
    }
    return e;
  };
  return lookup;
}

/**
 * ツール内の穴埋め（ChatGPT を呼ばない）。
 *  1. 穴のまわりの色を、同じ面の中だけで穴の内側へ広げる。「同じ面」は奥行きが連続していること
 *     （隣との距離の比が小さい、または両方とも空）で判断するので、空の色が柱に、柱の色が空ににじまない。
 *  2. どこからも届かない所（丸ごと見えていなかった面や空）は、すでにある絵の「同じ形・同じ高さの平均の色」で塗る。
 *  3. 穴の中だけ、同じ面の隣どうしでならす。
 * 新しい模様は作れないので、広い穴はのっぺりした色になる。
 */
export function localFill(v, reproj, holes, { meshes, sources, smoothPasses = 40 }) {
  const { W, H, z } = v, n = W * H;
  const out = new Uint8ClampedArray(reproj), todo = new Uint8Array(n);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { todo[i] = holes[i * 4] > 127 ? 1 : 0; col[i * 3] = reproj[i * 4]; col[i * 3 + 1] = reproj[i * 4 + 1]; col[i * 3 + 2] = reproj[i * 4 + 2]; }
  const same = (a, b) => (z[a] === 0 ? z[b] === 0 : z[b] !== 0 && Math.abs(Math.log(z[a] / z[b])) < 0.1);
  const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let front = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (todo[i]) continue;
    for (const [dx, dy] of STEPS) { const qx = x + dx, qy = y + dy; if (qx >= 0 && qy >= 0 && qx < W && qy < H && todo[qy * W + qx]) { front.push(i); break; } }
  }
  while (front.length) {
    const next = [];
    for (const i of front) {
      const x = i % W, y = (i - x) / W;
      for (const [dx, dy] of STEPS) {
        const qx = x + dx, qy = y + dy; if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
        const j = qy * W + qx; if (!todo[j] || !same(i, j)) continue;
        todo[j] = 0; col[j * 3] = col[i * 3]; col[j * 3 + 1] = col[i * 3 + 1]; col[j * 3 + 2] = col[i * 3 + 2]; next.push(j);
      }
    }
    front = next;
  }
  const boxes = nameBoxes(meshes), palette = buildPalette(boxes, sources), p = [0, 0, 0];
  let fromPalette = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!todo[i]) continue;
    const e = palette(classify(boxes, worldAt(v, x, y, p), p));
    col[i * 3] = e[0] / e[3]; col[i * 3 + 1] = e[1] / e[3]; col[i * 3 + 2] = e[2] / e[3]; fromPalette++;
  }
  // ならす（穴の中だけ、同じ面の隣とだけ平均を取る）
  const idx = []; for (let i = 0; i < n; i++) if (holes[i * 4] > 127) idx.push(i);
  const tmp = new Float32Array(idx.length * 3);
  for (let pass = 0; pass < smoothPasses; pass++) {
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], x = i % W, y = (i - x) / W;
      let r = col[i * 3], g = col[i * 3 + 1], b = col[i * 3 + 2], c = 1;
      for (const [dx, dy] of STEPS) {
        const qx = x + dx, qy = y + dy; if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
        const j = qy * W + qx; if (!same(i, j)) continue;
        r += col[j * 3]; g += col[j * 3 + 1]; b += col[j * 3 + 2]; c++;
      }
      tmp[k * 3] = r / c; tmp[k * 3 + 1] = g / c; tmp[k * 3 + 2] = b / c;
    }
    for (let k = 0; k < idx.length; k++) { const i = idx[k]; col[i * 3] = tmp[k * 3]; col[i * 3 + 1] = tmp[k * 3 + 1]; col[i * 3 + 2] = tmp[k * 3 + 2]; }
  }
  for (const i of idx) { out[i * 4] = col[i * 3]; out[i * 4 + 1] = col[i * 3 + 1]; out[i * 4 + 2] = col[i * 3 + 2]; }
  return { rgba: out, spread: idx.length - fromPalette, fromPalette };
}
