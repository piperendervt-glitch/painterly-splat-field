// プレビズの形から、画素ごとの「種類・物体・面の向き・日なた」を取り出す。
// プレビズの書き出し（previz/main.js）と、粒の空間（studio/splat.js、太陽を動かしたときの影）の両方で使う。
import * as THREE from 'three/webgpu';
import { positionView, normalWorld, uniform, vec4 } from 'three/tsl';
import { typeByKey, SKY_TYPE } from '../shared/labels.js';
import { hemi, visibilityAt, FLAT_LIGHT, LIT_LIGHT } from '../shared/light.js';

// ---- 形に付いた札を集める ----
// 戻り値：solids = 形ごとの { mesh, typeId, objectId, casts }、objects = 物体の一覧（番号は 1 から。0 は「物体なし」）。
export function labelScene(scene) {
  scene.updateMatrixWorld(true);
  const solids = [], objects = [], byName = new Map(), box = new THREE.Box3();
  scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    let lab = null;
    for (let o = mesh; o && !lab; o = o.parent) lab = o.userData.label || null;
    if (!lab) throw new Error(`形 "${mesh.name || mesh.uuid}" に札がありません（previz/scene.js の label() で種類と物体を付けてください）`);
    const type = typeByKey(lab.type);
    let obj = byName.get(lab.object);
    if (!obj) {
      obj = { id: objects.length + 1, name: lab.object, type: type.key, type_id: type.id, base_color: [0, 0, 0], bounds: new THREE.Box3() };
      byName.set(lab.object, obj); objects.push(obj);
    }
    const c = mesh.material.color;
    const base = [c.r, c.g, c.b]; // リニア
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    obj.bounds.union(box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    solids.push({ mesh, typeId: type.id, objectId: obj.id, casts: lab.casts !== false, base });
  });
  for (const o of objects) {
    const first = solids.find((s) => s.objectId === o.id);
    o.base_color = first.base.map((v) => Math.round(toSrgb(v) * 255));
    o.base_linear = first.base;
    const b = o.bounds; o.bounds = { min: b.min.toArray().map(r3), max: b.max.toArray().map(r3) };
  }
  return { solids, objects };
}
const r3 = (v) => +v.toFixed(3);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// 札のある形だけを描くため、ほかの線や点群をいったん隠す。戻り値は元に戻す関数。
function isolate(scene, keep) {
  const hidden = [];
  scene.traverse((o) => {
    if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && !keep.has(o) && o.visible) { o.visible = false; hidden.push(o); }
  });
  return () => { for (const o of hidden) o.visible = true; };
}

async function renderAndRead(renderer, scene, cam, rt, clear) {
  const bg = scene.background, color = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
  scene.background = null;
  renderer.setClearColor(clear, 1);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  renderer.setClearColor(color, alpha);
  scene.background = bg;
  return renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height);
}

let normalMat = null;
function getNormalMaterial() {
  if (!normalMat) {
    normalMat = new THREE.MeshBasicNodeMaterial();
    normalMat.outputNode = vec4(normalWorld.normalize().mul(0.5).add(0.5), 1);
  }
  return normalMat;
}
const idMats = new Map();
function getIdMaterial(typeId, objectId) {
  const key = typeId * 65536 + objectId;
  if (!idMats.has(key)) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.outputNode = vec4(typeId / 255, (objectId >> 8) / 255, (objectId & 255) / 255, 1);
    idMats.set(key, m);
  }
  return idMats.get(key);
}

/**
 * 1視点ぶんの種類・物体・面の向きを描いて読み戻す。
 * rt は幅×高さが書き出しと同じで、アンチエイリアスなし・最近傍の RenderTarget（番号が混ざらないように）。
 * flip は読み戻しの行の向き（奥行きの読み戻しで決めたものと同じ）。
 * 戻り値：type = Uint8Array(W*H)、object = Uint16Array(W*H)、normal = Int8Array(W*H*3)（-127〜127、ワールド座標）。空は type 0・object 0・normal 0。
 */
