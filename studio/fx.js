// 粒の動きと光を、描くとき（シェーダー）に付ける。
//   風の揺れ ・ プレイヤーのまわりの草よけ ・ 足跡 ・ 光の付け替え（時間帯）
// 粒ごとの札（揺れやすさ、種類の光の受け方、足跡が付くか、面の向き、描いたときの日なた）は、描画用の配列 C・D から読む。
//   A = [位置 xyz, 粒の間隔]  B = [表示する色 rgb（リニア）, 境界からの距離]
//   C = [空, 視点, 揺れやすさ 0〜1, 光の受け方（0 太陽 / 1 空 / 2 自分で光る）＋ 足跡が付くなら 4]
//   D = [面の向き xyz, 描いたときの日なた 0〜1]
// 光の式は shared/light.js と同じ（粒の色 = 絵の色 × 今の明るさ ÷ 描いたときの明るさ）。
import * as THREE from 'three/webgpu';
import { uniform, texture, varying, vec2, vec3, vec4, float, sin, dot, floor, mix, max, min, step, smoothstep, abs, mod } from 'three/tsl';

export const SUN_MAP_SIZE = 1024;   // 太陽から見た奥行きの地図（影用）の画素数
export const FOOT_SIZE = 2048;      // 足跡の地図の画素数
export const FOOT_METERS = 128;     // 足跡の地図が覆う広さ（m）。1 画素 6.25 cm
export const KIND = { sun: 0, sky: 1, self: 2 };

