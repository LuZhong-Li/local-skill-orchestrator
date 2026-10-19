import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs = new Set<string>();

/** 创建受控临时目录；进程退出时统一清理，测试也可显式调用 cleanupTempDirs。 */
export function makeTempDir(prefix = 'sm-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

export function tempDirCount(): number {
  return tempDirs.size;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // 进程退出清理不得因单个目录占用而抛出；显式 cleanup 的测试可自行断言。
    }
  }
  tempDirs.clear();
}

process.once('exit', cleanupTempDirs);
