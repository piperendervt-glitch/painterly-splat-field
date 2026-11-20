// 「筆跡の粒」に渡す 3D の形を用意する。場面は 2 通り：
//   プレビズの場面   previz/scene.js の形そのもの（地面・アーチ・塔）
//   絵 1 枚の場面    実在の絵（scenes/<名前>/。painting/build.mjs・relabel.mjs の書き出し）から形を組む：
//                    背景の面（奥行きの絵から、手前の物を除いてなめらかに埋めたメッシュ）＋ 物ごとの形 ＋ 絵の外まで続く土台の平面
//                    物ごとの形は、いまは絵の輪郭をふくらませた形（表と裏のある丸みのある板）。物ごとの 3D モデルを置く口は後で足す
// 返す形は shared/strokefield.js の tris（三角形ごとの位置・頂点の面の向き・種類・物体）。
import * as THREE from 'three/webgpu';
import { buildScene, EXPORT } from '../previz/scene.js';
import { labelScene } from '../previz/gbuffer.js';
import { TYPES, typeByKey } from '../shared/labels.js';
import { TriList, buildPaintingTris } from '../shared/paintscene.js';

const PAINT_TYPE_KEYS = { sky: 'sky', ground: 'grass', water: 'water', figure: 'figure', far: 'far', tree: 'leaves' };
const FRONT = new Uint8Array(256); for (const t of TYPES) FRONT[t.id] = t.layer === 'front' ? 1 : 0;

// 三角形の辺のうち、形の角（となりの面と 35° 以上折れている辺・となりの無い辺）に印を付ける（3 bit / 三角形）。
// 角のそばの筆跡は、角に沿う向きに寄せて、角からはみ出さないようにする（shared/strokefield.js）
export function sharpEdges(tris) {
  const q = (o) => `${Math.round(tris.pos[o] * 1000)},${Math.round(tris.pos[o + 1] * 1000)},${Math.round(tris.pos[o + 2] * 1000)}`;
  const faceN = (t) => { const o = t * 9, a = new THREE.Vector3().fromArray(tris.pos, o), b = new THREE.Vector3().fromArray(tris.pos, o + 3), c = new THREE.Vector3().fromArray(tris.pos, o + 6); return b.sub(a).cross(c.sub(a)).normalize(); };
  const edges = new Map(), normals = [];
  for (let t = 0; t < tris.n; t++) {
    normals.push(faceN(t));
    for (let k = 0; k < 3; k++) { const a = q(t * 9 + k * 3), b = q(t * 9 + ((k + 1) % 3) * 3), key = a < b ? a + '|' + b : b + '|' + a; if (!edges.has(key)) edges.set(key, []); edges.get(key).push(t * 3 + k); }
  }
  const sharp = new Uint8Array(tris.n), cos35 = Math.cos(35 * Math.PI / 180);
  for (const list of edges.values()) for (const e of list) {
    const t = Math.floor(e / 3), others = list.filter((x) => Math.floor(x / 3) !== t);
    if (!others.length || others.every((x) => normals[t].dot(normals[Math.floor(x / 3)]) < cos35)) sharp[t] |= 1 << (e % 3);
  }
  return sharp;
}

async function image(url, W, H) {
  const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(`${url} を読めませんでした`);
  const bmp = await createImageBitmap(await r.blob()), c = new OffscreenCanvas(W, H), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, W, H); return g.getImageData(0, 0, W, H).data;
}

// ---- プレビズの場面 ----
function previzScene(views) {
  const scene = buildScene(), labels = labelScene(scene), list = new TriList(), v = new THREE.Vector3();
  for (const s of labels.solids) {
    const g = s.mesh.geometry.index ? s.mesh.geometry.toNonIndexed() : s.mesh.geometry;
    const P = g.attributes.position, N = g.attributes.normal, m = s.mesh.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(m);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(m); list.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); list.nrm.push(v.x, v.y, v.z);
      if (i % 3 === 0) { list.type.push(s.typeId); list.object.push(s.objectId); }
    }
  }
  const tris = list.done(); tris.sharp = sharpEdges(tris);
  let cams = EXPORT.cameras.map((c) => ({ name: c.name, position: c.position, target: c.target, W: EXPORT.width, H: EXPORT.height, fov: EXPORT.fovY }));
  if (views) cams = views.filter((x) => x.extrinsics && x.extrinsics.target).map((x) => ({ name: x.name, position: x.extrinsics.position, target: x.extrinsics.target, W: x.width, H: x.height, fov: x.intrinsics.fov_y_deg }));
  cams = cams.map((c) => {
    const cam = new THREE.PerspectiveCamera(c.fov, c.W / c.H, 0.1, 5000); cam.position.fromArray(c.position); cam.lookAt(...c.target); cam.updateMatrixWorld(true);
    const fy = c.H / 2 / Math.tan(c.fov * Math.PI / 360);
    return { name: c.name, W: c.W, H: c.H, position: c.position, target: c.target, cam: { W: c.W, H: c.H, fx: fy, fy, cx: c.W / 2, cy: c.H / 2, view: Array.from(cam.matrixWorldInverse.elements), pos: c.position },
      offset: null, fovFull: c.fov, fovPlain: c.fov,
      apply(camera) { camera.position.fromArray(c.position); camera.lookAt(...c.target); } };
  });
  return { kind: 'previz', tris, cams, solids: labels.solids, objects: labels.objects, notes: [] };
}

