// 絵 1 枚から作った場面（プレビズの形が無い場面）で、視点を足すための計算。three.js にも画面にも依存しない（node でも試せる）。
//
// もと：LucidDreamer（Chung ほか 2023）の「Dreaming」の段。
//   1. すでにある絵の画素を、奥行きを使って 3D に置き、新しい視点へ写す。写らなかった所が穴
//   2. 穴を画像生成で埋める（このツールでは Codex）
//   3. 埋めた絵の奥行きを推定し、すでに位置の分かっている所で尺度を合わせる。残ったずれは、穴の縁での差を穴の中へなめらかに広げて消す
//   4. 穴だった画素だけを、新しい点として足す
// 本家は点を 1 つずつ写して間を補うが、ここでは奥行きの絵を細かい三角形の面として写す（すき間が出ず、手前の面が奥を隠す）。
// 行列はどれも、行ごとに並んだ 4x4（cameras.json と同じ）。
import { pullPush } from './layers.js';

const NEAR = 0.05;

/** 位置・右・上・前の向きから、カメラ → 世界 と 世界 → カメラ の行列を作る。 */
export function cameraMatrices(position, { r, u, f }) {
  const [px, py, pz] = position;
  const c2w = [r[0], u[0], -f[0], px, r[1], u[1], -f[1], py, r[2], u[2], -f[2], pz, 0, 0, 0, 1];
  const w2c = [r[0], r[1], r[2], -(r[0] * px + r[1] * py + r[2] * pz), u[0], u[1], u[2], -(u[0] * px + u[1] * py + u[2] * pz), -f[0], -f[1], -f[2], f[0] * px + f[1] * py + f[2] * pz, 0, 0, 0, 1];
  return { c2w, w2c };
}
/** 位置と見る先から、カメラの向き（右・上・前）を作る。three.js の lookAt と同じ手順で、傾きは付けない（studio/viewdata.js の cameraBasis と同じ結果）。 */
export function lookBasis(position, target) {
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }, cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let z = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
  if (!(Math.hypot(...z) > 0)) z = [0, 0, 1];
  z = norm(z);
  let x = cross([0, 1, 0], z);
  if (!(Math.hypot(...x) > 0)) { z = norm([z[0], z[1], z[2] + 0.0001]); x = cross([0, 1, 0], z); }
  x = norm(x);
  return { r: x, u: cross(z, x), f: [-z[0], -z[1], -z[2]] };
}
const mul = (a, b) => { const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) o[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j]; return o; };

/**
 * すでにある視点（sources）の絵を、新しい視点（target）へ写す。
 *   target   { W, H, fx, fy, cx, cy, c2w, w2c }
 *   sources  [{ W, H, fx, fy, cx, cy, c2w, w2c, z（画素ごとの奥行き。0 = 空）, type, object（札。無ければ null）, valid（1 = 使う画素。null = 全部） }]
 *   step     何画素おきに面の頂点を置くか（1 = 全部。下見は粗くてよい）
 * 奥行きの段（手前の物と背景の境目）に張った面は、新しい視点で引き伸ばされるときだけ捨てる（そこが穴になる）。裏返った面も捨てる。
 * 返すもの（target の画素ごと）：inv = 1 / 奥行き（0 = 何も写らなかった）、src = どの視点から（-1 = 無し）、u・v = その視点の画素の位置、sky = 1 なら空だと分かった所
 */
