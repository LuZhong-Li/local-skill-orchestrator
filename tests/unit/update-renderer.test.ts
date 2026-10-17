import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useKernel } from '../../gui/renderer/src/composables/useKernel.ts';
import { runSequentialUpdates } from '../../gui/renderer/src/update-runner.ts';
import { updateItemView } from '../../gui/renderer/src/update-presentation.ts';
import type { KernelResult, UpdateCheckItem } from '../../gui/renderer/src/types.ts';

function result(command: string, ok = true): KernelResult {
  return { ok, command, findings: [], changes: [], exit_code: ok ? 0 : 1 };
}

test('T2 确认：取消后 update 执行通道调用次数为 0', async () => {
  const calls: string[][] = [];
  const original = globalThis.window;
  globalThis.window = {
    skillManager: {
      invoke: async () => result('list'),
      preview: async () => ({ ...result('update'), preview: true }),
      execute: async (argv: string[]) => {
        calls.push(argv);
        return result('update');
      },
      describe: async () => ({ workspace: 'C:/tmp/ws' }),
      updates: {
        check: async () => ({}),
        getSettings: async () => ({}),
        setSettings: async () => ({}),
        update: async (id: string) => {
          calls.push(['update', id]);
          return result('update');
        },
        latest: async () => null,
        onReport: () => () => undefined,
      },
    },
  } as unknown as Window;

  try {
    const kernel = useKernel();
    const pending = kernel.runWithConfirm(['update', 'alpha'], '更新 alpha');
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(kernel.pendingConfirm.value, null);
    kernel.answerConfirm(false);
    const outcome = await pending;
    assert.equal(outcome, null);
    assert.deepEqual(calls, [], '用户取消时不得触碰 update 执行通道');
  } finally {
    globalThis.window = original;
  }
});

test('T2 确认：批准后 update 走专用通道，且仍由既有 preview→confirm→execute 驱动', async () => {
  const generic: string[][] = [];
  const updates: string[] = [];
  const original = globalThis.window;
  globalThis.window = {
    skillManager: {
      invoke: async () => result('list'),
      preview: async () => ({ ...result('update'), preview: true }),
      execute: async (argv: string[]) => {
        generic.push(argv);
        return result('update');
      },
      describe: async () => ({ workspace: 'C:/tmp/ws' }),
      updates: {
        check: async () => ({}),
        getSettings: async () => ({}),
        setSettings: async () => ({}),
        update: async (id: string) => {
          updates.push(id);
          return result('update');
        },
        latest: async () => null,
        onReport: () => () => undefined,
      },
    },
  } as unknown as Window;

  try {
    const kernel = useKernel();
    const pending = kernel.runWithConfirm(['update', 'alpha'], '更新 alpha');
    await new Promise((resolve) => setImmediate(resolve));
    kernel.answerConfirm(true);
    const outcome = await pending;
    assert.equal(outcome?.ok, true);
    assert.deepEqual(updates, ['alpha']);
    assert.deepEqual(generic, [], '不得绕过 updates:update 通道');
  } finally {
    globalThis.window = original;
  }
});

test('T3 确认：目标标签经专用通道传递到主进程 update', async () => {
  const updates: Array<[string, string | undefined]> = [];
  const original = globalThis.window;
  globalThis.window = {
    skillManager: {
      invoke: async () => result('list'),
      preview: async () => ({ ...result('update'), preview: true }),
      execute: async () => result('update'),
      describe: async () => ({ workspace: 'C:/tmp/ws' }),
      updates: {
        check: async () => ({}),
        getSettings: async () => ({}),
        setSettings: async () => ({}),
        update: async (id: string, ref?: string) => {
          updates.push([id, ref]);
          return result('update');
        },
        latest: async () => null,
        onReport: () => () => undefined,
      },
    },
  } as unknown as Window;

  try {
    const kernel = useKernel();
    const pending = kernel.runWithConfirm(['update', 'alpha', '--ref', 'v1.1.0'], '更新 alpha');
    await new Promise((resolve) => setImmediate(resolve));
    kernel.answerConfirm(true);
    await pending;
    assert.deepEqual(updates, [['alpha', 'v1.1.0']]);
  } finally {
    globalThis.window = original;
  }
});

