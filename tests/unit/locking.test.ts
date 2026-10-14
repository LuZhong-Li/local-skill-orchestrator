import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetLocks, withLock, withProcessLock } from '../../kernel/store/locking/index.ts';
import { KernelError } from '../../kernel/store/errors.ts';
import { CODES } from '../../kernel/store/contract.ts';

test('S-04 同一 key 的调用串行执行', async () => {
  resetLocks();
  const order: string[] = [];
  const first = withLock('k', async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('first-end');
  });
  const second = withLock('k', () => {
    order.push('second');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('S-04 不同 key 之间互不阻塞', async () => {
  resetLocks();
  const order: string[] = [];
  await Promise.all([
    withLock('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a');
    }),
    withLock('b', () => {
      order.push('b');
    }),
  ]);
  assert.equal(order[0], 'b', '未被占用的 key 应先完成');
});

test('S-04 前序任务失败不阻塞后续排队', async () => {
  resetLocks();
  const failing = withLock('k', () => {
    throw new Error('boom');
  });
  const following = withLock('k', () => 'ok');
  await assert.rejects(failing);
  assert.equal(await following, 'ok');
});

test('S-04 值传递与返回正常', async () => {
  resetLocks();
  assert.equal(await withLock('x', () => 42), 42);
});

test('S-04 跨进程锁在一期返回明确错误而非静默降级', () => {
  assert.throws(
    () => withProcessLock(),
    (error: unknown) => error instanceof KernelError && error.code === CODES.LOCK_FAILED,
  );
});
