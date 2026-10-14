/**
 * S-03 原子写入与事务。
 *
 * 步骤：写入同目录下的临时文件 → 刷盘 → 原子替换目标 → 失败时清理临时文件。
 * 临时文件与目标同目录，保证换名在同一个文件系统内完成，避免跨设备换名失败。
 */
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KernelError } from '../errors.ts';
import { CODES } from '../contract.ts';

export interface AtomicWriteOptions {
  /** 注入点：写入临时文件之后、替换目标之前调用，用于测试中断路径 */
  onBeforeRename?: (tempPath: string) => void;
}

/**
 * 原子写入文本内容。失败时清理临时文件并抛出 E-IO-002，
 * 目标文件保持调用前的状态，不产生半写内容。
 */
export function atomicWriteFile(
  targetPath: string,
  content: string,
  options: AtomicWriteOptions = {},
): void {
  const tempPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
  let handle: number | undefined;
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    handle = openSync(tempPath, 'r+');
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    options.onBeforeRename?.(tempPath);
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // 关闭失败不影响后续清理
      }
    }
    rmSync(tempPath, { force: true });
    throw new KernelError({
      code: CODES.IO_ATOMIC_FAILED,
      message: `原子写入失败：${error instanceof Error ? error.message : String(error)}`,
      source: 'atomic',
      target: targetPath,
      remedy: '请检查目标目录是否可写，并确认磁盘空间充足；目标文件未被改动',
      cause: error,
    });
  }
}
