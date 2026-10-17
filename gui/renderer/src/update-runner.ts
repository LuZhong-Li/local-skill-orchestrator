import type { KernelResult } from './types.ts';

export type UpdateRunStatus = 'ok' | 'failed' | 'cancelled';

export interface UpdateAttempt {
  cancelled: boolean;
  result: KernelResult | null;
}

export interface UpdateRunResult {
  id: string;
  status: UpdateRunStatus;
  message: string;
}

/**
 * 逐项执行更新；单条失败继续下一条，用户取消则停止剩余条目。
 * 每次 update 仍由调用方走既有「预览 → 确认 → --yes」链路。
 */
export async function runSequentialUpdates(
  ids: string[],
  run: (id: string) => Promise<UpdateAttempt>,
): Promise<UpdateRunResult[]> {
  const results: UpdateRunResult[] = [];
  for (const id of ids) {
    let attempt: UpdateAttempt;
    try {
      attempt = await run(id);
    } catch (error) {
      results.push({
        id,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (attempt.cancelled) {
      results.push({ id, status: 'cancelled', message: '用户取消，未执行该条更新' });
      break;
    }
    if (attempt.result === null) {
      results.push({ id, status: 'failed', message: '执行通道未返回结果' });
      continue;
    }
    results.push({
      id,
      status: attempt.result.ok ? 'ok' : 'failed',
      message: attempt.result.ok
        ? '更新完成'
        : attempt.result.findings.map((item) => item.code).join('、') || '更新失败',
    });
  }
  return results;
}
