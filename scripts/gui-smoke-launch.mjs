/** GUI 冒烟进程收尾：结束 Electron/daemon 的整个进程树。 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

/** 读取可能尚未写回的文件；失败时返回调用方给定的占位值。 */
export function readTextOrFallback(path, fallback) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}
