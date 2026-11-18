// 角度を変えたときの崩れを減らすための計算。3D の描画も画面も使わない（数の配列だけ）ので、単体で確かめられる。
// 1 枚の絵から 3D を作る既存の手法から、次の 3 つを取り入れている。
//   1. 面に沿う粒（サーフェル）            … 2D Gaussian Splatting / WonderWorld の「面に寝かせた粒」。
//      粒を「カメラへ向いた丸」ではなく「面の上の楕円」にする。地面のように斜めに見ていた面は、元の視点では
//      1 画素でも面の上では奥へ長い。丸のままだと、上や横から見たときに粒の列のすき間が見える。
//   2. 境目の伸びを切る                    … 3D Photo Inpainting（Shih ら 2020）の「奥行きの境目で網を切る」。
//      奥行きを 1 枚の連続した面として推定する手法（SHARP も）は、手前の物と奥の背景の間を粒でつないでしまう
//      （ゴムの膜）。視線に沿って並ぶその粒を見つけて捨てる。
//   3. 背後の層                            … 層つき奥行き画像（Layered Depth Image。3D Photo Inpainting、SLIDE、WonderWorld）。
//      手前の物を取り除いた「背景だけの絵と奥行き」を作り、物の後ろに 2 層目として置く。
//      奥行きは同じ行の左右の背景から伸ばし、色は左右の背景の色 ＋ 近くの背景の筆あと（細かい模様）を写す。

// ---- 1. 面に沿う粒 ----

/**
 * 面の向き n、視点からの向き r（どちらも単位ベクトル）、丸のときの広がり sigma（m）から、
 * 面に沿った楕円の粒の共分散（xx, xy, xz, yy, yz, zz）を out[o..o+5] に入れる。
 * 視線に直角な向きは sigma のまま、面に沿って奥へ向かう向きは sigma / |n・r|（上限 maxStretch 倍、かつ STRETCH_METERS まで。
 * 上限の 2 倍より多く伸ばす必要がある所は、逆にだんだん伸ばさなくする）、厚みは sigma × thin。
 * 元の視点から見ると丸い粒と同じ大きさに見える。
 */
export function surfelCov(out, o, nx, ny, nz, rx, ry, rz, sigma, maxStretch = 16, thin = 0.15) {
  const c = Math.abs(nx * rx + ny * ry + nz * rz);
  // t1 = n × r（面の上で、視線に直角）。n と r が平行なら、面の上のどれか 1 本
  let ax = ny * rz - nz * ry, ay = nz * rx - nx * rz, az = nx * ry - ny * rx, l = Math.hypot(ax, ay, az);
  if (l < 1e-4) { if (Math.abs(nx) < 0.9) { ax = 0; ay = nz; az = -ny; } else { ax = -nz; ay = 0; az = nx; } l = Math.hypot(ax, ay, az); }
  ax /= l; ay /= l; az /= l;
  const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax; // t2 = n × t1（面の上で、奥へ向かう）
  // 伸ばす倍率：必要な倍率（1 / |n・r|）まで。上限の 2 倍を超えて必要な所（地平線の近く）は、伸ばしても覆えず太い帯になるだけなので、
  // 上限の 4 倍で丸に戻るまで、だんだん伸ばさなくする
  const need = 1 / Math.max(c, 1e-3), fade = Math.max(0, Math.min(1, (4 * maxStretch - need) / (2 * maxStretch)));
  const k = Math.max(1, Math.min(1 + (Math.min(maxStretch, need) - 1) * fade, STRETCH_METERS / sigma)), s1 = sigma * sigma, s2 = s1 * k * k, s3 = s1 * thin * thin;
  out[o] = s1 * ax * ax + s2 * bx * bx + s3 * nx * nx;
  out[o + 1] = s1 * ax * ay + s2 * bx * by + s3 * nx * ny;
  out[o + 2] = s1 * ax * az + s2 * bx * bz + s3 * nx * nz;
  out[o + 3] = s1 * ay * ay + s2 * by * by + s3 * ny * ny;
  out[o + 4] = s1 * ay * az + s2 * by * bz + s3 * ny * nz;
  out[o + 5] = s1 * az * az + s2 * bz * bz + s3 * nz * nz;
}
const STRETCH_METERS = 1.5; // 伸ばした後の広がり（σ）の上限（m）。地平線近くの 1 画素は面の上で何十 m にもなるので、そこまでは伸ばさない
/** 丸い粒（どこから見ても同じ大きさ）の共分散。 */
export function roundCov(out, o, sigma) { const s = sigma * sigma; out[o] = out[o + 3] = out[o + 5] = s; out[o + 1] = out[o + 2] = out[o + 4] = 0; }

