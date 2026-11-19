// 絵の中の物を選んで、持つ・動かす・投げる・消す・戻す（「粒の空間」の歩く画面）。物理は studio/physics.js（Rapier）。
//
// しくみ：
//   1. 動かせる物（手前の物の物体の札）ごとに「枠」の番号を決め、その物の粒に枠の番号を持たせる（描画用の配列 F.w。F.z は粒の元の番号で、触って揺らす studio/jiggle.js が使う）
//   2. 枠ごとの「置いたときからの変換」を小さな絵（4 × 枠の数、RGBA float）に入れ、シェーダーで粒の位置・形・面の向きに掛ける
//      （1 列目〜3 列目 = 変換の 1〜3 行目、4 列目 = [見せるか, 選んでいるか, 0, 0]）。枠 0 は動かない粒（いつも単位行列）
//   3. 並べ直し（studio/sortworker.js）にも同じ変換を渡す（動いた物の粒も遠い順に並ぶ）
//   4. 歩く人の当たり（shared/collision.js）では、動かせる物のもとの形を外し、重い物だけ今の箱の形を入れる。軽い物は体で押す
import * as THREE from 'three/webgpu';
import { createPhysics } from './physics.js';
import { setStaticOff, setDynamic, groundAt } from '../shared/collision.js';

export const SLOTS = 256;     // 動かせる物の数の上限（枠 0 は使わない）
export const PUSH_MASS = 40;  // これより軽い物は、歩く人が体で押せる（当たりで止まらない）

/** 変換の絵と、物体の札 → 枠の表。作り直し（粒の作り直し）をまたいで同じものを使う */
export function createMover() {
  const data = new Float32Array(4 * SLOTS * 4);
  const tex = new THREE.DataTexture(data, 4, SLOTS, THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  const m = { tex, data, slotOf: new Uint16Array(65536), ids: [0], selected: 0 };
  m.identity = (slot) => { const o = slot * 16; data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0], o); };
  m.clear = () => { m.slotOf.fill(0); m.ids = [0]; m.selected = 0; for (let s = 0; s < SLOTS; s++) m.identity(s); tex.needsUpdate = true; };
  m.set = (slot, mat, visible) => { const o = slot * 16; data.set(mat.slice(0, 12), o); data[o + 12] = visible ? 1 : 0; data[o + 13] = slot === m.selected ? 1 : 0; };
  m.select = (slot) => { if (m.selected === slot) return false; if (m.selected) data[m.selected * 16 + 13] = 0; m.selected = slot; if (slot) data[slot * 16 + 13] = 1; tex.needsUpdate = true; return true; };
  /** 並べ直しに渡す、枠ごとの 4×4（行ごと。4 行目の最後 = 見せるか） */
  m.matrices = () => { const out = new Float32Array(SLOTS * 16); for (let s = 0; s < SLOTS; s++) { const o = s * 16; out.set(data.subarray(o, o + 12), o); out[o + 15] = data[o + 12] ? 1 : 0; } return out; };
  m.clear();
  return m;
}

/**
 * 動かせる物を決めて、枠を振る。
 *   targets = objectmodel.js の objectTargets の結果（物体の札ごと）、movable(target) = 動かせる物にするか
 * 返すもの：枠を振った物の一覧 [{ id, slot, typeId }]
 */
export function assignSlots(mover, targets, movable) {
  mover.clear();
  const list = [];
  for (const t of targets) {
    if (!movable(t) || mover.ids.length >= SLOTS) continue;
    const slot = mover.ids.length; mover.ids.push(t.id); mover.slotOf[t.id] = slot;
    list.push({ id: t.id, slot, typeId: t.typeId });
  }
  return list;
}

/** 粒 i の枠（動かない粒は 0）。手前の物の種類で、絵の面か物のモデルの層の粒だけが動く */
export function slotFor(mover, c, i, front) {
  if (!c.object) return 0;
  const s = mover.slotOf[c.object[i]];
  if (!s) return 0;
  const layer = c.layer[i];
  return (layer === 0 || layer === 4) && front[c.type[i]] ? s : 0;
}

/**
 * 物理を付ける。cloud = 粒の元データ、list = assignSlots の結果、W = 歩く人の当たり、kindOf(typeId) = 重さの種類（physics.js の DENSITY）、
 * eye = 絵の視点（板のような物に、見る向きの厚みを足す）、scene = 当たりの箱の表示を足す所
 */
