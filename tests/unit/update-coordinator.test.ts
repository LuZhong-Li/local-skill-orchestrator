import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UPDATE_SETTINGS,
  PERIODIC_CHECK_INTERVAL_MS,
  UpdateCoordinator,
  UpdateSettingsStore,
  type UpdateBridge,
  type UpdateSettings,
  type UpdateTimers,
} from '../../gui/main/updates/index.ts';
import type { KernelResult } from '../../gui/bridge/kernel.ts';

const START = Date.UTC(2026, 9, 17, 8, 0, 0);

function inspectResult(id: string): KernelResult {
  return {
    ok: true,
    command: 'inspect',
    findings: [],
    changes: [],
    exit_code: 0,
    data: {
      source: {
        type: 'git',
        url: `https://example.com/${id}.git`,
        ref: 'v1.0.0',
      },
      meta: { version: '1.0.0' },
      record: { checksum: `sha256:${id}` },
      checksum: { recorded: `sha256:${id}`, recomputed: `sha256:${id}`, match: true },
    },
  };
}

function listResult(ids: string[]): KernelResult {
  return {
    ok: true,
    command: 'list',
    findings: [],
    changes: [],
    exit_code: 0,
    data: { initialized: true, records: ids.map((id) => ({ id })) },
  };
}

function fakeBridge(ids = ['alpha']): UpdateBridge & {
  executeCalls: string[][];
  inspectCalls: string[];
} {
  const executeCalls: string[][] = [];
  const inspectCalls: string[] = [];
  return {
    executeCalls,
    inspectCalls,
    list: async () => listResult(ids),
    inspect: async (id) => {
      inspectCalls.push(id);
      return inspectResult(id);
    },
    execute: async (argv) => {
      executeCalls.push(argv);
      return {
        ok: true,
        command: 'update',
        findings: [],
        changes: [],
        exit_code: 0,
        data: { id: argv[1] },
      };
    },
  };
}

function memoryStore(
  initial: UpdateSettings = DEFAULT_UPDATE_SETTINGS,
  writes: string[] = [],
): { store: UpdateSettingsStore; writes: string[] } {
  let text: string | null = JSON.stringify(initial);
  return {
    writes,
    store: new UpdateSettingsStore('C:/tmp/settings.json', {
      readText: () => text,
      writeText: (next) => {
        text = next;
        writes.push(next);
      },
    }),
  };
}

function fakeTimers(): UpdateTimers & {
  callback: (() => void) | null;
  delay: number | null;
  cleared: number;
} {
  const timers = {
    callback: null as (() => void) | null,
    delay: null as number | null,
    cleared: 0,
    setInterval(callback: () => void, delay: number): unknown {
      timers.callback = callback;
      timers.delay = delay;
      return 7;
    },
    clearInterval(): void {
      timers.cleared += 1;
    },
  };
  return timers;
}

function coordinator(options: {
  bridge?: ReturnType<typeof fakeBridge>;
  settings?: UpdateSettings;
  timers?: ReturnType<typeof fakeTimers>;
  now?: () => number;
  notify?: (report: unknown) => void;
  probe?: () => Promise<{
    ok: true;
    tags: Array<{ tag: string; commit: string; peeled: boolean }>;
  }>;
}) {
  const bridge = options.bridge ?? fakeBridge();
  const timers = options.timers ?? fakeTimers();
  const memory = memoryStore(options.settings ?? DEFAULT_UPDATE_SETTINGS);
  const notifications: unknown[] = [];
  const instance = new UpdateCoordinator({
    bridge,
    settings: memory.store,
    timers,
    now: options.now ?? (() => START),
    notify: options.notify ?? ((report) => notifications.push(report)),
    probe:
      options.probe ??
      (async () => ({
        ok: true,
        tags: [
          {
            tag: 'v1.0.0',
            commit: '1111111111111111111111111111111111111111',
            peeled: false,
          },
          {
            tag: 'v1.1.0',
            commit: '2222222222222222222222222222222222222222',
            peeled: false,
          },
        ],
      })),
  });
  return { instance, bridge, timers, memory, notifications };
}

