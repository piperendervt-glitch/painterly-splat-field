// 手元の PC の外の道具（WSL に入れたモデル）を、決まった形のコマンドで呼ぶ。
//   <コマンド> <仕事.json>   終了コード 0 で成功。失敗は 0 以外と、標準エラーに理由
// Windows で、コマンドが wsl で始まるときは、仕事.json の中のファイルの場所も /mnt/c/... の形に直して渡す。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const WIN = process.platform === 'win32';
export const isWsl = (command) => WIN && /^\s*"?wsl(\.exe)?"?(\s|$)/i.test(command);

/** C:\a\b → /mnt/c/a/b（Windows の場所でなければそのまま） */
export function wslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p));
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : String(p).replace(/\\/g, '/');
}

/** 仕事の中の、名前が場所を表す値（image, mask, cutout, out_dir など）を、WSL の形に直す */
export function convertJob(job, keys) {
  const out = { ...job };
  for (const k of keys) if (typeof out[k] === 'string') out[k] = wslPath(out[k]);
  return out;
}

/**
 * コマンドを動かす。jobFile は書いてある仕事.json（WSL に渡すときは中身の場所を直してあること）。
 * 標準出力と標準エラーを logFile に残し、画面にも流す。失敗したら理由つきで投げる。
 */
export function runJob({ command, jobFile, logFile, timeoutSeconds = 7200, label = '外の道具', envName = '' }) {
  const arg = isWsl(command) ? wslPath(jobFile) : jobFile;
  const full = `${command} ${JSON.stringify(arg)}`;
  return new Promise((resolve, reject) => {
    const child = spawn(full, { shell: true, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
    let log = '';
    const add = (c) => { const s = c.toString('utf8'); log = (log + s).slice(-200000); process.stdout.write(s); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${label}が ${timeoutSeconds} 秒たっても終わらないので止めました`)); }, timeoutSeconds * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${label}（${command}）を起動できません：${e.message}${envName ? `。別のコマンドにするときは環境変数 ${envName} に入れてください` : ''}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, `${full}\nexit ${code}\n${log}`); } catch { /* 残せなくても続ける */ } }
      if (code === 0) return resolve(log);
      const last = log.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      reject(new Error(`${label}が失敗しました（終了コード ${code}）${last ? `：${last}` : ''}`));
    });
  });
}
