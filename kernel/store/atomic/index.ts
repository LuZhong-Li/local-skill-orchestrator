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
import { CODES } from '@skill-manager/contract';

export interface AtomicWriteOptions {
  /** 注入点：写入临时文件之后、替换目标之前调用，用于测试中断路径 */
  onBeforeRename?: (tempPath: string) => void;
}

export interface RenameRetryOptions {
  /** 最大尝试次数（含首次），默认 5 */
  attempts?: number;
  /** 线性退避的基础间隔，默认 10ms */
  backoffMs?: number;
  /** 注入点：测试重试与耗尽路径 */
  rename?: (from: string, to: string) => void;
  /** 注入点：测试退避序列，默认 Atomics.wait */
  sleep?: (ms: number) => void;
}

/** 替换目标的重试次数；仅用于消除瞬时占用，不掩盖真实占用 */
const RENAME_ATTEMPTS = 5;
/** 重试的基础间隔，按尝试次数线性退避 */
const RENAME_BACKOFF_MS = 10;

/**
 * 替换目标文件或目录。
 *
 * 在 Windows 上换名文件或目录时，可能瞬时失败并报 EPERM、EACCES 或 EBUSY——
 * 通常是安全软件或索引服务短暂持有目标文件，与目标是否真的不可写无关。
 * 这类瞬时失败在有限次数内重试即可消除；重试用尽后仍原样抛出，
 * 真实占用不会被掩盖。目录移动同样走本函数，避免 adopt / accept / clean
 * 绕过退避策略。
 */
export function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): void {
  const {
    attempts = RENAME_ATTEMPTS,
    backoffMs = RENAME_BACKOFF_MS,
    rename = renameSync,
    sleep = sleepSync,
  } = options;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || attempt === attempts) throw error;
      sleep(backoffMs * attempt);
    }
  }
  throw new Error('rename retry exhausted');
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/** 同步等待：本函数位于同步写入路径，用 Atomics.wait 阻塞而不空转 CPU */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
    renameWithRetry(tempPath, targetPath);
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
