// 穴を、手元の PC の画像生成モデル（Stable Diffusion の inpainting など）で描き足す。ChatGPT の利用枠は使わない。
// LucidDreamer が穴埋めに Stable Diffusion を使うのと同じ役目。モデルの用意は docs/local-inpaint.md。
//
// 呼ぶ相手（コマンド）との約束：
//   <コマンド> <穴の絵.png> <出す絵.png> <仕事.json>
//   穴の絵   : 描く所が真のマゼンタ（#FF00FF）の RGB の絵
//   出す絵   : 同じ大きさの PNG（穴の外は、こちらで元の絵に戻すので何でもよい。位置だけは 1 画素もずらさない）
//   仕事.json: { style, hint, width, height, model?, seed?, init?, strength? }。style は画風（英語の名詞句）、hint は穴に描く物の指示。
//              init（絵）があるときは、穴の中をその絵から strength（0〜1）の強さで描き直す（別視点の絵の、点描の細かさを戻す仕上げ）
//   終了コード 0 で成功。失敗は 0 以外と、標準エラーに理由
// コマンドが wsl で始まるとき（Windows から WSL の中のモデルを呼ぶ）は、ファイルの場所を /mnt/c/... の形に直して渡す。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WIN = process.platform === 'win32';
const isWsl = (command) => /^\s*"?wsl(\.exe)?"?(\s|$)/i.test(command);
/** Windows の場所（C:\a\b）を WSL の中の場所（/mnt/c/a/b）に直す。 */
export function wslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
}

/** 既定のコマンド：PC 側の用意（/opt/psf-ext/inpaint/run.sh）をそのまま呼ぶ。Windows では WSL 越し。 */
export const defaultCommand = () => (WIN ? 'wsl -- /opt/psf-ext/inpaint/run.sh' : '/opt/psf-ext/inpaint/run.sh');

// コマンドを 1 回動かす。files はコマンドに渡すファイルの場所（WSL 越しなら /mnt/c/... に直す）。out ができていなければ失敗。
export async function runCommand({ command, files, out, workDir, timeoutSeconds = 3600, label = 'PC の生成モデル', doc = 'docs/local-inpaint.md', envName = 'PSF_INPAINT', logName = 'local-output.txt' }) {
  fs.rmSync(out, { force: true });
  const conv = WIN && isWsl(command) ? wslPath : (p) => p;
  const line = `${command} ${files.map((p) => `"${conv(p)}"`).join(' ')}`;
  const { code, stderr, stdout } = await new Promise((resolve, reject) => {
    const child = spawn(line, { cwd: workDir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', so = '';
    child.stdout.on('data', (c) => { so = (so + c).slice(-20000); process.stdout.write(String(c).replace(/\r/g, '\n')); });
    child.stderr.on('data', (c) => { err = (err + c).slice(-20000); });
    const timer = setTimeout(() => {
      if (WIN && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else child.kill();
      reject(new Error(`${label}が ${timeoutSeconds} 秒たっても終わらないので止めました（${workDir}）`));
    }, Math.max(30, timeoutSeconds) * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${label}を起動できません：${e.message}`)); });
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, stderr: err, stdout: so }); });
  });
  fs.writeFileSync(path.join(workDir, logName), `${line}\nexit ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  if (code !== 0 || !fs.existsSync(out)) {
    const text = `${stderr}\n${stdout}`, tail = text.trim().split('\n').slice(-6).join('\n').slice(-600);
    if (code === 127 || code === 9009 || /No such file or directory|not found|認識されていません|is not recognized/i.test(text)) {
      throw new Error(`${label}の用意が見つかりません（${command}）。${doc} の手順で用意するか、環境変数 ${envName} に呼び出すコマンドを入れてください。\n${tail}`);
    }
    if (/out of memory|CUDA error|device not ready/i.test(text)) throw new Error(`${label}が、GPU のメモリ不足か GPU のエラーで止まりました。\n${tail}`);
    throw new Error(`${label}が失敗しました（終了コード ${code}）。\n${tail}`);
  }
  return out;
}

/**
 * 1 枚描いてもらう。返すのはできた絵（workDir/<outName>）の場所。
 * job = { style, hint, width, height, model?, seed?, init?, strength? }。init（絵のファイル）があると、穴の中をその絵から描き直す（仕上げ）
 */
export async function localInpaint({ command, workDir, holesFile, job, timeoutSeconds = 3600, outName = 'result.png' }) {
  const out = path.join(workDir, outName), jobFile = path.join(workDir, outName === 'result.png' ? 'job.json' : outName.replace(/\.png$/, '-job.json'));
  const conv = WIN && isWsl(command) ? wslPath : (p) => p;
  fs.writeFileSync(jobFile, JSON.stringify({ ...job, ...(job.init ? { init: conv(job.init) } : {}) }, null, 1));
  return runCommand({ command, files: [holesFile, out, jobFile], out, workDir, timeoutSeconds, logName: `${path.basename(jobFile, '.json')}-output.txt` });
}