export function createFx() {
  const u = {
    time: uniform(0),
    // 風：wind は揺れ幅（m）。0 で止まる
    wind: uniform(0), windDir: uniform(new THREE.Vector2(1, 0)), windSpeed: uniform(1), sheen: uniform(0.9),
    // 草よけ：player は足元の位置。part は押しのける強さ（m）。0 で止まる
    player: uniform(new THREE.Vector3(0, -1e4, 0)), part: uniform(0), partRadius: uniform(1.3),
    // 足跡：foot は暗くする強さ（0〜1）、footShow は目立たせる表示（0/1）、footOrigin は地図の中心（x, z）
    foot: uniform(0), footShow: uniform(0), footOrigin: uniform(new THREE.Vector2(0, 0)),
    // 表示：show = 0 そのまま / 1 光を変えた後 / 2 いまの日なた、colorFx = 1 なら風の照りと足跡の色を掛ける
    show: uniform(0), colorFx: uniform(1),
    // 光
    sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunDir0: uniform(new THREE.Vector3(0, 1, 0)),
    sunRGB: uniform(new THREE.Vector3(1, 1, 1)), skyRGB: uniform(new THREE.Vector3(1, 1, 1)), skyGain: uniform(new THREE.Vector3(1, 1, 1)),
    paintAmb: uniform(1), paintSun: uniform(0), bands: uniform(0), maxGain: uniform(4),
    // 影：太陽カメラの行列と範囲。sunOn = 0 なら全部が影（太陽が地平線の下、または地図がまだ無い）
    sunM: uniform(new THREE.Matrix4()), sunBox: uniform(new THREE.Vector4(-1, 1, -1, 1)), sunRange: uniform(1), sunTexel: uniform(0.1), sunOn: uniform(0),
    // 粒の間隔から、もとの視点からの距離と、奥行きの刻みの粗さを戻す（影を調べるときに面から浮かせる量）
    zFromSize: uniform(1), zStep: uniform(0),
  };

  const sunTex = new THREE.DataTexture(new Uint8Array(SUN_MAP_SIZE * SUN_MAP_SIZE * 4).fill(255), SUN_MAP_SIZE, SUN_MAP_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  sunTex.magFilter = sunTex.minFilter = THREE.NearestFilter; sunTex.generateMipmaps = false; sunTex.needsUpdate = true;
  const footData = new Uint8Array(FOOT_SIZE * FOOT_SIZE);
  const footTex = new THREE.DataTexture(footData, FOOT_SIZE, FOOT_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  footTex.magFilter = footTex.minFilter = THREE.LinearFilter; footTex.generateMipmaps = false; footTex.needsUpdate = true;

  /** 描画用の配列（vec4 のノード）から、粒の位置と色のノードを作る。 */
  function nodes(P, B, C, D) {
    const pos = P.xyz, sway = C.z, kind = mod(C.w, 4), tracks = step(3.5, C.w);

    // 足跡の濃さ（0〜1）。もとの位置で地図を引く。地図の外は 0
    const fuv = pos.xz.sub(u.footOrigin).div(FOOT_METERS).add(0.5);
    const inMap = step(0, fuv.x).mul(step(fuv.x, 1)).mul(step(0, fuv.y)).mul(step(fuv.y, 1));
    const foot = texture(footTex, fuv).r.mul(tracks).mul(inMap);

    // 風：風下へ進む大きな波 ＋ 横切る細かい波 ＋ ゆっくりした強弱。-1〜1
    const dir = u.windDir, along = dot(pos.xz, dir), across = dot(pos.xz, vec2(dir.y.negate(), dir.x)), t = u.time.mul(u.windSpeed);
    const w1 = sin(along.mul(0.35).sub(t.mul(1.6)));
    const w2 = sin(across.mul(0.9).add(t.mul(2.3)).add(along.mul(0.17)));
    const gust = sin(along.mul(0.06).sub(t.mul(0.45))).mul(0.5).add(0.5);
    const wave = w1.mul(0.6).add(w2.mul(0.4)).mul(gust.mul(0.7).add(0.3));
    const calm = float(1).sub(foot.mul(0.8));                       // 踏まれた草は揺れにくい
    const blow = wave.mul(u.wind).mul(sway).mul(calm);              // 揺れ（m）
    const windOffset = vec3(dir.x.mul(blow), abs(blow).mul(-0.25), dir.y.mul(blow));

    // 草よけ：プレイヤーの足元から外へ押し、少し倒す
    const away = pos.xz.sub(u.player.xz), dist = away.length();
    const nearPlayer = float(1).sub(smoothstep(0.15, u.partRadius, dist)).mul(float(1).sub(smoothstep(0.8, 1.8, abs(pos.y.sub(u.player.y)))));
    const push = nearPlayer.mul(u.part).mul(sway);
    const partOffset = vec3(away.x.div(max(dist, 0.05)).mul(push), push.mul(-0.3), away.y.div(max(dist, 0.05)).mul(push));

    const position = pos.add(windOffset).add(partOffset);

    // 影：太陽から見た奥行きの地図と比べる。面から少し浮かせ、4 点の平均で縁をなだらかにする（shared/light.js の visibilityAt と同じ）
    const n = D.xyz, z = P.w.mul(u.zFromSize), lift = z.mul(z).mul(u.zStep).add(0.05).add(u.sunTexel);
    const c = u.sunM.mul(vec4(pos.add(n.mul(lift)), 1));
    const depth = c.z.negate().sub(u.sunTexel.mul(1.5));
    const fx = c.x.sub(u.sunBox.x).div(u.sunBox.y.sub(u.sunBox.x)).mul(SUN_MAP_SIZE).sub(0.5);
    const fy = u.sunBox.w.sub(c.y).div(u.sunBox.w.sub(u.sunBox.z)).mul(SUN_MAP_SIZE).sub(0.5);
    const x0 = floor(fx), y0 = floor(fy), tx = fx.sub(x0), ty = fy.sub(y0);
    const tap = (ox, oy) => {
      const s = texture(sunTex, vec2(x0.add(ox + 0.5), y0.add(oy + 0.5)).div(SUN_MAP_SIZE));
      const v = floor(s.r.mul(255).add(0.5)).mul(256).add(floor(s.g.mul(255).add(0.5)));
      return max(step(65534.5, v), step(depth, v.div(65534).mul(u.sunRange))); // 何も無い所か、遮る形より手前なら日なた
    };
    const vis = mix(mix(tap(0, 0), tap(1, 0), tx), mix(tap(0, 1), tap(1, 1), tx), ty).mul(u.sunOn);

    // 光の付け替え
    const base = B.xyz, h = n.y.mul(0.2).add(0.8);
    const before = max(0.05, u.paintAmb.mul(h).add(u.paintSun.mul(max(dot(n, u.sunDir0), 0)).mul(D.w)));
    const raw = max(dot(n, u.sunDir), 0).mul(vis), bands = max(u.bands, 1);
    const d = mix(raw, floor(raw.mul(bands).add(0.5)).div(bands), step(0.5, u.bands)); // 明暗を段階に分ける
    const gain = min(vec3(u.maxGain), u.skyRGB.mul(h).add(u.sunRGB.mul(d)).div(before));
    const isSky = step(0.5, kind).mul(step(kind, 1.5)), isSelf = step(1.5, kind);
    const relit = mix(mix(base.mul(gain), base.mul(u.skyGain), isSky), base, isSelf);
    const sunGray = mix(vec3(d.mul(0.97).add(0.03)), vec3(0.3), isSky);
    const shown = mix(mix(base, relit, step(0.5, u.show)), sunGray, step(1.5, u.show));

    // 風で草がなびくと明るさも波打つ。足跡は暗くする
    const sheen = float(1).add(blow.mul(u.sheen));
    const dark = float(1).sub(foot.mul(u.foot));
    const fxColor = mix(shown, shown.mul(sheen).mul(dark), u.colorFx);
    const color = mix(fxColor, vec3(1, 0, 1), foot.mul(u.footShow));

    return { position, color: varying(color) }; // 色は粒ごとに一定なので、頂点側で計算して渡す
  }

  /** 影用の地図を差し替える。map は renderSunMap() の戻り値（packed つき）。null なら全部が影。 */
  function setSunMap(map) {
    if (!map || !map.packed) { u.sunOn.value = 0; return; }
    sunTex.image.data.set(map.packed); sunTex.needsUpdate = true;
    u.sunM.value.fromArray(map.m);
    u.sunBox.value.set(map.left, map.right, map.bottom, map.top);
    u.sunRange.value = map.range; u.sunTexel.value = map.texel; u.sunOn.value = 1;
  }

  // ---- 足跡 ----
  const texel = FOOT_METERS / FOOT_SIZE;
  /** 足の形（長さ 34 cm、幅 15 cm ほどの楕円）を (x, z) に、向き (dx, dz) で押す。地図の外なら何もしない。 */
  function stamp(x, z, dx, dz) {
    const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    const cx = (x - u.footOrigin.value.x) / texel + FOOT_SIZE / 2, cz = (z - u.footOrigin.value.y) / texel + FOOT_SIZE / 2;
    const R = Math.ceil(0.3 / texel);
    if (cx < R + 1 || cz < R + 1 || cx > FOOT_SIZE - R - 2 || cz > FOOT_SIZE - R - 2) return false;
    const a = 0.17 / texel, b = 0.075 / texel, soft = 0.07 / texel;
    for (let j = Math.floor(cz - R); j <= Math.ceil(cz + R); j++) for (let i = Math.floor(cx - R); i <= Math.ceil(cx + R); i++) {
      const px = i + 0.5 - cx, pz = j + 0.5 - cz, al = px * dx + pz * dz, ac = -px * dz + pz * dx;
      const e = Math.sqrt((al / a) ** 2 + (ac / b) ** 2), v = Math.max(0, Math.min(1, 1 - (e - 1) * b / soft)); // 楕円の縁からなだらかに消す
      const k = j * FOOT_SIZE + i, val = Math.round(v * 255);
      if (val > footData[k]) footData[k] = val;
    }
    footTex.needsUpdate = true;
    return true;
  }
  function clearFootprints(x = 0, z = 0) { // 地図を消して、中心を (x, z) に置き直す（画素の刻みに合わせる）
    footData.fill(0); footTex.needsUpdate = true;
    u.footOrigin.value.set(Math.round(x / texel) * texel, Math.round(z / texel) * texel);
  }

  /** 歩く人が地図の端に近づいたら、地図をその人のまわりへずらす。足跡は残り、地図の外へ出た分だけ消える。 */
  function follow(x, z) {
    const o = u.footOrigin.value, limit = FOOT_METERS / 4;
    if (Math.abs(x - o.x) < limit && Math.abs(z - o.y) < limit) return;
    const sx = Math.round((x - o.x) / texel), sz = Math.round((z - o.y) / texel), old = footData.slice(), len = FOOT_SIZE - Math.abs(sx);
    footData.fill(0);
    if (len > 0) for (let j = Math.max(0, -sz); j < Math.min(FOOT_SIZE, FOOT_SIZE - sz); j++) {
      const from = (j + sz) * FOOT_SIZE + Math.max(0, sx);
      footData.set(old.subarray(from, from + len), j * FOOT_SIZE + Math.max(0, -sx));
    }
    o.set(o.x + sx * texel, o.y + sz * texel); footTex.needsUpdate = true;
  }

  return { u, nodes, setSunMap, stamp, clearFootprints, follow, footData, dispose() { sunTex.dispose(); footTex.dispose(); } };
}