export async function captureLabels(renderer, scene, cam, rt, labels, flip) {
  const W = rt.width, H = rt.height;
  const restore = isolate(scene, new Set(labels.solids.map((s) => s.mesh)));
  const saved = labels.solids.map((s) => s.mesh.material);
  let ids, nrm;
  try {
    labels.solids.forEach((s) => { s.mesh.material = getIdMaterial(s.typeId, s.objectId); });
    ids = await renderAndRead(renderer, scene, cam, rt, 0x000000);
    labels.solids.forEach((s, i) => { s.mesh.material = saved[i]; });
    scene.overrideMaterial = getNormalMaterial();
    nrm = await renderAndRead(renderer, scene, cam, rt, 0x000000);
  } finally {
    scene.overrideMaterial = null;
    labels.solids.forEach((s, i) => { s.mesh.material = saved[i]; });
    restore();
  }
  const type = new Uint8Array(W * H), object = new Uint16Array(W * H), normal = new Int8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = flip ? H - 1 - y : y;
    for (let x = 0; x < W; x++) {
      const s = (sy * W + x) * 4, o = y * W + x;
      const t = ids[s]; type[o] = t; object[o] = ids[s + 1] * 256 + ids[s + 2];
      if (t === SKY_TYPE && object[o] === 0) continue;
      let nx = nrm[s] / 127.5 - 1, ny = nrm[s + 1] / 127.5 - 1, nz = nrm[s + 2] / 127.5 - 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      normal[o * 3] = Math.round(nx / len * 127); normal[o * 3 + 1] = Math.round(ny / len * 127); normal[o * 3 + 2] = Math.round(nz / len * 127);
    }
  }
  return { type, object, normal };
}

// ---- 太陽から見た奥行きの地図 ----
const uNear = uniform(0), uRange = uniform(1);
let sunMat = null;
function getSunMaterial() {
  if (!sunMat) {
    sunMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const v = positionView.z.negate().sub(uNear).div(uRange).clamp(0, 1).mul(65534).add(0.5).floor(); // 65535 は「何も無い」に取っておく
    const hi = v.div(256).floor(), lo = v.sub(hi.mul(256));
    sunMat.outputNode = vec4(hi.div(255), lo.div(255), 0, 1);
  }
  return sunMat;
}
const sunTargets = new Map();

/**
 * 太陽の方向 dir（面から太陽へ向かう単位ベクトル [x, y, z]）から、影を落とす形の奥行きの地図を作る。
 * 平行な光なので、形とその影は地図の同じ場所に写る。だから地図は影を落とす形が収まる広さだけあればよい。
 * 太陽が地平線より下なら null（全部が影）。戻り値は shared/light.js の visibilityAt() にそのまま渡せる。
 */
export async function renderSunMap(renderer, scene, labels, dir, { size = 2048, margin = 3 } = {}) {
  if (dir[1] <= 0.01) return null;
  const casters = labels.solids.filter((s) => s.casts);
  if (!casters.length) return { size: 1, depth: new Float32Array([Infinity]), m: new THREE.Matrix4().elements, left: -1, right: 1, bottom: -1, top: 1 };
  const f = new THREE.Vector3(-dir[0], -dir[1], -dir[2]).normalize(); // 光が進む向き
  const up = Math.abs(f.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const r = new THREE.Vector3().crossVectors(f, up).normalize(), u = new THREE.Vector3().crossVectors(r, f);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], p = new THREE.Vector3(), samples = [];
  for (const s of casters) {
    const pos = s.mesh.geometry.attributes.position, stepBy = Math.max(1, Math.floor(pos.count / 60));
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(s.mesh.matrixWorld);
      const c = [p.dot(r), p.dot(u), p.dot(f)];
      for (let k = 0; k < 3; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
      if (i % stepBy === 0) samples.push(p.clone());
    }
  }
  const half = Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 2 + margin; // 正方形にして画素を等しくする
  const cr = (lo[0] + hi[0]) / 2, cu = (lo[1] + hi[1]) / 2, range = hi[2] - lo[2] + margin * 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0, range);
  cam.position.copy(r).multiplyScalar(cr).addScaledVector(u, cu).addScaledVector(f, lo[2] - margin);
  cam.up.copy(up); cam.lookAt(p.copy(cam.position).add(f));
  cam.updateMatrixWorld(true); cam.updateProjectionMatrix();

  let rt = sunTargets.get(size);
  if (!rt) { rt = new THREE.RenderTarget(size, size, { type: THREE.UnsignedByteType, samples: 0, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter }); sunTargets.set(size, rt); }
  uNear.value = 0; uRange.value = range;
  const restore = isolate(scene, new Set(casters.map((s) => s.mesh)));
  let px;
  try { scene.overrideMaterial = getSunMaterial(); px = await renderAndRead(renderer, scene, cam, rt, 0xffff00); }
  finally { scene.overrideMaterial = null; restore(); }

  const m = cam.matrixWorldInverse.elements.slice();
  const at = (x, y) => { const i = (y * size + x) * 4, v = px[i] * 256 + px[i + 1]; return v >= 65535 ? Infinity : v / 65534 * range; };
  // 読み戻しの行の向きは描画方式で変わりうる。形の頂点が自分の奥行きに合うほうを選ぶ。
  const score = [0, 0];
  for (const q of samples) {
    const x = Math.floor((q.dot(r) - cr + half) / (2 * half) * size), y = Math.floor((half - (q.dot(u) - cu)) / (2 * half) * size);
    if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1) continue;
    const d = q.dot(f) - (lo[2] - margin);
    for (const flip of [0, 1]) {
      const row = flip ? size - 1 - y : y;
      let best = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) best = Math.min(best, Math.abs(at(x + dx, row + dy) - d));
      if (best < 0.5) score[flip]++;
    }
  }
  const flip = score[1] > score[0];
  const depth = new Float32Array(size * size);
  for (let y = 0; y < size; y++) { const sy = flip ? size - 1 - y : y; for (let x = 0; x < size; x++) depth[y * size + x] = at(x, sy); }
  return { size, depth, m, left: -half, right: half, bottom: -half, top: half, texel: 2 * half / size, flip, score };
}

