/**
 * S-04 文件锁。
 *
 * 一期为单进程运行，进程内互斥即可满足需求；跨进程锁保留接口未实现，
 * 调用 withLock 的跨进程模式会返回 E-LOCK-001 而不是静默降级。
 */
import { KernelError } from '../errors.ts';
import { CODES } from '@skill-manager/contract';

const chains = new Map<string, Promise<unknown>>();

/**
 * 以 key 为粒度的进程内互斥执行。
 * 同一 key 的调用串行执行，不同 key 互不阻塞。
 */
export async function withLock<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => task(),
    () => task(),
  );
  // 记录链尾，且不因前序失败而中断后续排队
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  try {
    return await run;
  } finally {
    if (chains.get(key) === settled) chains.delete(key);
  }
}

/** 跨进程锁接口占位：一期未实现 */
export function withProcessLock(): never {
  throw new KernelError({
    code: CODES.LOCK_FAILED,
    message: '跨进程锁在一期未实现',
    source: 'locking',
    remedy: '一期只支持单进程运行；如需并发运行，请等待跨进程锁落地',
  });
}

/** 仅供测试使用：清空锁链 */
export function resetLocks(): void {
  chains.clear();
}
