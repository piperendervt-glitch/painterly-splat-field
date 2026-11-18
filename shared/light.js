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

// ---- 1日の光 ----
// 時刻（0〜24）から、照らす光の向き・色・強さと、空の光の色・強さを返す。
// 太陽は 6 時に +X（方位 90°）から昇り、12 時に +Z の空（方位 0°、カメラAの背中側）でいちばん高く、18 時に -X（方位 270°）へ沈む。
// 夜は同じ道を月が通る（弱い青い光）。日の出・日の入りの瞬間は強さが 0 になるので、太陽と月の入れ替わりは見えない。
export const SUN_PEAK = 62, MOON_PEAK = 50; // いちばん高いときの高さ（度）
const DAY_KEYS = [
  // 時刻, 照らす光の色, 強さ, 空の光の色, 強さ
  [0, '#8fb0ff', 0.12, '#2a3a7a', 0.30],
  [4.5, '#8fb0ff', 0.12, '#2a3a7a', 0.30],
  [6, '#ff8a4a', 0, '#8f86b8', 0.36],
  [6.7, '#ffb070', 0.7, '#c9a9b8', 0.44],
  [8, '#ffe0b8', 0.95, '#b9cdf2', 0.50],
  [12, '#fff7e6', 1.1, '#cfe2ff', 0.55],
  [16, '#ffeccc', 1.0, '#c5d5f5', 0.52],
  [17.3, '#ff9a4a', 0.8, '#b89ac0', 0.46],
  [18, '#ff6a2a', 0, '#7a6fb0', 0.40],
  [19.5, '#8fb0ff', 0.12, '#3a4488', 0.32],
  [24, '#8fb0ff', 0.12, '#2a3a7a', 0.30],
];
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
export function dayLight(hour) {
  const h = ((hour % 24) + 24) % 24;
  let k = 0; while (k < DAY_KEYS.length - 2 && h >= DAY_KEYS[k + 1][0]) k++;
  const a = DAY_KEYS[k], b = DAY_KEYS[k + 1], t = (h - a[0]) / (b[0] - a[0]);
  const lerp = (x, y) => x + (y - x) * t, mixHex = (x, y) => rgbHex(hexRgb(x).map((v, i) => lerp(v, hexRgb(y)[i])));
  const day = h >= 6 && h < 18, u = day ? (h - 6) / 12 : ((h + 6) % 24) / 12; // 昇ってから沈むまでを 0〜1
  return {
    azimuth: ((90 - 180 * u) % 360 + 360) % 360, elevation: (day ? SUN_PEAK : MOON_PEAK) * Math.sin(Math.PI * u),
    sunColor: mixHex(a[1], b[1]), sun: lerp(a[2], b[2]), skyColor: mixHex(a[3], b[3]), sky: lerp(a[4], b[4]), moon: !day,
  };
}
// 時間帯の見本（時刻）
export const PRESET_HOURS = { morning: 7.5, noon: 12, evening: 17.3, night: 22 };
