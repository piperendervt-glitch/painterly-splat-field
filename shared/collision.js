// 歩くときの当たり判定。プレビズの形（三角形）そのものを使うので、推定はしない。
// three.js に依存しない（形は labelScene() の solids から、頂点の配列と行列を直接読む）。node でも試せる。
//
// 人の形：足元の点 feet と、縦に並べた3つの球（足首の上・腰・頭）。いちばん下の球は「段差の高さ」より上に置くので、
// それより低い段は横からぶつからず、足元の判定で上に乗る。
import { TYPES } from './labels.js';

const SOLID = new Map(TYPES.map((t) => [t.id, t.solid || 'walk']));

// ---- 形を三角形の一覧にする ----
// 戻り値：tris = 三角形ごとに [ax ay az bx by bz cx cy cz]、nrm = 面の向き（単位）、typeId / objectId、kind = 0 床 / 1 壁
export function buildCollision(solids, { maxSlopeDeg = 50, cell = 4, dynamicMax = 6144 } = {}) {
  const list = [];
  for (const s of solids) {
    const solid = SOLID.get(s.typeId);
    if (solid === 'none') continue;
    const g = s.mesh.geometry, pos = g.attributes.position.array, idx = g.index ? g.index.array : null;
    s.mesh.updateWorldMatrix(true, false);
    const e = s.mesh.matrixWorld.elements;
    const count = idx ? idx.length : pos.length / 3;
    const v = new Float32Array(9);
    for (let t = 0; t < count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = (idx ? idx[t + k] : t + k) * 3, x = pos[i], y = pos[i + 1], z = pos[i + 2];
        v[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        v[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        v[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      list.push({ v: v.slice(), typeId: s.typeId, objectId: s.objectId, solid });
    }
  }
  const n = list.length, cosMax = Math.cos(maxSlopeDeg * Math.PI / 180);
  // 後ろに dynamicMax 個ぶん、動かせる物の三角形（setDynamic）を入れる枠をとる
  const cap = n + dynamicMax;
  const W = { n, tris: new Float32Array(cap * 9), nrm: new Float32Array(cap * 3), typeId: new Uint8Array(cap), objectId: new Uint16Array(cap), kind: new Uint8Array(cap),
    cell, grid: new Map(), big: [], stamp: new Uint32Array(cap), tick: 0, cosMax, maxSlopeDeg,
    off: new Uint8Array(65536), dyn: [], cap };
  let kept = 0;
  for (const t of list) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.v;
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz); if (len < 1e-9) continue; // つぶれた三角形
    nx /= len; ny /= len; nz /= len;
    const i = kept++;
    W.tris.set(t.v, i * 9); W.nrm[i * 3] = nx; W.nrm[i * 3 + 1] = ny; W.nrm[i * 3 + 2] = nz;
    W.typeId[i] = t.typeId; W.objectId[i] = t.objectId;
    W.kind[i] = t.solid === 'walk' && ny >= cosMax ? 0 : 1; // 上を向いた歩ける面だけが床
    // 水平方向の升目に登録する。広い三角形（平らな地面など）は升目に入れず、いつも調べる。
    const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx), z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
    if ((x1 - x0) * (z1 - z0) > cell * cell * 64) { W.big.push(i); continue; }
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gz = Math.floor(z0 / cell); gz <= Math.floor(z1 / cell); gz++) {
      const key = gx * 73856093 ^ gz * 19349663; let a = W.grid.get(key); if (!a) W.grid.set(key, (a = [])); a.push(i);
    }
  }
  W.n = kept;
  return W;
}

// 水平の範囲 [x0,x1]×[z0,z1] にかかる三角形を1回ずつ fn(i) に渡す。
function near(W, x0, z0, x1, z1, fn) {
  const tick = ++W.tick, off = W.off;
  for (const i of W.big) if (!off[W.objectId[i]]) fn(i);
  for (const i of W.dyn) fn(i); // 動かせる物の今の形（いつも調べる。数は少ない）
  const c = W.cell;
  for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++) for (let gz = Math.floor(z0 / c); gz <= Math.floor(z1 / c); gz++) {
    const a = W.grid.get(gx * 73856093 ^ gz * 19349663); if (!a) continue;
    for (const i of a) { if (W.stamp[i] === tick) continue; W.stamp[i] = tick; if (!off[W.objectId[i]]) fn(i); }
  }
}

// ---- 動かせる物（studio/physics.js で動く物）----
/** 物体の番号 ids の、もとの（動かない）三角形を使う・使わない */
export function setStaticOff(W, ids, on = true) { for (const id of ids) if (id > 0 && id < 65536) W.off[id] = on ? 1 : 0; }

/**
 * 動かせる物の今の形を、箱で入れ直す（毎コマ呼んでよい）。boxes = [{ id, typeId, center [x,y,z], rot（行ごとの 3×3）, half [x,y,z] }]
 * 箱の面は、上を向いて歩ける種類なら床、ほかは壁。入りきらない分は入れない。
 */
