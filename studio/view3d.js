// 視点を足す：3D の画面。プレビズの形のまわりを回って見て、候補のカメラと見る先を掴んで動かす。
// 「カメラの目で見る」にすると、画面の見え方がそのまま候補の視点になる（回す・寄る・ずらすで候補が動く）。
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildScene } from '../previz/scene.js';
import { VIEW_TINTS } from './viewdata.js';

const MIN_Y = 0.3, FREE_FOV = 50, CAND = 0x9ccf5a;

// 視点の形（四角すいの枠と、上を示す三角）。位置から見る先へ向けて置く。
const probe = new THREE.PerspectiveCamera();
function frustumPoints(position, target, fovY, aspect, len) {
  probe.position.fromArray(position); probe.up.set(0, 1, 0); probe.lookAt(target[0], target[1], target[2]); probe.updateMatrixWorld(true);
  const h = len * Math.tan(fovY * Math.PI / 360), w = h * aspect;
  const P = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(probe.matrixWorld);
  const o = P(0, 0, 0), a = P(-w, h, -len), b = P(w, h, -len), c = P(w, -h, -len), d = P(-w, -h, -len), up = P(0, h * 1.5, -len);
  return [o, a, o, b, o, c, o, d, a, b, b, c, c, d, d, a, a, up, up, b];
}
function frustumLines(color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(20 * 3), 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  lines.frustumCulled = false; lines.renderOrder = 5;
  lines.place = (position, target, fovY, aspect, len) => {
    frustumPoints(position, target, fovY, aspect, len).forEach((p, i) => geo.attributes.position.setXYZ(i, p.x, p.y, p.z));
    geo.attributes.position.needsUpdate = true;
  };
  return lines;
}

