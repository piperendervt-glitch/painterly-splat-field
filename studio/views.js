// 視点を足す：穴の多い視点を探す → プレビズを書き出し直す → すでにある絵を新しい視点へ写す → 穴だけ埋める。
import { createView3D } from './view3d.js';
import { loadViews, loadImage, sceneTriangles, analyze, warpInto, localFill, VIEW_TINTS, LIGHTS } from './viewdata.js';
import * as dream from './dreamviews.js';

const $ = (id) => document.getElementById(id);
const api = async (url, body) => {
  const res = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `失敗しました（${res.status}）`);
  return data;
};
const say = (text) => { $('status').textContent = text; };
const log = (text) => { const el = $('log'); el.textContent += (el.textContent ? '\n' : '') + text; el.scrollTop = el.scrollHeight; };
const problem = (text) => { $('problem').hidden = !text; $('problem').textContent = text || ''; };
const gl = new URLSearchParams(location.search).has('gl');

const PREVIEW_W = 160, PREVIEW_H = 240, SEARCH_W = 40, SEARCH_H = 60;
let D = null, meshes = null, busy = false, mode = 'painted', stage = 'reproj', light = 'free';
const sfx = () => LIGHTS[light].sfx;
let repaired = '', heading = 0; // heading：カメラの水平の向き（真下を向いている間も覚えておく）
let v3 = null; // 3D の画面（作れなかったら null のまま、地図だけで使う）
let cand = { position: [24, 1.7, -30], target: [0, 15, 0] }, selected = null, dots = [], mapT = null, timer = 0;
// 絵 1 枚から作った場面（プレビズの形が無い）では、形の代わりに絵の奥行きを使う（studio/dreamviews.js）。shape = 3D の画面と地図に出す、絵の形
let painting = false, shape = null;

const fovY = () => D.views[0].fov_y_deg;
const painted = () => D.views.filter((v) => v.painted);

// ---- 読み込み ----
async function reload() {
  D = await loadViews(light);
  painting = dream.isPainting(D.cams);
  if (painting) return reloadPainting();
  // 足した視点が書き出しから消えていたら（古いプレビズの画面から保存された場合など）、書き出し直して戻す。絵は残っているので描き直しは要らない
  const extras = await extraCameras();
  const lost = extras.filter((c) => !D.views.some((v) => v.name === c.name)).map((c) => c.name).join('・');
  if (lost && lost !== repaired) {
    repaired = lost; say('足した視点を戻しています'); log(`足した視点（${lost}）がプレビズの書き出しから消えていたので、書き出し直します。`);
    try { await reexport(); D = await loadViews(light); log('戻しました。'); say('–'); } catch (e) { log(`戻せませんでした：${e.message}`); say('止まりました'); }
  }
  for (const v of D.views) if (extras.some((c) => c.name === v.name)) v.added = true; // 絵がまだ無くても、足した視点として並べる
  meshes = meshes || sceneTriangles();
  problem(painted().length ? '' : `「${LIGHTS[light].name}」の絵画がまだありません。先に「絵画化」のタブで、この光の描き方の絵を作ってください（穴かどうかは、絵がある視点を基準に決めます）。`);
  if (selected && !D.views.some((v) => v.name === selected)) selected = null;
  if (v3) { v3.setViews(D.views); v3.setCandidate(cand); }
  renderAdded(); drawMap(); show(); showAuto();
}

// 絵 1 枚から作った場面の読み直し：プレビズの書き出し直しはしない（形が無い）。足した視点は cameras.json に added の印つきで入っている
function reloadPainting() {
  meshes = [];
  shape = dream.sceneMesh(D);
  problem(painted().length ? '' : 'この場面の絵がまだありません（paint-out に <視点>_painted.png がありません）。');
  if (selected && !D.views.some((v) => v.name === selected)) selected = null;
  if (v3) { v3.setMesh(shape); v3.setViews(D.views); v3.setCandidate(cand); }
  renderAdded(); drawMap(); show(); showAuto();
}
const dreamIO = {
  savePaint: (name, rgba, w, h) => savePng(name, rgba, w, h),
  async saveExport(name, rgba, w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    const res = await fetch(`/api/previz-export/${name}`, { method: 'POST', body: await new Promise((r) => c.toBlob(r, 'image/png')) });
    if (!res.ok) throw new Error(`${name} を保存できませんでした`);
  },
  async loadAdded() { const r = await fetch('/files/previz-export/added_views.json', { cache: 'no-store' }); return r.ok ? r.json() : []; },
  async saveAdded(list) { const r = await fetch('/api/previz-export/added_views.json', { method: 'POST', body: JSON.stringify(list, null, 1) }); if (!r.ok) throw new Error('足した視点の一覧を保存できませんでした'); },
};

