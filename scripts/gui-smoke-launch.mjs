/** GUI 冒烟进程收尾：结束 Electron/daemon 的整个进程树。 */
import { spawn } from 'node:child_process';

export function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}