/** 点が日なたか（0〜1）。n は面の向き。奥行きの刻みの粗さ lift（m）ぶん、面から浮かせて調べる（自分の影を拾わないため）。 */
export function sunVisibility(map, x, y, z, nx, ny, nz, lift) {
  if (!map) return 0;
  const k = lift + map.texel;
  return visibilityAt(map, x + nx * k, y + ny * k, z + nz * k, map.texel * 1.5);
}

/**
 * 1視点ぶんの「日なた」と、下絵にする2枚（光なし・影つき）を、種類・物体・面の向き・奥行きから計算する。
 * view = { W, H, depth(Uint16), type, object, normal, matrixWorld(elements), fx, fy, cx, cy, near, far }
 * 戻り値：sun = Uint8Array(W*H)（255 = 日なた、0 = 影。空は 255）、flat / lit = Uint8ClampedArray(W*H*4)。
 */
export function shadeView(view, labels, sunMap, sunDir, sky = { flat: [201, 206, 211], lit: [159, 195, 230] }) {
  const { W, H, depth, type, object, normal, matrixWorld: e, fx, fy, cx, cy, near, far } = view;
  const sun = new Uint8Array(W * H).fill(255), flat = new Uint8ClampedArray(W * H * 4), lit = new Uint8ClampedArray(W * H * 4);
  const baseOf = new Map(labels.objects.map((o) => [o.id, o.base_linear]));
  const step = (1 / near - 1 / far) / 65535;
  const out = (c) => toSrgb(Math.min(1, c)) * 255 + 0.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4, v = depth[i];
    flat[o + 3] = lit[o + 3] = 255;
    if (!v || !object[i]) { for (let k = 0; k < 3; k++) { flat[o + k] = sky.flat[k]; lit[o + k] = sky.lit[k]; } continue; }
    const z = 1 / (v * step + 1 / far);
    const px = (x + 0.5 - cx) / fx * z, py = -(y + 0.5 - cy) / fy * z, pz = -z;
    const wx = e[0] * px + e[4] * py + e[8] * pz + e[12], wy = e[1] * px + e[5] * py + e[9] * pz + e[13], wz = e[2] * px + e[6] * py + e[10] * pz + e[14];
    const nx = normal[i * 3] / 127, ny = normal[i * 3 + 1] / 127, nz = normal[i * 3 + 2] / 127;
    const vis = sunVisibility(sunMap, wx, wy, wz, nx, ny, nz, 0.05 + z * z * step);
    sun[i] = Math.round(vis * 255);
    const ndl = Math.max(0, nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2]), h = hemi(ny), base = baseOf.get(object[i]);
    const lf = FLAT_LIGHT.ambient * h, ll = LIT_LIGHT.ambient * h + LIT_LIGHT.sun * ndl * vis;
    for (let k = 0; k < 3; k++) { flat[o + k] = out(base[k] * lf); lit[o + k] = out(base[k] * ll); }
  }
  return { sun, flat, lit };
}

export { toLin, toSrgb };