/** ガウシアンの向き（四元数 w, x, y, z）と 3 軸の広がり（m）から、共分散を out[o..o+5] に入れる。 */
export function quatCov(out, o, qw, qx, qy, qz, s0, s1, s2) {
  const l = Math.hypot(qw, qx, qy, qz) || 1; qw /= l; qx /= l; qy /= l; qz /= l;
  const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
  const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
  const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
  const a = s0 * s0, b = s1 * s1, c = s2 * s2;
  out[o] = a * r00 * r00 + b * r01 * r01 + c * r02 * r02;
  out[o + 1] = a * r00 * r10 + b * r01 * r11 + c * r02 * r12;
  out[o + 2] = a * r00 * r20 + b * r01 * r21 + c * r02 * r22;
  out[o + 3] = a * r10 * r10 + b * r11 * r11 + c * r12 * r12;
  out[o + 4] = a * r10 * r20 + b * r11 * r21 + c * r12 * r22;
  out[o + 5] = a * r20 * r20 + b * r21 * r21 + c * r22 * r22;
}

/**
 * 奥行きのます目（z[y * W + x]、0 = 空）から、ます (x, y) の面の向き（カメラ座標。+X 右、+Y 上、カメラは −Z を見る）を out に入れる。
 * 左右・上下に step ますはなれた点との差から求める。奥行きの境目（比の対数が edgeLog より大きい）をまたぐ側は使わない。
 * 求められなければ（空、まわりが全部境目）false を返し、カメラの方を向いた向きを入れる。
 *   ax, ay  ます 1 つぶんの視線の傾き（x_cam = (x − cx) * ax * z、y_cam = −(y − cy) * ay * z）。画素なら 1 / fx、1 / fy
 */