export function warp(target, sources, { step = 1 } = {}) {
  const { W, H } = target, n = W * H;
  const inv = new Float32Array(n), src = new Int16Array(n).fill(-1), U = new Float32Array(n), V = new Float32Array(n), sky = new Uint8Array(n);
  const limit = 2.5 * step + 1.5; // 段の面は、これより伸びたら捨てる（画素）
  const wide = 6 * step + 2;      // ゆるい坂の面（同じ物の中で奥行きが少しずつ変わる所）は、ここまで伸びたら捨てる
  sources.forEach((s, si) => {
    const M = mul(target.w2c, s.c2w), gw = Math.floor((s.W - 1) / step) + 1, gh = Math.floor((s.H - 1) / step) + 1, g = gw * gh;
    const tx = new Float32Array(g), ty = new Float32Array(g), ti = new Float32Array(g), lz = new Float32Array(g), ok = new Uint8Array(g), use = new Uint8Array(g), lab = new Int32Array(g);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(s.W - 1, gx * step), y = Math.min(s.H - 1, gy * step), i = y * s.W + x, k = gy * gw + gx, z = s.z[i];
      use[k] = s.valid ? s.valid[i] : 1; lab[k] = s.type ? s.type[i] * 65536 + (s.object ? s.object[i] : 0) : 0;
      if (!(z > 0)) continue;
      const xc = (x + 0.5 - s.cx) / s.fx * z, yc = -(y + 0.5 - s.cy) / s.fy * z, zc = -z;
      const X = M[0] * xc + M[1] * yc + M[2] * zc + M[3], Y = M[4] * xc + M[5] * yc + M[6] * zc + M[7], Z = -(M[8] * xc + M[9] * yc + M[10] * zc + M[11]);
      if (Z < NEAR) continue;
      tx[k] = target.cx + X / Z * target.fx - 0.5; ty[k] = target.cy - Y / Z * target.fy - 0.5; ti[k] = 1 / Z; lz[k] = Math.log(z); ok[k] = 1;
    }
    const tri = (a, b, c, loose) => {
      const ax = tx[a], ay = ty[a], bx = tx[b], by = ty[b], cx = tx[c], cy = ty[c];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(area > 1e-9)) return; // 裏返った面・つぶれた面（もとの視点では、この並びで area が正）
      const x0f = Math.min(ax, bx, cx), x1f = Math.max(ax, bx, cx), y0f = Math.min(ay, by, cy), y1f = Math.max(ay, by, cy);
      if (loose === 1 && (x1f - x0f > limit || y1f - y0f > limit)) return;
      if (loose === 0 && (x1f - x0f > wide || y1f - y0f > wide)) return;
      const x0 = Math.max(0, Math.ceil(x0f)), x1 = Math.min(W - 1, Math.floor(x1f)), y0 = Math.max(0, Math.ceil(y0f)), y1 = Math.min(H - 1, Math.floor(y1f));
      if (x0 > x1 || y0 > y1) return;
      const ia = ti[a], ib = ti[b], ic = ti[c], k = 1 / area;
      const ua = (a % gw) * step, va = Math.floor(a / gw) * step, ub = (b % gw) * step, vb = Math.floor(b / gw) * step, uc = (c % gw) * step, vc = Math.floor(c / gw) * step;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * k, w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * k, w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const iz = w0 * ia + w1 * ib + w2 * ic, o = y * W + x;
        if (iz <= inv[o]) continue;
        inv[o] = iz; src[o] = si;
        U[o] = Math.min(s.W - 1, (w0 * ia * ua + w1 * ib * ub + w2 * ic * uc) / iz); V[o] = Math.min(s.H - 1, (w0 * ia * va + w1 * ib * vb + w2 * ic * vc) / iz);
      }
    };
    for (let gy = 0; gy + 1 < gh; gy++) for (let gx = 0; gx + 1 < gw; gx++) {
      const a = gy * gw + gx, b = a + 1, c = a + gw, d = c + 1;
      if (!(ok[a] && ok[b] && ok[c] && ok[d]) || !(use[a] || use[b] || use[c] || use[d])) continue;
      const lo = Math.min(lz[a], lz[b], lz[c], lz[d]), ratio = Math.max(lz[a], lz[b], lz[c], lz[d]) - lo;
      // 1 = 段の面、0 = ゆるい坂の面、-1 = ほぼ平らに続く面（寄って大きく伸びても捨てない）
      const loose = ratio > 0.3 || (ratio > 0.04 && !(lab[a] === lab[b] && lab[a] === lab[c] && lab[a] === lab[d])) ? 1 : ratio > 0.02 * step ? 0 : -1;
      tri(a, b, c, loose); tri(b, d, c, loose); // 画面では y が下向きなので、この並びで area が正
    }
  });
  // 何も写らなかった所：その向きが、どれかの視点で空なら、空だと分かる
  const m = target.c2w;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * W + x; if (inv[o] > 0) continue;
    const a = (x + 0.5 - target.cx) / target.fx, b = -(y + 0.5 - target.cy) / target.fy;
    const dx = m[0] * a + m[1] * b - m[2], dy = m[4] * a + m[5] * b - m[6], dz = m[8] * a + m[9] * b - m[10];
    for (let si = 0; si < sources.length; si++) {
      const s = sources[si], q = s.w2c;
      const zc = -(q[8] * dx + q[9] * dy + q[10] * dz); if (zc <= 1e-6) continue;
      const px = s.cx + (q[0] * dx + q[1] * dy + q[2] * dz) / zc * s.fx - 0.5, py = s.cy - (q[4] * dx + q[5] * dy + q[6] * dz) / zc * s.fy - 0.5;
      const ix = Math.round(px), iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= s.W || iy >= s.H) continue;
      const j = iy * s.W + ix; if (s.z[j] !== 0 || (s.valid && !s.valid[j])) continue;
      sky[o] = 1; src[o] = si; U[o] = Math.max(0, Math.min(s.W - 1, px)); V[o] = Math.max(0, Math.min(s.H - 1, py)); break;
    }
  }
  return { W, H, inv, src, U, V, sky };
}

/** warp の結果を数える（下見用）。covered = 絵が写った画素、holes = 穴。 */
export function warpStats(w) {
  let covered = 0; for (let i = 0; i < w.W * w.H; i++) if (w.src[i] >= 0) covered++;
  return { covered, holes: w.W * w.H - covered, pixels: w.W * w.H };
}

function bilinear(img, W, H, px, py, out) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(px))), y0 = Math.max(0, Math.min(H - 1, Math.floor(py))), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, px - x0)), fy = Math.max(0, Math.min(1, py - y0));
  for (let c = 0; c < 3; c++) out[c] = (img[(y0 * W + x0) * 4 + c] * (1 - fx) + img[(y0 * W + x1) * 4 + c] * fx) * (1 - fy) + (img[(y1 * W + x0) * 4 + c] * (1 - fx) + img[(y1 * W + x1) * 4 + c] * fx) * fy;
}

/**
 * warp の結果から、新しい視点の絵と材料を作る。sources には painted（RGBA）が要る。
 * 返すもの：rgba（写した絵。穴は灰色）、hole（1 = 穴）、holeCount、z（分かっている奥行き。空と穴は 0）、known（1 = 面か空だと分かった）、type・object（札。穴は 0）
 * 細い線や点だけの穴（面の継ぎ目の誤差）は、まわりから埋めて穴から外す。
 */