// ---- 地図 ----
function drawMap() {
  const c = $('map'), g = c.getContext('2d'), S = c.width;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grow = (x, z) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  for (const m of meshes) if (!m.ground) { grow(m.min[0], m.min[2]); grow(m.max[0], m.max[2]); }
  if (painting && shape) for (let i = 0; i < shape.positions.length; i += 3 * 97) grow(shape.positions[i], shape.positions[i + 2]);
  for (const v of D.views) grow(v.def.extrinsics.position[0], v.def.extrinsics.position[2]);
  grow(cand.position[0], cand.position[2]);
  const span = Math.max(x1 - x0, z1 - z0) + 80, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, k = S / span;
  mapT = { k, mx, mz, S, bounds: [x0, x1, z0, z1] };
  const X = (x) => (x - mx) * k + S / 2, Z = (z) => (z - mz) * k + S / 2;
  g.fillStyle = '#1b231b'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#263026'; g.lineWidth = 1; // 20m の目盛り
  for (let t = Math.ceil((mx - span / 2) / 20) * 20; t < mx + span / 2; t += 20) { g.beginPath(); g.moveTo(X(t), 0); g.lineTo(X(t), S); g.stroke(); }
  for (let t = Math.ceil((mz - span / 2) / 20) * 20; t < mz + span / 2; t += 20) { g.beginPath(); g.moveTo(0, Z(t)); g.lineTo(S, Z(t)); g.stroke(); }
  if (painting && shape) { // 絵の形を、上から見た点の集まりで出す
    for (let i = 0; i < shape.positions.length; i += 3 * 5) { g.fillStyle = `rgb(${shape.colors[i] * 255 | 0},${shape.colors[i + 1] * 255 | 0},${shape.colors[i + 2] * 255 | 0})`; g.fillRect(X(shape.positions[i]) - 1, Z(shape.positions[i + 2]) - 1, 2, 2); }
  }
  const top = Math.max(1, ...dots.map((d) => d.score));
  for (const d of dots) { g.fillStyle = `rgba(255,0,255,${0.08 + 0.8 * d.score / top})`; g.beginPath(); g.arc(X(d.x), Z(d.z), 5, 0, 7); g.fill(); }
  g.fillStyle = '#8d8a80'; g.font = '13px sans-serif';
  for (const m of meshes) if (!m.ground) { g.fillRect(X(m.min[0]), Z(m.min[2]), (m.max[0] - m.min[0]) * k, (m.max[2] - m.min[2]) * k); }
  const wedge = (pos, tgt, color, label, len) => {
    if (Math.hypot(tgt[0] - pos[0], tgt[2] - pos[2]) < 0.5) { // ほぼ真下（真上）向き：輪で示す
      g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.arc(X(pos[0]), Z(pos[2]), 14, 0, 7); g.stroke();
      g.fillStyle = color; g.beginPath(); g.arc(X(pos[0]), Z(pos[2]), 6, 0, 7); g.fill(); g.fillText(label, X(pos[0]) + 18, Z(pos[2]) - 10); return;
    }
    const a = Math.atan2(tgt[2] - pos[2], tgt[0] - pos[0]), half = Math.atan(Math.tan(fovY() * Math.PI / 360) * D.views[0].W / D.views[0].H);
    g.fillStyle = color; g.globalAlpha = 0.22; g.beginPath(); g.moveTo(X(pos[0]), Z(pos[2]));
    g.arc(X(pos[0]), Z(pos[2]), len * k, a - half, a + half); g.closePath(); g.fill(); g.globalAlpha = 1;
    g.beginPath(); g.arc(X(pos[0]), Z(pos[2]), 6, 0, 7); g.fill();
    g.fillText(label, X(pos[0]) + 9, Z(pos[2]) - 8);
  };
  D.views.forEach((v, i) => { const t = VIEW_TINTS[i % VIEW_TINTS.length]; wedge(v.def.extrinsics.position, v.def.extrinsics.target, `rgb(${t})`, v.name + (v.painted ? '' : '（絵なし）'), 45); });
  wedge(cand.position, cand.target, '#9ccf5a', '候補', 60);
  g.strokeStyle = '#fff'; g.lineWidth = 2; const tx = X(cand.target[0]), tz = Z(cand.target[2]);
  g.beginPath(); g.moveTo(tx - 6, tz); g.lineTo(tx + 6, tz); g.moveTo(tx, tz - 6); g.lineTo(tx, tz + 6); g.stroke();
  g.fillStyle = '#8f9a8c'; g.fillText('目盛り 20 m ・ 上が奥（-Z）', 10, S - 10);
}
function mapPoint(e) {
  const c = $('map'), r = c.getBoundingClientRect(), { k, mx, mz, S } = mapT;
  return [((e.clientX - r.left) / r.width * S - S / 2) / k + mx, ((e.clientY - r.top) / r.height * S - S / 2) / k + mz];
}
let dragging = false;
function mapInput(e) {
  if (busy) return;
  const [x, z] = mapPoint(e);
  if (e.shiftKey || e.button === 2) { cand.target[0] = x; cand.target[2] = z; } else { cand.position[0] = x; cand.position[2] = z; }
  selected = null; sliders(); renderAdded(); drawMapKeepScale(); schedule(); if (v3) v3.setCandidate(cand);
}
function drawMapKeepScale() { drawMap(); } // 地図の範囲は候補の位置に合わせて広がる
$('map').addEventListener('pointerdown', (e) => { dragging = true; $('map').setPointerCapture(e.pointerId); mapInput(e); });
$('map').addEventListener('pointermove', (e) => { if (dragging) mapInput(e); });
$('map').addEventListener('pointerup', () => { dragging = false; });
$('map').addEventListener('contextmenu', (e) => e.preventDefault());