const BOX_FACES = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
export function setDynamic(W, boxes) {
  W.dyn.length = 0;
  let k = W.n;
  const c = [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]], v = new Float32Array(24);
  for (const b of boxes) {
    if (k + 12 > W.cap) break;
    const R = b.rot, h = b.half, solid = SOLID.get(b.typeId) || 'walk';
    if (solid === 'none') continue;
    for (let j = 0; j < 8; j++) {
      const lx = c[j][0] * h[0], ly = c[j][1] * h[1], lz = c[j][2] * h[2];
      v[j * 3] = b.center[0] + R[0] * lx + R[1] * ly + R[2] * lz; v[j * 3 + 1] = b.center[1] + R[3] * lx + R[4] * ly + R[5] * lz; v[j * 3 + 2] = b.center[2] + R[6] * lx + R[7] * ly + R[8] * lz;
    }
    for (const f of BOX_FACES) for (const tri of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) {
      const o = k * 9;
      for (let q = 0; q < 3; q++) { W.tris[o + q * 3] = v[tri[q] * 3]; W.tris[o + q * 3 + 1] = v[tri[q] * 3 + 1]; W.tris[o + q * 3 + 2] = v[tri[q] * 3 + 2]; }
      const t = W.tris, ax = t[o], ay = t[o + 1], az = t[o + 2];
      let nx = (t[o + 4] - ay) * (t[o + 8] - az) - (t[o + 5] - az) * (t[o + 7] - ay), ny = (t[o + 5] - az) * (t[o + 6] - ax) - (t[o + 3] - ax) * (t[o + 8] - az), nz = (t[o + 3] - ax) * (t[o + 7] - ay) - (t[o + 4] - ay) * (t[o + 6] - ax);
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      W.nrm[k * 3] = nx; W.nrm[k * 3 + 1] = ny; W.nrm[k * 3 + 2] = nz;
      W.typeId[k] = b.typeId; W.objectId[k] = 0; // 0：もとの三角形を外す印（off）に左右されない
      W.kind[k] = solid === 'walk' && ny >= W.cosMax ? 0 : 1;
      W.dyn.push(k); k++;
    }
  }
}

// 点 p に最も近い三角形 i 上の点を out に入れる（Ericson『Real-Time Collision Detection』5.1.5）。
function closestOnTri(W, i, px, py, pz, out) {
  const t = W.tris, o = i * 9;
  const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w; return;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
}

// 真下へ線を下ろして、(x, z) の足元にある床の高さを返す。yTop より上の床と、yBottom より下は見ない。
// 戻り値：{ y, tri } か null。
export function groundAt(W, x, z, yTop, yBottom = -1e9) {
  let best = null, bestY = yBottom;
  const t = W.tris;
  near(W, x, z, x, z, (i) => {
    if (W.kind[i]) return;
    const o = i * 9;
    const ax = t[o], az = t[o + 2], bx = t[o + 3], bz = t[o + 5], cx = t[o + 6], cz = t[o + 8];
    // 水平面での重心座標
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-12) return;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) return;
    const y = u * t[o + 1] + v * t[o + 4] + w * t[o + 7];
    if (y <= yTop && y > bestY) { bestY = y; best = i; }
  });
  return best === null ? null : { y: bestY, tri: best };
}

// ---- 歩く人 ----
export const WALK_DEFAULTS = {
  radius: 0.3,      // 体の太さ（半径、m）
  height: 1.8,      // 背の高さ（m）
  eye: 1.7,         // 目の高さ（m）。書き出しカメラと同じ 1.7 にすると、カメラの位置で絵がそのまま見える
  step: 0.45,       // 乗り越えられる段差（m）
  walk: 4.5,        // 歩く速さ（m/s）
  run: 12,          // 走る速さ（m/s、Shift）
  gravity: 22,      // 重力（m/s²）。現実（9.8）より強めにして、ゲームらしく早く落ちる
  jump: 7,          // 跳ぶ初速（m/s、Space）。高さ約 1.1 m
  fly: 14,          // すり抜け中の速さ（m/s）
  floorY: -40,      // ここより落ちたら、最後に立っていた所へ戻す
};

export function makeWalker(W, opts = {}) {
  return { W, p: { ...WALK_DEFAULTS, ...opts }, feet: [0, 0, 0], vy: 0, onGround: false, groundTri: -1, eyeY: 0, lastSafe: [0, 0, 0],
    contacts: [], noclip: false };
}

// 足元を (x, y, z) の真下の床に置く。床が無ければその高さのまま空中に置く。
export function placeWalker(wk, x, y, z) {
  const g = groundAt(wk.W, x, z, y + wk.p.step) || groundAt(wk.W, x, z, 1e9);
  wk.feet[0] = x; wk.feet[2] = z; wk.feet[1] = g ? g.y : y;
  wk.vy = 0; wk.onGround = !!g; wk.groundTri = g ? g.tri : -1;
  resolve(wk);
  wk.eyeY = wk.feet[1] + wk.p.eye;
  wk.lastSafe = wk.feet.slice();
}

// 体の3つの球の中心の高さ（足元から）
function sphereHeights(p) {
  const lo = p.step + p.radius, hi = Math.max(lo, p.height - p.radius);
  return [lo, (lo + hi) / 2, hi];
}

