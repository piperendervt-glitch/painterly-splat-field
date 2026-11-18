// 動かせる物の物理（重力・ぶつかり・押す・持つ）。Rapier（@dimforge/rapier3d-compat、Apache-2.0）を使う。
// three.js にも画面にも依存しない（node でも試せる）。
//
// 物：絵の物体 1 つ = 剛体 1 つ。当たりの形は、その物の粒の位置の凸包（物の粒が板のように薄いときは、見る向きに厚みを足す）。
// 地面：歩くときの当たりの三角形（shared/collision.js の W）のうち、動かせる物の分を除いたもの（動かない三角形のメッシュ）。
// 自分：歩く人と同じ所に、動かすと物を押すカプセル（キネマティック）を置く。
//
// 物の動きは「置いたときからの変換」（4×4。行ごと）で返す。粒の位置 = 変換 × 置いたときの位置。
import RAPIER from '@dimforge/rapier3d-compat';

let ready = null;
export const initPhysics = () => (ready ||= RAPIER.init());

// 種類ごとの、見かけの体積あたりの重さ（kg/m³）。人は凸包が体より大きいので軽め。物の見かけの体積 = 凸包を囲む箱 × 0.5
export const DENSITY = { figure: 450, stone: 2200, trunk: 600, leaves: 60, lamp: 400, default: 500 };

/** 点の集まりの、いちばん薄い向きの厚み（m）と、それを測った軸（重心からの共分散の固有ベクトル。べき乗法） */
function thinAxis(pts) {
  const n = pts.length / 3; let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 3]; cy += pts[i * 3 + 1]; cz += pts[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  const C = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (let i = 0; i < n; i++) { const x = pts[i * 3] - cx, y = pts[i * 3 + 1] - cy, z = pts[i * 3 + 2] - cz; C[0] += x * x; C[1] += x * y; C[2] += x * z; C[3] += y * y; C[4] += y * z; C[5] += z * z; }
  // いちばん小さい固有値の向き = (tr·I − C) のいちばん大きい固有値の向き
  const tr = C[0] + C[3] + C[5], M = [tr - C[0], -C[1], -C[2], tr - C[3], -C[4], tr - C[5]];
  let v = [0.31, 0.53, 0.79];
  for (let it = 0; it < 40; it++) {
    const w = [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[1] * v[0] + M[3] * v[1] + M[4] * v[2], M[2] * v[0] + M[4] * v[1] + M[5] * v[2]];
    const l = Math.hypot(...w) || 1; v = w.map((x) => x / l);
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const d = (pts[i * 3] - cx) * v[0] + (pts[i * 3 + 1] - cy) * v[1] + (pts[i * 3 + 2] - cz) * v[2]; if (d < lo) lo = d; if (d > hi) hi = d; }
  return { axis: v, thick: hi - lo, center: [cx, cy, cz] };
}

/**
 * 物の当たりの形の点（重心が原点）と、囲む箱。薄すぎる物は、見る向きに minThick（幅に対する割合）まで厚くする。
 *   pts = 世界の位置（x y z の並び）、view = 厚みを足す向き（絵の視点から物への向き。無ければいちばん薄い向き）
 */
export function hullPoints(pts, { maxPoints = 1500, minThick = 0.35, view = null } = {}) {
  const n = pts.length / 3, step = Math.max(1, Math.floor(n / maxPoints)), keep = [];
  for (let i = 0; i < n; i += step) keep.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  const t = thinAxis(keep), m = keep.length / 3;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m; i++) for (let k = 0; k < 3; k++) { const v = keep[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  const width = Math.max(hi[0] - lo[0], hi[2] - lo[2], 0.05), want = width * minThick;
  let out = keep;
  if (t.thick < want) { // 板のような物：前後に半分ずつずらした写しを足す
    const ax = view ? (() => { const l = Math.hypot(...view) || 1; return view.map((x) => x / l); })() : t.axis, h = (want - t.thick) / 2;
    out = [];
    for (let i = 0; i < m; i++) for (const s of [-h, h]) out.push(keep[i * 3] + ax[0] * s, keep[i * 3 + 1] + ax[1] * s, keep[i * 3 + 2] + ax[2] * s);
  }
  const k = out.length / 3, c = [0, 0, 0];
  lo = [Infinity, Infinity, Infinity]; hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < k; i++) for (let j = 0; j < 3; j++) { const v = out[i * 3 + j]; if (v < lo[j]) lo[j] = v; if (v > hi[j]) hi[j] = v; }
  for (let j = 0; j < 3; j++) c[j] = (lo[j] + hi[j]) / 2;
  const local = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) for (let j = 0; j < 3; j++) local[i * 3 + j] = out[i * 3 + j] - c[j];
  return { local, center: c, half: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
}

/**
 * 物理の世界を作る。
 *   ground  { tris（三角形ごとに 9 個）, n }  動かない当たり
 *   objects [{ id, pts（世界の位置）, kind（DENSITY の名前）, view? }]
 * 返すもの：操作の一式（下の説明）
 */