// ---- 右の絵 ----
function put(rgba, w, h) {
  const c = $('shot'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
}
function schedule() { clearTimeout(timer); timer = setTimeout(show, 60); }
let showSeq = 0;
async function show() {
  if (!D) return;
  const seq = ++showSeq; // 途中で次の表示が始まったら、古いほうは捨てる
  $('fillBox').hidden = !selected;
  if (!selected) {
    $('shotTitle').textContent = '候補の視点から見た今の状態';
    if (painting) {
      const a = dream.preview(D, cand, 288, VIEW_TINTS, mode);
      put(a.rgba, a.w, a.h);
      $('shotNote').textContent = `絵の ${(100 * a.holes / a.pixels).toFixed(0)}% が穴（すでにある絵が写らない所）で、${(100 * a.covered / a.pixels).toFixed(0)}% はすでに描かれています。穴が半分を超えると、描き足す絵がもとの絵とつながりにくくなります。`;
      window.__views = { analysis: a, cand, D };
      return;
    }
    const a = analyze({ meshes, views: D.views, position: cand.position, target: cand.target, fovY: fovY(), w: PREVIEW_W, h: PREVIEW_H, mode });
    put(a.rgba, a.w, a.h);
    $('shotNote').textContent = a.surface
      ? `見えている面のうち、穴は ${(100 * a.holes / a.surface).toFixed(0)}%。空の穴は ${a.sky ? (100 * a.skyHoles / a.sky).toFixed(0) : 0}%。画面全体では ${(100 * a.covered / (a.w * a.h)).toFixed(0)}% がすでに描かれています。`
      : '形が見えていません。';
    window.__views = { analysis: a, cand, D };
    return;
  }
  const v = D.views.find((x) => x.name === selected), st = v.st, x = sfx(), has = (k) => !!st[`${k}${x}`];
  if (!has('reproj')) { // この光の描き方では、まだ写していない
    put(new Uint8ClampedArray(v.W * v.H * 4).fill(40), v.W, v.H);
    $('shotTitle').textContent = `視点 ${v.name}：まだ写していません`;
    $('shotNote').textContent = `「${LIGHTS[light].name}」では、この視点へまだ絵を写していません。「すでにある絵を写し直す」を押してください。`;
    return;
  }
  const kind = stage === 'painted' && !has('painted') ? 'reproj' : stage === 'overlay' && !has('overlay') ? (has('painted') ? 'painted' : 'reproj') : stage;
  const title = `視点 ${v.name}：${{ reproj: '埋める前（マゼンタが穴）', painted: '埋めた後', overlay: '重ねて確認（シアンがプレビズの輪郭）' }[kind]}`;
  const img = await loadImage(`/files/paint-out/${v.name}_${kind}${x}.png`, v.W, v.H);
  const holes = has('holes') ? await loadImage(`/files/paint-out/${v.name}_holes${x}.png`, v.W, v.H) : null;
  if (seq !== showSeq) return;
  let holeCount = 0;
  if (holes) {
    for (let i = 0; i < v.W * v.H; i++) if (holes[i * 4] > 127) { holeCount++; if (kind === 'reproj') { img[i * 4] = 255; img[i * 4 + 1] = 0; img[i * 4 + 2] = 255; } }
  }
  put(new Uint8ClampedArray(img), v.W, v.H);
  $('shotTitle').textContent = title;
  $('shotNote').textContent = `穴は絵の ${(100 * holeCount / (v.W * v.H)).toFixed(1)}%。${has('painted') ? '埋めた絵があります。' : 'まだ埋めていません。'}${stage !== kind ? '（選んだ絵はまだ無いので、ある絵を出しています）' : ''}`;
}

// ---- 足した視点の一覧 ----
function renderAdded() {
  const box = $('added'), list = D.views.filter((v) => v.added);
  if (!list.length) { box.innerHTML = '<p class="note">足した視点はまだありません。</p>'; return; }
  box.replaceChildren(...list.map((v) => {
    const row = document.createElement('div'); row.className = 'item';
    const name = document.createElement('span'); const filled = !!v.st[`painted${sfx()}`];
    name.textContent = `視点 ${v.name}（${filled ? '埋めた' : v.st[`reproj${sfx()}`] ? 'まだ穴あり' : 'まだ写していない'}）`;
    const see = document.createElement('button'); see.type = 'button'; see.className = 'plain'; see.textContent = selected === v.name ? '表示中' : '見る';
    see.addEventListener('click', () => { selected = v.name; stage = filled ? 'painted' : 'reproj'; press($('stage'), stage); renderAdded(); show(); });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'plain'; del.textContent = '取り消す';
    del.addEventListener('click', () => removeView(v.name));
    row.append(name, see, del); return row;
  }));
}

// ---- 穴の多い視点を探す ----
async function search() {
  if (busy || !painted().length || painting) return;
  busy = true; $('search').disabled = true; dots = [];
  try {
    const solids = meshes.filter((m) => !m.ground);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const m of solids) { x0 = Math.min(x0, m.min[0]); x1 = Math.max(x1, m.max[0]); z0 = Math.min(z0, m.min[2]); z1 = Math.max(z1, m.max[2]); }
    for (const v of D.views) { const p = v.def.extrinsics.position; x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    x0 -= 40; x1 += 40; z0 -= 40; z1 += 40;
    const step = Math.max(8, Math.max(x1 - x0, z1 - z0) / 16), camY = Number($('camY').value), high = $('high').checked;
    const byName = new Map(); // 同じ名前の形（塔の胴と屋根など）は 1 つにまとめる
    for (const m of solids) {
      const b = byName.get(m.name) || { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let i = 0; i < 3; i++) { b.min[i] = Math.min(b.min[i], m.min[i]); b.max[i] = Math.max(b.max[i], m.max[i]); }
      byName.set(m.name, b);
    }
    // 見る先は形ごとの中心。近すぎると形で画面が埋まるので、形の高さに応じて離れる
    const targets = [...byName.values()].map((m) => ({ at: [(m.min[0] + m.max[0]) / 2, Math.min((m.min[1] + m.max[1]) / 2, 15), (m.min[2] + m.max[2]) / 2], away: Math.max(20, 0.9 * (m.max[1] - m.min[1])), top: m.max[1] }));
    const heights = high ? [...new Set([camY, 30, 70])] : [camY];
    // 調べる組み合わせ：[位置, 見る先]。地図の点は、その水平位置でいちばん良かった点数
    const jobs = [];
    for (let z = z0; z <= z1; z += step) for (let x = x0; x <= x1; x += step) for (const y of heights) {
      if (solids.some((m) => x > m.min[0] - 3 && x < m.max[0] + 3 && z > m.min[2] - 3 && z < m.max[2] + 3 && y < m.max[1] + 3)) continue; // 形の中には立てない
      for (const { at, away } of targets) if (Math.hypot(at[0] - x, at[1] - y, at[2] - z) >= away) jobs.push({ position: [x, y, z], target: [...at] });
    }
    if (high) for (const { at, top } of targets) for (const up of [30, 70]) jobs.push({ position: [at[0], top + up, at[2]], target: [at[0], 0, at[2]] }); // 真上から
    let best = null, done = 0;
    const dotAt = new Map();
    for (const job of jobs) {
      const a = analyze({ meshes, views: D.views, position: job.position, target: job.target, fovY: fovY(), w: SEARCH_W, h: SEARCH_H, wantImage: false });
      // 形（地面以外）の穴を重く、地面の穴を軽く数える。すでに描かれた所が 2 割は見えていること（画風と位置を合わせる手がかり）
      const score = a.covered >= 0.2 * a.w * a.h ? a.solidHoles + 0.2 * (a.holes - a.solidHoles) : 0;
      if (!best || score > best.score) best = { score, ...job };
      const key = `${job.position[0]},${job.position[2]}`, d = dotAt.get(key) || { x: job.position[0], z: job.position[2], score: 0 };
      d.score = Math.max(d.score, score); dotAt.set(key, d);
      if (++done % 24 === 0) { dots = [...dotAt.values()]; say(`探しています ${done} / ${jobs.length}`); drawMap(); await new Promise((r) => setTimeout(r)); }
    }
    dots = [...dotAt.values()];
    const spots = jobs;
    if (best && best.score > 0) {
      cand = { position: best.position, target: best.target }; selected = null;
      $('searchNote').textContent = `${spots.length} 通りの視点を調べ、穴がいちばん多く見える所（高さ ${best.position[1].toFixed(1)} m）へ候補を移しました。地図の点は濃いほど穴が多い位置です。`;
    } else $('searchNote').textContent = '穴の見える位置が見つかりませんでした。';
    say('–'); sliders(); renderAdded(); drawMap(); show(); if (v3) v3.setCandidate(cand);
  } finally { busy = false; $('search').disabled = false; }
}

// ---- プレビズを書き出し直す（隠した枠でプレビズの画面を開き、保存まで任せる） ----
function reexport() {
  return new Promise((ok, ng) => {
    const f = document.createElement('iframe'); f.style.cssText = 'width:100%;height:100%;border:0';
    const done = (fn, v) => { clearTimeout(t); window.removeEventListener('message', on); f.remove(); fn(v); };
    const on = (e) => { if (e.source !== f.contentWindow || !e.data || e.data.type !== 'previz-saved') return; e.data.ok ? done(ok) : done(ng, new Error(e.data.error || 'プレビズを書き出せませんでした')); };
    const t = setTimeout(() => done(ng, new Error('プレビズの書き出しが終わりませんでした（3 分）')), 180000);
    window.addEventListener('message', on);
    f.src = `../previz/?autosave${gl ? '&gl' : ''}`; $('frameHost').append(f);
  });
}
const extraCameras = async () => { const r = await fetch('/files/previz-export/extra_cameras.json', { cache: 'no-store' }); return r.ok ? r.json() : []; };
const saveExtra = (list) => fetch('/api/previz-export/extra_cameras.json', { method: 'POST', body: JSON.stringify(list, null, 2) }).then((r) => { if (!r.ok) throw new Error('カメラの一覧を保存できませんでした'); });
async function savePng(name, rgba, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const res = await fetch(`/api/paint-out/${name}`, { method: 'POST', body: blob });
  if (!res.ok) throw new Error(`${name} を保存できませんでした`);
}
function nextName() {
  const used = new Set(D.views.map((v) => v.name));
  if (painting) for (let i = 1; ; i++) if (!used.has(`R${i}`)) return `R${i}`; // 絵 1 枚の場面で足した視点は R1, R2, …（.gitignore がこの名前の絵を外す）
  for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(ch)) return ch;
  for (let i = 1; ; i++) if (!used.has(`V${i}`)) return `V${i}`;
}