export function compose(w, sources, { skyType = 0 } = {}) {
  const { W, H } = w, n = W * H;
  const rgba = new Uint8ClampedArray(n * 4), hole = new Uint8Array(n), z = new Float32Array(n), type = new Uint8Array(n), object = new Uint16Array(n), col = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * 4; rgba[o + 3] = 255;
    if (w.src[i] < 0) { hole[i] = 1; rgba[o] = rgba[o + 1] = rgba[o + 2] = 128; continue; }
    const s = sources[w.src[i]];
    bilinear(s.painted, s.W, s.H, w.U[i], w.V[i], col); rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
    if (w.sky[i]) { type[i] = skyType; continue; }
    z[i] = 1 / w.inv[i];
    const j = Math.round(w.V[i]) * s.W + Math.round(w.U[i]);
    if (s.type) type[i] = s.type[j]; if (s.object) object[i] = s.object[j];
  }
  for (let pass = 0; pass < 2; pass++) {
    const before = hole.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (!before[i]) continue;
      let near = 0, r = 0, g = 0, b = 0, k = 0, pick = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = i + dy * W + dx; if (before[j]) near++; else { r += rgba[j * 4]; g += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; k++; if (pick < 0 || z[j] > z[pick]) pick = j; }
      }
      if (near > 3 || !k) continue; // 奥行きと札は、まわりでいちばん奥の画素のもの（継ぎ目の奥に見えるのは背景）
      hole[i] = 0; rgba[i * 4] = r / k; rgba[i * 4 + 1] = g / k; rgba[i * 4 + 2] = b / k; z[i] = z[pick]; type[i] = type[pick]; object[i] = object[pick];
    }
  }
  const known = new Uint8Array(n); let holeCount = 0;
  for (let i = 0; i < n; i++) { known[i] = hole[i] ? 0 : 1; holeCount += hole[i]; }
  return { W, H, rgba, hole, holeCount, z, known, type, object };
}

/**
 * 点の集まり（物ごとの 3D を置いた点群）を新しい視点へ写して、compose の結果 c に重ねる（c を書き換える）。
 * 人や物は、もとの絵の画素を奥行きで動かすと 1 枚の板のままだが、別の処理で立体にした点群なら、横から見た形になる。
 *   cloud = { n, xyz（世界の座標。Float32Array 3n）, rgb（Uint8Array 3n）, object（点ごとの物体の番号。無ければ null）, radius（点の半径 m。Float32Array n か数） }
 *   type  = 点の画素に付ける種類の番号
 * 点は、その画素に今ある面より手前のときだけ書く（穴・空の所には必ず書く）。1 点は、半径に合わせた大きさの円で書く（minPx〜maxPx 画素）。
 * 返すのは { pixels（点で埋めた画素）, holes（そのうち穴だった画素） }。
 */
export function overlayPoints(c, target, cloud, { type = 0, minPx = 0.8, maxPx = 8, close = 2, cull = -0.3, through = 0.08 } = {}) {
  const { W, H } = c, n = W * H, w = target.w2c, inv = new Float32Array(n), pick = new Int32Array(n).fill(-1);
  const rOf = typeof cloud.radius === 'number' ? () => cloud.radius : (k) => cloud.radius[k];
  // カメラの位置（世界）。面の向き（cloud.normal）があれば、はっきり向こうを向いた点（裏側の面）は写さない：
  //   手前の面の点のすき間から、裏側の暗い点がのぞいて見えるのを防ぐ。cull = 向きと視線の内積がこれより小さい点を捨てる（-1〜0。null で捨てない）
  const eye = [-(w[0] * w[3] + w[4] * w[7] + w[8] * w[11]), -(w[1] * w[3] + w[5] * w[7] + w[9] * w[11]), -(w[2] * w[3] + w[6] * w[7] + w[10] * w[11])], nrm = cull === null ? null : cloud.normal;
  for (let k = 0; k < cloud.n; k++) {
    const x = cloud.xyz[k * 3], y = cloud.xyz[k * 3 + 1], z = cloud.xyz[k * 3 + 2];
    const Z = -(w[8] * x + w[9] * y + w[10] * z + w[11]); if (!(Z > NEAR)) continue;
    if (nrm) { const nx = nrm[k * 3], ny = nrm[k * 3 + 1], nz = nrm[k * 3 + 2], nl = Math.hypot(nx, ny, nz); if (nl > 0.5) { const vx = eye[0] - x, vy = eye[1] - y, vz = eye[2] - z; if ((nx * vx + ny * vy + nz * vz) / (nl * Math.hypot(vx, vy, vz)) < cull) continue; } }
    const px = target.cx + (w[0] * x + w[1] * y + w[2] * z + w[3]) / Z * target.fx - 0.5, py = target.cy - (w[4] * x + w[5] * y + w[6] * z + w[7]) / Z * target.fy - 0.5;
    const r = Math.max(minPx, Math.min(maxPx, rOf(k) * target.fx / Z)), iz = 1 / Z;
    const x0 = Math.max(0, Math.ceil(px - r)), x1 = Math.min(W - 1, Math.floor(px + r)), y0 = Math.max(0, Math.ceil(py - r)), y1 = Math.min(H - 1, Math.floor(py + r));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      if ((xx - px) ** 2 + (yy - py) ** 2 > r * r + 0.25) continue;
      const o = yy * W + xx; if (iz > inv[o]) { inv[o] = iz; pick[o] = k; }
    }
  }
  // 点と点のすき間を閉じる：近くで見ると点の間隔が画素より広くなり、物の中に点々と抜けが出る。
  //   抜けた画素の左右（または上下）close 画素以内の両側に同じ物体の点があれば、近いほうの点で埋める。物の外側（片側しか点が無い所）は広げない。
  //   すき間から裏側の点がのぞいた画素（両側より through m より奥）も同じように置き換える。
  if (close > 0) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const add = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = y * W + x;
      let a = -1, b = -1, da = 0, db = 0;
      for (let k = 1; k <= close && a < 0; k++) { const xx = x - dx * k, yy = y - dy * k; if (xx < 0 || yy < 0) break; if (pick[yy * W + xx] >= 0) { a = yy * W + xx; da = k; } }
      if (a < 0) continue;
      for (let k = 1; k <= close && b < 0; k++) { const xx = x + dx * k, yy = y + dy * k; if (xx >= W || yy >= H) break; if (pick[yy * W + xx] >= 0) { b = yy * W + xx; db = k; } }
      if (b < 0) continue;
      if (cloud.object && cloud.object[pick[a]] !== cloud.object[pick[b]]) continue; // 別々の物の間は埋めない
      // 点がある画素でも、両側の点より through m より奥なら、すき間から裏側がのぞいた点なので、手前の点で置き換える
      if (pick[o] >= 0 && !(through > 0 && 1 / inv[o] - Math.max(1 / inv[a], 1 / inv[b]) > through)) continue;
      add.push(o, da <= db ? a : b);
    }
    for (let k = 0; k < add.length; k += 2) { pick[add[k]] = pick[add[k + 1]]; inv[add[k]] = inv[add[k + 1]]; }
  }
  let pixels = 0, holes = 0;
  for (let o = 0; o < n; o++) {
    const k = pick[o]; if (k < 0) continue;
    if (!c.hole[o] && c.z[o] > 0 && inv[o] <= 1.001 / c.z[o]) continue; // 今ある面のほうが手前
    if (c.hole[o]) { holes++; c.hole[o] = 0; c.holeCount--; }
    c.rgba[o * 4] = cloud.rgb[k * 3]; c.rgba[o * 4 + 1] = cloud.rgb[k * 3 + 1]; c.rgba[o * 4 + 2] = cloud.rgb[k * 3 + 2];
    c.z[o] = 1 / inv[o]; c.known[o] = 1; c.type[o] = type; if (c.object) c.object[o] = cloud.object ? cloud.object[k] : 0;
    pixels++;
  }
  return { pixels, holes };
}

