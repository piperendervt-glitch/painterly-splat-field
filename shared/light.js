// 光の式。プレビズの「光なし／影つき」の絵、粒の光の付け替え、どちらも同じ式を使う。
//
//   空の光  hemi(n) = 0.8 + 0.2 * n.y                 上を向いた面ほど少し明るい。向きのない光。
//   明るさ  L = ambient * hemi(n) + sun * max(n・l, 0) * vis
//             n = 面の向き、l = 太陽の方向（面から太陽へ）、vis = 太陽が見えるか（0 = 影、1 = 日なた）
//
// 粒の色は「絵の色 × 今の明るさ ÷ 描いたときの明るさ」で動かす。
//   光の少ない絵   描いたときの明るさ = hemi(n)                         （ambient 1、sun 0）
//   影つきの絵     描いたときの明るさ = 0.45 * hemi(n) + 1.0 * max(n・l0, 0) * vis0

export const hemi = (ny) => 0.8 + 0.2 * ny;

export const FLAT_LIGHT = { ambient: 1, sun: 0 };
export const LIT_LIGHT = { ambient: 0.45, sun: 1 };

/** 方位（度。0 = +Z の方向、90 = +X の方向）と高さ（度）から、太陽の方向（面から太陽へ向かう単位ベクトル）。 */
export function sunDirection(azimuthDeg, elevationDeg) {
  const a = azimuthDeg * Math.PI / 180, e = elevationDeg * Math.PI / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}
export function sunAngles(dir) {
  const [x, y, z] = dir, len = Math.hypot(x, y, z);
  let az = Math.atan2(x, z) * 180 / Math.PI; if (az < 0) az += 360;
  return { azimuth: az, elevation: Math.asin(y / len) * 180 / Math.PI };
}

export function brightness(light, ny, ndl, vis) {
  return light.ambient * hemi(ny) + light.sun * Math.max(ndl, 0) * vis;
}

// 太陽から見た奥行きの地図（sun map）で、点が日なたか影かを調べる。
//   map = { size, depth: Float32Array(size*size)（太陽側の面からの距離 m。何も無い所は Infinity）,
//           m: 太陽カメラの world→camera 行列（three の elements と同じ列優先 16 個）,
//           left, right, bottom, top, near }
// 戻り値 0〜1（縁は 4 点の平均でなだらかにする）。地図の外は日なた。
export function visibilityAt(map, x, y, z, bias) {
  const e = map.m;
  const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const d = -(e[2] * x + e[6] * y + e[10] * z + e[14]) - bias;
  const fx = (cx - map.left) / (map.right - map.left) * map.size - 0.5;
  const fy = (map.top - cy) / (map.top - map.bottom) * map.size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const lit = (ix, iy) => (ix < 0 || iy < 0 || ix >= map.size || iy >= map.size ? 1 : (d <= map.depth[iy * map.size + ix] ? 1 : 0));
  return (lit(x0, y0) * (1 - tx) + lit(x0 + 1, y0) * tx) * (1 - ty) + (lit(x0, y0 + 1) * (1 - tx) + lit(x0 + 1, y0 + 1) * tx) * ty;
}

// 時間帯の見本。太陽の向き・色・強さと、空の光の色・強さ。
export const PRESETS = {
  morning: { name: '朝', azimuth: 100, elevation: 14, sunColor: '#ffd9a8', sun: 0.9, skyColor: '#b9cdf2', sky: 0.5 },
  noon:    { name: '昼', azimuth: 200, elevation: 68, sunColor: '#fff7e6', sun: 1.1, skyColor: '#cfe2ff', sky: 0.55 },
  evening: { name: '夕', azimuth: 285, elevation: 9,  sunColor: '#ff9a4a', sun: 0.95, skyColor: '#9a8fc7', sky: 0.42 },
  night:   { name: '夜', azimuth: 320, elevation: 40, sunColor: '#8fb0ff', sun: 0.12, skyColor: '#2a3a7a', sky: 0.3 },
};
