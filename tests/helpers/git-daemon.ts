import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** 取一个空闲端口：绑定 0 后立即释放，git daemon 需要显式端口。 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port <= 0) throw new Error('无法取得空闲端口');
  return port;
}

/** 起回环 git daemon；Windows 用 taskkill /T，POSIX 用独立进程组。 */
export async function startGitDaemon(basePath: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    'git',
    [
      'daemon',
      '--reuseaddr',
      '--export-all',
      `--base-path=${basePath}`,
      `--port=${port}`,
      '--listen=127.0.0.1',
    ],
    { stdio: 'ignore', detached: process.platform !== 'win32' },
  );
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = () => {
      const probe = spawnSync(process.execPath, [
        '-e',
        `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`,
      ]);
      if (probe.status === 0) return resolve();
      if (Date.now() > deadline) return reject(new Error('git daemon 未在 10 秒内就绪'));
      setTimeout(attempt, 100);
    };
    attempt();
  });
  return child;
}

export function stopGitDaemon(child: { pid?: number } | null): void {
  if (child?.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // 已退出
  }
}