async function addView() {
  if (busy) return;
  if (!painted().length) return problem('まだ絵画がありません。先に「絵画化」のタブで絵を作ってください。');
  busy = true; $('add').disabled = true; $('log').textContent = '';
  try { await addViewCore(); say('穴を埋める方法を選んでください'); }
  catch (e) { log(`止まりました：${e.message}`); say('止まりました'); }
  finally { busy = false; $('add').disabled = false; }
}
// いまの候補の視点を足す：プレビズを書き出し直し、すでにある絵を写す。返すのは { name, holes（いまの光の描き方での穴の画素数。絵が無ければ null）, pixels }
async function addViewCore() {
  if (painting) return addDreamView(nextName(), cand);
  const name = nextName(), round = (a) => a.map((x) => +x.toFixed(3));
  say('プレビズを書き出しています'); log(`視点 ${name} を足します：位置 ${round(cand.position).join(', ')} → 見る先 ${round(cand.target).join(', ')}`);
  await api('/api/view/forget', { view: name });
  await saveExtra([...(await extraCameras()).filter((c) => c.name !== name), { name, position: round(cand.position), target: round(cand.target) }]);
  await reexport(); log('プレビズを書き出し直しました（色・奥行き・カメラ情報）。');
  say('絵を写しています');
  let wroteNew = false, holes = null;
  for (const L of Object.keys(LIGHTS)) { // 絵のある描き方すべてについて写す
    const h = await warpView(name, L, !wroteNew);
    if (h !== null) { wroteNew = true; if (L === light) holes = h; }
  }
  if (!wroteNew) throw new Error('写せる絵がありませんでした');
  selected = name; stage = 'reproj'; press($('stage'), stage);
  await reload();
  const v = D.views.find((x) => x.name === name);
  return { name, holes, pixels: v ? v.W * v.H : 1 };
}
// 絵 1 枚の場面：候補 c の視点 name を足す（または写し直す）。すでにある絵を奥行きで写し、穴の奥行きは仮に、まわりからなめらかに伸ばす
async function addDreamView(name, c) {
  const round = (a) => a.map((x) => +x.toFixed(3));
  say('絵を写しています'); log(`視点 ${name} を足します：位置 ${round(c.position).join(', ')} → 見る先 ${round(c.target).join(', ')}`);
  await api('/api/view/forget', { view: name });
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now(), r = await dream.addView(D, c, name, dreamIO);
  log(`すでにある絵を写しました（${((performance.now() - t0) / 1000).toFixed(1)} 秒）。穴は絵の ${(100 * r.holes / r.pixels).toFixed(1)}%。穴の奥行きは、埋めた後に決め直します。`);
  selected = name; stage = 'reproj'; press($('stage'), stage);
  await reload();
  return { name, holes: r.holes, pixels: r.pixels };
}
// 絵 1 枚の場面：埋めた絵の奥行きを推定し、分かっている所に合わせて、穴の奥行きを決め直す
async function refineDreamDepth(name) {
  if (!D.state.depthReady) { log('奥行き推定の用意がまだ無いので、穴の奥行きは仮の値（まわりからなめらかに伸ばした値）のままです。start.bat を起動し直すと入ります。'); return false; }
  say('埋めた絵の奥行きを推定しています');
  await api('/api/depth', { view: name, light });
  let st; for (;;) { await sleep(700); try { st = await api('/api/paint/status'); } catch { continue; } if (!st.running) break; }
  if (st.code !== 0) { log(`奥行きを推定できませんでした（${st.code}）。穴の奥行きは仮の値のままです。\n${st.log}`); return false; }
  D = await loadViews(light);
  const v = D.views.find((x) => x.name === name);
  const [holes, dp] = await Promise.all([loadImage(`/files/paint-out/${name}_holes.png`, v.W, v.H), loadImage(`/files/paint-out/${name}_disp.png`, v.W, v.H)]);
  const disp = new Float32Array(v.W * v.H); for (let i = 0; i < disp.length; i++) disp[i] = (dp[i * 4] * 256 + dp[i * 4 + 1]) / 65535;
  await new Promise((r) => setTimeout(r, 30));
  const r = await dream.refineDepth(D, v, holes, disp, dreamIO);
  log(r ? `埋めた絵の奥行きを推定して、すでにある面に合わせました（${r.samples} 点で合わせ、穴のうち空にした画素 ${r.skyHoles}、もとの絵の手前に来たので粒にしない画素 ${r.carved}）。` : '奥行きを合わせる手がかり（すでに位置の分かっている面）が足りないので、穴の奥行きは仮の値のままです。');
  return !!r;
}
// 視点 name へ、光の描き方 L の絵を写す。写した絵・穴の印を保存する。返すのは穴の画素数。絵が無ければ何もせず null。
async function warpView(name, L, writeNew) {
  const data = await loadViews(L), v = data.views.find((x) => x.name === name), x = LIGHTS[L].sfx;
  if (!v) throw new Error('書き出しに新しい視点が入っていません');
  const sources = data.views.filter((s) => s.painted && s !== v && !(s.added && !s.st[`painted${x}`]));
  if (!sources.length) return null;
  await new Promise((r) => setTimeout(r));
  const w = warpInto(v, sources);
  await savePng(`${name}_reproj${x}.png`, w.reproj, v.W, v.H);
  await savePng(`${name}_holes${x}.png`, w.holes, v.W, v.H);
  if (writeNew) await savePng(`${name}_new.png`, w.holes, v.W, v.H); // 粒にするのは穴だった画素だけ
  log(`「${LIGHTS[L].name}」の絵を写しました。穴は絵の ${(100 * w.holeCount / (v.W * v.H)).toFixed(1)}%。`);
  return w.holeCount;
}
async function rewarp() {
  if (busy || !selected) return; busy = true;
  try {
    say('絵を写しています'); $('log').textContent = '';
    const v = D.views.find((x) => x.name === selected);
    if (painting) { await addDreamView(selected, { position: [...v.def.extrinsics.position], target: [...v.def.extrinsics.target] }); say('–'); return; }
    // 埋めた絵が残っていると、それ自身が「すでにある絵」として写ってしまうので、先に消す
    await fetch(`/api/paint-out/${selected}_painted${sfx()}.png`, { method: 'DELETE' });
    if ((await warpView(selected, light, !v.st.new_mask)) === null) log(`「${LIGHTS[light].name}」の絵がまだありません。`);
    stage = 'reproj'; press($('stage'), stage); await reload(); say('–');
  } catch (e) { log(`止まりました：${e.message}`); say('止まりました'); }
  finally { busy = false; }
}
async function removeView(name) {
  if (busy) return; busy = true;
  try {
    say('取り消しています'); log(`視点 ${name} を取り消します。`);
    if (painting) {
      await api('/api/view/forget', { view: name }); // 一覧から外す前に（一覧にある間だけ、奥行きや札の絵も消える）
      await dreamIO.saveAdded((await dreamIO.loadAdded()).filter((v) => v.name !== name));
      if (selected === name) selected = null;
      await reload(); say('–'); log('取り消しました。'); return;
    }
    await saveExtra((await extraCameras()).filter((c) => c.name !== name));
    await api('/api/view/forget', { view: name });
    await reexport(); if (selected === name) selected = null;
    await reload(); say('–'); log('取り消しました。');
  } catch (e) { log(`止まりました：${e.message}`); say('止まりました'); }
  finally { busy = false; }
}