export function gridNormal(out, z, W, H, x, y, cx, cy, ax, ay, step = 2, edgeLog = 0.1) {
  const i = y * W + x, z0 = z[i];
  out[0] = 0; out[1] = 0; out[2] = 1;
  if (!(z0 > 0)) return false;
  const ok = (j) => z[j] > 0 && Math.abs(Math.log(z[j] / z0)) < edgeLog * step;
  const px = (xx, yy, zz, o) => { P[o] = (xx - cx) * ax * zz; P[o + 1] = -(yy - cy) * ay * zz; P[o + 2] = -zz; };
  const xl = x - step >= 0 && ok(i - step) ? x - step : x, xr = x + step < W && ok(i + step) ? x + step : x;
  const yu = y - step >= 0 && ok(i - step * W) ? y - step : y, yd = y + step < H && ok(i + step * W) ? y + step : y;
  if (xl === xr || yu === yd) return false;
  px(xl, y, z[y * W + xl], 0); px(xr, y, z[y * W + xr], 3); px(x, yu, z[yu * W + x], 6); px(x, yd, z[yd * W + x], 9);
  const ux = P[3] - P[0], uy = P[4] - P[1], uz = P[5] - P[2];       // 右へ
  const vx = P[6] - P[9], vy = P[7] - P[10], vz = P[8] - P[11];     // 上へ
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz); if (!(l > 0)) return false;
  nx /= l; ny /= l; nz /= l;
  // カメラの側を向かせる（視線 = この点の位置の向き。内積が負ならカメラ向き）
  px(x, y, z0, 0);
  if (nx * P[0] + ny * P[1] + nz * P[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
  out[0] = nx; out[1] = ny; out[2] = nz;
  return true;
}
const P = new Float64Array(12);

// ---- 2. 境目の伸びを切る ----

/**
 * 連続した面として推定された奥行きのます目（SHARP の粒の並びなど）から、「手前と奥をつなぐ膜」のますを探す。
 * 戻り値：境目からの距離（ます。max まで）。0 = 膜のます（左右、上下、または斜めの両隣と、同じ向きに急な段がある）、
 * 1 = 段のすぐ手前・すぐ奥のます、2 以上 = そこからの距離。
 *   margin  ます目の端からこのます数は調べない
 *   log  隣との奥行きの比（対数）がこれを超えたら「急な段」。地面は、目の高さ 1.7 m・2 画素おきのますで 100 m 先でも 0.09 ほど
 */
export function sheetDistance(z, W, H, { log = 0.12, max = 7, margin = 0 } = {}) {
  const d = new Uint8Array(W * H).fill(max);
  const lz = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lz[i] = z[i] > 0 ? Math.log(z[i]) : NaN;
  const steep = (a, b) => { const v = lz[b] - lz[a]; return v > log ? 1 : v < -log ? -1 : 0; }; // NaN（空）は 0
  let sheets = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (Number.isNaN(lz[i])) continue;
    if (x < margin || y < margin || x >= W - margin || y >= H - margin) continue; // ます目の端（絵の外へはみ出す所）は奥行きが乱れるので、見ない
    let sheet = false, edge = false;
    for (const [dx, dy] of DIRS) {
      const xa = x - dx, ya = y - dy, xb = x + dx, yb = y + dy;
      const a = xa >= 0 && ya >= 0 && xa < W && ya < H ? steep(ya * W + xa, i) : 0;
      const b = xb >= 0 && yb >= 0 && xb < W && yb < H ? steep(i, yb * W + xb) : 0;
      if (a && b) sheet = true;       // 両側に段：膜の途中（同じ向き）か、1 ますだけ飛び出した点（逆向き）
      else if (a || b) edge = true;
    }
    if (sheet) { d[i] = 0; sheets++; } else if (edge) d[i] = 1;
  }
  spread(d, W, H);
  return { distance: d, sheets };
}
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
// 行きと帰りの 2 回で、おおよその距離を広げる
function spread(d, W, H) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) v = Math.min(v, d[i - W] + 1);
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x + 1 < W) v = Math.min(v, d[i + 1] + 1);
    if (y + 1 < H) v = Math.min(v, d[i + W] + 1);
    d[i] = v;
  }
}

// ---- 3. 背後の層 ----

export const BACK_NONE = 0, BACK_BEHIND = 1, BACK_RING = 2;

/**
 * 手前の物を取り除いた「背景だけ」の奥行きと色を作る。
 *   W, H    ます目の大きさ
 *   z       奥行き（0 = 空）
 *   type    種類の札（Uint8Array）
 *   rgba    色（W × H × 4）
 *   front   種類の番号 → 1 なら「手前の物」（人・木・建物など。取り除く側）。Uint8Array(256)
 *   cut     1 のますは信用しない（境目の膜など）。物と同じく取り除いて埋める。無ければ null
 *   halo    物のまわり何ますを「縁」として塗り直すか。絵の輪郭と札のずれ、輪郭のにじみを隠す
 *   blur    色の「ならした下地」を作るときの半径（ます）
 *   passes  ならす回数
 * 戻り値：
 *   kind    0 = 何もしない、1 = 物の後ろ（BACK_BEHIND）、2 = 物のまわりの縁（BACK_RING。奥行きは元のまま、色だけ塗り直す）
 *   z2      背景の奥行き（0 = 空）
 *   rgb     背景の色（W × H × 3）
 *   from    札（種類・物体・面の向きなど）を引き継ぐ元のます（−1 = 無し）
 *   stats   { behind, ring, sky, skipped（背景のほうが手前になった）, noSource（左右にも上下にも背景が無かった） }
 * 作り方：
 *   奥行き … 行ごとに、埋める区間の左右にある背景を見る。両方が面なら 1 / z をまっすぐつなぐ（平らな地面なら正しい奥行きになる）。
 *            片方だけなら、その値のまま伸ばす。空と面なら、近い側に合わせる。そのあと、埋めた中だけをならす。
 *   色     … ならした下地（左右の背景の色をつないだもの）に、近い側の背景の「筆あと」（色 − ならした色）を鏡写しに重ねる。
 *            新しい模様は作れない。人の後ろに隠れていた別の人や物は出てこない。
 */