// ---- 絵 1 枚の場面（形の組み立ては shared/paintscene.js） ----
async function paintingScene(cams) {
  const v = cams.views[0], W = v.width, H = v.height, { near, far } = cams.depth, intr = v.intrinsics;
  const [depthPx, labPx, objPx] = await Promise.all([image(`/files/previz-export/${v.depth}`, W, H), image(`/files/previz-export/${v.labels}`, W, H), image(`/files/previz-export/${v.objects}`, W, H)]);
  const remap = new Uint8Array(256); for (const t of (cams.labels && cams.labels.types) || []) remap[t.id] = PAINT_TYPE_KEYS[t.name] ? typeByKey(PAINT_TYPE_KEYS[t.name]).id : 0;
  const z = new Float32Array(W * H), type = new Uint8Array(W * H), object = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const val = depthPx[i * 4] * 256 + depthPx[i * 4 + 1]; z[i] = val ? 1 / (val / 65535 * (1 / near - 1 / far) + 1 / far) : 0;
    type[i] = remap[labPx[i * 4]]; object[i] = objPx[i * 4] + objPx[i * 4 + 1] * 256;
  }
  const c2w = v.extrinsics.camera_to_world.flat(), w2c = v.extrinsics.world_to_camera.flat(), notes = [], GRASS = typeByKey('grass').id;
  const typeOfObject = (o) => remap[((cams.labels.types || []).find((x) => x.name === o.type) || {}).id || 0] || typeByKey('figure').id;
  const { tris, bg, baseY, by, made, objects: built, size: S } = buildPaintingTris({ W, H, z, type, object, c2w, intr }, cams.objects, { typeOfObject, grass: GRASS });
  const objects = [{ id: 0, name: '背景' }, ...built.map((o) => ({ id: o.id, name: `物_${o.id}` }))];
  notes.push(`背景の面 ${(bg.indices.length / 3 / 1000).toFixed(1)} 千枚、物 ${made} 個（輪郭をふくらませた形）、土台の高さ ${baseY.toFixed(2)} m`);
  // 当たり判定用（歩く）：背景の面と土台だけ
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(bg.positions, 3)); geo.setIndex(Array.from(bg.indices));
  const base = new THREE.Mesh(new THREE.PlaneGeometry(2 * S, 2 * S)); base.rotation.x = -Math.PI / 2; base.position.y = by; base.updateMatrixWorld(true);
  const solids = [{ mesh: new THREE.Mesh(geo), typeId: GRASS, objectId: 0 }, { mesh: base, typeId: GRASS, objectId: 0 }];
  // カメラ：光軸が絵のまん中に無い（cy が上寄り）ので、大きな対称の枠の一部として合わせる
  const view16 = []; for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) view16.push(w2c[r * 4 + c]);
  const fullH = 2 * Math.max(intr.cy, H - intr.cy), fullW = 2 * Math.max(intr.cx, W - intr.cx), fov = 2 * Math.atan(fullH / 2 / intr.fy) * 180 / Math.PI;
  const pos = [c2w[3], c2w[7], c2w[11]], m4 = new THREE.Matrix4().set(...c2w);
  const cam = { name: v.name, W, H, position: pos, target: v.extrinsics.target || [pos[0] - c2w[2] * 10, pos[1] - c2w[6] * 10, pos[2] - c2w[10] * 10],
    cam: { W, H, fx: intr.fx, fy: intr.fy, cx: intr.cx, cy: intr.cy, view: view16, pos },
    mask: { object }, // 絵のどの画素がどの物体か（絵の色を写すのは、同じ物体の画素からだけ）
    offset: [fullW, fullH, fullW / 2 - intr.cx, fullH / 2 - intr.cy, W, H], fovFull: fov, fovPlain: 2 * Math.atan(H / 2 / intr.fy) * 180 / Math.PI,
    apply(camera) { m4.decompose(camera.position, camera.quaternion, camera.scale); } };
  return { kind: 'painting', tris, cams: [cam], solids, objects, notes };
}

/** いまの場面（サーバーの PSF_SCENE）の形とカメラを読む。 */
export async function loadScene() {
  let cams = null;
  try { const r = await fetch('/files/previz-export/cameras.json', { cache: 'no-store' }); if (r.ok) cams = await r.json(); } catch { /* 無ければプレビズの 2 視点 */ }
  if (cams && cams.views && cams.views[0] && cams.views[0].labels && !cams.views[0].type) return paintingScene(cams);
  return previzScene(cams && cams.views);
}
