// 粒を触って揺らす：マウスのブラシや歩く人の体で粒を押すと、ばねで元の場所へ戻りながら、ぷるぷる揺れる。
//
// 粒ごとに「元の場所からのずれ」を持ち、GPU で毎コマ動かす（ばね・減衰・ブラシの力・体の押しのけ）。
//   ずれは浮動小数の画像（一辺 W の正方形に近い形。1 画素 = 1 粒）に入れる。粒の番号 i は画素 (i % W, floor(i / W))。
//   動かし方は Verlet 法：次 = 今 + (今 − 前) × 減衰 + 加速度 × dt²。前・今・次の 3 枚を回して使う。
//   粒は遠い順に並べ直されるので、描くときは粒が持っている元の番号（F.z）で画像を引く。
// 画像の座標は WebGPU の向き（上が 0）で揃える。three.js は WebGL 2 でも screenCoordinate と描き込んだ画像の textureLoad を
// 同じ向きに直してくれるので、どちらの描き方でも番号と画素が一致する。
//
// 待機中のゆらぎ（粒ごとに違う速さでふわふわ動く）は状態を持たないので、描くときにシェーダーで足すだけ（offsetNodes）。
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, textureLoad, screenCoordinate, ivec2, int, vec2, vec3, vec4, float, sin, cos, dot, floor, fract, max, min, mix, step, smoothstep, abs, sqrt, exp, clamp, normalize, cross, length, hash } from 'three/tsl';

export const BRUSH_MODES = ['push', 'stroke', 'press', 'pull', 'swirl', 'scatter', 'flick'];
const SUB = 1 / 120; // 1 回の計算で進める時間（秒）。ばねが速くても暴れないように細かく刻む