// カメラ cam の画素 (x, y)・奥行き z の点の、世界での高さ
const heightAt = (cam, x, y, z) => { const m = cam.c2w; return m[4] * ((x + 0.5 - cam.cx) / cam.fx * z) + m[5] * (-(y + 0.5 - cam.cy) / cam.fy * z) - m[6] * z + m[7]; };
// カメラ cam の画素 (x, y) を通る線が、高さ groundY の水平な面に当たる所の奥行き（当たらなければ 0）
const planeDepth = (cam, x, y, groundY) => { const m = cam.c2w, dy = m[4] * ((x + 0.5 - cam.cx) / cam.fx) + m[5] * (-(y + 0.5 - cam.cy) / cam.fy) - m[6]; return dy < -1e-6 ? (groundY - m[7]) / dy : 0; };

/**
 * 穴の「手前の物の側」を見つける。視点を動かしてできた穴（物の陰から現れた所）は、片側が手前の物、反対側が背景で、
 * 穴の中に見えるのは背景のほう。だから、穴の奥行きを決めるときは、手前の物の奥行きを手がかりにしてはいけない。
 *   穴の横（縦）の並びごとに両端の分かっている画素を比べ、ratio 倍より手前にある側を「手前の物」とする（空は無限に遠い背景）。
 *   地面の高さの画素は手前の物にしない（平らな地面は、行が違うだけで奥行きが変わる）。
 * 返すもの：fg（1 = 穴に接した手前の物の面。分かっている画素。縁から reach 歩ぶん、同じ面をたどって広げる）、
 *           run（穴の画素ごと：1 = 手前の物と背景にはさまれた並びの中）、bgz（その並びの背景の側の端の奥行き。空なら 0）
 */
export function foregroundSide(c, { cam = null, groundY = 0, ratio = 1.12, reach = 64 } = {}) {
  const { W, H } = c, n = W * H, fg = new Uint8Array(n), run = new Uint8Array(n), bgz = new Float32Array(n), seeds = [];
  const far = (i) => (c.z[i] > 0 ? c.z[i] : Infinity);
  const ground = (i) => !!cam && c.z[i] > 0 && Math.abs(heightAt(cam, i % W, (i / W) | 0, c.z[i]) - groundY) < 0.12;
  const scan = (lines, len, idx) => {
    for (let l = 0; l < lines; l++) for (let t = 0; t < len;) {
      if (!c.hole[idx(l, t)]) { t++; continue; }
      const start = t; while (t < len && c.hole[idx(l, t)]) t++;
      if (start === 0 || t === len) continue; // 絵の端まで続く穴は、比べる相手が無い
      const a = idx(l, start - 1), b = idx(l, t), za = far(a), zb = far(b);
      const f = za < zb / ratio && !ground(a) ? a : zb < za / ratio && !ground(b) ? b : -1;
      if (f < 0) continue;
      if (!fg[f]) { fg[f] = 1; seeds.push(f); }
      const back = c.z[f === a ? b : a];
      for (let q = start; q < t; q++) { const i = idx(l, q); if (!run[i]) { run[i] = 1; bgz[i] = back; } } // 横の並びを先に見るので、横が優先
    }
  };
  scan(H, W, (l, t) => l * W + t); // 横の並び
  scan(W, H, (l, t) => t * W + l); // 縦の並び
  let queue = seeds;
  for (let step = 0; step < reach && queue.length; step++) { // 同じ面（奥行きがつながっている所）をたどって広げる
    const next = [];
    for (const i of queue) {
      const x = i % W, y = (i - x) / W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || fg[j] || c.hole[j] || !(c.z[j] > 0) || Math.abs(Math.log(c.z[j] / c.z[i])) > 0.06) continue;
        fg[j] = 1; next.push(j);
      }
    }
    queue = next;
  }
  return { fg, run, bgz };
}

