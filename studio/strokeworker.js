// 3D の形を筆跡の粒に変える仕事（shared/strokefield.js）を、画面の描画とは別の糸（Web Worker）で行う。
// 受け取るもの：
//   { type: 'init', tris, refs, opts, tree }   形と参照の絵。絵を調べて決まりを学ぶ（数秒）。返事：{ type: 'ready', summary, maps }
//   { type: 'opts', opts }                      まき方の設定だけ変える（作り置きの箱は捨てる）。返事：{ type: 'cleared' }
//   { type: 'node', key }                       1 つの箱の筆跡を作る。返事：{ type: 'node', key, count, arrays, mask, ms }
//   { type: 'sky', opts }                       空の筆跡。返事：{ type: 'sky', count, arrays }
import { analyze, makeTree, generateNode, childLists, generateSky, nodeKey, STROKE_ATTRS, modelFor, shadeColor } from '../shared/strokefield.js';
import { ANGLE_BINS } from '../shared/brushstats.js';

let tris = null, A = null, tree = null, opts = {};
const lists = new Map(); // 箱 → 掛かっている三角形（作った箱の子の一覧も入れておく）

function listOf(key) {
  if (lists.has(key)) return lists.get(key);
  const [l, x, y, z] = key.split('/').map(Number);
  if (l === 0) { const all = Int32Array.from({ length: tris.n }, (_, i) => i); lists.set(key, all); return all; }
  const parent = nodeKey(l - 1, x >> 1, y >> 1, z >> 1), pl = listOf(parent);
  for (const c of childLists(tris, tree, parent, pl).children) lists.set(c.key, c.list);
  if (!lists.has(key)) lists.set(key, new Int32Array(0));
  if (lists.size > 20000) { let i = 0; for (const k of lists.keys()) { if (i++ > 5000) break; if (k !== key) lists.delete(k); } }
  return lists.get(key);
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const t0 = performance.now();
      tris = m.tris; opts = m.opts || {}; lists.clear();
      A = analyze(tris, m.refs, opts);
      tree = makeTree(tris, m.tree || {});
      const ref = A.refs[0], W = ref.cam.W, H = ref.cam.H;
      const types = [...A.types.entries()].map(([k, s]) => ({ kind: k, width: s.width, length: s.length, aspect: s.aspect, scale: s.scale, bristle: s.bristle, coh: s.cohMean, count: s.count, measured: s.measured, hist: Array.from(s.hist), phiHist: Array.from(s.phiHist), curves: s.curves }));
      const models = {};
      for (const [k, md] of A.models) models[k] = { coef: md.coef, count: md.count, bank: md.bank.filter((_, i) => i % Math.max(1, Math.floor(md.bank.length / 24)) === 0).slice(0, 24) };
      if (A.sky) models.sky = { coef: A.sky.coef, count: A.sky.count, bank: A.sky.bank.filter((_, i) => i % Math.max(1, Math.floor(A.sky.bank.length / 24)) === 0).slice(0, 24) };
      // 確かめ用の地図（1 枚目の参照の絵）：筆の向き・はっきりさ・種類・境目
      const maps = { W, H, theta: ref.field.theta, coh: ref.field.coh, kind: ref.kind, edge: ref.edge, refs: A.refs.map((r) => r.name) };
      self.postMessage({ type: 'ready', ms: performance.now() - t0, summary: { types, models, ref: A.ref, tree, angleBins: ANGLE_BINS }, maps });
      return;
    }
    if (m.type === 'opts') { opts = { ...opts, ...m.opts }; self.postMessage({ type: 'cleared' }); return; }
    if (m.type === 'node') {
      const t0 = performance.now(), list = listOf(m.key);
      const g = generateNode(tris, A, tree, m.key, list, opts);
      const [l] = m.key.split('/').map(Number);
      let mask = 0;
      if (l < tree.maxLevel) { const ch = childLists(tris, tree, m.key, list); mask = ch.mask; for (const c of ch.children) lists.set(c.key, c.list); }
      const buf = STROKE_ATTRS.map((k) => g.arrays[k].buffer);
      self.postMessage({ type: 'node', key: m.key, count: g.count, arrays: g.arrays, mask, flat: g.flat, ms: performance.now() - t0, gen: m.gen }, [...buf, g.arrays.O.buffer]);
      return;
    }
    if (m.type === 'sky') {
      const g = generateSky(A, { ...opts, ...(m.opts || {}) });
      self.postMessage({ type: 'sky', count: g.count, arrays: g.arrays, gen: m.gen }, [...STROKE_ATTRS.map((k) => g.arrays[k].buffer), g.arrays.O.buffer]);
      return;
    }
    if (m.type === 'shade') { // 下塗り用：頂点ごとの陰影だけの色
      const out = new Float32Array(tris.n * 9);
      for (let t = 0; t < tris.n; t++) {
        const md = modelFor(A, tris.object[t], tris.type[t]);
        for (let k = 0; k < 3; k++) { const o = t * 9 + k * 3, c = shadeColor(md, [tris.nrm[o], tris.nrm[o + 1], tris.nrm[o + 2]]); out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; }
      }
      self.postMessage({ type: 'shade', colors: out }, [out.buffer]);
    }
  } catch (err) { console.error(err); self.postMessage({ type: 'error', message: String(err && err.message || err), key: m.key }); }
};