export function backLayer({ W, H, z, type, rgba, front, cut = null, halo = 3, blur = 5, passes = 24 }) {
  const n = W * H;
  const kind = new Uint8Array(n);
  let things = 0;
  for (let i = 0; i < n; i++) if ((z[i] > 0 && front[type[i]]) || (cut && cut[i])) { kind[i] = BACK_BEHIND; things++; }
  const stats = { behind: 0, ring: 0, sky: 0, skipped: 0, noSource: 0 };
  const z2 = new Float32Array(n), rgb = new Uint8ClampedArray(n * 3), from = new Int32Array(n).fill(-1);
  if (!things) return { kind, z2, rgb, from, stats };

  // 縁：物からの距離が halo 以内の背景
  if (halo > 0) {
    const d = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) if (kind[i]) d[i] = 0;
    spread(d, W, H);
    for (let i = 0; i < n; i++) if (!kind[i] && d[i] <= halo) kind[i] = BACK_RING;
  }

  // 色の下地：背景（埋めない所）だけをならした色
  const low = blurKnown(rgba, kind, W, H, blur);

  // 行ごとに左右からつなぐ
  const disp = new Float32Array(n);        // 1 / z（空は 0）
  const sky = new Uint8Array(n);           // 1 = 背景は空
  const done = new Uint8Array(n);          // 1 = 埋めた
  const base = new Float32Array(n * 3);    // ならした下地
  const detail = new Int32Array(n).fill(-1); // 筆あとを写す元のます
  const RUN = 96;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!kind[row + x]) continue;
      let x1 = x; while (x1 + 1 < W && kind[row + x1 + 1]) x1++;
      const L = x > 0 ? row + x - 1 : -1, R = x1 + 1 < W ? row + x1 + 1 : -1;
      if (L >= 0 || R >= 0) {
        const lSky = L >= 0 && !(z[L] > 0), rSky = R >= 0 && !(z[R] > 0), len = x1 - x + 1;
        // 筆あとの元にできる背景の長さ（同じ種類が続くかぎり）
        let ln = 0, rn = 0;
        if (L >= 0) while (ln < RUN && x - 1 - ln >= 0 && !kind[L - ln] && type[L - ln] === type[L]) ln++;
        if (R >= 0) while (rn < RUN && x1 + 1 + rn < W && !kind[R + rn] && type[R + rn] === type[R]) rn++;
        for (let k = 0; k < len; k++) {
          const i = row + x + k, t = (k + 0.5) / len;
          // どちらの側から取るか：両方あれば近い側。奥行きは、両方が面のときだけつなぐ
          const useL = R < 0 || (L >= 0 && t < 0.5), S = useL ? L : R;
          from[i] = S; done[i] = 1;
          if (useL ? lSky : rSky) { sky[i] = 1; disp[i] = 0; }
          else if (L >= 0 && R >= 0 && !lSky && !rSky) disp[i] = (1 - t) / z[L] + t / z[R];
          else disp[i] = 1 / z[S];
          const both = L >= 0 && R >= 0 && lSky === rSky; // 色も、同じ仲間（面どうし・空どうし）のときだけつなぐ
          for (let c = 0; c < 3; c++) base[i * 3 + c] = both ? (1 - t) * low[L * 3 + c] + t * low[R * 3 + c] : low[S * 3 + c];
          // 鏡写し：区間の端からの距離だけ、背景の側へ折り返す（背景の長さを超えたら行ったり来たり）
          const m = useL ? ln : rn, dist = useL ? k : len - 1 - k;
          // 背景が短くて何度も折り返すと同じ模様が並ぶので、2 巡目からは行と巡ごとにずらす
          if (m >= 4) {
            const lap = Math.floor(dist / m), shift = lap ? hash2(y >> 1, lap * 2 + (useL ? 0 : 1)) % m : 0;
            const q = (dist + shift) % (2 * m), off = q < m ? q : 2 * m - 1 - q; detail[i] = useL ? L - off : R + off;
          }
        }
      }
      x = x1;
    }
  }
  // 左右に背景が無かった所（物が行の端から端まで）：上下の埋めた所・背景から、そのまま伸ばす
  for (let pass = 0; pass < 2; pass++) {
    const y0 = pass ? H - 2 : 1, y1 = pass ? -1 : H, dy = pass ? -1 : 1;
    for (let y = y0; y !== y1; y += dy) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!kind[i] || done[i]) continue;
      const j = i - dy * W;
      if (kind[j] && !done[j]) continue;
      done[i] = 1;
      if (kind[j]) { sky[i] = sky[j]; disp[i] = disp[j]; from[i] = from[j]; for (let c = 0; c < 3; c++) base[i * 3 + c] = base[j * 3 + c]; }
      else { sky[i] = z[j] > 0 ? 0 : 1; disp[i] = z[j] > 0 ? 1 / z[j] : 0; from[i] = j; for (let c = 0; c < 3; c++) base[i * 3 + c] = low[j * 3 + c]; }
    }
  }

  // 埋めた中だけをならす（同じ仲間の隣とだけ平均を取る。外側の背景は動かさない）
  const idx = []; for (let i = 0; i < n; i++) if (kind[i] && done[i]) idx.push(i);
  const m = idx.length, tmp = new Float32Array(m * 4);
  for (let i = 0; i < n; i++) if (!kind[i]) { disp[i] = z[i] > 0 ? 1 / z[i] : 0; sky[i] = z[i] > 0 ? 0 : 1; base[i * 3] = low[i * 3]; base[i * 3 + 1] = low[i * 3 + 1]; base[i * 3 + 2] = low[i * 3 + 2]; }
  for (let pass = 0; pass < passes; pass++) {
    for (let k = 0; k < m; k++) {
      const i = idx[k], x = i % W, y = (i - x) / W;
      let r = base[i * 3], g = base[i * 3 + 1], b = base[i * 3 + 2], dd = disp[i], c = 1;
      for (let e = 0; e < 4; e++) {
        const qx = x + STEP4[e * 2], qy = y + STEP4[e * 2 + 1]; if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
        const j = qy * W + qx; if (sky[j] !== sky[i] || (kind[j] && !done[j])) continue;
        r += base[j * 3]; g += base[j * 3 + 1]; b += base[j * 3 + 2]; dd += disp[j]; c++;
      }
      tmp[k * 4] = r / c; tmp[k * 4 + 1] = g / c; tmp[k * 4 + 2] = b / c; tmp[k * 4 + 3] = dd / c;
    }
    for (let k = 0; k < m; k++) { const i = idx[k]; base[i * 3] = tmp[k * 4]; base[i * 3 + 1] = tmp[k * 4 + 1]; base[i * 3 + 2] = tmp[k * 4 + 2]; disp[i] = tmp[k * 4 + 3]; }
  }

  for (let k = 0; k < m; k++) {
    const i = idx[k], s = detail[i];
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = base[i * 3 + c] + (s >= 0 ? softClip(rgba[s * 4 + c] - low[s * 3 + c]) : 0);
    if (kind[i] === BACK_RING && !(cut && cut[i])) { z2[i] = z[i]; from[i] = i; stats.ring++; continue; } // 縁：奥行きと札は元のまま
    if (sky[i]) { z2[i] = 0; stats.sky++; stats.behind++; kind[i] = BACK_BEHIND; continue; }
    const zb = 1 / disp[i];
    if (z[i] > 0 && !(cut && cut[i]) && zb < z[i] * 1.03) { kind[i] = BACK_NONE; stats.skipped++; continue; } // 背景のほうが手前：置かない
    z2[i] = zb; kind[i] = BACK_BEHIND; stats.behind++;
  }
  for (let i = 0; i < n; i++) if (kind[i] && !done[i]) { kind[i] = BACK_NONE; stats.noSource++; }
  return { kind, z2, rgb, from, stats };
}
const STEP4 = [1, 0, -1, 0, 0, 1, 0, -1];
// 筆あとの強さをなだらかに抑える（±DETAIL_MAX まで）。札から漏れた物の輪郭のような強い差を、背景へ写さないため
const DETAIL_MAX = 36;
const softClip = (v) => DETAIL_MAX * Math.tanh(v / DETAIL_MAX);
function hash2(a, b) { let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35); h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); return (h ^ (h >>> 13)) >>> 0; }