// 体が壁にめり込んでいたら押し出す。横には押し出し、上からぶつかった（天井）ときだけ下へ押す。
const tmp = [0, 0, 0];
function resolve(wk, record) {
  const { W, p, feet } = wk, r = p.radius, hs = sphereHeights(p);
  let hitCeil = false;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (let s = 0; s < hs.length; s++) {
      const cx = feet[0], cy = feet[1] + hs[s], cz = feet[2];
      let px = 0, py = 0, pz = 0;
      near(W, cx - r, cz - r, cx + r, cz + r, (i) => {
        closestOnTri(W, i, cx, cy, cz, tmp);
        const dx = cx - tmp[0], dy = cy - tmp[1], dz = cz - tmp[2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r) return;
        let d = Math.sqrt(d2), nx, ny, nz;
        if (d < 1e-6) { nx = W.nrm[i * 3]; ny = W.nrm[i * 3 + 1]; nz = W.nrm[i * 3 + 2]; d = 0; }
        else { nx = dx / d; ny = dy / d; nz = dz / d; }
        const depth = r - d;
        // 最も深い押し出しを各成分で取る（同じ壁の三角形が重なっても二重に押さない）
        const ex = nx * depth, ey = ny * depth, ez = nz * depth;
        if (Math.abs(ex) > Math.abs(px)) px = ex;
        if (Math.abs(ez) > Math.abs(pz)) pz = ez;
        if (ey < py) py = ey;
        if (record) record.push(i);
      });
      if (px || pz) { feet[0] += px; feet[2] += pz; moved = true; }
      if (py < -1e-4 && s === hs.length - 1) { feet[1] += py; hitCeil = true; moved = true; }
    }
    if (!moved) break;
  }
  return hitCeil;
}

// 1コマ進める。input = { forward: -1..1, right: -1..1, run, jump, up, down, yaw }（yaw はカメラの左右の向き、ラジアン）
export function stepWalker(wk, dt, input) {
  const { p, feet } = wk;
  const f = input.forward || 0, rr = input.right || 0, mag = Math.hypot(f, rr) || 1;
  const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
  const dirX = (-sin * f + cos * rr) / mag, dirZ = (-cos * f - sin * rr) / mag;

  if (wk.noclip) { // すり抜け：当たりなしで飛ぶ（確かめ用）
    const sp = p.fly * (input.run ? 3 : 1) * dt;
    feet[0] += dirX * sp; feet[2] += dirZ * sp; feet[1] += ((input.up ? 1 : 0) - (input.down ? 1 : 0)) * sp;
    wk.vy = 0; wk.onGround = false; wk.eyeY = feet[1] + p.eye; wk.contacts.length = 0;
    return;
  }

  const speed = (input.run ? p.run : p.walk) * (f || rr ? 1 : 0);
  let dist = speed * dt;
  wk.contacts.length = 0;
  // 横の移動は小刻みに（体の半径の半分ずつ）。速く走っても薄い壁を抜けない。
  const steps = Math.max(1, Math.ceil(dist / (p.radius * 0.5)));
  for (let s = 0; s < steps; s++) {
    feet[0] += dirX * dist / steps; feet[2] += dirZ * dist / steps;
    if (resolve(wk, wk.contacts) && wk.vy > 0) wk.vy = 0;
    if (wk.onGround) { // 床に沿って段を上り下りする
      const g = groundAt(wk.W, feet[0], feet[2], feet[1] + p.step, feet[1] - p.step);
      if (g) { feet[1] = g.y; wk.groundTri = g.tri; } else wk.onGround = false;
    }
  }

  if (wk.onGround && input.jump) { wk.vy = p.jump; wk.onGround = false; }
  if (!wk.onGround) {
    wk.vy -= p.gravity * dt;
    const ny = feet[1] + wk.vy * dt;
    const g = groundAt(wk.W, feet[0], feet[2], feet[1] + p.step * (wk.vy > 0 ? 0 : 1));
    if (wk.vy <= 0 && g && ny <= g.y) { feet[1] = g.y; wk.vy = 0; wk.onGround = true; wk.groundTri = g.tri; }
    else { feet[1] = ny; wk.groundTri = -1; }
    if (resolve(wk, wk.contacts) && wk.vy > 0) wk.vy = 0;
  }

  if (wk.onGround) wk.lastSafe = feet.slice();
  if (feet[1] < p.floorY) { feet[0] = wk.lastSafe[0]; feet[1] = wk.lastSafe[1]; feet[2] = wk.lastSafe[2]; wk.vy = 0; wk.onGround = true; }

  // 目の高さ：段を上ったときは少し遅れて追いつく（がくっと跳ねない）。空中ではそのまま。
  const target = feet[1] + p.eye;
  wk.eyeY = wk.onGround ? wk.eyeY + (target - wk.eyeY) * (1 - Math.exp(-dt * 18)) : target;
  if (Math.abs(wk.eyeY - target) > p.step * 2) wk.eyeY = target;
}
