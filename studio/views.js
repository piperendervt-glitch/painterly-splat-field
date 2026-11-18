// 視点を足す：穴の多い視点を探す → プレビズを書き出し直す → すでにある絵を新しい視点へ写す → 穴だけ埋める。
import { loadViews, loadImage, sceneTriangles, analyze, warpInto, localFill, VIEW_TINTS, LIGHTS } from './viewdata.js';

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
let cand = { position: [24, 1.7, -30], target: [0, 15, 0] }, selected = null, dots = [], mapT = null, timer = 0;

const fovY = () => D.views[0].fov_y_deg;
const painted = () => D.views.filter((v) => v.painted);

// ---- 読み込み ----
async function reload() {
  D = await loadViews(light);
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
  renderAdded(); drawMap(); show();
}

// ---- 地図 ----
function drawMap() {
  const c = $('map'), g = c.getContext('2d'), S = c.width;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grow = (x, z) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  for (const m of meshes) if (!m.ground) { grow(m.min[0], m.min[2]); grow(m.max[0], m.max[2]); }
  for (const v of D.views) grow(v.def.extrinsics.position[0], v.def.extrinsics.position[2]);
  grow(cand.position[0], cand.position[2]);
  const span = Math.max(x1 - x0, z1 - z0) + 80, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, k = S / span;
  mapT = { k, mx, mz, S, bounds: [x0, x1, z0, z1] };
  const X = (x) => (x - mx) * k + S / 2, Z = (z) => (z - mz) * k + S / 2;
  g.fillStyle = '#1b231b'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#263026'; g.lineWidth = 1; // 20m の目盛り
  for (let t = Math.ceil((mx - span / 2) / 20) * 20; t < mx + span / 2; t += 20) { g.beginPath(); g.moveTo(X(t), 0); g.lineTo(X(t), S); g.stroke(); }
  for (let t = Math.ceil((mz - span / 2) / 20) * 20; t < mz + span / 2; t += 20) { g.beginPath(); g.moveTo(0, Z(t)); g.lineTo(S, Z(t)); g.stroke(); }
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
  selected = null; sliders(); renderAdded(); drawMapKeepScale(); schedule();
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
  if (busy || !painted().length) return;
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
    say('–'); sliders(); renderAdded(); drawMap(); show();
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
  for (const ch of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (!used.has(ch)) return ch;
  for (let i = 1; ; i++) if (!used.has(`V${i}`)) return `V${i}`;
}

async function addView() {
  if (busy) return;
  if (!painted().length) return problem('まだ絵画がありません。先に「絵画化」のタブで絵を作ってください。');
  busy = true; $('add').disabled = true; $('log').textContent = '';
  try {
    const name = nextName(), round = (a) => a.map((x) => +x.toFixed(3));
    say('プレビズを書き出しています'); log(`視点 ${name} を足します：位置 ${round(cand.position).join(', ')} → 見る先 ${round(cand.target).join(', ')}`);
    await api('/api/view/forget', { view: name });
    await saveExtra([...(await extraCameras()).filter((c) => c.name !== name), { name, position: round(cand.position), target: round(cand.target) }]);
    await reexport(); log('プレビズを書き出し直しました（色・奥行き・カメラ情報）。');
    say('絵を写しています');
    let wroteNew = false;
    for (const L of Object.keys(LIGHTS)) wroteNew = (await warpView(name, L, !wroteNew)) || wroteNew; // 絵のある描き方すべてについて写す
    if (!wroteNew) throw new Error('写せる絵がありませんでした');
    selected = name; stage = 'reproj'; press($('stage'), stage);
    await reload(); say('穴を埋める方法を選んでください');
  } catch (e) { log(`止まりました：${e.message}`); say('止まりました'); }
  finally { busy = false; $('add').disabled = false; }
}
// 視点 name へ、光の描き方 L の絵を写す。写した絵・穴の印を保存する。絵が無ければ何もしない。
async function warpView(name, L, writeNew) {
  const data = await loadViews(L), v = data.views.find((x) => x.name === name), x = LIGHTS[L].sfx;
  if (!v) throw new Error('書き出しに新しい視点が入っていません');
  const sources = data.views.filter((s) => s.painted && s !== v && !(s.added && !s.st[`painted${x}`]));
  if (!sources.length) return false;
  await new Promise((r) => setTimeout(r));
  const w = warpInto(v, sources);
  await savePng(`${name}_reproj${x}.png`, w.reproj, v.W, v.H);
  await savePng(`${name}_holes${x}.png`, w.holes, v.W, v.H);
  if (writeNew) await savePng(`${name}_new.png`, w.holes, v.W, v.H); // 粒にするのは穴だった画素だけ
  log(`「${LIGHTS[L].name}」の絵を写しました。穴は絵の ${(100 * w.holeCount / (v.W * v.H)).toFixed(1)}%。`);
  return true;
}
async function rewarp() {
  if (busy || !selected) return; busy = true;
  try {
    say('絵を写しています'); $('log').textContent = '';
    const v = D.views.find((x) => x.name === selected);
    // 埋めた絵が残っていると、それ自身が「すでにある絵」として写ってしまうので、先に消す
    await fetch(`/api/paint-out/${selected}_painted${sfx()}.png`, { method: 'DELETE' });
    if (!(await warpView(selected, light, !v.st.new_mask))) log(`「${LIGHTS[light].name}」の絵がまだありません。`);
    stage = 'reproj'; press($('stage'), stage); await reload(); say('–');
  } catch (e) { log(`止まりました：${e.message}`); say('止まりました'); }
  finally { busy = false; }
}
async function removeView(name) {
  if (busy) return; busy = true;
  try {
    say('取り消しています'); log(`視点 ${name} を取り消します。`);
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
  try {
    const v = D.views.find((x) => x.name === selected), t0 = performance.now();
    say('ツール内で埋めています');
    if (!v.st[`reproj${sfx()}`]) throw new Error('まだ絵を写していません。「すでにある絵を写し直す」を押してください。');
    const [reproj, holes] = await Promise.all([loadImage(`/files/paint-out/${v.name}_reproj${sfx()}.png`, v.W, v.H), loadImage(`/files/paint-out/${v.name}_holes${sfx()}.png`, v.W, v.H)]);
    await new Promise((r) => setTimeout(r, 30));
    const f = localFill(v, reproj, holes, { meshes, sources: painted().filter((s) => s !== v) });
    await savePng(`${v.name}_painted${sfx()}.png`, f.rgba, v.W, v.H);
    const all = Math.max(1, f.spread + f.fromPalette);
    log(`視点 ${v.name}：ツール内で埋めました（${((performance.now() - t0) / 1000).toFixed(1)} 秒）。穴のうち ${(100 * f.spread / all).toFixed(0)}% はまわりの色を広げ、${(100 * f.fromPalette / all).toFixed(0)}% は${f.byLabels ? '同じ物体・種類の札の' : '同じ形の'}平均の色で塗りました。`);
    stage = 'painted'; press($('stage'), stage); await reload(); say('埋めました');
  } catch (e) { log(`止まりました：${e.message}`); say('止まりました'); }
  finally { busy = false; }
}
let watching = false;
async function fillCodex(dryRun) {
  if (busy || !selected) return;
  try { await api('/api/paint/fill', { view: selected, dryRun, light }); watching = true; $('log').textContent = ''; poll(); }
  catch (e) { log(e.message); }
}
async function poll() {
  if (!watching) return;
  try {
    const st = await api('/api/paint/status');
    say(st.running ? `Codex で描いています ${st.seconds} 秒` : st.code === 0 ? '終わりました' : `止まりました（${st.code}）`);
    $('log').textContent = st.log; $('stop').disabled = !st.running;
    $('fillCodex').disabled = $('fillDry').disabled = $('fillLocal').disabled = st.running;
    if (!st.running) { watching = false; if (st.code === 0 && !st.dryRun) { stage = 'painted'; press($('stage'), stage); } await reload(); return; }
  } catch { say('サーバーに届きません'); }
  setTimeout(poll, 1500);
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
const changed = () => { selected = null; sliders(); renderAdded(); drawMap(); schedule(); };
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
$('fillLocal').addEventListener('click', fillLocal);
$('fillCodex').addEventListener('click', () => fillCodex(false));
$('fillDry').addEventListener('click', () => fillCodex(true));
$('stop').addEventListener('click', () => api('/api/paint/stop', {}).catch(() => {}));
window.addEventListener('focus', () => { if (!busy && !watching) reload().catch(() => {}); });

sliders();
reload().then(() => { window.__ready = true; }).catch((e) => { problem(e.message); });
