// 粒を遠い順に並べ直す仕事を、画面の描画とは別の糸（Web Worker）で行う。歩いている間に画面が止まらないようにするため。
// 受け取るもの：
//   { type: 'source', arrays }     粒の元の並びでの描画用の値（vec4 × 粒の数 の配列を何本か。1 本目が [位置 xyz, 粒の間隔]）。表示や粒を変えたときに送られてくる
//   { type: 'sort', eye, arrays }  eye（[x, y, z]）から遠い順に並べ、arrays（渡された空きの配列。本数は source と同じ）に書いて返す
// 描画用の vec4 の中身は studio/splat.js の sendSource の説明のとおり。
let src = null, keys = null, dist = null, order = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'source') {
    src = m.arrays;
    const n = src[0].length / 4;
    if (!order || order.length !== n) { keys = new Uint16Array(n); dist = new Float32Array(n); order = new Uint32Array(n); }
    return;
  }
  if (m.type !== 'sort') return;
  const out = m.arrays, send = (extra) => self.postMessage({ arrays: out, eye: m.eye, ...extra }, out.map((a) => a.buffer));
  if (!src || out.length !== src.length || out[0].length !== src[0].length) return send({ ms: 0, empty: true });
  const t0 = performance.now(), P = src[0], n = P.length / 4, [ex, ey, ez] = m.eye;
  let far = 0;
  for (let i = 0; i < n; i++) {
    const dx = P[i * 4] - ex, dy = P[i * 4 + 1] - ey, dz = P[i * 4 + 2] - ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz); dist[i] = d; if (d > far) far = d;
  }
  // 近い所ほど細かく分けたいので、距離の平方根で 16bit に刻み、数え上げで並べる
  const scale = 65535 / Math.sqrt(far || 1), count = new Uint32Array(65537);
  for (let i = 0; i < n; i++) { const key = 65535 - Math.min(65535, Math.sqrt(dist[i]) * scale | 0); keys[i] = key; count[key + 1]++; }
  for (let i = 0; i < 65536; i++) count[i + 1] += count[i];
  for (let i = 0; i < n; i++) order[count[keys[i]]++] = i;
  for (let k = 0; k < src.length; k++) {
    const S = src[k], A = out[k];
    for (let j = 0; j < n; j++) { const i = order[j] * 4, o = j * 4; A[o] = S[i]; A[o + 1] = S[i + 1]; A[o + 2] = S[i + 2]; A[o + 3] = S[i + 3]; }
  }
  send({ ms: performance.now() - t0 });
};