/**
 * 決めた穴の奥行き z（空は 0）を、場面の形に合わせて整える（z を書き換える）。cam = { fx, fy, cx, cy, c2w } があれば地面の平面（高さ groundY）も使う。
 *   1. 手前の物と背景にはさまれた穴（物の陰から現れた所）：そこに見えるのは背景。背景の側の端の奥行きにする。
 *      ただし、その画素を通る線が背景の物より手前で地面に当たるなら、見えるのは地面（背景の物の足もとより下）なので、平面の式の奥行きにする。
 *      奥行きの推定は物の輪郭でぼやけるので、推定のままだと穴の点が物の輪郭にまとわり付いたり、背景から浮いたりする。
 *   2. ほかの穴：地面より下に来た点は地面に載せる。高さが地面に近い点も平面の式に載せる（立っている物の足もと＝すぐ上が同じ奥行きで高い所は除く）。
 *   3. 傾いて推定された地面：地面に載った所とつながっていて、面が寝ている所（傾き maxSlope 度まで、高さ maxLying m まで。maxSlope = 0 でやらない）。
 *      奥行きの推定は絵の端で傾きやすく、芝が斜めの板になって地面から浮く。
 * 返すもの：{ slivers（1 で決めた画素）, snapped（2 で平面に載せた画素）, flattened（3 で平面に載せた画素） }
 */
export function settleHoleDepth(c, z, { cam = null, groundY = 0, side = null, skyZ = 400, maxSlope = 35, maxLying = 1.5 } = {}) {
  const { W, H } = c, n = W * H;
  side = side || foregroundSide(c, { cam, groundY });
  let slivers = 0, snapped = 0, flattened = 0;
  const zp = new Float32Array(n);
  if (cam) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (c.hole[i]) { const p = planeDepth(cam, x, y, groundY); zp[i] = p > 0 && p < skyZ ? p : 0; } }
  for (let i = 0; i < n; i++) {
    if (!c.hole[i] || !side.run[i]) continue;
    const zb = side.bgz[i];
    if (zb > 0) { z[i] = zp[i] > 0 ? Math.min(zp[i], zb) : zb; slivers++; }
    else if (zp[i] > 0) { z[i] = zp[i]; slivers++; } // 背景が空で、線が地面に当たる：地面
  }
  if (cam) {
    const h = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) { const zi = c.hole[i] ? z[i] : c.z[i]; if (zi > 0) h[i] = heightAt(cam, i % W, (i / W) | 0, zi) - groundY; }
    const zAt = (i) => (c.hole[i] ? z[i] : c.z[i]), out = new Float32Array(z);
    // 立っている物の足もとか：0.5 m ぶん上の画素が、同じくらいの奥行きで、地面より高い
    const foot = (x, y) => { const i = y * W + x, up = y - Math.max(4, Math.min(80, Math.round(0.5 * cam.fy / z[i]))); if (up < 0) return false; const zj = zAt(up * W + x); return zj > 0 && Math.abs(Math.log(zj / z[i])) < 0.1 && h[up * W + x] > 0.4; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!c.hole[i] || side.run[i] || !(zp[i] > 0)) continue;
      if (!(z[i] > 0) || z[i] > zp[i]) { out[i] = zp[i]; snapped++; continue; } // 空とされたが地面に当たる所、地面より下に来た所
      if (Math.abs(h[i]) > 0.25 + 0.02 * z[i] || Math.log(zp[i] / z[i]) > 0.27) continue;
      if (foot(x, y)) continue;
      out[i] = zp[i]; snapped++;
    }
    // 3. 傾いて推定された地面：地面に載った所とつながっていて、面が寝ている（奥へ行くほど少しずつ高くなる板のような）所は、地面として平面に載せる。
    //    立っている物は面が立っている（上下の画素で、奥へはほとんど進まずに高さだけ変わる）ので、ここには入らない。
    const m = cam.c2w, k = Math.max(4, Math.round(H / 128)), tan = Math.tan(maxSlope * Math.PI / 180);
    const world = (x, y, zi) => { const xc = (x + 0.5 - cam.cx) / cam.fx * zi, yc = -(y + 0.5 - cam.cy) / cam.fy * zi; return [m[0] * xc + m[1] * yc - m[2] * zi + m[3], m[4] * xc + m[5] * yc - m[6] * zi + m[7], m[8] * xc + m[9] * yc - m[10] * zi + m[11]]; };
    const lying = (x, y) => { // 上下 k 画素先との間で、面の傾きが maxSlope より寝ているか（比べられる相手がみな寝ていること）
      const i = y * W + x, p = world(x, y, z[i]); let seen = 0;
      for (const yy of [y - k, y + k]) {
        if (yy < 0 || yy >= H) continue;
        const zj = zAt(yy * W + x); if (!(zj > 0)) continue;
        const q = world(x, yy, zj), run = Math.hypot(q[0] - p[0], q[2] - p[2]);
        if (Math.abs(q[1] - p[1]) > run * tan) return false;
        seen++;
      }
      return seen > 0;
    };
    const done = new Uint8Array(n); let queue = [];
    for (let i = 0; i < n; i++) if (c.hole[i] ? zp[i] > 0 && out[i] === zp[i] : Math.abs(h[i]) < 0.12) { done[i] = 1; queue.push(i); }
    while (maxSlope > 0 && queue.length) {
      const next = [];
      for (const i of queue) {
        const x = i % W, y = (i - x) / W;
        for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
          if (j < 0 || done[j] || !c.hole[j] || side.run[j] || !(zp[j] > 0) || !(z[j] > 0) || !(h[j] > 0 && h[j] <= maxLying)) continue;
          if (!lying(j % W, (j / W) | 0) || foot(j % W, (j / W) | 0)) continue; // 幹の根もとなど、立っている物の足もとは寝て推定されやすいので除く
          done[j] = 1; out[j] = zp[j]; flattened++; next.push(j);
        }
      }
      queue = next;
    }
    z.set(out);
  }
  return { slivers, snapped, flattened };
}

