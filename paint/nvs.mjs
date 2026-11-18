// 穴を、「別視点の絵を生成するモデル」（ViewCrafter、Stable Virtual Camera、UGG など）で作った絵で埋める。
// もとの絵と、足す視点のカメラを渡して、その視点から見た絵を生成してもらう。モデルの用意は docs/local-inpaint.md。
//
// 呼ぶ相手（コマンド）との約束：
//   <コマンド> <仕事.json>
//   仕事.json = {
//     model?            : モデルの名前（無ければ相手の既定）
//     source_image      : もとの絵（PNG）
//     source_intrinsics : { width, height, fx, fy, cx, cy }（主点は中心とは限らない）
//     source_depth      : もとの絵の奥行き（float32 の .npy、(高さ, 幅)、カメラの前方向の距離をメートルで、0 = 空）
//     targets[]         : { name, c2w（4×4。OpenCV の向き。世界 = もとの絵のカメラ座標。平行移動はメートル）, intrinsics,
//                           render（その視点へ写した今の絵。分からない所は真のマゼンタ）, out（生成した絵を書く所。PNG、同じ大きさ）, out_depth?（奥行きを書く所。.npy） }
//     style, hint, seed?
//   }
//   終了コード 0 で成功。失敗は 0 以外と、標準エラーに理由
import fs from 'node:fs';
import path from 'node:path';
import { readPng } from './image.mjs';
import { runCommand, wslPath } from './localinpaint.mjs';

const WIN = process.platform === 'win32';
export const defaultNvsCommand = () => (WIN ? 'wsl -- /opt/psf-ext/nvs/run.sh' : '/opt/psf-ext/nvs/run.sh');

/** float32 の配列を .npy（(h, w)）で書く。 */
export function writeNpy(file, arr, h, w) {
  let head = `{'descr': '<f4', 'fortran_order': False, 'shape': (${h}, ${w}), }`;
  while ((10 + head.length + 1) % 64) head += ' ';
  head += '\n';
  const b = Buffer.alloc(10 + head.length + arr.length * 4);
  b.write('\x93NUMPY', 0, 'latin1'); b[6] = 1; b[7] = 0; b.writeUInt16LE(head.length, 8); b.write(head, 10, 'latin1');
  for (let i = 0; i < arr.length; i++) b.writeFloatLE(arr[i], 10 + head.length + i * 4);
  fs.writeFileSync(file, b);
}

const mul = (a, b) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]; return o; };
const FLIP = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]; // three.js のカメラの向き ↔ OpenCV のカメラの向き
const rows = (m) => [0, 4, 8, 12].map((i) => m.slice(i, i + 4).map((x) => +x.toFixed(8)));
const intr = (def) => ({ width: def.width, height: def.height, fx: def.intrinsics.fx, fy: def.intrinsics.fy, cx: def.intrinsics.cx, cy: def.intrinsics.cy });

/**
 * 仕事の中身を作る。exportDir = previz-export（cameras.json と added_views.json、奥行きの絵）、paintDir = 絵の置き場。
 * view = 足した視点の名前、holesFile = その視点へ写した絵（穴はマゼンタ）。もとの絵の奥行きは workDir に .npy で書く。
 */
export function nvsJob({ exportDir, paintDir, view, holesFile, workDir, style, hint, model, seed }) {
  const cams = JSON.parse(fs.readFileSync(path.join(exportDir, 'cameras.json'), 'utf8'));
  const addedFile = path.join(exportDir, 'added_views.json'), added = fs.existsSync(addedFile) ? JSON.parse(fs.readFileSync(addedFile, 'utf8')) : [];
  const src = cams.views.find((v) => fs.existsSync(path.join(paintDir, `${v.name}_painted.png`)));
  if (!src) throw new Error('もとの視点の絵がありません');
  const tgt = [...cams.views, ...added].find((v) => v.name === view);
  if (!tgt) throw new Error(`視点 ${view} がカメラの一覧にありません`);
  // もとの絵の奥行き（16bit の絵）をメートルに直して .npy にする
  const dp = readPng(path.join(exportDir, src.depth)), { near, far } = cams.depth, n = dp.width * dp.height, z = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = dp.data[i * 4] * 256 + dp.data[i * 4 + 1]; z[i] = v ? 1 / (v / 65535 * (1 / near - 1 / far) + 1 / far) : 0; }
  const depthFile = path.join(workDir, 'source_depth.npy');
  writeNpy(depthFile, z, dp.height, dp.width);
  // 足す視点のカメラを、もとの絵のカメラ座標（OpenCV の向き）から見た形にする
  const rel = mul(FLIP, mul(mul(src.extrinsics.world_to_camera.flat(), tgt.extrinsics.camera_to_world.flat()), FLIP));
  const job = {
    source_image: path.join(paintDir, `${src.name}_painted.png`), source_intrinsics: intr(src), source_depth: depthFile,
    targets: [{ name: view, c2w: rows(rel), intrinsics: intr(tgt), render: holesFile, out: path.join(workDir, 'result.png'), out_depth: path.join(workDir, 'result_depth.npy') }],
    style, hint: hint || '',
  };
  if (model) job.model = model;
  if (Number.isFinite(seed)) job.seed = seed;
  return job;
}

/** 生成してもらう。返すのはできた絵（workDir/result.png）の場所。 */
export async function nvsGenerate({ command, workDir, job, timeoutSeconds = 7200 }) {
  const conv = WIN && /^\s*"?wsl(\.exe)?"?(\s|$)/i.test(command) ? wslPath : (p) => p;
  const sent = { ...job, source_image: conv(job.source_image), source_depth: conv(job.source_depth), targets: job.targets.map((t) => ({ ...t, render: conv(t.render), out: conv(t.out), out_depth: conv(t.out_depth) })) };
  const jobFile = path.join(workDir, 'nvs-job.json');
  fs.writeFileSync(jobFile, JSON.stringify(sent, null, 1));
  return runCommand({ command, files: [jobFile], out: job.targets[0].out, workDir, timeoutSeconds, label: '別視点の絵を生成するモデル', envName: 'PSF_NVS', logName: 'nvs-output.txt' });
}
