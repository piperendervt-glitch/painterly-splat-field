// 粒の空間で歩く：プレビズの形を当たり判定に使う（shared/collision.js）。ここは画面に出す部分と、確かめ用の表示。
import * as THREE from 'three/webgpu';
import { buildCollision, makeWalker, placeWalker, stepWalker, WALK_DEFAULTS } from '../shared/collision.js';
import { TYPES } from '../shared/labels.js';

const FLOOR = new THREE.Color(0x4fd16a), WALL = new THREE.Color(0xff9a3c), HIT = new THREE.Color(0xff2a4a);
const TYPE_NAME = new Map(TYPES.map((t) => [t.id, t.name]));

/** scene に確かめ用の表示を足し、歩く人を作る。solids は labelScene() の戻り値。 */
export function createWalk(scene, solids, objects) {
  const W = buildCollision(solids);
  const wk = makeWalker(W);
  const objName = new Map((objects || []).map((o) => [o.id, o.name]));

  // 当たりの形：床（立てる面）は緑、壁は橙、いまぶつかっている三角形は赤
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(W.tris.slice(0, W.n * 9), 3));
  const colors = new Float32Array(W.n * 9);
  const paint = (i, c) => { for (let k = 0; k < 3; k++) { colors[i * 9 + k * 3] = c.r; colors[i * 9 + k * 3 + 1] = c.g; colors[i * 9 + k * 3 + 2] = c.b; } };
  for (let i = 0; i < W.n; i++) paint(i, W.kind[i] ? WALL : FLOOR);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: true }));
  const lines = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, wireframe: true, transparent: true, opacity: 0.75 }));
  fill.renderOrder = lines.renderOrder = 3;
  const shapes = new THREE.Group(); shapes.add(fill, lines); shapes.visible = false;

  // 自分の体（後ろから見るとき・回して見るとき）と、足元の輪（立っていれば緑、空中なら赤）
  const p = wk.p;
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0x7fe0ff, wireframe: true, transparent: true, opacity: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(p.radius, p.height - 2 * p.radius, 4, 12), bodyMat);
  const eyeDot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(p.radius * 0.8, p.radius * 1.15, 32), new THREE.MeshBasicMaterial({ color: 0x4fd16a, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
  ring.rotation.x = -Math.PI / 2;
  for (const m of [body, eyeDot, ring]) m.renderOrder = 4;
  const me = new THREE.Group(); me.add(body, eyeDot, ring); me.visible = false;
  scene.add(shapes, me);

  let painted = [];
  function update(dt, input) {
    stepWalker(wk, dt, input);
    if (shapes.visible) { // ぶつかっている三角形を赤くする（足元の床は輪の色で示す。地面の三角形は広いので赤くしない）
      for (const i of painted) paint(i, W.kind[i] ? WALL : FLOOR);
      painted = [...new Set(wk.contacts)];
      for (const i of painted) paint(i, HIT);
      geo.attributes.color.needsUpdate = true;
    }
    const [x, y, z] = wk.feet;
    body.position.set(x, y + p.height / 2, z);
    eyeDot.position.set(x, wk.eyeY, z);
    ring.position.set(x, y + 0.03, z);
    ring.material.color.set(wk.noclip ? 0x7fe0ff : wk.onGround ? 0x4fd16a : 0xff2a4a);
  }

  return {
    W, wk, shapes, me,
    place: (x, y, z) => placeWalker(wk, x, y, z),
    update,
    setEye(v) { p.eye = v; if (wk.onGround) wk.eyeY = wk.feet[1] + v; },
    setSpeed(v) { p.walk = v; p.run = v * WALK_DEFAULTS.run / WALK_DEFAULTS.walk; },
    // いまの状態を文字で
    status() {
      if (wk.noclip) return 'すり抜け中（当たりなし）';
      if (!wk.onGround) return wk.vy > 0 ? '跳んでいる' : '落ちている';
      const t = wk.groundTri;
      return t >= 0 ? `${TYPE_NAME.get(W.typeId[t]) || '?'}（${objName.get(W.objectId[t]) || '?'}）に立っている` : '立っている';
    },
  };
}
