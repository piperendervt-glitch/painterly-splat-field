// GUI 用の小さな API。Vite の開発サーバーに差し込む（vite.config.js）。手元の PC の中だけで使う。
//   GET  /api/state                 書き出し・絵画のファイルがどこまで揃っているか
//   GET  /files/previz-export/<名>   プレビズの書き出し
//   GET  /files/paint-out/<名>       絵画化の結果
//   POST /api/previz-export/<名>     プレビズ画面からの保存（png / cameras.json）
//   POST /api/paint/run             paint/paint.mjs views を起動（{ views, style, dryRun, light }）
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
const SAFE_NAME = /^[A-Za-z0-9_-]+\.(png|json)$/;
const TYPES = { '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
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
  out.views = (cams.views || []).map((v) => ({
    name: v.name,
    color: stat(path.join(DIRS['previz-export'], v.color)),
    depth: stat(path.join(DIRS['previz-export'], v.depth)),
    flat: stat(path.join(DIRS['previz-export'], `${v.name}_flat.png`)),
    lit: stat(path.join(DIRS['previz-export'], `${v.name}_lit.png`)),
    painted: stat(path.join(DIRS['paint-out'], `${v.name}_painted.png`)),
    overlay: stat(path.join(DIRS['paint-out'], `${v.name}_overlay.png`)),
    painted_flat: stat(path.join(DIRS['paint-out'], `${v.name}_painted_flat.png`)),
    overlay_flat: stat(path.join(DIRS['paint-out'], `${v.name}_overlay_flat.png`)),
    painted_lit: stat(path.join(DIRS['paint-out'], `${v.name}_painted_lit.png`)),
    overlay_lit: stat(path.join(DIRS['paint-out'], `${v.name}_overlay_lit.png`)),
  }));
  return out;
}

function runPaint({ views, style, dryRun, light }) {
  const args = [path.join(ROOT, 'paint', 'paint.mjs'), 'views', '--in', DIRS['previz-export'], '--out', DIRS['paint-out']];
  if (Array.isArray(views) && views.length) args.push('--views', views.filter((v) => /^[A-Za-z0-9_-]+$/.test(v)).join(','));
  if (typeof style === 'string' && style.trim()) args.push('--style', style.trim().slice(0, 500));
  if (light === 'flat' || light === 'previz') args.push('--light', light); // free（既定）は今までどおり
  if (dryRun) args.push('--dry-run');
  Object.assign(job, { running: true, log: '', code: null, startedAt: Date.now(), dryRun: !!dryRun });
  const child = spawn(process.execPath, args, { cwd: path.join(ROOT, 'paint'), windowsHide: true });
  job.child = child;
  const add = (c) => { job.log = (job.log + c.toString('utf8')).slice(-20000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('error', (e) => { add(`起動できませんでした：${e.message}\n`); job.running = false; job.code = -1; job.child = null; });
  child.on('close', (code) => { job.running = false; job.code = code; job.child = null; });
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