// kind が 0 のますだけを使って、半径 r の箱でならした色（W × H × 3）。まわりに 1 つも無いますは 0 のまま。
function blurKnown(rgba, kind, W, H, r) {
  const n = W * H, a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) if (!kind[i]) { a[i * 4] = rgba[i * 4]; a[i * 4 + 1] = rgba[i * 4 + 1]; a[i * 4 + 2] = rgba[i * 4 + 2]; a[i * 4 + 3] = 1; }
  const acc = [0, 0, 0, 0];
  // 横
  for (let y = 0; y < H; y++) {
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    for (let x = -r; x < W + r; x++) {
      const add = x + r, sub = x - r - 1;
      if (add < W) { const j = (y * W + add) * 4; for (let c = 0; c < 4; c++) acc[c] += a[j + c]; }
      if (sub >= 0) { const j = (y * W + sub) * 4; for (let c = 0; c < 4; c++) acc[c] -= a[j + c]; }
      if (x >= 0 && x < W) { const j = (y * W + x) * 4; for (let c = 0; c < 4; c++) b[j + c] = acc[c]; }
    }
  }
  // 縦
  const out = new Float32Array(n * 3);
  for (let x = 0; x < W; x++) {
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    for (let y = -r; y < H + r; y++) {
      const add = y + r, sub = y - r - 1;
      if (add < H) { const j = (add * W + x) * 4; for (let c = 0; c < 4; c++) acc[c] += b[j + c]; }
      if (sub >= 0) { const j = (sub * W + x) * 4; for (let c = 0; c < 4; c++) acc[c] -= b[j + c]; }
      if (y >= 0 && y < H && acc[3] > 0.5) { const j = (y * W + x) * 3; out[j] = acc[0] / acc[3]; out[j + 1] = acc[1] / acc[3]; out[j + 2] = acc[2] / acc[3]; }
    }
  }
  return out;
}

