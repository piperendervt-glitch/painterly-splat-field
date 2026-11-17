// 粒を遠い順に並べ直す仕事を、画面の描画とは別の糸（Web Worker）で行う。歩いている間に画面が止まらないようにするため。
// 受け取るもの：
//   { type: 'source', P, B, C, D }  粒の元の並びでの描画用の値（各 vec4 × 粒の数）。表示や粒を変えたときに送られてくる
//   { type: 'sort', eye, A, B, C, D }  eye（[x, y, z]）から遠い順に並べ、A・B・C・D（渡された空きの配列）に書いて返す
// 描画用の vec4 の中身は studio/splat.js の sendSource の説明のとおり。
let P = null, SB = null, SC = null, SD = null, keys = null, dist = null, order = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'source') {
    P = m.P; SB = m.B; SC = m.C; SD = m.D;
    const n = P.length / 4;
    if (!order || order.length !== n) { keys = new Uint16Array(n); dist = new Float32Array(n); order = new Uint32Array(n); }
    return;
  }
  if (m.type !== 'sort') return;
  const A = m.A, B = m.B, C = m.C, D = m.D;
  if (!P || A.length !== P.length) { self.postMessage({ A, B, C, D, eye: m.eye, ms: 0, empty: true }, [A.buffer, B.buffer, C.buffer, D.buffer]); return; }
  const t0 = performance.now(), n = P.length / 4, [ex, ey, ez] = m.eye;
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
  for (let j = 0; j < n; j++) {
    const i = order[j] * 4, o = j * 4;
    A[o] = P[i]; A[o + 1] = P[i + 1]; A[o + 2] = P[i + 2]; A[o + 3] = P[i + 3];
    B[o] = SB[i]; B[o + 1] = SB[i + 1]; B[o + 2] = SB[i + 2]; B[o + 3] = SB[i + 3];
    C[o] = SC[i]; C[o + 1] = SC[i + 1]; C[o + 2] = SC[i + 2]; C[o + 3] = SC[i + 3];
    D[o] = SD[i]; D[o + 1] = SD[i + 1]; D[o + 2] = SD[i + 2]; D[o + 3] = SD[i + 3];
  }
  self.postMessage({ A, B, C, D, eye: m.eye, ms: performance.now() - t0 }, [A.buffer, B.buffer, C.buffer, D.buffer]);
};