// ---- 穴を埋める ----
async function fillLocal() {
  if (busy || !selected) return; busy = true;
  try { await fillLocalCore(selected); stage = 'painted'; press($('stage'), stage); await reload(); say('埋めました'); }
  catch (e) { log(`止まりました：${e.message}`); say('止まりました'); }
  finally { busy = false; }
}
async function fillLocalCore(name) {
  const v = D.views.find((x) => x.name === name), t0 = performance.now();
  say('ツール内で埋めています');
  if (!v.st[`reproj${sfx()}`]) throw new Error('まだ絵を写していません。「すでにある絵を写し直す」を押してください。');
  const [reproj, holes] = await Promise.all([loadImage(`/files/paint-out/${v.name}_reproj${sfx()}.png`, v.W, v.H), loadImage(`/files/paint-out/${v.name}_holes${sfx()}.png`, v.W, v.H)]);
  await new Promise((r) => setTimeout(r, 30));
  const f = localFill(v, reproj, holes, { meshes, sources: painted().filter((s) => s !== v) });
  await savePng(`${v.name}_painted${sfx()}.png`, f.rgba, v.W, v.H);
  const all = Math.max(1, f.spread + f.fromPalette);
  log(`視点 ${v.name}：ツール内で埋めました（${((performance.now() - t0) / 1000).toFixed(1)} 秒）。穴のうち ${(100 * f.spread / all).toFixed(0)}% はまわりの色を広げ、${(100 * f.fromPalette / all).toFixed(0)}% は${f.byLabels ? '同じ物体・種類の札の' : '同じ形の'}平均の色で塗りました。`);
}
let watching = false, watchName = '';
// 絵 1 枚の場面で Codex に頼むときの追加：形の見本（プレビズ）は無し、画風は場面の物、人を増やさない指示
const fillExtra = () => (painting ? { noPreviz: true, style: dream.fillStyle(D.cams), hint: dream.FILL_HINT } : {});
// 描き手：nvs = 別視点の絵を生成するモデル（もとの絵とカメラから、その視点の絵を作る。利用枠なし）、
//         model = 手元の PC の画像生成モデル（穴をまわりから描く。利用枠なし）、codex = ChatGPT（Codex、利用枠を使う）
const ENGINES = { nvs: { name: '別視点の生成モデル' }, model: { name: 'PC の生成モデル' }, codex: { name: 'Codex' } };
const engineBody = (engine) => {
  const m = $('modelName').value.trim(), nm = $('nvsName').value.trim();
  if (engine === 'model') return { engine: 'local', ...(m ? { model: m } : {}) };
  if (engine === 'nvs') return { engine: 'nvs', ...(nm ? { model: nm } : {}), ...($('refineOn').checked ? { refine: Number($('refineStrength').value), ...(m ? { refineModel: m } : {}) } : {}) };
  return {};
};
let watchEngine = 'codex';
async function fillCodex(dryRun, engine = 'codex') {
  if (busy || !selected) return;
  try { await api('/api/paint/fill', { view: selected, dryRun, light, ...fillExtra(), ...engineBody(engine) }); watching = true; watchName = selected; watchEngine = engine; $('log').textContent = ''; poll(); }
  catch (e) { log(e.message); }
}
async function poll() {
  if (!watching) return;
  try {
    const st = await api('/api/paint/status');
    say(st.running ? `${ENGINES[watchEngine].name}で描いています ${st.seconds} 秒` : st.code === 0 ? '終わりました' : `止まりました（${st.code}）`);
    $('log').textContent = st.log; $('stop').disabled = !st.running;
    $('fillCodex').disabled = $('fillModel').disabled = $('fillNvs').disabled = $('fillDry').disabled = $('fillLocal').disabled = st.running;
    if (!st.running) {
      watching = false;
      if (st.code === 0 && !st.dryRun) {
        stage = 'painted'; press($('stage'), stage);
        if (painting && watchName) { busy = true; try { await reload(); await refineDreamDepth(watchName); } catch (e) { log(`奥行きを決め直せませんでした：${e.message}`); } finally { busy = false; say('終わりました'); } }
      }
      await reload(); return;
    }
  } catch { say('サーバーに届きません'); }
  setTimeout(poll, 1500);
}