export function createJiggle() {
  const u = {
    on: uniform(0),                       // 0 なら、ずれを足さない（描くとき）
    time: uniform(0),
    // ばね：k = (2π × 戻る速さ Hz)²。zeta は減衰（0 = いつまでも揺れる、1 = 揺れずに戻る）。drag は空気の抵抗（ばね 0 のとき用）
    k: uniform(Math.pow(2 * Math.PI * 1.6, 2)), zeta: uniform(0.12), spread: uniform(0.35), maxShift: uniform(3),
    typeAware: uniform(0),                // 1 なら揺れやすい種類（草・葉）ほど柔らかく、石などは硬く
    // ブラシ：画面の上の円（CSS 画素）。hit は円の中でいちばん手前の面までの奥行き（m）、band はその前後で押す幅（m、0 なら奥まで全部）
    brushOn: uniform(0), mode: uniform(0), cursor: uniform(new THREE.Vector2(-1e4, -1e4)), radius: uniform(60), strength: uniform(0.5),
    hit: uniform(1e9), band: uniform(2), viewport: uniform(new THREE.Vector2(1, 1)),
    viewProj: uniform(new THREE.Matrix4()), camRight: uniform(new THREE.Vector3(1, 0, 0)), camUp: uniform(new THREE.Vector3(0, 1, 0)), camFwd: uniform(new THREE.Vector3(0, 0, -1)),
    brushVel: uniform(new THREE.Vector3()), // ブラシが動いた速さ（m/秒、世界の向き）。「なでる」で粒を連れていく
    kick: uniform(0),                     // 「はじく」：押した瞬間だけ 1
    // 体：歩く人のカプセル（足元 feet、半径 bodyR、高さ bodyH）。bodyK は押しのける強さ 0〜1、lift は足元の地面を押さない高さ
    feet: uniform(new THREE.Vector3(0, -1e4, 0)), bodyR: uniform(0.35), bodyH: uniform(1.75), bodyK: uniform(0), lift: uniform(0.08),
    // 待機中のゆらぎ：粒の間隔に対する揺れ幅と、速さ
    wobble: uniform(0), wobbleSpeed: uniform(1),
    // 表示：heatScale は「動いた量」の色の目盛り（m）
    heatScale: uniform(0.5),
    // 計算用
    dt: uniform(SUB), n: uniform(0), W: uniform(1),
  };

  const placeholder = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType); placeholder.needsUpdate = true;
  const restNode = texture(placeholder);
  const readCur = texture(placeholder), readPrev = texture(placeholder);
  // 描くときに引く画像（今と前）。あとで .value を差し替える
  const drawCur = texture(placeholder), drawPrev = texture(placeholder);

  let st = null; // { W, H, n, rest, rts: [3], cur, renderer, quad, clearQuad }

  // ---- 1 回ぶん進める計算（画面いっぱいの四角を、ずれの画像へ描く） ----
  const simNode = Fn(() => {
    const c = ivec2(screenCoordinate.xy);
    const id = float(c.y).mul(u.W).add(float(c.x));
    const live = step(id, u.n.sub(0.5));
    const rest = restNode.load(c), cur = readCur.load(c).xyz, prev = readPrev.load(c).xyz;
    const pos = rest.xyz.add(cur);

    // 粒ごとの硬さ：ばらつき（spread）と、種類（rest.w = 揺れやすさ 0〜1。札が無ければ 1）
    const h1 = hash(id), h2 = hash(id.add(7.31)), h3 = hash(id.add(19.7));
    const soft = mix(float(1), rest.w.mul(0.85).add(0.15), u.typeAware);
    const kI = u.k.mul(float(1).add(h1.sub(0.5).mul(2).mul(u.spread))).mul(mix(float(1), float(0.25).add(rest.w.mul(0.75)), u.typeAware)).max(0);
    const omega = sqrt(kI);
    const kRef = max(u.k, float(Math.pow(2 * Math.PI * 1.0, 2))); // ばねが 0（戻らない）でも押せるように
    const damp = exp(u.zeta.mul(2).mul(max(omega, 6.0)).mul(u.dt).negate());
    const vel = cur.sub(prev);

    // ---- ブラシ ----
    const clip = u.viewProj.mul(vec4(pos, 1));
    const wv = max(clip.w, 1e-4);
    const ndc = clip.xy.div(wv);
    const px = vec2(ndc.x.mul(0.5).add(0.5).mul(u.viewport.x), float(0.5).sub(ndc.y.mul(0.5)).mul(u.viewport.y)); // 上が 0 の CSS 画素
    const toP = px.sub(u.cursor), dpx = length(toP), d = dpx.div(u.radius);
    const inFront = step(0.0001, clip.w);
    const depthOk = mix(float(1), float(1).sub(smoothstep(u.band, u.band.mul(1.6).add(0.2), abs(clip.w.sub(u.hit)))), step(0.001, u.band));
    const fall = exp(d.mul(d).mul(-2.6)).mul(float(1).sub(step(1.35, d))).mul(inFront).mul(depthOk).mul(u.brushOn).mul(soft);
    const sd = toP.div(max(dpx, 0.5)); // 画面の上で、円の中心から粒への向き（下が +y）
    const radial = u.camRight.mul(sd.x).sub(u.camUp.mul(sd.y));
    const tangent = u.camRight.mul(sd.y.negate()).sub(u.camUp.mul(sd.x));
    const rnd = normalize(vec3(h1.sub(0.5), h2.sub(0.5), h3.sub(0.5)).add(1e-4));
    const m = u.mode;
    const is = (k) => float(1).sub(step(0.5, abs(m.sub(k))));
    // 力の向き（強さ 1 で、ばねと釣り合ったときに strength m ずれる）
    const dir = radial.mul(is(0)).add(u.camFwd.mul(0.35).mul(is(0)))          // 押しのける
      .add(u.camFwd.mul(is(2)))                                                 // へこませる
      .add(radial.mul(-0.8).sub(u.camFwd.mul(0.6)).mul(is(3)))                  // 引っぱる
      .add(tangent.mul(is(4)))                                                  // かき回す
      .add(rnd.mul(is(5)));                                                     // ばらばら
    const accBrush = dir.mul(u.strength).mul(kRef).mul(fall);
    // なでる：ブラシの動きに連れていく（粒の速さをブラシの速さへ寄せる）
    const velNow = vel.div(u.dt);
    const accStroke = u.brushVel.sub(velNow).mul(fall).mul(is(1)).mul(24).mul(u.strength.mul(2).min(4));
    // はじく：押した瞬間に、外向き＋ばらばらの速さを一度だけ与える
    const kickVel = radial.add(rnd.mul(0.7)).add(u.camFwd.mul(0.3)).mul(u.strength).mul(omega.max(4)).mul(fall).mul(u.kick).mul(is(6));

    const acc = cur.mul(kI.negate()).add(accBrush).add(accStroke);
    let next = cur.add(vel.mul(damp)).add(kickVel.mul(u.dt)).add(acc.mul(u.dt.mul(u.dt)));

    // ---- 体：カプセルの中に入った粒を外へ押し出す ----
    const a = u.feet.add(vec3(0, u.bodyR.add(u.lift), 0)), b = u.feet.add(vec3(0, max(u.bodyH.sub(u.bodyR), u.bodyR.add(u.lift)), 0));
    const p2 = rest.xyz.add(next), ab = b.sub(a);
    const t = clamp(dot(p2.sub(a), ab).div(max(dot(ab, ab), 1e-6)), 0, 1);
    const q = a.add(ab.mul(t)), off = p2.sub(q);
    const dist = length(off);
    const flat = vec3(off.x, 0, off.z);
    const outDir = mix(normalize(flat.add(vec3(1e-4, 0, 0))), off.div(max(dist, 1e-5)), step(0.02, dist));
    const inside = float(1).sub(step(u.bodyR, dist));
    next = next.add(outDir.mul(u.bodyR.sub(dist)).mul(inside).mul(u.bodyK).mul(soft));

    // 動かせる距離の上限（ユーザーが決める）
    const L = length(next);
    next = next.mul(min(float(1), u.maxShift.div(max(L, 1e-6))));
    return vec4(next.mul(live), 1);
  })();

  const simMat = new THREE.NodeMaterial();
  simMat.fragmentNode = simNode; simMat.depthTest = false; simMat.depthWrite = false; simMat.blending = THREE.NoBlending;
  const quad = new THREE.QuadMesh(simMat);

  /** 粒の元の場所を GPU へ渡し、ずれの画像を用意する。positions は粒の位置（xyz × n）、soft は揺れやすさ（0〜1、無ければ全部 1）。 */
  function attach(renderer, positions, n, soft) {
    dispose();
    const W = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(n)))), H = Math.max(1, Math.ceil(n / W));
    const data = new Float32Array(W * H * 4);
    for (let i = 0; i < n; i++) { data[i * 4] = positions[i * 3]; data[i * 4 + 1] = positions[i * 3 + 1]; data[i * 4 + 2] = positions[i * 3 + 2]; data[i * 4 + 3] = soft ? soft[i] : 1; }
    const rest = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    rest.minFilter = rest.magFilter = THREE.NearestFilter; rest.generateMipmaps = false; rest.needsUpdate = true;
    const rts = [0, 1, 2].map(() => {
      const rt = new THREE.RenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
      rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
      return rt;
    });
    st = { W, H, n, rest, rts, cur: 0, renderer, acc: 0, idleFor: 0, steps: 0, settled: false };
    u.W.value = W; u.n.value = n;
    restNode.value = rest;
    clear();
  }
  function bindDraw() {
    if (!st) return;
    drawCur.value = st.rts[st.cur].texture; drawPrev.value = st.rts[(st.cur + 2) % 3].texture;
  }
  /** 全部の粒を元の場所に戻す（ずれと速さを 0 に）。 */
  function clear() {
    if (!st) return;
    const r = st.renderer, keep = r.getRenderTarget(), col = new THREE.Color(), a = r.getClearAlpha();
    r.getClearColor(col);
    r.setClearColor(0x000000, 0);
    for (const rt of st.rts) { r.setRenderTarget(rt); r.clear(true, false, false); }
    r.setRenderTarget(keep); r.setClearColor(col, a);
    st.settled = true; st.idleFor = 1e9;
    bindDraw();
  }

  /** 時間を進める。busy = ブラシや体が触っている（または計算を止めてはいけない）。返り値は、このコマで計算した回数。 */
  function advance(dt, busy, paused) {
    if (!st) return 0;
    u.time.value += dt;
    if (paused) return 0;
    // 揺れが収まるまでの時間：振幅が e^-6 になるまで。減衰 0 で戻る力があると、いつまでも揺れ続ける
    const w = Math.sqrt(Math.max(u.k.value, 1)), z = u.zeta.value;
    const settle = z <= 0.001 ? Infinity : 6 / (z * Math.max(w * (1 - u.spread.value), 6));
    if (busy) { st.idleFor = 0; st.settled = false; } else st.idleFor += dt;
    if (st.idleFor > settle + 0.5) { st.settled = true; st.acc = 0; return 0; }
    st.acc = Math.min(st.acc + dt, SUB * 12); // 重いコマが続いても、一度に追いつく量は 0.1 秒まで
    let done = 0;
    const r = st.renderer, keep = r.getRenderTarget();
    while (st.acc >= SUB) {
      st.acc -= SUB;
      const prev = st.rts[(st.cur + 2) % 3], cur = st.rts[st.cur], next = st.rts[(st.cur + 1) % 3];
      readCur.value = cur.texture; readPrev.value = prev.texture;
      r.setRenderTarget(next); quad.render(r);
      st.cur = (st.cur + 1) % 3; done++; st.steps++;
      u.kick.value = 0; // はじくのは 1 回だけ
    }
    r.setRenderTarget(keep);
    bindDraw();
    return done;
  }

  /** 描くとき：粒の元の番号（idNode）と間隔（spacing）から、足すずれ（位置）と、表示用の量を返す。 */
  function offsetNodes(idNode, spacing) {
    const id = floor(idNode.add(0.5));
    const y = floor(id.div(u.W)), x = id.sub(y.mul(u.W));
    const c = ivec2(int(x), int(y));
    const cur = drawCur.load(c).xyz, prev = drawPrev.load(c).xyz;
    const shift = cur.mul(u.on);
    // 待機中のゆらぎ：粒ごとに違う速さと向きで、間隔の wobble 倍くらい
    const h1 = hash(id.add(3.1)), h2 = hash(id.add(11.7)), h3 = hash(id.add(23.3)), t = u.time.mul(u.wobbleSpeed);
    const wob = vec3(
      sin(t.mul(h1.mul(1.6).add(1.1)).add(h2.mul(6.283))),
      sin(t.mul(h2.mul(1.4).add(0.9)).add(h3.mul(6.283))).mul(0.6),
      cos(t.mul(h3.mul(1.5).add(1.0)).add(h1.mul(6.283))),
    ).mul(spacing.mul(u.wobble));
    const amount = length(cur).mul(u.on);
    const speed = length(cur.sub(prev)).div(SUB).mul(u.on);
    return { offset: shift.add(wob), amount, speed, heat: (base, which) => heatColor(base, amount, speed, which) };
  }

  /** 「動いた量」「いま動いている粒」の色。base は下に敷く色（暗い灰色）。which = 0 動いた量 / 1 速さ */
  function heatColor(base, amount, speed, which) {
    const v = mix(amount.div(u.heatScale), speed.div(u.heatScale.mul(6)), which).clamp(0, 1);
    const ramp = mix(mix(vec3(0.05, 0.25, 1.0), vec3(1.0, 0.85, 0.1), smoothstep(0, 0.5, v)), vec3(1.0, 0.1, 0.05), smoothstep(0.5, 1, v));
    return mix(base, ramp, smoothstep(0.003, 0.03, v));
  }

  function dispose() {
    if (!st) return;
    st.rest.dispose(); for (const rt of st.rts) rt.dispose();
    st = null;
  }

  return {
    u, attach, step: advance, clear, offsetNodes, heatColor, dispose,
    get ready() { return !!st; },
    get settled() { return !st || st.settled; },
    get steps() { return st ? st.steps : 0; },
    get size() { return st ? [st.W, st.H] : [0, 0]; },
    // 確かめ用：ずれの画像を読み出す（Float32Array、W × H × 4）。WebGL 2 では行の向きが逆になることがある
    async read() { if (!st) return null; return st.renderer.readRenderTargetPixelsAsync(st.rts[st.cur], 0, 0, st.W, st.H); },
  };
}

/**
 * ブラシの当たり：画面の円の中に入る粒のうち、手前から 1 割くらいの奥行きを返す（ばらけた粒に引っぱられないように）。
 * 粒が多いときは間引いて調べる。sky は空の粒の印（調べない）。返り値 { depth, count, point } か null。
 */
export function pickDepth(positions, n, sky, viewProj, cursor, radius, viewport, budget = 400000) {
  const e = viewProj.elements, step = Math.max(1, Math.floor(n / budget));
  const depths = [];
  const r2 = radius * radius;
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i += step) {
    if (sky && sky[i]) continue;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0.05) continue;
    const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
    const px = (cx * 0.5 + 0.5) * viewport.x - cursor.x, py = (0.5 - cy * 0.5) * viewport.y - cursor.y;
    if (px * px + py * py > r2) continue;
    depths.push(w); sx += x; sy += y; sz += z;
  }
  if (!depths.length) return null;
  const sorted = Float32Array.from(depths).sort();
  const depth = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))];
  return { depth, count: depths.length * step, center: [sx / depths.length, sy / depths.length, sz / depths.length] };
}
