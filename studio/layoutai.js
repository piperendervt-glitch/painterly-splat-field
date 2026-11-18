// AI（Codex）に書かせた「形の配置」（箱と円柱の一覧）を、絵と見比べるための道具。DOM も THREE も使わない。
//
// 配置の座標：カメラの真下の地面が原点、+x = 絵の右、+y = 上、+z = 奥（カメラから離れる向き。地面に沿う）。単位は m。
// 配置の形（paint/paint.mjs の layout が整えたもの）：
//   { objects: [{ name, shape: 'box', center: [x, y, z], size: [幅, 高さ, 奥行き], yaw_deg } | { name, shape: 'cylinder', center, radius, height }] }
//
// 流れ（studio/splat.js）：briefText でカメラと奥行きの表を文にして AI に渡す → 返ってきた配置を worldShapes でワールドに置く →
// rasterLayout で絵の上に写す → compareLayout で奥行き・物の輪郭と見比べた文と点数を作る → それを AI に見せて直してもらう。

/** 視点（c2w = 行ごとの 4x4）と地面の高さから、配置の座標のわく（原点と軸）を作る。 */
export function layoutFrame(c2w, baseY) {
  let fx = -c2w[2], fz = -c2w[10];
  const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
  return { origin: [c2w[3], baseY, c2w[11]], right: [-fz, 0, fx], fwd: [fx, 0, fz], height: c2w[7] - baseY };
}
const toWorld = (f, p) => [f.origin[0] + f.right[0] * p[0] + f.fwd[0] * p[2], f.origin[1] + p[1], f.origin[2] + f.right[2] * p[0] + f.fwd[2] * p[2]];
/** ワールドの点を配置の座標にする。 */
export function toLayout(f, x, y, z) {
  const dx = x - f.origin[0], dz = z - f.origin[2];
  return [dx * f.right[0] + dz * f.right[2], y - f.origin[1], dx * f.fwd[0] + dz * f.fwd[2]];
}

/**
 * 配置をワールドに置く。返すのは [{ name, shape, center, half, yaw（three.js の rotation.y）, ax, az（水平の 2 軸）, radius }]。
 * 円柱は half = [半径, 高さ / 2, 半径]。
 */
export function worldShapes(layout, frame) {
  return (layout.objects || []).map((o) => {
    const a = (o.yaw_deg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), cyl = o.shape === 'cylinder';
    // 配置の座標で、箱の幅の軸 = (cos, 0, sin)、奥行きの軸 = (-sin, 0, cos)
    const ax = [frame.right[0] * c + frame.fwd[0] * s, 0, frame.right[2] * c + frame.fwd[2] * s], az = [-frame.right[0] * s + frame.fwd[0] * c, 0, -frame.right[2] * s + frame.fwd[2] * c];
    return { name: o.name, shape: cyl ? 'cylinder' : 'box', center: toWorld(frame, o.center), half: cyl ? [o.radius, o.height / 2, o.radius] : [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2],
      yaw: cyl ? 0 : Math.atan2(-ax[2], ax[0]), ax: cyl ? [1, 0, 0] : ax, az: cyl ? [0, 0, 1] : az, radius: cyl ? o.radius : 0 };
  });
}

