// 筆跡 1 本の形の絵（8 種類）。横が筆の進む向き、縦が筆の幅。DOM も THREE も使わない。
//   R = 塗れている（255）・いない（0）。中間の値はふちのぼかし（シェーダーで半分を境に切る）
//   G = 毛の筋の明暗（128 が中立）。シェーダーで色に掛ける（強さは絵から測った「毛の筋の強さ」）
// 形：入りは丸く太く、抜きは細くかすれる。ふちは少しぎざぎざにし、抜きのかすれは毛の筋に沿って切れる。
export const BRUSH_W = 256, BRUSH_H = 64, BRUSH_N = 8;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function brushAtlas() {
  const W = BRUSH_W, H = BRUSH_H, data = new Uint8Array(W * H * BRUSH_N * 4);
  for (let v = 0; v < BRUSH_N; v++) {
    const R = rng(1000 + v * 77);
    // 毛の筋：縦（幅の方向）に並ぶ細い筋。筋ごとに明るさと、どこで切れるかが違う
    const nb = 18 + Math.floor(R() * 14), bristles = Array.from({ length: nb }, () => ({ y: R(), tone: R(), end: 0.55 + R() * 0.45, w: 0.02 + R() * 0.03 }));
    const ragA = Array.from({ length: 6 }, () => [R() * 6.28, 3 + R() * 9, 0.02 + R() * 0.05]), ragB = Array.from({ length: 6 }, () => [R() * 6.28, 3 + R() * 9, 0.02 + R() * 0.05]);
    const bend = (R() - 0.5) * 0.25, head = 0.08 + R() * 0.1, tail = 0.25 + R() * 0.3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, yy = (y + 0.5) / H - 0.5 - bend * Math.sin(u * Math.PI) * 0.5;
      // 太さの輪郭：入りは丸く、抜きは細く
      let half = 0.46;
      if (u < head) half *= Math.sqrt(Math.max(0, 1 - ((head - u) / head) ** 2));
      if (u > 1 - tail) half *= Math.max(0, 1 - ((u - (1 - tail)) / tail) ** 1.6 * 0.85);
      let up = half, dn = half; // 上下のふちのぎざぎざ
      for (const [ph, f, a] of ragA) up += Math.sin(u * f * 6.28 + ph) * a * 0.5;
      for (const [ph, f, a] of ragB) dn += Math.sin(u * f * 6.28 + ph) * a * 0.5;
      const edge = yy >= 0 ? up - yy : dn + yy; // ふちまでの距離（正 = 中）
      // いちばん近い毛の筋
      let tone = 0.5, endAt = 1, best = 1;
      for (const b of bristles) { const d = Math.abs(yy + 0.5 - b.y); if (d < best) { best = d; tone = b.tone; endAt = b.end; } }
      let a = Math.min(1, Math.max(0, edge * 40 + 0.5));
      if (u > endAt && u > 1 - tail) a *= Math.max(0, 1 - (u - endAt) * 12); // 抜きのかすれ：筋ごとに切れる
      const o = ((v * H + y) * W + x) * 4;
      data[o] = Math.round(a * 255);
      data[o + 1] = Math.round(Math.min(255, Math.max(0, 128 + (tone - 0.5) * 200 + Math.sin(u * 40 + tone * 9) * 10)));
      data[o + 2] = 0; data[o + 3] = 255;
    }
  }
  return { data, width: W, height: H * BRUSH_N };
}