export async function createPhysics({ ground, objects, gravity = 9.81, player = { radius: 0.3, height: 1.8 } }) {
  await initPhysics();
  const world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
  if (ground && ground.n) {
    const v = ground.tris.slice(0, ground.n * 9), idx = new Uint32Array(ground.n * 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    world.createCollider(RAPIER.ColliderDesc.trimesh(v, idx).setFriction(0.9));
  }
  const bodies = new Map(), byCollider = new Map();
  for (const o of objects) {
    const h = hullPoints(o.pts, { view: o.view });
    const desc = RAPIER.ColliderDesc.convexHull(h.local);
    if (!desc) continue; // 点が平らすぎる・少なすぎる
    const vol = 8 * h.half[0] * h.half[1] * h.half[2] * 0.5, mass = Math.max(1, vol * (DENSITY[o.kind] || DENSITY.default));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...h.center).setCanSleep(true).setLinearDamping(0.05).setAngularDamping(0.4));
    const col = world.createCollider(desc.setMass(mass).setFriction(0.8).setRestitution(0.05), body);
    body.sleep(); // 置いたままでは動かない（触る・持つまで眠る）
    const b = { id: o.id, body, col, rest: h.center.slice(), half: h.half, mass, removed: false, kind: o.kind };
    bodies.set(o.id, b); byCollider.set(col.handle, b);
  }
  // 自分（歩く人）：物を押すカプセル
  const half = Math.max(0.05, player.height / 2 - player.radius);
  const me = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1e4, 0));
  const meCol = world.createCollider(RAPIER.ColliderDesc.capsule(half, player.radius), me);
  const hold = { b: null, dist: 2.5, target: [0, 0, 0] };

  const api = {
    world, bodies, mass: (id) => bodies.get(id)?.mass ?? 0,
    /** 歩く人の足元。物を押す。null で外す（回して見るとき） */
    setPlayer(feet) {
      if (!feet) { me.setNextKinematicTranslation({ x: 0, y: -1e4, z: 0 }); return; }
      me.setNextKinematicTranslation({ x: feet[0], y: feet[1] + player.height / 2, z: feet[2] });
    },
    /** 見ている向きの線で、いちばん近い物を探す。{ id, dist } か null */
    pick(origin, dir, maxDist = 30) {
      const ray = new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: dir[0], y: dir[1], z: dir[2] });
      const hit = world.castRay(ray, maxDist, true, undefined, undefined, meCol, undefined, (c) => byCollider.has(c.handle));
      if (!hit) return null;
      const b = byCollider.get(hit.collider.handle), t = hit.timeOfImpact ?? hit.toi;
      return b && !b.removed ? { id: b.id, dist: t } : null;
    },
    /** 持つ（目の前 dist m の所へ引き寄せ続ける）。id = null で放す。放すときに throwVel を与えられる */
    grab(id, dist = 2.5) { const b = bodies.get(id); if (!b || b.removed) return false; hold.b = b; hold.dist = Math.max(1, dist); b.body.wakeUp(); return true; },
    release(throwVel = null) {
      const b = hold.b; hold.b = null; if (!b) return;
      if (throwVel) b.body.setLinvel({ x: throwVel[0], y: throwVel[1], z: throwVel[2] }, true);
    },
    holding: () => (hold.b ? hold.b.id : null),
    setHoldTarget(eye, dir) { for (let k = 0; k < 3; k++) hold.target[k] = eye[k] + dir[k] * hold.dist; },
    scrollHold(d) { hold.dist = Math.max(1, Math.min(12, hold.dist + d)); },
    remove(id) { const b = bodies.get(id); if (!b) return; if (hold.b === b) hold.b = null; b.removed = true; b.body.setEnabled(false); },
    /** 1 つ（または全部）を、置いたときの所へ戻す */
    reset(id = null) {
      for (const b of id === null ? bodies.values() : [bodies.get(id)].filter(Boolean)) {
        b.removed = false; b.body.setEnabled(true);
        b.body.setTranslation({ x: b.rest[0], y: b.rest[1], z: b.rest[2] }, false); b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, false); b.body.setAngvel({ x: 0, y: 0, z: 0 }, false); b.body.sleep();
      }
      if (id === null || (hold.b && hold.b.id === id)) hold.b = null;
    },
    /** 時間を進める */
    step(dt) {
      if (hold.b) { // 持っている物：目標へ速さで引き寄せる（ぶつかりは物理のまま）
        const p = hold.b.body.translation(), k = 12;
        hold.b.body.setLinvel({ x: (hold.target[0] - p.x) * k, y: (hold.target[1] - p.y) * k, z: (hold.target[2] - p.z) * k }, true);
        const w = hold.b.body.angvel(); hold.b.body.setAngvel({ x: w.x * 0.8, y: w.y * 0.8, z: w.z * 0.8 }, true);
      }
      world.timestep = Math.min(1 / 30, Math.max(1 / 240, dt));
      world.step();
    },
    /** 物ごとの「置いたときからの変換」（行ごとの 4×4）と、消したか。changed は動いた（眠っていない）物 */
    transforms() {
      const out = [];
      for (const b of bodies.values()) {
        const t = b.body.translation(), q = b.body.rotation(), { x, y, z, w } = q;
        const R = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
        const r = b.rest, m = [
          R[0], R[1], R[2], t.x - (R[0] * r[0] + R[1] * r[1] + R[2] * r[2]),
          R[3], R[4], R[5], t.y - (R[3] * r[0] + R[4] * r[1] + R[5] * r[2]),
          R[6], R[7], R[8], t.z - (R[6] * r[0] + R[7] * r[1] + R[8] * r[2]),
          0, 0, 0, 1,
        ];
        out.push({ id: b.id, m, removed: b.removed, moving: !b.removed && !b.body.isSleeping(), half: b.half, center: [t.x, t.y, t.z], rot: R });
      }
      return out;
    },
    dispose() { world.free(); },
  };
  return api;
}
