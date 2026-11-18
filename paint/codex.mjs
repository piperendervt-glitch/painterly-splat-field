// ChatGPT の月額プラン経由で絵を 1 枚作る。OpenAI の Codex CLI（codex exec）の組み込みの画像生成を呼ぶ。
// game-studio の server/imagegen/codex-cli.js と同じ呼び方：
//   codex exec --sandbox workspace-write --skip-git-repo-check   文は標準入力から。条件の絵は作業フォルダの references/ に置く
//   OPENAI_API_KEY を外して呼ぶので、API の従量課金ではなく、codex login した ChatGPT のプランの利用枠を使う。
// Codex は同時に 2 つ動かすと壊れることがあるので、呼ぶ側で 1 枚ずつ順番に呼ぶこと。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const WIN = process.platform === 'win32';

function launch(command, args, options) {
  if (!WIN) return spawn(command, args, options);
  const quote = (a) => (/[\s"]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a);
  return spawn([command, ...args].map(quote).join(' '), { ...options, shell: true, windowsHide: true });
}

function stop(child) {
  if (WIN && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* 下へ */ }
  }
  child.kill();
}

/** Codex に渡す文。references は [{ name, note }]。 */
export function buildPrompt({ width, height, references, instructions }) {
  const shape = width === height ? 'square' : (width > height ? 'landscape' : 'portrait');
  const lines = [
    `Please generate 1 bitmap raster image (PNG) using your built-in image_gen tool${references.length ? ', following the reference image(s) below' : ''}.`,
    `Render the image in ${shape} aspect ratio (${width}x${height} pixels).`,
    'The output must be a bitmap, not SVG or code.',
    '',
  ];
  if (references.length) {
    lines.push('Reference images available in your working directory (load them with view_image before generating):');
    for (const r of references) lines.push(`  - references/${r.name}${r.note ? ` : ${r.note}` : ''}`);
    lines.push('');
  }
  lines.push(
    'Instructions:',
    instructions,
    '',
    'After generation, copy the resulting image file into the current working directory with the file name result.png.',
    'The working directory must contain exactly 1 new image file when you are done.',
    'Do not modify the files under references/ - they are inputs only.',
    '',
    'Do not ask for confirmation. Proceed directly with generation and file placement, then stop.',
  );
  return lines.join('\n');
}

async function imagesIn(dir, since, deep) {
  const out = [];
  const walk = async (d, depth) => {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (deep && depth < 4) await walk(p, depth + 1); continue; }
      if (!IMAGE_RE.test(e.name)) continue;
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.mtimeMs >= since) out.push({ file: p, mtime: st.mtimeMs });
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.file);
}

export function explain(code, stderr, stdout) {
  const text = `${stderr}\n${stdout}`;
  if (/usage_limit_reached|TooManyRequests|\b429\b/i.test(text)) return 'ChatGPT のプランの利用枠に当たりました。時間を置いてから、もう一度試してください。';
  if (/is not recognized as an internal or external command|command not found|認識されていません/i.test(text) || code === 9009 || code === 127) return 'Codex CLI が見つかりません。npm install -g @openai/codex で入れて、codex login を済ませてください。';
  if (/Missing bearer|\b401\b|not logged in|codex login/i.test(text)) return 'Codex にログインしていません。codex login を済ませてから、もう一度試してください。';
  const tail = text.trim().split('\n').slice(-6).join('\n').slice(-600);
  return `Codex が失敗しました（終了コード ${code}）。\n${tail}`;
}

/**
 * 1 枚作る。workDir は空のフォルダ（このあと prompt.txt・codex-output.txt・references/ が残る）。
 * references: [{ name, file, note }]。返すのはできた絵のファイルの場所。
 */
export async function generate({ workDir, prompt, references, command = 'codex', timeoutSeconds = 600, dryRun = false }) {
  const ran = await exec({ workDir, prompt, references, command, timeoutSeconds, dryRun });
  if (!ran) return null;
  const { code, stdout, stderr, started } = ran;
  const named = path.join(workDir, 'result.png');
  let found = fs.existsSync(named) ? named : (await imagesIn(workDir, started - 2000, false))[0];
  if (!found) {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    found = (await imagesIn(path.join(home, 'generated_images'), started - 2000, true))[0];
  }
  if (!found) {
    if (code !== 0 || /usage_limit_reached|Missing bearer/i.test(stderr + stdout)) throw new Error(explain(code, stderr, stdout));
    throw new Error(`Codex は終わりましたが、絵が見つかりません。記録：${workDir}`);
  }
  return found;
}

/**
 * 絵ではなく、JSON のファイルを 1 つ書いてもらう（形の配置など）。workDir に resultName ができる。
 * references: [{ name, file, note }]（絵でも文でもよい）。返すのは読み込んだ中身。dryRun なら null。
 */
export async function askJson({ workDir, prompt, references, resultName = 'result.json', command = 'codex', timeoutSeconds = 600, dryRun = false }) {
  const ran = await exec({ workDir, prompt, references, command, timeoutSeconds, dryRun });
  if (!ran) return null;
  const { code, stdout, stderr } = ran, file = path.join(workDir, resultName);
  if (!fs.existsSync(file)) {
    if (code !== 0 || /usage_limit_reached|Missing bearer/i.test(stderr + stdout)) throw new Error(explain(code, stderr, stdout));
    throw new Error(`Codex は終わりましたが、${resultName} が見つかりません。記録：${workDir}`);
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${resultName} が JSON として読めません（${e.message}）。記録：${workDir}`); }
}

// Codex を 1 回動かす。作業フォルダに prompt.txt・references/・codex-output.txt が残る。dryRun なら用意だけして null
async function exec({ workDir, prompt, references, command = 'codex', timeoutSeconds = 600, dryRun = false }) {
  const refDir = path.join(workDir, 'references');
  await fsp.mkdir(refDir, { recursive: true });
  for (const r of references) await fsp.copyFile(r.file, path.join(refDir, r.name));
  await fsp.writeFile(path.join(workDir, 'prompt.txt'), prompt);
  if (dryRun) return null;
  // 作業フォルダで起動するので、./xxx のような道は、ここで今いる所からの道に直す
  if (/[\\/]/.test(command)) command = path.resolve(command);

  const env = { ...process.env };
  delete env.OPENAI_API_KEY; // API の課金ではなく、ログインしているプランの利用枠で動かす
  const started = Date.now();
  const timeoutMs = Math.max(30, timeoutSeconds) * 1000;
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = launch(command, ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check'], { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const keep = (s, chunk) => (s + chunk).slice(-20000);
    child.stdout.on('data', (c) => { out = keep(out, c); process.stdout.write('.'); });
    child.stderr.on('data', (c) => { err = keep(err, c); });
    const timer = setTimeout(() => { stop(child); reject(new Error(`Codex が ${timeoutSeconds} 秒たっても終わらないので止めました（${workDir}）`)); }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `Codex CLI（${command}）が見つかりません。npm install -g @openai/codex で入れて、codex login を済ませてください` : `Codex を起動できません：${e.message}`));
    });
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, stdout: out, stderr: err }); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
  process.stdout.write('\n');
  await fsp.writeFile(path.join(workDir, 'codex-output.txt'), `exit ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`).catch(() => {});

  return { code, stdout, stderr, started };
}