const CYL_SIDES = 16;
// 形の面（四角形の頂点 4 つ × 面の数）と、線で描くときの辺（点 2 つ × 辺の数）
function shapeFaces(s) {
  const { center: c, half: h, ax, az } = s, P = (i, j, k) => [c[0] + ax[0] * i + az[0] * k, c[1] + j, c[2] + ax[2] * i + az[2] * k];
  if (s.shape !== 'cylinder') {
    const v = (i, j, k) => P(i * h[0], j * h[1], k * h[2]);
    return [[v(-1, -1, -1), v(1, -1, -1), v(1, 1, -1), v(-1, 1, -1)], [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)], [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)],
      [v(1, -1, -1), v(1, -1, 1), v(1, 1, 1), v(1, 1, -1)], [v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1)], [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)]];
  }
  const faces = [], r = h[0];
  for (let i = 0; i < CYL_SIDES; i++) {
    const a0 = i / CYL_SIDES * 2 * Math.PI, a1 = (i + 1) / CYL_SIDES * 2 * Math.PI, p = (a, j) => P(Math.cos(a) * r, j, Math.sin(a) * r);
    faces.push([p(a0, -h[1]), p(a1, -h[1]), p(a1, h[1]), p(a0, h[1])]);
    faces.push([P(0, h[1], 0), p(a0, h[1]), p(a1, h[1]), P(0, h[1], 0)]); // 上のふた（三角）
  }
  return faces;
}
/** 線で描くときの辺：[[点, 点], …]（ワールド座標）。 */
export function shapeEdges(s) {
  const edges = [];
  if (s.shape !== 'cylinder') {
    const f = shapeFaces(s);
    for (const q of [f[0], f[1]]) for (let i = 0; i < 4; i++) edges.push([q[i], q[(i + 1) % 4]]);
    for (let i = 0; i < 4; i++) edges.push([f[0][i], f[1][i]]);
    return edges;
  }
  const { center: c, half: h } = s, p = (a, j) => [c[0] + Math.cos(a) * h[0], c[1] + j, c[2] + Math.sin(a) * h[0]];
  for (let i = 0; i < CYL_SIDES; i++) {
    const a0 = i / CYL_SIDES * 2 * Math.PI, a1 = (i + 1) / CYL_SIDES * 2 * Math.PI;
    edges.push([p(a0, -h[1]), p(a1, -h[1])], [p(a0, h[1]), p(a1, h[1])]);
    if (i % 4 === 0) edges.push([p(a0, -h[1]), p(a0, h[1])]);
  }
  return edges;
}

/** ワールドの点を視点の絵に写す。out = [u, v, zc]（zc = カメラの前向きの距離。0.05 以下なら後ろ）。view = { w2c, intr: { fx, fy, cx, cy } } */
export function project(view, p, out) {
  const m = view.w2c, { fx, fy, cx, cy } = view.intr;
  const xc = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], yc = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], zc = -(m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]);
  out[2] = zc;
  if (zc > 0.05) { out[0] = cx + xc / zc * fx; out[1] = cy - yc / zc * fy; }
  return out;
}

/**
 * 形を絵の上に写す（粗います目。cell 画素ごと）。いちばん手前の形の番号と距離を持つ。
 * 返すもの：{ gw, gh, cell, id（Int16Array。-1 = 何も無い）, depth（Float32Array） }
 */
export function rasterLayout(shapes, view, cell = 4) {
  const gw = Math.ceil(view.W / cell), gh = Math.ceil(view.H / cell), id = new Int16Array(gw * gh).fill(-1), depth = new Float32Array(gw * gh).fill(Infinity);
  const q = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], t = [0, 0, 0];
  shapes.forEach((s, si) => {
    for (const face of shapeFaces(s)) {
      let front = 0;
      for (let k = 0; k < 4; k++) { project(view, face[k], q[k]); if (q[k][2] > 0.05) front++; }
      if (!front) continue;
      // 面の上に点を打つ数：写した辺の長さ（ます目）から。カメラの後ろへ回る面は多めに打つ
      const len = (a, b) => (q[a][2] > 0.05 && q[b][2] > 0.05 ? Math.hypot(q[a][0] - q[b][0], q[a][1] - q[b][1]) / cell : 300);
      const nu = Math.max(2, Math.min(600, Math.ceil(Math.max(len(0, 1), len(3, 2)) * 1.6))), nv = Math.max(2, Math.min(600, Math.ceil(Math.max(len(0, 3), len(1, 2)) * 1.6)));
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const a = i / nu, b = j / nv, w0 = (1 - a) * (1 - b), w1 = a * (1 - b), w2 = a * b, w3 = (1 - a) * b;
        t[0] = face[0][0] * w0 + face[1][0] * w1 + face[2][0] * w2 + face[3][0] * w3; t[1] = face[0][1] * w0 + face[1][1] * w1 + face[2][1] * w2 + face[3][1] * w3; t[2] = face[0][2] * w0 + face[1][2] * w1 + face[2][2] * w2 + face[3][2] * w3;
        const p = project(view, t, q[0]); // q[0] は面の頂点の写しを持っていたが、もう使わない
        if (!(p[2] > 0.05)) continue;
        const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
        const o = gy * gw + gx;
        if (p[2] < depth[o]) { depth[o] = p[2]; id[o] = si; }
      }
    }
  });
  return { gw, gh, cell, id, depth };
}