/**
 * 穴の奥行きを、分かっている面の奥行きからなめらかに広げて埋める（奥行きの推定が使えないときの代わり）。z を書き換える。
 * 手前の物の側（foregroundSide）からは広げない。cam と groundY があれば、地面の高さの所は平面の式に載せる。
 */
export function extendDepth(c, { cam = null, groundY = 0 } = {}) {
  const n = c.W * c.H, lz = new Float32Array(n), k = new Uint8Array(n); let any = false;
  const side = foregroundSide(c, { cam, groundY });
  for (let i = 0; i < n; i++) if (c.z[i] > 0 && !side.fg[i]) { lz[i] = Math.log(c.z[i]); k[i] = 1; any = true; }
  if (!any) for (let i = 0; i < n; i++) if (c.z[i] > 0) { lz[i] = Math.log(c.z[i]); k[i] = 1; any = true; }
  if (!any) { for (let i = 0; i < n; i++) if (c.hole[i]) c.z[i] = 10; return c.z; }
  const f = pullPush(lz, k, c.W, c.H), z = new Float32Array(c.z);
  for (let i = 0; i < n; i++) if (c.hole[i]) z[i] = Math.exp(f[i]);
  const known = { W: c.W, H: c.H, hole: c.hole, z: Float32Array.from(c.z, (v, i) => (c.hole[i] ? 0 : v)) };
  settleHoleDepth(known, z, { cam, groundY, side });
  for (let i = 0; i < n; i++) if (c.hole[i]) c.z[i] = z[i];
  return c.z;
}

/**
 * 埋めた絵から推定した「近さ」（disp。尺度とずれが不明。大きいほど近い）を、分かっている奥行きに合わせて、穴の奥行きを決める。
 *   1. 分かっている面で、1/z = a × disp + b に合わせる（外れ値を除きながら）
 *   2. 残った差（1/z − (a × disp + b)）を、穴の中へなめらかに広げて足す。穴の縁で、すでにある面とつながる
 *   3. とても遠い所（skyZ より遠い）と、近さがほぼ 0 の所は空にする
 *   4. 手前の物に接した穴は背景の側の奥行きに寄せ、地面の高さの所は平面の式に載せる（settleHoleDepth。cam = { fx, fy, cx, cy, c2w } があるとき）
 * 2 と 4 では、穴に接した「手前の物」の面（foregroundSide）を手がかりから外す。
 * 返すもの：{ z（穴も埋まった奥行き。空は 0）, a, b, samples, skyHoles, slivers, snapped, flattened } または null（合わせられなかった）
 */
export function alignDepth(c, disp, { skyZ = 400, minZ = 0.3, cam = null, groundY = 0, maxSlope = 35 } = {}) {
  const { W, H } = c, n = W * H;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { if (disp[i] < lo) lo = disp[i]; if (disp[i] > hi) hi = disp[i]; }
  if (!(hi > lo)) return null;
  const xs = [], ys = [];
  for (let y = 1; y < H; y += 3) for (let x = 1; x < W; x += 3) { const i = y * W + x; if (c.z[i] > 0 && !c.hole[i]) { xs.push(disp[i]); ys.push(1 / c.z[i]); } }
  if (xs.length < 200) return null;
  let a = 0, b = 0, keep = xs.map(() => true);
  for (let round = 0; round < 4; round++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0;
    for (let i = 0; i < xs.length; i++) if (keep[i]) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; k++; }
    const det = k * sxx - sx * sx; if (!(Math.abs(det) > 1e-12) || k < 100) return null;
    a = (k * sxy - sx * sy) / det; b = (sy - a * sx) / k;
    const res = xs.map((x, i) => Math.abs(ys[i] - (a * x + b))), sorted = Float64Array.from(res).sort(), cut = 2.5 * sorted[sorted.length >> 1] + 1e-9;
    keep = res.map((r) => r <= cut);
  }
  if (!(a > 0)) return null;
  const r = new Float32Array(n), k = new Uint8Array(n), side = foregroundSide(c, { cam, groundY });
  for (let i = 0; i < n; i++) if (c.z[i] > 0 && !c.hole[i] && !side.fg[i]) { r[i] = 1 / c.z[i] - (a * disp[i] + b); k[i] = 1; }
  const f = pullPush(r, k, W, H), z = new Float32Array(c.z);
  let skyHoles = 0;
  for (let i = 0; i < n; i++) {
    if (!c.hole[i]) continue;
    const iz = a * disp[i] + b + f[i];
    if (iz < 1 / skyZ || disp[i] - lo < 0.01 * (hi - lo)) { z[i] = 0; skyHoles++; } else z[i] = Math.max(minZ, 1 / iz);
  }
  const settled = settleHoleDepth(c, z, { cam, groundY, side, maxSlope });
  return { z, a, b, samples: xs.length, skyHoles, ...settled };
}