// ---- 連続で進める：1 歩ずつ角度を進めて「視点を足す → 穴を埋める」を繰り返す。止めるまで続く（回数の上限は無い） ----
const auto = { running: false, stop: false, steps: 0, codex: 0, model: 0, nvs: 0, lines: [], kind: 'orbit', dir: 'right', fill: 'codex' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const autoLog = (text) => { auto.lines.push(text); const el = $('autoLog'); el.textContent = auto.lines.join('\n'); el.scrollTop = el.scrollHeight; };
const fovX = () => 2 * Math.atan(Math.tan(fovY() * Math.PI / 360) * D.views[0].W / D.views[0].H) * 180 / Math.PI;
function showAuto() {
  const b = $('autoRun'), deg = Number($('autoStep').value);
  b.textContent = !auto.running ? '連続で進める' : auto.stop ? '止めています…' : '止める';
  b.disabled = auto.running && auto.stop;
  $('oAutoStep').textContent = `${deg}°（1 周 ${Math.ceil(360 / deg)} 歩）`;
  if (!D) return;
  const fx = fovX();
  $('autoHint').textContent = painting
    ? (auto.kind === 'pan'
      ? `その場で向きだけを変えます。奥行きの誤差が絵のずれにならないので、絵 1 枚の場面ではこちらが確実です。絵の横の画角は ${fx.toFixed(0)}° で、いまの角度では絵の ${Math.max(0, Math.round(100 * (1 - deg / fx)))}% ほどが前の絵と重なります。`
      : '見る先（白い印）を中心に回ります。位置が動くので、人や木の後ろが穴になります。絵 1 枚の場面では奥行きが粗いので、1 歩を小さく（5〜10°）するか、見る先を近くに置いて、穴が半分を超えないようにしてください。')
    : auto.kind === 'pan'
    ? `絵の横の画角は ${fx.toFixed(0)}°。1 歩がこれより大きいと、前の絵と重ならず、画風と位置を合わせる手がかりが無くなります。${deg >= fx ? 'いまの角度では重なりません。' : `いまの角度では、絵の ${Math.round(100 * (1 - deg / fx))}% ほどが前の絵と重なります。`}`
    : '見る先（白い印）を中心に、同じ高さ・同じ距離で回ります。1 歩を大きくすると枚数は減りますが、前の絵に斜めから浅く写っていた面は穴と数えないので、粗い色のまま残りやすくなります。';
  $('autoCount').textContent = auto.running || auto.steps ? `これまで ${auto.steps} 歩。別視点の生成モデルを ${auto.nvs} 回、PC の生成モデルを ${auto.model} 回、Codex を ${auto.codex} 回呼びました。` : '';
}
// 候補の視点を deg 度ぶん進める（上から見て時計回りが正）。orbit = 見る先のまわりを回る、pan = その場で向きを変える
function turnCandidate(deg, kind) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), [px, py, pz] = cand.position, [tx, ty, tz] = cand.target;
  if (kind === 'pan') { const dx = tx - px, dz = tz - pz; cand = { position: [px, py, pz], target: [px + dx * c - dz * s, ty, pz + dx * s + dz * c] }; }
  else { const dx = px - tx, dz = pz - tz; cand = { position: [tx + dx * c - dz * s, py, tz + dx * s + dz * c], target: [tx, ty, tz] }; }
}
// Codex で 1 枚描いてもらい、終わるまで待つ。返すのは /api/paint/status の結果
async function codexFillWait(name, engine = 'codex') {
  await api('/api/paint/fill', { view: name, dryRun: false, light, ...fillExtra(), ...engineBody(engine) });
  for (;;) {
    await sleep(1500);
    let st; try { st = await api('/api/paint/status'); } catch { say('サーバーに届きません'); continue; }
    say(st.running ? `${ENGINES[engine].name}で描いています ${st.seconds} 秒（視点 ${name}）` : st.code === 0 ? '終わりました' : `止まりました（${st.code}）`);
    $('log').textContent = st.log;
    if (!st.running) return st;
  }
}
async function autoRun() {
  if (auto.running) { // 止める：いまの 1 歩の途中でも止める（Codex が動いていれば、それも止める）
    auto.stop = true; showAuto(); api('/api/paint/stop', {}).catch(() => {}); return;
  }
  if (busy) return;
  if (!painted().length) return problem('まだ絵画がありません。先に「絵画化」のタブで絵を作ってください。');
  Object.assign(auto, { running: true, stop: false, steps: 0, codex: 0, model: 0, nvs: 0, lines: [] }); busy = true; $('add').disabled = true; $('log').textContent = ''; showAuto();
  let last = '';
  try {
    while (!auto.stop) {
      // 角度・向き・埋め方は 1 歩ごとに読む（進めている途中で変えられる）
      const deg = Number($('autoStep').value), engine = ENGINES[auto.fill] ? auto.fill : null;
      turnCandidate(auto.dir === 'right' ? deg : -deg, auto.kind);
      selected = null; sliders(); drawMap(); if (v3) v3.setCandidate(cand);
      autoLog(`${auto.steps + 1} 歩目：${auto.dir === 'right' ? '右' : '左'}へ ${deg}°（${auto.kind === 'pan' ? 'その場で向きを変える' : '見る先のまわりを回る'}）`);
      const { name, holes, pixels } = await addViewCore();
      last = name;
      if (holes === null) throw new Error(`「${LIGHTS[light].name}」の絵がありません`);
      autoLog(`  視点 ${name} を足しました。穴は絵の ${(100 * holes / pixels).toFixed(1)}%。`);
      if (auto.stop) break;
      if (holes === 0) autoLog('  穴が無いので、描き足さずに次へ進みます。');
      else if (engine) {
        auto[engine]++; showAuto();
        const st = await codexFillWait(name, engine);
        if (auto.stop) break;
        if (st.code !== 0) throw new Error(`${ENGINES[engine].name}が止まりました（終了コード ${st.code}）。下の「進み具合」に出力があります`);
        autoLog(`  ${ENGINES[engine].name}で描き足しました。`);
        if (painting) { await reload(); autoLog((await refineDreamDepth(name)) ? '  埋めた絵の奥行きを推定して、すでにある面に合わせました。' : '  穴の奥行きは仮の値のままです（進み具合の欄を見てください）。'); }
      } else { await fillLocalCore(name); autoLog('  ツール内で埋めました。'); }
      last = ''; auto.steps++; showAuto();
      stage = 'painted'; press($('stage'), stage); await reload();
    }
  } catch (e) { autoLog(`止まりました：${e.message}`); }
  if (last) autoLog(`視点 ${last} は穴が残ったままです。「2. 穴を埋める」で埋めるか、取り消してください。`);
  autoLog(`終わりました。${auto.steps} 歩進み、別視点の生成モデルを ${auto.nvs} 回、PC の生成モデルを ${auto.model} 回、Codex を ${auto.codex} 回呼びました。`);
  auto.running = false; auto.stop = false; busy = false; $('add').disabled = false; showAuto(); say('–');
  await reload().catch(() => {});
}