export async function createView3D(host, { gl = false, onChange = () => {}, mesh = null } = {}) {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: gl });
  await renderer.init();
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  host.append(renderer.domElement);
  const overlay = document.createElement('div'); overlay.className = 'v3-overlay'; host.append(overlay);
  const frame = document.createElement('div'); frame.className = 'v3-frame'; frame.hidden = true; overlay.append(frame);

  // mesh（{ positions, colors, indices }）があれば、プレビズの形の代わりにそれを出す（絵 1 枚から作った場面：奥行きの絵を面にした物）
  const scene = mesh ? new THREE.Scene() : buildScene();
  let picture = null;
  const setMesh = (m) => {
    if (picture) { scene.remove(picture); picture.geometry.dispose(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    const lin = new Float32Array(m.colors.length), c = new THREE.Color();
    for (let i = 0; i < lin.length; i += 3) { c.setRGB(m.colors[i], m.colors[i + 1], m.colors[i + 2], THREE.SRGBColorSpace); lin[i] = c.r; lin[i + 1] = c.g; lin[i + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(lin, 3)); geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    picture = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })); picture.name = 'picture';
    scene.add(picture);
  };
  if (mesh) { scene.background = new THREE.Color(0x1b231b); setMesh(mesh); }
  const grid = new THREE.GridHelper(400, 20, 0x3c4a3c, 0x2f3b2f); grid.position.y = 0.05; grid.material.transparent = true; grid.material.opacity = 0.6; scene.add(grid);
  const solids = []; scene.traverse((o) => { if (o.isMesh) solids.push(o); });
  const listSolids = () => { solids.length = 0; scene.traverse((o) => { if (o.isMesh && (o === picture || !mesh)) solids.push(o); }); };

  const camera = new THREE.PerspectiveCamera(FREE_FOV, 1, 0.3, 4000);
  camera.position.set(70, 55, 90);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 12, -30); orbit.zoomToCursor = true; orbit.maxDistance = 1500; orbit.update();

  // 候補：カメラ（緑の玉）と見る先（白い玉）、そのあいだの線、視点の枠
  const ball = (color, r) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true })); m.renderOrder = 6; return m; };
  const camBall = ball(CAND, 1), tgtBall = ball(0xffffff, 0.7);
  const candLines = frustumLines(CAND);
  const sightGeo = new THREE.BufferGeometry(); sightGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const sight = new THREE.Line(sightGeo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.7 }));
  sight.frustumCulled = false; sight.renderOrder = 5;
  const candGroup = new THREE.Group(); candGroup.add(candLines, sight, camBall, tgtBall); scene.add(candGroup);

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSpace('world'); gizmo.setSize(0.9);
  const gizmoHelper = gizmo.getHelper(); scene.add(gizmoHelper);
  gizmo.attach(camBall);

  const viewGroup = new THREE.Group(); scene.add(viewGroup);
  let labels = [], fovY = 50, aspect = 2 / 3, locked = false, handle = 'camera', silent = false, queued = false;
  const cand = { position: [24, 1.7, -30], target: [0, 15, 0] };

  const label = (text, color) => { const el = document.createElement('span'); el.className = 'v3-label'; el.textContent = text; el.style.color = color; overlay.append(el); return el; };
  const candLabel = label('候補', '#9ccf5a');

  function placeCandidate() {
    camBall.position.fromArray(cand.position); tgtBall.position.fromArray(cand.target);
    const len = Math.min(14, Math.max(4, 0.35 * camBall.position.distanceTo(tgtBall.position)));
    candLines.place(cand.position, cand.target, fovY, aspect, len);
    sightGeo.attributes.position.setXYZ(0, ...cand.position); sightGeo.attributes.position.setXYZ(1, ...cand.target); sightGeo.attributes.position.needsUpdate = true;
  }
  const emit = () => { if (!silent) onChange({ position: [...cand.position], target: [...cand.target] }); };

  // 画面に、書き出す絵と同じ縦横比の枠を出す（カメラの目で見ているとき）。枠の中が絵になる範囲
  function layout() {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false); camera.aspect = w / h;
    if (locked) {
      const fh = Math.min(h, w / aspect), fw = fh * aspect;
      camera.fov = 2 * Math.atan(Math.tan(fovY * Math.PI / 360) * h / fh) * 180 / Math.PI;
      Object.assign(frame.style, { width: `${fw}px`, height: `${fh}px`, left: `${(w - fw) / 2}px`, top: `${(h - fh) / 2}px` });
    } else camera.fov = FREE_FOV;
    camera.updateProjectionMatrix(); invalidate();
  }

  const v = new THREE.Vector3();
  function placeLabel(el, p, show = true) {
    v.fromArray(p).project(camera);
    const ok = show && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
    el.hidden = !ok; if (!ok) return;
    el.style.left = `${(v.x * 0.5 + 0.5) * host.clientWidth + 10}px`; el.style.top = `${(-v.y * 0.5 + 0.5) * host.clientHeight - 20}px`;
  }
  function draw() {
    queued = false;
    // 玉は、遠くても近くても画面の上で同じくらいの大きさに保つ
    for (const b of [camBall, tgtBall]) b.scale.setScalar(Math.max(0.3, camera.position.distanceTo(b.position) * 0.012));
    renderer.render(scene, camera);
    for (const l of labels) placeLabel(l.el, l.at);
    placeLabel(candLabel, cand.position, !locked);
    api.frames++;
  }
  function invalidate() { if (!queued) { queued = true; requestAnimationFrame(draw); } }

  // 画面のカメラ → 候補（カメラの目で見ているとき）
  function fromScreen() {
    if (camera.position.y < MIN_Y) camera.position.y = MIN_Y;
    cand.position = camera.position.toArray(); cand.target = orbit.target.toArray();
    placeCandidate(); emit();
  }
  orbit.addEventListener('change', () => { if (locked) fromScreen(); invalidate(); });
  gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
  gizmo.addEventListener('change', invalidate);
  gizmo.addEventListener('objectChange', () => {
    if (camBall.position.y < MIN_Y) camBall.position.y = MIN_Y;
    cand.position = camBall.position.toArray(); cand.target = tgtBall.position.toArray();
    placeCandidate(); emit(); invalidate();
  });

  // 玉をクリックすると、矢印がその玉に付く。形をダブルクリックすると、そこが見る先になる
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  const aim = (e) => { const r = renderer.domElement.getBoundingClientRect(); mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(mouse, camera); };
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (locked || e.button !== 0 || gizmo.axis) return;
    aim(e);
    const hit = ray.intersectObjects([camBall, tgtBall], false)[0];
    if (hit) api.setHandle(hit.object === camBall ? 'camera' : 'target', true);
  });
  renderer.domElement.addEventListener('dblclick', (e) => {
    aim(e);
    const hit = ray.intersectObjects(solids, false)[0];
    if (!hit) return;
    cand.target = hit.point.toArray();
    if (locked) { orbit.target.copy(hit.point); orbit.update(); fromScreen(); } else { placeCandidate(); emit(); }
    invalidate();
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  new ResizeObserver(layout).observe(host);

  const api = {
    frames: 0, camera, orbit, gizmo,
    onHandle: () => {},
    // すでにある視点を、色つきの枠で並べる
    setViews(views) {
      viewGroup.clear(); for (const l of labels) l.el.remove(); labels = [];
      if (!views.length) return;
      fovY = views[0].fov_y_deg; aspect = views[0].W / views[0].H;
      views.forEach((view, i) => {
        const t = VIEW_TINTS[i % VIEW_TINTS.length], color = new THREE.Color(t[0] / 255, t[1] / 255, t[2] / 255);
        const lines = frustumLines(color), ex = view.def.extrinsics;
        lines.place(ex.position, ex.target, fovY, aspect, 8); viewGroup.add(lines);
        labels.push({ el: label(view.name + (view.painted ? '' : '（絵なし）'), `rgb(${t})`), at: ex.position });
      });
      placeCandidate(); layout();
    },
    // 絵の形を差し替える（視点を足した後）
    setMesh(m) { setMesh(m); listSolids(); invalidate(); },
    // 外（つまみ・地図・自動で探す）で候補が変わったとき
    setCandidate(c) {
      cand.position = [...c.position]; cand.target = [...c.target]; placeCandidate();
      if (locked) { silent = true; camera.position.fromArray(cand.position); orbit.target.fromArray(cand.target); orbit.update(); silent = false; }
      invalidate();
    },
    setHandle(which, tell = false) {
      handle = which; gizmo.attach(which === 'camera' ? camBall : tgtBall); invalidate();
      if (tell) api.onHandle(which);
    },
    // カメラの目で見る：画面の見え方 = 候補の視点
    setLocked(on) {
      if (on === locked) return;
      locked = on; frame.hidden = !on; candGroup.visible = !on; gizmoHelper.visible = !on; gizmo.enabled = !on;
      silent = true;
      if (on) { api.outside = { position: camera.position.clone(), target: orbit.target.clone() }; camera.position.fromArray(cand.position); orbit.target.fromArray(cand.target); }
      else if (api.outside) { camera.position.copy(api.outside.position); orbit.target.copy(api.outside.target); }
      orbit.update(); silent = false; layout();
    },
    // 形と視点がすべて入るように引く
    frameAll() {
      if (locked) return;
      const box = new THREE.Box3();
      for (const m of solids) if (m.name !== 'ground') box.expandByObject(m);
      box.expandByPoint(v.fromArray(cand.position)).expandByPoint(v.fromArray(cand.target));
      for (const l of labels) box.expandByPoint(v.fromArray(l.at));
      const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
      const d = r / Math.sin(FREE_FOV * Math.PI / 360) * 1.05;
      orbit.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(0.45, 0.42, 0.79).normalize().multiplyScalar(d)); orbit.update(); invalidate();
    },
    // 軸に沿って見る（上・前・横）
    lookFrom(dir) {
      if (locked) return;
      const d = camera.position.distanceTo(orbit.target);
      camera.position.copy(orbit.target).add(new THREE.Vector3(...dir).normalize().multiplyScalar(d)); orbit.update(); invalidate();
    },
    get locked() { return locked; }, get handle() { return handle; }, candidate: () => cand,
  };
  placeCandidate(); layout();
  return api;
}