// 絵の色を点描のつぶより大きくならす（種類を色で見分けるため）。返すのは RGB（Float32、0〜255）
function smoothColor(rgba, W, H, r = 6) {
  const n = W * H, a = new Float32Array(n * 3), b = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = rgba[i * 4]; a[i * 3 + 1] = rgba[i * 4 + 1]; a[i * 3 + 2] = rgba[i * 4 + 2]; }
  const pass = (src, dst, len, stride, lines, lineStride) => {
    for (let l = 0; l < lines; l++) for (let ch = 0; ch < 3; ch++) {
      const o = l * lineStride * 3 + ch; let sum = 0, cnt = 0;
      for (let t = 0; t <= Math.min(r, len - 1); t++) { sum += src[o + t * stride * 3]; cnt++; }
      for (let t = 0; t < len; t++) {
        dst[o + t * stride * 3] = sum / cnt;
        const add = t + r + 1, del = t - r;
        if (add < len) { sum += src[o + add * stride * 3]; cnt++; }
        if (del >= 0) { sum -= src[o + del * stride * 3]; cnt--; }
      }
    }
  };
  pass(a, b, W, 1, H, W); // 横
  pass(b, a, H, W, W, 1); // 縦
  return a;
}
// 色の見分けに使う 3 つの量：明るさ、赤−緑、黄−青
const feat = (c, i, out) => { const r = c[i * 3], g = c[i * 3 + 1], b = c[i * 3 + 2]; out[0] = (r + g + b) / 3; out[1] = r - g; out[2] = (r + g) / 2 - b; return out; };

/**
 * 種類ごとの色と奥行きの傾向を、札の分かっている絵（もとの視点）から集める。
 * view = { W, H, painted（RGBA）, type, z }。返すのは { stat[種類] = { n, mean[3], var[3], zLo, zHi } }。穴を色で見分ける labelHoles に渡す。
 */
export function colorModel(view, { step = 3 } = {}) {
  const { W, H } = view, col = smoothColor(view.painted, W, H), f = [0, 0, 0], acc = [];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const i = y * W + x, t = view.type[i];
    const a = acc[t] || (acc[t] = { n: 0, s: [0, 0, 0], q: [0, 0, 0], zs: [] });
    feat(col, i, f); a.n++;
    for (let k = 0; k < 3; k++) { a.s[k] += f[k]; a.q[k] += f[k] * f[k]; }
    if (view.z[i] > 0) a.zs.push(view.z[i]);
  }
  const stat = [];
  acc.forEach((a, t) => {
    if (!a || a.n < 50) return;
    const mean = a.s.map((v) => v / a.n), vari = a.q.map((v, k) => Math.max(16, v / a.n - mean[k] * mean[k]));
    a.zs.sort((p, q) => p - q);
    const at = (p) => (a.zs.length ? a.zs[Math.min(a.zs.length - 1, Math.floor(p * a.zs.length))] : 0);
    stat[t] = { n: a.n, mean, var: vari, zLo: at(0.1), zHi: at(0.95) };
  });
  return { stat };
}

/**
 * 穴の画素に種類の札を付ける（c.type を書き換える）。空（z = 0）は空。
 * 色の手がかり（rgba = 埋めた後の絵、model = colorModel の結果）が無いとき：地面より rise 以上高い所は遠景、ほかは地面。
 * 色の手がかりがあるとき：地面の高さの所は「地面か水か」を色で、それより高い所は「遠景か木か人か」を色と距離で決める。木にした画素は、つながったかたまりごとに新しい物体の番号を付ける（objectBase から）。
 */