// ---- 操作 ----
function press(el, v) { for (const x of el.children) x.setAttribute('aria-pressed', x.dataset.v === String(v) ? 'true' : 'false'); }
function seg(id, fn) { const el = $(id); el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; press(el, b.dataset.v); fn(b.dataset.v); }); }
// つまみの表示を、いまの候補（位置と見る先）に合わせる。
function sliders() {
  const [px, py, pz] = cand.position, [tx, ty, tz] = cand.target, flat = Math.hypot(tx - px, tz - pz);
  if (flat > 0.05) heading = Math.atan2(tz - pz, tx - px);
  const pitch = Math.atan2(py - ty, flat) * 180 / Math.PI;
  $('camY').value = py; $('oCamY').textContent = `${py.toFixed(1)} m`;
  $('tgtY').value = ty; $('oTgtY').textContent = `${ty.toFixed(1)} m`;
  $('pitch').value = pitch; $('oPitch').textContent = Math.abs(pitch) < 0.5 ? '水平' : pitch > 89.5 ? '真下' : pitch > 0 ? `下へ ${pitch.toFixed(0)} 度` : `上へ ${(-pitch).toFixed(0)} 度`;
}
const changed = () => { selected = null; sliders(); renderAdded(); drawMap(); schedule(); if (v3) v3.setCandidate(cand); };
$('camY').addEventListener('input', () => { cand.position[1] = Number($('camY').value); changed(); });
$('tgtY').addEventListener('input', () => { cand.target[1] = Number($('tgtY').value); changed(); });
$('pitch').addEventListener('input', () => { // 位置と水平の向きはそのまま、見る先を動かす
  const p = Number($('pitch').value) * Math.PI / 180, [px, py, pz] = cand.position;
  const d = Math.max(10, Math.hypot(cand.target[0] - px, cand.target[1] - py, cand.target[2] - pz));
  cand.target = [px + Math.cos(heading) * Math.cos(p) * d, py - Math.sin(p) * d, pz + Math.sin(heading) * Math.cos(p) * d];
  changed();
});
$('topdown').addEventListener('click', () => { // 見る先の真上へ移り、地面を真下に見る
  if (busy) return;
  cand.position = [cand.target[0], Math.max(cand.position[1], 60), cand.target[2]]; cand.target[1] = 0;
  changed();
});
seg('mode', (v) => { mode = v; selected = null; renderAdded(); show(); });
seg('stage', (v) => { stage = v; show(); });
seg('light', (v) => { if (busy) return press($('light'), light); light = v; reload().catch((e) => problem(e.message)); });
$('rewarp').addEventListener('click', rewarp);
$('search').addEventListener('click', () => search().catch((e) => { log(e.message); busy = false; $('search').disabled = false; }));
$('add').addEventListener('click', addView);
$('autoRun').addEventListener('click', () => { autoRun().catch((e) => { autoLog(`止まりました：${e.message}`); auto.running = false; auto.stop = false; busy = false; $('add').disabled = false; showAuto(); }); });
$('autoStep').addEventListener('input', showAuto);
for (const key of ['kind', 'dir', 'fill']) seg(`auto${key[0].toUpperCase()}${key.slice(1)}`, (v) => { auto[key] = v; showAuto(); });
$('fillLocal').addEventListener('click', fillLocal);
$('fillCodex').addEventListener('click', () => fillCodex(false));
$('fillModel').addEventListener('click', () => fillCodex(false, 'model'));
$('fillNvs').addEventListener('click', () => fillCodex(false, 'nvs'));
$('refineStrength').addEventListener('input', () => { $('oRefine').textContent = Number($('refineStrength').value).toFixed(2); });
$('fillDry').addEventListener('click', () => fillCodex(true));
$('stop').addEventListener('click', () => api('/api/paint/stop', {}).catch(() => {}));
window.addEventListener('focus', () => { if (!busy && !watching) reload().catch(() => {}); });
window.__auto = auto;