export async function attachPhysics(mover, { cloud, list, front, W, kindOf, eye, scene, player }) {
  // 物ごとの粒の位置
  const pts = new Map(list.map((o) => [o.slot, []]));
  for (let i = 0; i < cloud.n; i++) {
    const s = slotFor(mover, cloud, i, front); if (!s) continue;
    const a = pts.get(s); if (a.length < 3 * 20000 || Math.random() < 0.1) a.push(cloud.position[i * 3], cloud.position[i * 3 + 1], cloud.position[i * 3 + 2]);
  }
  const objects = [];
  for (const o of list) {
    const p = pts.get(o.slot); if (!p || p.length < 30) continue;
    let cx = 0, cy = 0, cz = 0; const n = p.length / 3; for (let i = 0; i < n; i++) { cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2]; }
    objects.push({ id: o.id, pts: p, kind: kindOf(o.typeId), view: [cx / n - eye[0], 0, cz / n - eye[2]] });
  }
  // 地面：動かせる物の分を除いた当たりの三角形
  setStaticOff(W, list.map((o) => o.id));
  const keep = [];
  for (let i = 0; i < W.n; i++) if (!W.off[W.objectId[i]]) keep.push(i);
  const gt = new Float32Array(keep.length * 9); keep.forEach((t, k) => gt.set(W.tris.subarray(t * 9, t * 9 + 9), k * 9));
  const groundY = (x, z, yTop) => { const g = groundAt(W, x, z, yTop + 50); return g ? g.y : null; }; // 動かない地面の高さ（動かせる物の分は除いてある）
  const phys = await createPhysics({ ground: { tris: gt, n: keep.length }, objects, player, groundY, pushMass: PUSH_MASS });
  phys.step(1 / 120); // 当たりの問い合わせ（pick）を使えるようにする

  const typeOf = new Map(list.map((o) => [o.id, o.typeId]));
  // 当たりの箱の表示
  const boxes = new THREE.Group(); boxes.visible = false; boxes.renderOrder = 5;
  const boxMat = new THREE.LineBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthTest: false });
  const boxOf = new Map();
  for (const b of phys.bodies.values()) {
    const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2));
    const l = new THREE.LineSegments(g, boxMat); l.matrixAutoUpdate = false; boxes.add(l); boxOf.set(b.id, l);
  }
  scene.add(boxes);
  const m4 = new THREE.Matrix4();
  const removed = [];

  const it = {
    phys, boxes, removed, count: phys.bodies.size,
    /** 1 コマ。返すもの：動いた物があったか（並べ直しを頼む目印） */
    update(dt, { walking, feet, eye: e, dir }) {
      phys.setPlayer(walking ? feet : null);
      if (phys.holding() !== null) phys.setHoldTarget(e, dir);
      phys.step(dt);
      let moved = false;
      const dyn = [];
      for (const t of phys.transforms()) {
        const slot = mover.slotOf[t.id];
        const o = slot * 16, was = mover.data.subarray(o, o + 13);
        let diff = !!was[12] === t.removed;
        for (let k = 0; k < 12 && !diff; k++) if (Math.abs(was[k] - t.m[k]) > 1e-5) diff = true;
        if (diff) { mover.set(slot, t.m, !t.removed); moved = true; }
        if (!t.removed && phys.mass(t.id) >= PUSH_MASS) dyn.push({ id: t.id, typeId: typeOf.get(t.id), center: t.center, rot: t.rot, half: t.half });
        const box = boxOf.get(t.id);
        if (box && boxes.visible) { const R = t.rot; m4.set(R[0], R[1], R[2], t.center[0], R[3], R[4], R[5], t.center[1], R[6], R[7], R[8], t.center[2], 0, 0, 0, 1); box.matrix.copy(m4); box.visible = !t.removed; }
      }
      setDynamic(W, dyn);
      if (moved) mover.tex.needsUpdate = true;
      return moved;
    },
    /** 見ている向きの物を選ぶ（光らせる）。返すもの：{ id, dist } か null */
    aim(e, dir) {
      const hit = phys.holding() !== null ? { id: phys.holding(), dist: 0 } : phys.pick(e, dir, 25);
      mover.select(hit ? mover.slotOf[hit.id] : 0);
      return hit;
    },
    grabOrDrop(e, dir) {
      if (phys.holding() !== null) { phys.release(); return 'drop'; }
      const hit = phys.pick(e, dir, 6);
      return hit && phys.grab(hit.id, Math.max(1.5, hit.dist)) ? 'grab' : null;
    },
    throwHeld(dir, speed = 9) { if (phys.holding() === null) return false; phys.release([dir[0] * speed, dir[1] * speed + 2, dir[2] * speed]); return true; },
    removeAimed(e, dir) {
      const id = phys.holding() !== null ? phys.holding() : (phys.pick(e, dir, 25) || {}).id;
      if (id === undefined || id === null) return null;
      phys.remove(id); removed.push(id); mover.select(0); return id;
    },
    undoRemove() { const id = removed.pop(); if (id === undefined) return null; phys.reset(id); return id; },
    resetAll() { phys.reset(); removed.length = 0; },
    scroll(d) { phys.scrollHold(d); },
    holding: () => phys.holding(),
    dispose() { setStaticOff(W, list.map((o) => o.id), false); setDynamic(W, []); scene.remove(boxes); phys.dispose(); mover.clear(); },
  };
  return it;
}