// ---- 視点（奥行きの絵）から、面に沿う粒と背後の層を作る ----
// 視点 v は { W, H, z, type, object, hasTypes, hasLabels, normalPx, sunPx, labelEdge, near, far, c2w（行ごとの 4x4）, def.intrinsics }。

export const SIGMA_K = 2.6 / 6; // 粒の広がり（σ）÷ 粒の間隔。「粒の大きさ」が 2.6 倍のときの値（studio/splat.js の makeMaterials）

/** 視点 v の画素 (x, y) の面の向き（ワールド座標）を out に入れる。面の向きの絵があればそれ、無ければ奥行きから求める。 */
export function viewNormal(v, z, x, y, step, out) {
  const m = v.c2w;
  if (v.hasLabels && z === v.z) {
    const o = (y * v.W + x) * 4, nx = v.normalPx[o] / 127.5 - 1, ny = v.normalPx[o + 1] / 127.5 - 1, nz = v.normalPx[o + 2] / 127.5 - 1, l = Math.hypot(nx, ny, nz);
    if (l > 0.5) { out[0] = nx / l; out[1] = ny / l; out[2] = nz / l; return true; }
  }
  const { fx, fy, cx, cy } = v.def.intrinsics;
  const ok = gridNormal(N3, z, v.W, v.H, x, y, cx - 0.5, cy - 0.5, 1 / fx, 1 / fy, step);
  out[0] = m[0] * N3[0] + m[1] * N3[1] + m[2] * N3[2]; out[1] = m[4] * N3[0] + m[5] * N3[1] + m[6] * N3[2]; out[2] = m[8] * N3[0] + m[9] * N3[1] + m[10] * N3[2];
  return ok;
}
const N3 = [0, 0, 1];

/** 種類の一覧（shared/labels.js の TYPES）から、「手前の物」の表を作る。layer が 'back' でない種類が手前の物。 */
export function frontTable(types) { const t = new Uint8Array(256); for (const x of types) t[x.id] = x.layer === 'back' ? 0 : 1; return t; }