// ---- 3D の画面 ----
function showSpace(which) {
  const is3d = which === '3d' && !!v3;
  $('pane3d').hidden = !is3d; $('paneMap').hidden = is3d; press($('space'), is3d ? '3d' : 'map');
  for (const b of document.querySelectorAll('.v3only')) b.hidden = !is3d;
  $('lock').hidden = !is3d;
  if (!is3d) drawMap();
}
function setLock(on) {
  if (!v3) return;
  v3.setLocked(on); $('lock').setAttribute('aria-pressed', on ? 'true' : 'false');
  for (const b of document.querySelectorAll('.v3only')) b.disabled = on;
  $('handle').parentElement.hidden = on;
  $('hint3d').textContent = on
    ? '画面の見え方が、そのまま候補の視点です。緑の枠の中が絵になります。左ドラッグで見る先のまわりを回り、右ドラッグでずらし、ホイールで寄る・引く。形をダブルクリックすると、そこが見る先（回る中心）になります。'
    : '左ドラッグで回す、右ドラッグでずらす、ホイールで寄る・引く。緑の玉が候補のカメラ、白い玉が見る先で、矢印（3 方向）や四角（面に沿う）を掴むと動きます。形をダブルクリックすると、そこが見る先になります。';
}
seg('space', showSpace);
seg('handle', (v) => v3 && v3.setHandle(v));
$('lock').addEventListener('click', () => setLock(!v3.locked));
$('frameAll').addEventListener('click', () => v3 && v3.frameAll());
for (const b of document.querySelectorAll('[data-look]')) b.addEventListener('click', () => v3 && v3.lookFrom(b.dataset.look.split(',').map(Number)));
async function start3d() {
  try {
    v3 = await createView3D($('view3d'), {
      gl, mesh: painting ? shape : null,
      onChange: (c) => { // 3D の画面で候補が動いた
        if (busy) return v3.setCandidate(cand);
        cand = c; selected = null; sliders(); renderAdded(); if (!$('paneMap').hidden) drawMap(); schedule();
      },
    });
    v3.onHandle = (which) => press($('handle'), which);
    window.__v3 = v3;
  } catch (e) {
    v3 = null; $('no3d').hidden = false; $('no3d').textContent = `3D の画面を作れませんでした（${e.message}）。上からの地図で操作できます。`;
  }
  showSpace('3d');
}

// 絵 1 枚から作った場面なら、画面を始める前に切り替える：形の代わりに絵の奥行きを出し、形に頼る機能（自動で探す・光の描き分け）を隠す
async function prepare() {
  try { D = await loadViews(light); } catch { return; } // 書き出しが無いときは、今までどおり reload が知らせる
  painting = dream.isPainting(D.cams);
  if (!painting) return;
  shape = dream.sceneMesh(D); cand = dream.defaultCandidate(D);
  const b = dream.baseView(D), shot = $('shot');
  Object.assign(shot.style, { aspectRatio: `${b.W} / ${b.H}`, width: '100%', height: 'auto', minHeight: '0' });
  for (const id of ['searchBox', 'lightBox']) $(id).hidden = true;
  $('lead').textContent = 'この場面は絵 1 枚から作ってあります。視点を少しずつ変えて、絵の外や物の後ろ（穴）を描き足し、その分の粒を空間に加えます。';
  $('addNote').textContent = 'すでにある絵を、奥行きを使ってこの視点へ写します。写らなかった所が穴です。ChatGPT の利用枠は使いません。';
  $('fillNote').textContent = '「Codex で描き足す」は、まわりと同じ画風で穴だけを描きます（人や動物は増やさないように頼みます）。描いた後、その絵の奥行きを推定して、すでにある面に合わせます。「ツール内で埋める」は、まわりの色を広げるだけで、奥行きは仮の値のままです。';
  auto.kind = 'pan'; press($('autoKind'), 'pan'); $('autoStep').value = 20;
}
sliders();
prepare().then(() => { sliders(); return start3d(); }).then(reload).then(() => { if (v3) v3.frameAll(); }).then(() => { window.__ready = true; }).catch((e) => { problem(e.message); });
