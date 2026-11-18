// GUI 用の小さな API。Vite の開発サーバーに差し込む（vite.config.js）。手元の PC の中だけで使う。
//   GET  /api/state                 書き出し・絵画のファイルがどこまで揃っているか
//   GET  /files/previz-export/<名>   プレビズの書き出し
//   GET  /files/paint-out/<名>       絵画化の結果
//   POST /api/previz-export/<名>     プレビズ画面からの保存（png / cameras.json）
//   POST /api/paint/run             paint/paint.mjs views を起動（{ views, style, dryRun, light }）
//   POST /api/paint-out/<名>        「視点を足す」画面からの保存（写した絵・穴の印）
//   POST /api/paint/fill            paint/paint.mjs fill を起動（{ view, style, dryRun, light }）。足した視点の穴だけ描く
//   POST /api/paint/sky             paint/paint.mjs fill --sky を起動（{ face, sfx, light, styleRef, dryRun }）。空の天球の穴だけ描く
//   POST /api/paint/plate           paint/paint.mjs fill --plate を起動（{ view, src, dryRun }）。手前の物を消した背景の絵（背後の層の色）を描く
//   POST /api/sharp/plate           sharp/psf_sharp.py --plate を起動（{ view, src }）。背景の絵を SHARP に通して、奥行き用の粒を作る
//   POST /api/view/forget           足した視点の絵を消す（{ view }）
//   POST /api/paint/stop            止める
//   GET  /api/paint/status          実行中かどうかと出力
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 場面の切り替え：環境変数 PSF_SCENE=<名前> で起動すると、scenes/<名前>/ の中を使う（実在の絵から作った場面など）。
const SCENE = /^[A-Za-z0-9_-]+$/.test(process.env.PSF_SCENE || '') ? process.env.PSF_SCENE : '';
const DIRS = SCENE
  ? { 'previz-export': path.join(ROOT, 'scenes', SCENE, 'previz-export'), 'paint-out': path.join(ROOT, 'scenes', SCENE, 'paint-out') }
  : { 'previz-export': path.join(ROOT, 'previz-export'), 'paint-out': path.join(ROOT, 'paint', 'out') };