/**
 * 視点 v の背後の層の粒を、粒の列にする。back は backLayer() の戻り値（画素ごと）。
 *   viewId   粒の「視点」の番号
 *   opts     { skyZ, typeOf（種類 → { sway }）, edgeMax, labelEdgeMax, maxStretch, layerId, others（ほかの視点）, emitSky（背景が空の所にも粒を置くか。空を天球にするときは false） }
 */
export function backSplats(v, back, viewId, stride, { skyZ, typeOf, edgeMax, labelEdgeMax, maxStretch = 16, layerId = 1, others = [], emitSky = true }) {
  const { W, H, near, far } = v, { fx, fy, cx, cy } = v.def.intrinsics, m = v.c2w;
  let max = 0; const off = stride >> 1;
  for (let y = off; y < H; y += stride) for (let x = off; x < W; x += stride) if (back.kind[y * W + x]) max++;
  const col = {
    position: new Float32Array(max * 3), size: new Float32Array(max), color: new Uint8Array(max * 3), edge: new Uint8Array(max).fill(edgeMax),
    sky: new Uint8Array(max), view: new Uint8Array(max).fill(viewId), depthGray: new Uint8Array(max), cov: new Float32Array(max * 6), layer: new Uint8Array(max).fill(layerId),
  };
  if (v.hasTypes) Object.assign(col, { type: new Uint8Array(max), object: new Uint16Array(max), sway: new Uint8Array(max), labelEdge: new Uint8Array(max).fill(labelEdgeMax) });
  if (v.hasLabels) Object.assign(col, { normal: new Int8Array(max * 3), sunVis0: new Uint8Array(max), lift: new Float32Array(max) });
  const zStep = (1 / near - 1 / far) / 65535, nrm = [0, 0, 1];
  let k = 0, covered = 0;
  for (let y = off; y < H; y += stride) for (let x = off; x < W; x += stride) {
    const i = y * W + x; if (!back.kind[i]) continue;
    const sky = !(back.z2[i] > 0), zz = sky ? skyZ : back.z2[i];
    if (sky && !emitSky) continue; // 空は天球が受け持つとき
    const xc = (x + 0.5 - cx) / fx * zz, yc = -(y + 0.5 - cy) / fy * zz, zc = -zz;
    const px = m[0] * xc + m[1] * yc + m[2] * zc + m[3], py = m[4] * xc + m[5] * yc + m[6] * zc + m[7], pz = m[8] * xc + m[9] * yc + m[10] * zc + m[11];
    // ほかの視点の絵に写っている所は、そちらの粒が本物なので置かない（物の後ろだけ。縁は元の粒の代わりなので残す）
    if (back.kind[i] === BACK_BEHIND && !sky && others.some((o) => paintedIn(o, px, py, pz))) { covered++; continue; }
    col.position[k * 3] = px; col.position[k * 3 + 1] = py; col.position[k * 3 + 2] = pz;
    col.size[k] = zz * stride / fy;
    col.color[k * 3] = back.rgb[i * 3]; col.color[k * 3 + 1] = back.rgb[i * 3 + 1]; col.color[k * 3 + 2] = back.rgb[i * 3 + 2];
    col.depthGray[k] = sky ? 0 : Math.max(0, Math.min(255, (1 - Math.log(zz / near) / Math.log(far / near)) * 255));
    col.sky[k] = sky ? 1 : 0;
    const s = back.from[i]; // 札を引き継ぐ元の画素
    if (v.hasTypes && s >= 0) { const t = sky ? 0 : v.type[s]; col.type[k] = t; col.object[k] = sky ? 0 : v.object[s]; col.sway[k] = Math.round(((typeOf(t) || {}).sway || 0) * 255); }
    // 形：背景の奥行きから面の向きを求める。求められなければ、元の画素の面の向き
    const sigma = col.size[k] * SIGMA_K;
    let has = !sky && viewNormal(v, back.z2, x, y, Math.max(2, stride), nrm);
    if (!has && !sky && v.hasLabels && s >= 0) { for (let c = 0; c < 3; c++) nrm[c] = v.normalPx[s * 4 + c] / 127.5 - 1; has = true; }
    if (has) { const rl = Math.hypot(px - m[3], py - m[7], pz - m[11]); surfelCov(col.cov, k * 6, nrm[0], nrm[1], nrm[2], (px - m[3]) / rl, (py - m[7]) / rl, (pz - m[11]) / rl, sigma, maxStretch); }
    else roundCov(col.cov, k * 6, sigma);
    if (v.hasLabels) {
      for (let c = 0; c < 3; c++) col.normal[k * 3 + c] = Math.round(nrm[c] * 127);
      col.sunVis0[k] = s >= 0 ? v.sunPx[s * 4] : 255; col.lift[k] = 0.05 + zz * zz * zStep;
    }
    k++;
  }
  return { columns: col, count: k, covered };
}

