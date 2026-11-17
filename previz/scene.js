// プレビズの中身：地面・アーチ1つ・奥の塔。単位はメートル、+Y が上、カメラAは -Z の方向を向く。
import * as THREE from 'three/webgpu';
import { sunDirection } from '../shared/light.js';

export const SKY = 0xb9c7cf;

// 「影つきの絵」を描かせるときの太陽。方位は 0 = +Z（カメラAの背中側）、90 = +X。アーチの左奥から照らすので、影は手前の地面に落ちる。
// 粒の光を付け替えるとき、この向きが「描いたときの光」の基準になる。
export const PAINT_SUN = { azimuth: 205, elevation: 32 };

// 形に札を付ける。type は shared/labels.js の種類の key、object は物体の名前（同じ名前の形は1つの物体になる）。
// casts: false は影を落とさない形（平らな地面など）。グループに付けると、中の形すべてに効く。
const label = (o, type, object, casts = true) => { o.userData.label = { type, object, casts }; return o; };

export function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);

  scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x59633f, 1.6));
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
  sun.position.fromArray(sunDirection(PAINT_SUN.azimuth, PAINT_SUN.elevation)).multiplyScalar(120);
  scene.add(sun);

  const stone = new THREE.MeshLambertMaterial({ color: 0x8d8a80 });
  const farStone = new THREE.MeshLambertMaterial({ color: 0x9aa7b3 });
  const grass = new THREE.MeshLambertMaterial({ color: 0x7c9a48 });

  // 地面
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), grass);
  ground.rotation.x = -Math.PI / 2;
  ground.name = 'ground';
  scene.add(label(ground, 'grass', 'ground', false));

  // アーチ：開口の幅14m、柱の幅5m、全高30m、厚み6m。原点に立つ。
  const open = 7, pillar = 5, springY = 16, top = 30, thick = 6;
  const s = new THREE.Shape();
  s.moveTo(-open - pillar, 0);
  s.lineTo(-open - pillar, top);
  s.lineTo(open + pillar, top);
  s.lineTo(open + pillar, 0);
  s.lineTo(open, 0);
  s.lineTo(open, springY);
  s.absarc(0, springY, open, 0, Math.PI, false);
  s.lineTo(-open, 0);
  s.closePath();
  const archGeo = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 24 });
  archGeo.translate(0, 0, -thick / 2);
  const arch = new THREE.Mesh(archGeo, stone);
  arch.name = 'arch';
  scene.add(label(arch, 'stone', 'arch'));

  // 奥の塔：アーチの向こう 150m。
  const tower = new THREE.Group();
  tower.name = 'tower';
  const body = new THREE.Mesh(new THREE.CylinderGeometry(8, 11, 90, 32), farStone);
  body.position.y = 45;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(10, 22, 32), farStone);
  cap.position.y = 101;
  tower.add(body, cap);
  tower.position.set(0, 0, -150);
  scene.add(label(tower, 'stone', 'tower'));

  return scene;
}

// 書き出す2視点。position と target はワールド座標（m）。
export const EXPORT = {
  width: 1024,
  height: 1536,
  fovY: 55,   // 縦の画角（度）
  near: 0.5,  // 奥行きの符号化に使う最近・最遠（m）
  far: 2000,
  cameras: [
    { name: 'A', position: [3, 1.7, 46], target: [0, 15, 0] },
    { name: 'B', position: [-16, 1.7, 36], target: [0, 15, -6] },
  ],
};