const pct = (x) => `${Math.round(100 * x)}%`;
const r1 = (x) => (Math.abs(x) >= 100 ? String(Math.round(x)) : (Math.round(x * 10) / 10).toString());
const median = (a) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[a.length >> 1]; };

/**
 * 写した形（rasterLayout）を、絵の奥行きと「手前の物」の輪郭と見比べる。
 *   view   { W, H, z（奥行き。0 = 空）, w2c, intr }
 *   thing  Uint8Array（1 = 手前の物の画素、2 = 木の葉など「形にしなくてよい物」の画素。2 は重なりの点数に数えない）か null、object  物体の番号（Uint16Array）か null
 * 返すもの：{ text（AI に見せる英語の文）, score（0〜1。輪郭があれば重なり IoU、無ければ奥行きの合う割合）, covered, precise, perShape: [{ cells, sky, ratio, onThing }] }
 */
export function compareLayout(shapes, raster, view, { thing = null, object = null } = {}) {
  const { gw, gh, cell, id, depth } = raster, { W, H, z } = view, half = cell >> 1;
  const st = shapes.map(() => ({ cells: 0, sky: 0, onThing: 0, ratios: [], x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
  let things = 0, inter = 0, union = 0, agree = 0, shapeCells = 0;
  const obj = new Map(); // 物体の番号 → 覆われていないますなど
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const o = gy * gw + gx, px = Math.min(W - 1, gx * cell + half), py = Math.min(H - 1, gy * cell + half), pi = py * W + px, k = id[o], isThing = thing ? thing[pi] === 1 : false, soft = thing ? thing[pi] === 2 : false;
    if (isThing) things++;
    if (isThing || (k >= 0 && !soft)) union++;
    if (isThing && k >= 0) inter++;
    if (isThing && object) {
      const e = obj.get(object[pi]) || { cells: 0, open: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1, zs: [] };
      e.cells++; if (k < 0) { e.open++; e.x0 = Math.min(e.x0, px); e.x1 = Math.max(e.x1, px); e.y0 = Math.min(e.y0, py); e.y1 = Math.max(e.y1, py); if (z[pi] > 0 && e.zs.length < 4000) e.zs.push(z[pi]); }
      obj.set(object[pi], e);
    }
    if (k < 0) continue;
    const s = st[k]; s.cells++; if (!soft) shapeCells++;
    s.x0 = Math.min(s.x0, px); s.x1 = Math.max(s.x1, px); s.y0 = Math.min(s.y0, py); s.y1 = Math.max(s.y1, py);
    if (isThing || soft) s.onThing++;
    if (z[pi] === 0) s.sky++;
    else { const r = z[pi] / depth[o]; if (s.ratios.length < 20000) s.ratios.push(r); if (r > 0.8 && r < 1.25) agree++; }
  }
  const lines = [], total = gw * gh;
  shapes.forEach((sh, k) => {
    const s = st[k];
    s.ratio = median(s.ratios);
    if (!s.cells) { lines.push(`${k + 1} ${sh.name} : NOT VISIBLE in the picture (outside the frame, behind the camera, or completely hidden behind another shape). Move it into view or delete it.`); return; }
    const notes = [], sky = s.sky / s.cells, on = thing ? s.onThing / s.cells : null;
    if (sky > 0.25) notes.push(`${pct(sky)} of it lands on SKY: it is too tall, too wide or in the wrong place`);
    if (s.ratios.length && s.ratio > 1.25) notes.push(`the depth map at its pixels is ${r1(s.ratio)}x FARTHER than the shape: move it away from the camera (larger z), or nothing is there`);
    else if (s.ratios.length && s.ratio < 0.8) notes.push(`the depth map at its pixels is ${r1(s.ratio)}x its distance, so the picture is NEARER: move it closer (smaller z)`);
    else if (s.ratios.length) notes.push(`distance agrees with the depth map (${r1(s.ratio)}x)`);
    if (on !== null) notes.push(on < 0.5 ? `only ${pct(on)} of it lies on an object of the picture: it is too big, misplaced, or there is no object there` : `${pct(on)} of it lies on an object of the picture`);
    lines.push(`${k + 1} ${sh.name} : pixels x ${s.x0}-${s.x1}, y ${s.y0}-${s.y1} (${r1(100 * s.cells / total)}% of the picture). ${notes.join('. ')}.`);
  });
  const out = { perShape: st, covered: things ? inter / things : 0, precise: shapeCells ? inter / shapeCells : 0, score: thing && things ? inter / Math.max(1, union) : shapeCells ? agree / shapeCells : 0 };
  const text = [`Shapes of the current layout (number name : comparison with the picture). The picture is ${W} x ${H} pixels.`, ...lines];
  if (thing && things) {
    text.push('', `Overall: the shapes cover ${pct(out.covered)} of the object pixels of the picture, and ${pct(out.precise)} of the shape pixels lie on objects. Overlap score (IoU) ${pct(out.score)}.`);
    const open = [...obj.entries()].filter(([, e]) => e.open >= 12 && (e.open / e.cells >= 0.25 || e.open >= 400)).sort((a, b) => b[1].open - a[1].open).slice(0, 10);
    if (open.length) {
      text.push('Parts of objects of the picture that NO shape covers yet (add or enlarge shapes for these; each line is the uncovered part):');
      for (const [, e] of open) text.push(`- pixels x ${e.x0}-${e.x1}, y ${e.y0}-${e.y1}${e.zs.length ? `, camera distance about ${r1(median(e.zs))} m` : ''} (${pct(e.open / e.cells)} of that object is uncovered)`);
    }
  }
  out.text = text.join('\n');
  return out;
}

/**
 * AI に渡す、カメラと奥行きの説明の文（英語）。奥行きの表は、絵の上の格子の点ごとに、そこに見えている面の配置の座標 (x, y, z)。
 *   view { W, H, z, c2w, intr }
 */
export function briefText(view, frame, { cols = 7, rows = 11 } = {}) {
  const { W, H, z, c2w, intr } = view, { fx, fy, cx, cy } = intr, deg = 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -c2w[6]))) * deg; // 前向き（-Z 列）の上向きの成分
  const horizon = cy + Math.tan(pitch / deg) * fy; // ピッチだけなら、地平線は横 1 本
  const lines = [
    `Image: ${W} x ${H} pixels (x to the right, y downward).`,
    `Camera: ${r1(frame.height)} m above the ground, looking ${r1(Math.abs(pitch))} degrees ${pitch >= 0 ? 'upward' : 'downward'} from horizontal. Field of view: ${r1(2 * Math.atan(W / 2 / fx) * deg)} degrees horizontal, ${r1(2 * Math.atan(H / 2 / fy) * deg)} degrees vertical.`,
    `The horizon is at pixel row y = ${Math.round(horizon)}.`,
    `Horizontal angle of pixel column x: a = atan((x - ${r1(cx)}) / ${r1(fx)}) (x = 0 is ${r1(Math.atan(-cx / fx) * deg)} degrees, x = ${W} is +${r1(Math.atan((W - cx) / fx) * deg)} degrees).`,
    '',
    'Depth table: the 3D position (x, y, z) in metres, in the coordinate system described below, of the surface seen at each sample pixel. "sky" = nothing there.',
  ];
  const xs = Array.from({ length: cols }, (_, i) => Math.round((i + 0.5) * W / cols)), ys = Array.from({ length: rows }, (_, j) => Math.round((j + 0.5) * H / rows));
  for (const py of ys) {
    const cells = xs.map((px) => {
      // まわり 5×5 画素のまん中の値（1 画素の荒れを避ける）
      const zs = []; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = Math.max(0, Math.min(W - 1, px + dx * 2)), y = Math.max(0, Math.min(H - 1, py + dy * 2)); zs.push(z[y * W + x]); }
      const zc = median(zs);
      if (!zc) return `x=${px}: sky`;
      const xc = (px + 0.5 - cx) / fx * zc, yc = -(py + 0.5 - cy) / fy * zc;
      const wx = c2w[0] * xc + c2w[1] * yc - c2w[2] * zc + c2w[3], wy = c2w[4] * xc + c2w[5] * yc - c2w[6] * zc + c2w[7], wz = c2w[8] * xc + c2w[9] * yc - c2w[10] * zc + c2w[11];
      const p = toLayout(frame, wx, wy, wz);
      return `x=${px}: (${r1(p[0])}, ${r1(p[1])}, ${r1(p[2])})`;
    });
    lines.push(`row y=${py} | ${cells.join(' | ')}`);
  }
  return lines.join('\n');
}