test('T2 设置：默认关闭；读取不写盘，切换开关才写 settings.json', () => {
  const writes: string[] = [];
  const { store } = memoryStore(DEFAULT_UPDATE_SETTINGS, writes);
  assert.deepEqual(store.read(), {
    periodic_check_enabled: false,
    instant_check_enabled: false,
    language: { mode: 'system', value: 'zh-CN' },
  });
  assert.equal(writes.length, 0, '读取设置不得写盘');

  store.set({ periodic_check_enabled: true, instant_check_enabled: false });
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]!), {
    periodic_check_enabled: true,
    instant_check_enabled: false,
    language: { mode: 'system', value: 'zh-CN' },
  });
});

test('T2 调度：定期默认关闭时不注册定时器、不检查', async () => {
  const { instance, timers, bridge } = coordinator({});
  await instance.start();
  assert.equal(timers.delay, null);
  assert.deepEqual(bridge.inspectCalls, []);
  assert.equal(bridge.executeCalls.length, 0);
});

test('T2 调度：开启定期后固定 6 小时；触发只提示、不执行 update', async () => {
  let now = START;
  const { instance, timers, bridge, notifications } = coordinator({
    settings: { periodic_check_enabled: true, instant_check_enabled: false },
    now: () => now,
  });
  await instance.start();
  assert.equal(timers.delay, PERIODIC_CHECK_INTERVAL_MS);
  assert.equal(PERIODIC_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.deepEqual(bridge.inspectCalls, [], '启动时不立即检查');

  now += PERIODIC_CHECK_INTERVAL_MS;
  timers.callback?.();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(bridge.inspectCalls, ['alpha']);
  assert.equal(notifications.length, 1, '有可更新项时产生一次提示');
  assert.equal(bridge.executeCalls.length, 0, '定期路径绝不执行 update');
});

test('T2 调度：stop 清除定时器；停止后的旧回调不再发起检查', async () => {
  const { instance, timers, bridge } = coordinator({
    settings: { periodic_check_enabled: true, instant_check_enabled: false },
  });
  await instance.start();
  const callback = timers.callback;
  instance.stop();
  assert.equal(timers.cleared, 1);
  callback?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridge.inspectCalls, []);
});

test('T2 调度：即时检查开关默认关；开启后启动时只检查一次且不执行', async () => {
  const { instance, bridge } = coordinator({
    settings: { periodic_check_enabled: false, instant_check_enabled: true },
  });
  await instance.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridge.inspectCalls, ['alpha']);
  assert.equal(bridge.executeCalls.length, 0);
  instance.stop();
});

test('T2 检查：手动检查走 list→inspect，设置文件零写入；失败结果可读且不抛异常', async () => {
  const { instance, bridge, memory } = coordinator({});
  const report = await instance.checkNow('manual');
  assert.equal(report.command, 'update-check');
  assert.equal(report.data.items[0]?.state, 'update-available');
  assert.deepEqual(bridge.inspectCalls, ['alpha']);
  assert.equal(memory.writes.length, 0, '检查动作本身不得写设置文件');

  const failing = coordinator({});
  failing.bridge.list = async () => {
    throw new Error('离线');
  };
  const failed = await failing.instance.checkNow('manual');
  assert.equal(failed.ok, false);
  assert.match(failed.findings[0]?.message ?? '', /离线/);
  instance.stop();
});

test('T2 执行：确认后的专用通道只调用既有 update <id> --yes', async () => {
  const { instance, bridge } = coordinator({});
  const result = await instance.executeConfirmed('alpha');
  assert.equal(result.ok, true);
  assert.deepEqual(bridge.executeCalls, [['update', 'alpha']]);
});

test('T3 执行：确认后的远端目标通过 --ref 交给既有 update 通道', async () => {
  const { instance, bridge } = coordinator({});
  const result = await instance.executeConfirmed('alpha', 'v1.1.0');
  assert.equal(result.ok, true);
  assert.deepEqual(bridge.executeCalls, [['update', 'alpha', '--ref', 'v1.1.0']]);
});

test('T2 设置切换：开启定期登记 6h 调度并写入一次；关闭即清除', async () => {
  const { instance, timers, memory } = coordinator({});
  await instance.start();
  const enabled = await instance.setSettings({ periodic_check_enabled: true });
  assert.equal(enabled.periodic_check_enabled, true);
  assert.equal(memory.writes.length, 1);
  assert.equal(timers.delay, PERIODIC_CHECK_INTERVAL_MS);

  await instance.setSettings({ periodic_check_enabled: false });
  assert.equal(memory.writes.length, 2);
  assert.equal(timers.cleared, 1);
});