const SAFE_NAME = /^[A-Za-z0-9_-]+\.(png|json|ply|obj)$/;
const TYPES = { '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ply': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8' };
const WIN = process.platform === 'win32';

const job = { child: null, running: false, log: '', code: null, startedAt: 0, dryRun: false };

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((ok, ng) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { ng(new Error('大きすぎます')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', ng);
  });
}
const stat = (file) => { try { const s = fs.statSync(file); return { size: s.size, mtime: Math.round(s.mtimeMs) }; } catch { return null; } };

function state() {
  const out = { scene: SCENE, previz: null, views: [], paintReady: fs.existsSync(path.join(ROOT, 'paint', 'node_modules', 'pngjs')) };
  const camFile = path.join(DIRS['previz-export'], 'cameras.json');
  if (!fs.existsSync(camFile)) return out;
  let cams;
  try { cams = JSON.parse(fs.readFileSync(camFile, 'utf8')); } catch { return out; }
  out.previz = stat(camFile);
  out.ground_ai = Object.fromEntries(['', '_flat', '_lit'].map((sfx) => [`ground_ai${sfx}`, stat(path.join(DIRS['paint-out'], `ground_ai${sfx}.png`))])); // AI が描いた周囲の地面
  out.sky_ai = Object.fromEntries(['', '_flat', '_lit'].map((sfx) => [`sky_ai${sfx}`, stat(path.join(DIRS['paint-out'], `sky_ai${sfx}.png`))])); // AI が描いた空（天球の層）
  out.views = (cams.views || []).map((v) => ({
    name: v.name,
    color: stat(path.join(DIRS['previz-export'], v.color)),
    depth: stat(path.join(DIRS['previz-export'], v.depth)),
    flat: stat(path.join(DIRS['previz-export'], `${v.name}_flat.png`)),
    lit: stat(path.join(DIRS['previz-export'], `${v.name}_lit.png`)),
    painted: stat(path.join(DIRS['paint-out'], `${v.name}_painted.png`)),
    overlay: stat(path.join(DIRS['paint-out'], `${v.name}_overlay.png`)),
    reproj: stat(path.join(DIRS['paint-out'], `${v.name}_reproj.png`)),
    holes: stat(path.join(DIRS['paint-out'], `${v.name}_holes.png`)),
    reproj_flat: stat(path.join(DIRS['paint-out'], `${v.name}_reproj_flat.png`)),
    holes_flat: stat(path.join(DIRS['paint-out'], `${v.name}_holes_flat.png`)),
    reproj_lit: stat(path.join(DIRS['paint-out'], `${v.name}_reproj_lit.png`)),
    holes_lit: stat(path.join(DIRS['paint-out'], `${v.name}_holes_lit.png`)),
    new_mask: stat(path.join(DIRS['paint-out'], `${v.name}_new.png`)),
    painted_flat: stat(path.join(DIRS['paint-out'], `${v.name}_painted_flat.png`)),
    overlay_flat: stat(path.join(DIRS['paint-out'], `${v.name}_overlay_flat.png`)),
    painted_lit: stat(path.join(DIRS['paint-out'], `${v.name}_painted_lit.png`)),
    overlay_lit: stat(path.join(DIRS['paint-out'], `${v.name}_overlay_lit.png`)),
    sharp: stat(path.join(DIRS['paint-out'], `${v.name}_sharp.ply`)), // SHARP の粒（sharp/psf_sharp.py）
    plate_sharp: PLATE_SRC.filter((k) => fs.existsSync(plateFiles(v.name, k).sharp)), // その絵を SHARP に通した粒（背後の層の位置に使う）
    plates: PLATE_SRC.filter((k) => { const f = plateFiles(v.name, k); return fs.existsSync(f.out) && fs.existsSync(f.mask); }), // AI が描いた、手前の物を消した背景の絵（色のもとごと）
  }));
  return out;
}

function runPaint({ views, style, dryRun, light }) {
  const args = [path.join(ROOT, 'paint', 'paint.mjs'), 'views', '--in', DIRS['previz-export'], '--out', DIRS['paint-out']];
  if (Array.isArray(views) && views.length) args.push('--views', views.filter((v) => /^[A-Za-z0-9_-]+$/.test(v)).join(','));
  if (typeof style === 'string' && style.trim()) args.push('--style', style.trim().slice(0, 500));
  if (light === 'flat' || light === 'previz') args.push('--light', light); // free（既定）は今までどおり
  if (dryRun) args.push('--dry-run');
  startJob(args, dryRun);
}
function startJob(args, dryRun) {
  if (process.env.PAINT_CODEX) args.push('--codex', process.env.PAINT_CODEX); // 確かめ用：にせの codex に差し替える
  startProcess(process.execPath, args, path.join(ROOT, 'paint'), dryRun);
}
function startProcess(command, args, cwd, dryRun = false) {
  Object.assign(job, { running: true, log: '', code: null, startedAt: Date.now(), dryRun: !!dryRun });
  const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
  job.child = child;
  const add = (c) => { job.log = (job.log + c.toString('utf8')).slice(-20000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('error', (e) => { add(`起動できませんでした：${e.message}\n`); job.running = false; job.code = -1; job.child = null; });
  child.on('close', (code) => { job.running = false; job.code = code; job.child = null; });
}
// 足した視点の穴だけ描く。写した絵（<視点>_reproj<光>.png）と穴の印（<視点>_holes<光>.png）は画面が先に保存している。
// 光の描き方（light）ごとに、絵の名前の後ろと、下絵にするプレビズの絵が変わる。
const FILL_LIGHT = { free: { sfx: '', ref: 'color' }, flat: { sfx: '_flat', ref: 'flat' }, previz: { sfx: '_lit', ref: 'lit' } };
function fillFiles(view, light) {
  const { sfx, ref } = FILL_LIGHT[light] || FILL_LIGHT.free;
  const out = (name) => path.join(DIRS['paint-out'], `${view}_${name}${sfx}.png`), pre = (name) => path.join(DIRS['previz-export'], `${view}_${name}.png`);
  return { image: out('reproj'), mask: out('holes'), out: out('painted'), overlay: out('overlay'), previz: pre(ref), depth: pre('depth_view') };
}
function runFill({ view, style, dryRun, light }) {
  const f = fillFiles(view, light);
  const args = [path.join(ROOT, 'paint', 'paint.mjs'), 'fill', '--image', f.image, '--mask', f.mask, '--out', f.out, '--previz', f.previz, '--depth', f.depth, '--overlay', f.overlay];
  if (light === 'flat' || light === 'previz') args.push('--light', light);
  if (typeof style === 'string' && style.trim()) args.push('--style', style.trim().slice(0, 500));
  if (dryRun) args.push('--dry-run');
  startJob(args, dryRun);
}
// 空の天球の穴を描く。空の絵（sky_face<向き><光>.png）と穴の印（…_holes.png）は「粒の空間」の画面が先に保存している。
const SKY_SFX = ['', '_flat', '_lit'];
function skyFiles(face, sfx, kind = 'sky') { // kind = 'ground' は周囲の地面（同じ仕組みで、30° 見下ろした絵）
  const out = (name) => path.join(DIRS['paint-out'], `${kind === 'ground' ? 'ground' : 'sky'}_face${face}${sfx}${name}.png`);
  return { image: out(''), mask: out('_holes'), out: out('_painted') };
}
function runSky({ kind, face, sfx, light, styleRef, style, dryRun }) {
  const f = skyFiles(face, sfx, kind);
  const args = [path.join(ROOT, 'paint', 'paint.mjs'), 'fill', kind === 'ground' ? '--ground' : '--sky', '--image', f.image, '--mask', f.mask, '--out', f.out];
  if (light === 'flat' || light === 'previz') args.push('--light', light);
  const ref = typeof styleRef === 'string' && /^[A-Za-z0-9]+_painted(_flat|_lit)?$/.test(styleRef) ? path.join(DIRS['paint-out'], `${styleRef}.png`) : null;
  if (ref && fs.existsSync(ref)) args.push('--style-ref', ref); // 画風の見本にする、同じ場面の絵
  if (typeof style === 'string' && style.trim()) args.push('--style', style.trim().slice(0, 500));
  if (dryRun) args.push('--dry-run');
  startJob(args, dryRun);
}
// 手前の物を消した背景の絵（背後の層の色）を描く。元の絵（…_platein_…）、穴の印（…_platemask_…）、計算で埋めた目安（…_plateguide_…）は「粒の空間」の画面が先に保存している。
const PLATE_SRC = ['painted', 'painted_flat', 'painted_lit', 'previz', 'flat', 'lit']; // 色のもと（studio/splat.js の SOURCES の名前）
function plateFiles(view, src) {
  const out = (name) => path.join(DIRS['paint-out'], `${view}_${name}_${src}.png`);
  return { image: out('platein'), mask: out('platemask'), guide: out('plateguide'), out: out('plate'), sharp: path.join(DIRS['paint-out'], `${view}_plate_${src}_sharp.ply`) };
}
function runPlate({ view, src, dryRun }) {
  const f = plateFiles(view, src);
  const args = [path.join(ROOT, 'paint', 'paint.mjs'), 'fill', '--plate', '--image', f.image, '--mask', f.mask, '--guide', f.guide, '--out', f.out, '--grow', '0'];
  if (dryRun) args.push('--dry-run');
  startJob(args, dryRun);
}
// 背景の絵を SHARP に通す（sharp/setup.bat で作った Python を使う）。確かめ用に PSF_SHARP_PYTHON で差し替えられる
const sharpPython = () => process.env.PSF_SHARP_PYTHON || path.join(ROOT, 'sharp', '.venv', WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
function runSharpPlate({ view, src }) {
  const args = [path.join(ROOT, 'sharp', 'psf_sharp.py'), '--view', view, '--plate', src];
  if (SCENE) args.push('--scene', SCENE);
  startProcess(sharpPython(), args, path.join(ROOT, 'sharp'));
}
function stopPaint() {
  const child = job.child; if (!child) return;
  job.log += '\n（止めました）\n';
  if (WIN && child.pid) { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* 下へ */ } }
  child.kill();
}

// ほかのサイトのページからこの API を叩かれないようにする。
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export async function handle(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/files/')) {
      const [, , dir, name] = p.split('/');
      if (!DIRS[dir] || !SAFE_NAME.test(name || '')) return json(res, 404, { error: 'not found' });
      const file = path.join(DIRS[dir], name);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      res.statusCode = 200;
      res.setHeader('Content-Type', TYPES[path.extname(name)]);
      res.setHeader('Cache-Control', 'no-store');
      return fs.createReadStream(file).pipe(res);
    }
    if (!p.startsWith('/api/')) return next();
    if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'forbidden' });

    if (p === '/api/state' && req.method === 'GET') return json(res, 200, state());
    if (p === '/api/paint/status' && req.method === 'GET') {
      return json(res, 200, { running: job.running, code: job.code, log: job.log, dryRun: job.dryRun, seconds: job.running ? Math.round((Date.now() - job.startedAt) / 1000) : 0 });
    }
    if (p === '/api/paint/run' && req.method === 'POST') {
      if (job.running) return json(res, 409, { error: 'いま実行中です' });
      if (!fs.existsSync(path.join(DIRS['previz-export'], 'cameras.json'))) return json(res, 400, { error: 'プレビズの書き出しがありません。先に「プレビズ」で保存してください。' });
      const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
      runPaint(body);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/paint/fill' && req.method === 'POST') {
      if (job.running) return json(res, 409, { error: 'いま実行中です' });
      const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
      if (!/^[A-Za-z0-9]+$/.test(body.view || '')) return json(res, 400, { error: '視点の名前が使えません' });
      const need = fillFiles(body.view, body.light);
      for (const f of [need.image, need.mask, need.previz]) {
        if (!fs.existsSync(f)) return json(res, 400, { error: `${path.basename(f)} がありません。「視点を足す」からやり直してください。` });
      }
      runFill(body);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/paint/sky' && req.method === 'POST') {
      if (job.running) return json(res, 409, { error: 'いま実行中です' });
      const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
      if (![0, 1, 2, 3].includes(body.face) || !SKY_SFX.includes(body.sfx)) return json(res, 400, { error: '空の向きが使えません' });
      const need = skyFiles(body.face, body.sfx, body.kind);
      for (const f of [need.image, need.mask]) if (!fs.existsSync(f)) return json(res, 400, { error: `${path.basename(f)} がありません` });
      runSky(body);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/paint/plate' && req.method === 'POST') {
      if (job.running) return json(res, 409, { error: 'いま実行中です' });
      const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
      if (!/^[A-Za-z0-9]+$/.test(body.view || '') || !PLATE_SRC.includes(body.src)) return json(res, 400, { error: '視点か色のもとの名前が使えません' });
      const need = plateFiles(body.view, body.src);
      for (const f of [need.image, need.mask, need.guide]) if (!fs.existsSync(f)) return json(res, 400, { error: `${path.basename(f)} がありません` });
      runPlate(body);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/sharp/plate' && req.method === 'POST') {
      if (job.running) return json(res, 409, { error: 'いま実行中です' });
      const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
      if (!/^[A-Za-z0-9]+$/.test(body.view || '') || !PLATE_SRC.includes(body.src)) return json(res, 400, { error: '視点か色のもとの名前が使えません' });
      if (!fs.existsSync(plateFiles(body.view, body.src).out)) return json(res, 400, { error: 'AI が描いた背景の絵がまだありません' });
      if (!fs.existsSync(sharpPython())) return json(res, 400, { error: 'SHARP の用意がまだです。sharp フォルダの setup.bat を先に実行してください。' });
      runSharpPlate(body);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/paint-out/') && req.method === 'DELETE') { // 埋めた絵を消す（写し直す前）
      const name = p.slice('/api/paint-out/'.length);
      if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
      if (/^[A-Za-z0-9]+_plate_[a-z_]+\.png$/.test(name)) { for (const kind of ['plate', 'platemask', 'platein', 'plateguide']) fs.rmSync(path.join(DIRS['paint-out'], name.replace('_plate_', `_${kind}_`)), { force: true }); fs.rmSync(path.join(DIRS['paint-out'], name.replace('.png', '_sharp.ply')), { force: true }); return json(res, 200, { ok: true }); } // AI が描いた背景の絵（と、頼むときに作った絵）
      if (/^(sky|ground)_ai(_flat|_lit)?\.png$/.test(name)) { fs.rmSync(path.join(DIRS['paint-out'], name), { force: true }); return json(res, 200, { ok: true }); } // AI が描いた空
      if (!/^[A-Za-z0-9]+_painted(_flat|_lit)?\.png$/.test(name)) return json(res, 400, { error: 'ファイル名が使えません' });
      if (!fs.existsSync(path.join(DIRS['paint-out'], name.replace('_painted', '_reproj')))) return json(res, 400, { error: '足した視点の絵だけ消せます' }); // もとの視点の絵は消さない
      fs.rmSync(path.join(DIRS['paint-out'], name), { force: true });
      fs.rmSync(path.join(DIRS['paint-out'], name.replace('_painted', '_overlay')), { force: true });
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/paint-out/') && req.method === 'POST') {
      const name = p.slice('/api/paint-out/'.length);
      if (!/^[A-Za-z0-9_-]+\.png$/.test(name)) return json(res, 400, { error: 'ファイル名が使えません' });
      const body = await readBody(req);
      fs.mkdirSync(DIRS['paint-out'], { recursive: true });
      fs.writeFileSync(path.join(DIRS['paint-out'], name), body);
      return json(res, 200, { ok: true, size: body.length });
    }
    if (p === '/api/view/forget' && req.method === 'POST') { // 足した視点の、写した絵・穴の印・描き足した絵を消す
      const body = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
      if (!/^[A-Za-z0-9]+$/.test(body.view || '')) return json(res, 400, { error: '視点の名前が使えません' });
      for (const kind of ['painted', 'overlay', 'reproj', 'holes']) for (const sfx of ['', '_flat', '_lit']) fs.rmSync(path.join(DIRS['paint-out'], `${body.view}_${kind}${sfx}.png`), { force: true });
      fs.rmSync(path.join(DIRS['paint-out'], `${body.view}_new.png`), { force: true });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/paint/stop' && req.method === 'POST') { stopPaint(); return json(res, 200, { ok: true }); }
    if (p.startsWith('/api/previz-export/') && req.method === 'POST') {
      const name = p.slice('/api/previz-export/'.length);
      if (!SAFE_NAME.test(name)) return json(res, 400, { error: 'ファイル名が使えません' });
      const body = await readBody(req);
      fs.mkdirSync(DIRS['previz-export'], { recursive: true });
      fs.writeFileSync(path.join(DIRS['previz-export'], name), body);
      return json(res, 200, { ok: true, size: body.length });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

export function studioApi() {
  return {
    name: 'painterly-studio-api',
    configureServer(server) { server.middlewares.use(handle); },
    configurePreviewServer(server) { server.middlewares.use(handle); },
  };
}
