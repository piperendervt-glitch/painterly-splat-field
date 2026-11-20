// 穴（真のマゼンタ）を、同じ行のいちばん長い描いてある区間を鏡写しにして埋める。にせの描き手（mirror-codex、fake-inpaint）が使う。
export function mirrorFill(img) {
  const { width: W, height: H, data: d } = img;
  const hole = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) hole[i] = d[i * 4] > 250 && d[i * 4 + 1] < 5 && d[i * 4 + 2] > 250 ? 1 : 0;
  const out = new Uint8Array(d);
  const mirror = (x, lo, hi) => { // lo..hi（描いてある区間）の中で折り返す
    const n = hi - lo; if (n <= 0) return lo;
    let t = (x - lo) % (2 * n); if (t < 0) t += 2 * n;
    return lo + (t > n ? 2 * n - t : t);
  };
  let last = null;
  for (let y = 0; y < H; y++) {
    // この行の描いてある区間のうち、いちばん長いものを写す元にする
    let best = null, s = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && !hole[y * W + x];
      if (on && s < 0) s = x;
      if (!on && s >= 0) { if (!best || x - 1 - s > best[1] - best[0]) best = [s, x - 1]; s = -1; }
    }
    if (!best || best[1] - best[0] < 8) best = null;
    for (let x = 0; x < W; x++) {
      if (!hole[y * W + x]) continue;
      const o = (y * W + x) * 4;
      if (best) { const sx = mirror(x, best[0], best[1]), i = (y * W + sx) * 4; out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; }
      else if (last) { const i = (last * W + x) * 4; out[o] = out[i]; out[o + 1] = out[i + 1]; out[o + 2] = out[i + 2]; } // 行ぜんぶが穴：上の行を写す
      else { out[o] = 120; out[o + 1] = 140; out[o + 2] = 110; }
      out[o + 3] = 255;
    }
    last = y;
  }
  return { width: W, height: H, data: out };
}