/** ワールドの点 (x, y, z) が、視点 o の絵に写っているか（奥行きが合い、その画素が粒になっている）。 */
export function paintedIn(o, x, y, z) {
  const m = o.w2c, { fx, fy, cx, cy } = o.def.intrinsics;
  const xc = m[0] * x + m[1] * y + m[2] * z + m[3], yc = m[4] * x + m[5] * y + m[6] * z + m[7], zc = -(m[8] * x + m[9] * y + m[10] * z + m[11]);
  if (zc <= 0.05) return false;
  const ix = Math.floor(cx + xc / zc * fx), iy = Math.floor(cy - yc / zc * fy);
  if (ix < 1 || iy < 1 || ix >= o.W - 1 || iy >= o.H - 1) return false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { // 縁のずれを許すため、隣の画素も見る
    const j = (iy + dy) * o.W + ix + dx, zk = o.z[j];
    if (zk !== 0 && Math.abs(zk - zc) < 0.03 * zc + 0.02 && (!o.onlyNew || o.onlyNew[j * 4] >= 128)) return true;
  }
  return false;
}

// ---- AI が描いた背景の絵（手前の物を消した絵）を、背後の層の色に使う ----

/**
 * 「手前の物を消した背景の絵」を AI に頼むための絵を作る。
 *   back  backLayer の結果（絵と同じ大きさ）、rgba  元の絵、grow  層のます（物とその縁）から何画素ひろげて描いてもらうか
 * 返すもの：
 *   mask   穴の印（RGBA。白 = 描いてもらう所）
 *   guide  穴を計算で埋めた絵（RGBA。どこに何の背景が来るかの目安）
 *   holes  穴の割合（0〜1）
 */
export function plateRequest(back, rgba, W, H, grow = 6) {
  const n = W * H, d = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) if (back.kind[i]) d[i] = 0;
  spread(d, W, H);
  const mask = new Uint8ClampedArray(n * 4), guide = new Uint8ClampedArray(rgba);
  let holes = 0;
  for (let i = 0; i < n; i++) {
    const hole = d[i] <= grow; if (hole) holes++;
    mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = hole ? 255 : 0; mask[i * 4 + 3] = guide[i * 4 + 3] = 255;
    if (back.kind[i]) { guide[i * 4] = back.rgb[i * 3]; guide[i * 4 + 1] = back.rgb[i * 3 + 1]; guide[i * 4 + 2] = back.rgb[i * 3 + 2]; }
  }
  return { mask, guide, holes: holes / n };
}

/**
 * 背後の層の色を、AI が描いた背景の絵に差し替えたものを返す（元の層は変えない）。
 *   plate  AI が描いた背景の絵（RGBA）、mask  そのときの穴の印（RGBA。白 = AI が描いた所）
 *   pixel  層のます → 絵の画素（SHARP のます目のとき）。無ければ同じ番号
 * 差し替えるのは、層のます（kind ≠ 0）のうち、穴の印が白い所だけ。used = 差し替えた数。
 */
export function withPlate(back, plate, mask, pixel = null) {
  const rgb = new Uint8ClampedArray(back.rgb), n = back.kind.length;
  let used = 0;
  for (let s = 0; s < n; s++) {
    if (!back.kind[s]) continue;
    const i = pixel ? pixel[s] : s; if (i < 0 || mask[i * 4] < 128) continue;
    rgb[s * 3] = plate[i * 4]; rgb[s * 3 + 1] = plate[i * 4 + 1]; rgb[s * 3 + 2] = plate[i * 4 + 2]; used++;
  }
  return { ...back, rgb, used };
}