export function labelHoles(c, z, target, { ids, groundY = 0, rise = 0.6, rgba = null, model = null, objectBase = 0 }) {
  const { W, H } = c, m = target.c2w, col = rgba && model ? smoothColor(rgba, W, H) : null, f = [0, 0, 0];
  const S = model ? model.stat : [];
  const cost = (t, zi) => { // 色の離れ具合（小さいほどその種類らしい）＋距離が傾向から外れたときの罰
    const s = S[t]; if (!s) return Infinity;
    let d = 0; for (let k = 0; k < 3; k++) d += (f[k] - s.mean[k]) ** 2 / s.var[k] + Math.log(s.var[k]);
    if (t === ids.far && s.zLo > 0 && zi < s.zLo) d += 6 * Math.log(s.zLo / zi);
    if ((t === ids.tree || t === ids.figure) && s.zHi > 0 && zi > s.zHi) d += 6 * Math.log(zi / s.zHi);
    return d;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!c.hole[i]) continue;
    if (!(z[i] > 0)) { c.type[i] = ids.sky; if (c.object) c.object[i] = 0; continue; }
    const yc = -(y + 0.5 - target.cy) / target.fy * z[i], xc = (x + 0.5 - target.cx) / target.fx * z[i];
    const wy = m[4] * xc + m[5] * yc - m[6] * z[i] + m[7], high = wy > groundY + rise;
    let t = high ? ids.far : ids.ground;
    if (col) {
      feat(col, i, f);
      // 高い所：遠景・木・人（人は、絵の端で切れていた人の続きだけのはずなので、少し選びにくくする）。地面の高さ：地面・水
      let best = Infinity;
      for (const [k, extra] of high ? [[ids.far, 0], [ids.tree, 0], [ids.figure, 1.5]] : [[ids.ground, 0], [ids.water, 0]]) {
        if (k === undefined) continue;
        const d = cost(k, z[i]) + extra; if (d < best) { best = d; t = k; }
      }
    }
    c.type[i] = t; if (c.object) c.object[i] = 0;
  }
  if (col && c.object && objectBase > 0 && ids.tree !== undefined) { // 木のかたまりに番号を付ける（小さすぎるかたまりは番号なし）
    const seen = new Uint8Array(W * H), stack = []; let next = objectBase;
    for (let s0 = 0; s0 < W * H; s0++) {
      if (seen[s0] || !c.hole[s0] || c.type[s0] !== ids.tree) continue;
      const members = []; stack.push(s0); seen[s0] = 1;
      while (stack.length) {
        const i = stack.pop(); members.push(i);
        const x = i % W, y = (i - x) / W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen[j] || !c.hole[j] || c.type[j] !== ids.tree) continue;
          if (Math.abs(z[j] - z[i]) > 0.15 * Math.min(z[i], z[j])) continue; // 奥行きの段をまたがない
          seen[j] = 1; stack.push(j);
        }
      }
      if (members.length >= 400 && next < 65535) { for (const i of members) c.object[i] = next; next++; }
    }
  }
  return c.type;
}

/**
 * カメラ cam の画素 (x, y)・奥行き z の点が、もとの視点 base から見て「何も無いはずの所」にあるか：
 * base の絵に写り、そこに描かれた面より tol 以上手前（空の画素なら、どの距離でも手前）。
 * 後から足した点が、もとの絵の前に浮いて絵を隠すのを防ぐために使う。base・cam = { W, H, fx, fy, cx, cy, c2w, w2c }、base は z も。
 */
export function inFreeSpace(base, cam, x, y, z, tol = 0.12) {
  const xc = (x + 0.5 - cam.cx) / cam.fx * z, yc = -(y + 0.5 - cam.cy) / cam.fy * z, m = cam.c2w, w = base.w2c;
  const wx = m[0] * xc + m[1] * yc - m[2] * z + m[3], wy = m[4] * xc + m[5] * yc - m[6] * z + m[7], wz = m[8] * xc + m[9] * yc - m[10] * z + m[11];
  const bx = w[0] * wx + w[1] * wy + w[2] * wz + w[3], by = w[4] * wx + w[5] * wy + w[6] * wz + w[7], bz = -(w[8] * wx + w[9] * wy + w[10] * wz + w[11]);
  if (!(bz > 0.05)) return false;
  const px = Math.floor(base.cx + bx / bz * base.fx), py = Math.floor(base.cy - by / bz * base.fy);
  if (px < 1 || py < 1 || px >= base.W - 1 || py >= base.H - 1) return false;
  // まわり 3×3 のいちばん手前の面と比べる（物の縁で、境目のずれだけで捨てないように）
  let nearest = Infinity, sky = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const zb = base.z[(py + dy) * base.W + px + dx]; if (zb > 0) nearest = Math.min(nearest, zb); else sky++; }
  if (sky === 9) return true;
  return bz < nearest * (1 - tol);
}

/** 奥行きを、書き出しと同じ 16bit の絵（R = 上の桁、G = 下の桁。0 = 空）にする。RGBA。 */
export function depthPng(z, n, near, far) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = z[i] > 0 ? Math.max(1, Math.min(65535, Math.round((1 / z[i] - 1 / far) / (1 / near - 1 / far) * 65535))) : 0;
    out[i * 4] = v >> 8; out[i * 4 + 1] = v & 255; out[i * 4 + 3] = 255;
  }
  return out;
}
/** 奥行きの見るための絵（白 = 近い、黒 = 遠い・空）。RGBA。 */
export function depthViewPng(z, n) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { const g = z[i] > 0 ? Math.max(8, Math.min(255, 255 * Math.sqrt(1.5 / Math.max(1.5, z[i])))) : 0; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255; }
  return out;
}
/** 種類の絵（8bit の灰色 = 種類の番号）と、物体の絵（番号 = R + G × 256）。RGBA。 */
export function labelPngs(type, object, n) {
  const t = new Uint8ClampedArray(n * 4), o = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { t[i * 4] = t[i * 4 + 1] = t[i * 4 + 2] = type[i]; t[i * 4 + 3] = 255; o[i * 4] = object[i] & 255; o[i * 4 + 1] = object[i] >> 8; o[i * 4 + 3] = 255; }
  return { type: t, object: o };
}
/** 種類ごとの色と、近いほど明るい陰で塗った絵（プレビズの代わり）。colors = 種類の番号 → [r, g, b]。RGBA。 */
export function typeColorPng(type, z, n, colors) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = colors[type[i]] || [140, 140, 140], s = z[i] > 0 ? 0.55 + 0.45 * Math.sqrt(1.5 / Math.max(1.5, z[i])) : 1;
    out[i * 4] = c[0] * s; out[i * 4 + 1] = c[1] * s; out[i * 4 + 2] = c[2] * s; out[i * 4 + 3] = 255;
  }
  return out;
}