test('T2 插件宿主分发：update --host 必须走通用执行通道，不能丢掉 --host', async () => {
  const generic: string[][] = [];
  const updates: string[] = [];
  const original = globalThis.window;
  globalThis.window = {
    skillManager: {
      invoke: async () => result('list'),
      preview: async () => ({ ...result('update'), preview: true }),
      execute: async (argv: string[]) => {
        generic.push(argv);
        return result('update');
      },
      describe: async () => ({ workspace: 'C:/tmp/ws' }),
      updates: {
        check: async () => ({}),
        getSettings: async () => ({}),
        setSettings: async () => ({}),
        update: async (id: string) => {
          updates.push(id);
          return result('update');
        },
        latest: async () => null,
        onReport: () => () => undefined,
      },
    },
  } as unknown as Window;

  try {
    const kernel = useKernel();
    const pending = kernel.runWithConfirm(
      ['update', 'smoke-skill', '--host', 'x-smoke-tools-zed'],
      '分发 smoke-skill',
    );
    await new Promise((resolve) => setImmediate(resolve));
    kernel.answerConfirm(true);
    await pending;
    assert.deepEqual(generic, [['update', 'smoke-skill', '--host', 'x-smoke-tools-zed']]);
    assert.deepEqual(updates, []);
  } finally {
    globalThis.window = original;
  }
});

test('T2 批量执行：单条失败不阻断后续条目，取消停止剩余条目', async () => {
  const failure = await runSequentialUpdates(['a', 'b', 'c'], async (id) => {
    if (id === 'b') return { cancelled: false, result: result('update', false) };
    return { cancelled: false, result: result('update') };
  });
  assert.deepEqual(
    failure.map((item) => [item.id, item.status]),
    [
      ['a', 'ok'],
      ['b', 'failed'],
      ['c', 'ok'],
    ],
  );

  const cancel = await runSequentialUpdates(['a', 'b', 'c'], async (id) => ({
    cancelled: id === 'b',
    result: result('update'),
  }));
  assert.deepEqual(
    cancel.map((item) => [item.id, item.status]),
    [
      ['a', 'ok'],
      ['b', 'cancelled'],
    ],
  );
});

test('T2 四态视图：可更新/最新/不可检查/失败均有可读标签与说明', () => {
  const base: UpdateCheckItem = {
    id: 'alpha',
    state: 'update-available',
    summary: '来源标签 v2.0.0 高于当前基线 1.0.0',
    provenance: {
      url: 'https://example.com/alpha.git',
      ref: 'v1.0.0',
      checked_at: '2026-10-17T08:00:00Z',
    },
    backup_notice: '执行前将先行备份',
    baseline_version: '1.0.0',
    available: { ref: 'v2.0.0', commit: '2'.repeat(40) },
  };
  const available = updateItemView(base);
  assert.equal(available.label, '可更新');
  assert.equal(available.canUpdate, true);
  assert.match(available.primary, /1\.0\.0.*v2\.0\.0/);

  const current = updateItemView({ ...base, state: 'up-to-date', available: undefined });
  assert.equal(current.label, '已是最新');
  assert.equal(current.canUpdate, false);

  const unknown = updateItemView({
    ...base,
    state: 'not-checkable',
    reason: 'local-source',
    summary: '不可检查：本地来源没有新版本概念，请用 update --check 查看本地漂移',
    available: undefined,
  });
  assert.equal(unknown.label, '不可检查');
  assert.match(unknown.detail, /update --check/);

  const failed = updateItemView({
    ...base,
    state: 'failed',
    code: 'E-SRC-010',
    remedy: '稍后重试',
    summary: '检查失败：远端需要认证或已限流',
    available: undefined,
  });
  assert.equal(failed.label, '检查失败');
  assert.match(failed.detail, /E-SRC-010.*认证/);
});
