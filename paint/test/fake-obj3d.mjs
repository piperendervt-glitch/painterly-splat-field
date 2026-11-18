#!/usr/bin/env node
// 確かめ用の、にせの「絵 1 枚から物の 3D」（PSF_OBJ3D="node paint/test/fake-obj3d.mjs"）。本物の 3D は作らない。
// 切り抜きの色の平均で塗った形を書く：trellis・sam3d は 3D の粒（model.ply、だ円体の表面）、hunyuan3d は箱のメッシュ（model.glb）。
import fs from 'node:fs';
import path from 'node:path';
import { readPng } from '../image.mjs';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), cut = readPng(job.cutout);
let r = 0, g = 0, b = 0, n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
for (let y = 0; y < cut.height; y++) for (let x = 0; x < cut.width; x++) { const o = (y * cut.width + x) * 4; if (cut.data[o + 3] < 128) continue; r += cut.data[o]; g += cut.data[o + 1]; b += cut.data[o + 2]; n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const col = n ? [r / n / 255, g / n / 255, b / n / 255] : [0.5, 0.5, 0.5], hw = n ? (x1 - x0 + 1) / (y1 - y0 + 1) : 0.4; // 幅 ÷ 高さ
fs.mkdirSync(job.out_dir, { recursive: true });
const t0 = Date.now();
if (job.method === 'hunyuan3d') {
  // 箱（幅 hw、高さ 1、奥行き hw/2）。glTF の決まり：+Y が上
  const sx = hw / 2, sy = 0.5, sz = hw / 4, P = [], I = [], C = [];
  const face = (a, bb, c, d) => { const k = P.length / 3; P.push(...a, ...bb, ...c, ...d); I.push(k, k + 1, k + 2, k, k + 2, k + 3); for (let i = 0; i < 4; i++) C.push(...col, 1); };
  const v = (x, y, z) => [x * sx, y * sy, z * sz];
  face(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)); face(v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1));
  face(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)); face(v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1));
  face(v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1)); face(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1));
  const pos = Buffer.from(new Float32Array(P).buffer), colb = Buffer.from(new Float32Array(C).buffer), idx = Buffer.from(new Uint16Array(I).buffer);
  const bin = Buffer.concat([pos, colb, idx, Buffer.alloc((4 - idx.length % 4) % 4)]);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: colb.length }, { buffer: 0, byteOffset: pos.length + colb.length, byteLength: idx.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3', min: [-sx, -sy, -sz], max: [sx, sy, sz] }, { bufferView: 1, componentType: 5126, count: P.length / 3, type: 'VEC4' }, { bufferView: 2, componentType: 5123, count: I.length, type: 'SCALAR' }] };
  let js = Buffer.from(JSON.stringify(gltf)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b2 = Buffer.alloc(8); b2.writeUInt32LE(len, 0); b2.writeUInt32LE(type, 4); return b2; };
  fs.writeFileSync(path.join(job.out_dir, 'model.glb'), Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]));
} else {
  // だ円体の表面の 3D の粒（3D Gaussian Splatting の ply）。TRELLIS と同じく、中心が原点・高さ 1 くらい
  const N = 6000, props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${N}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const body = new Float32Array(N * props.length), SH = 0.28209479177387814, ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const yy = 1 - (i + 0.5) / N * 2, rr = Math.sqrt(1 - yy * yy), th = i * ga, o = i * props.length;
    body.set([Math.cos(th) * rr * hw / 2, yy * 0.5, Math.sin(th) * rr * hw / 4, 0, 0, 0, (col[0] - 0.5) / SH, (col[1] - 0.5) / SH, (col[2] - 0.5) / SH, 4, Math.log(0.012), Math.log(0.012), Math.log(0.012), 1, 0, 0, 0], o);
  }
  fs.writeFileSync(path.join(job.out_dir, 'model.ply'), Buffer.concat([Buffer.from(head), Buffer.from(body.buffer)]));
}
fs.writeFileSync(path.join(job.out_dir, 'info.json'), JSON.stringify({ method: job.method, fake: true, seconds: (Date.now() - t0) / 1000, peak_vram_gb: 0, files: fs.readdirSync(job.out_dir) }, null, 1));
console.log(`fake obj3d (${job.method}): ${fs.readdirSync(job.out_dir).join(', ')}`);
