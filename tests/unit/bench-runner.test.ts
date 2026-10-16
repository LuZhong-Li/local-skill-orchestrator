import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { parseArgs, runOnce } from '../../scripts/bench/runner.mjs';
import { createSamplerSession } from '../../scripts/bench/rss.mjs';

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  stdout: Readable;
  stderr: Readable;
  kill(): void;
}

/** 假子进程：可控制延迟与退出码，用于驱动 runOnce 的编排分支 */
function fakeChild(
  options: { pid?: number; exitCode?: number; delayMs?: number; stdout?: string } = {},
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = options.pid ?? 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = Readable.from(options.stdout === undefined ? [] : [options.stdout]);
  child.stderr = Readable.from([]);
  child.kill = () => {
    child.exitCode = 137;
  };
  setTimeout(() => {
    child.exitCode = options.exitCode ?? 0;
    child.emit('close', child.exitCode);
  }, options.delayMs ?? 1);
  return child;
}

function fakeSpawn(child: FakeChild) {
  return (() =>
    child as unknown as ChildProcess) as unknown as typeof import('node:child_process').spawn;
}

test('T1 编排：墙钟含进程启动、退出码与采样结论逐项落到样本', async () => {
  const times = [1000, 1250];
  let index = 0;
  const samplerInputs: Array<{ pid: number; aliveAtStart: boolean }> = [];
  const child = fakeChild({ exitCode: 0, delayMs: 5 });
  const result = await runOnce({
    command: 'kernel',
    args: ['scan'],
    spawnChild: fakeSpawn(child),
    now: () => times[Math.min(index++, times.length - 1)],
    sampler: {
      begin: (pid: number, { isAlive }: { isAlive: () => boolean }) => {
        samplerInputs.push({ pid, aliveAtStart: isAlive() });
        return {
          finish: async () => ({ ok: true, peakMb: 231.4, cpuMs: 640, samples: 12, reason: null }),
        };
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.wall_ms, 250, '墙钟 = 退出时刻 − spawn 时刻');
  assert.equal(result.exit_code, 0);
  assert.equal(result.peak_rss_mb, 231.4);
  assert.equal(result.rss_ok, true);
  assert.equal(result.rss_samples, 12);
  assert.equal(result.rss_reason, null);
  assert.equal(result.cpu_time_ms, 640);
  assert.equal(result.fs_observation, null, '未要求 fs 观测时不产生观测结果');
  assert.deepEqual(samplerInputs, [{ pid: 4242, aliveAtStart: true }], '采样器拿到 pid 且进程存活');
});

test('T1 编排：采样失败（无 READY）与非零退出码都如实记录，不静默兜底', async () => {
  const child = fakeChild({ exitCode: 7, delayMs: 5 });
  const result = await runOnce({
    command: 'kernel',
    args: ['--version'],
    spawnChild: fakeSpawn(child),
    sampler: {
      begin: () => ({
        finish: async () => ({
          ok: false,
          peakMb: null,
          cpuMs: null,
          samples: 0,
          reason: 'no-sample-before-exit',
        }),
      }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.exit_code, 7, '非零退出码原样记录');
  assert.equal(result.rss_ok, false);
  assert.equal(result.peak_rss_mb, null, '失败时绝不用 0 兜底');
  assert.equal(result.rss_reason, 'no-sample-before-exit');
  assert.equal(result.wall_ms >= 0, true);
});

test('T1 编排：fs 观测在运行期并行推进（注入 readSize / 时钟）', async () => {
  const child = fakeChild({ delayMs: 30 });
  let polls = 0;
  const result = await runOnce({
    command: 'kernel',
    args: ['scan'],
    spawnChild: fakeSpawn(child),
    sampler: {
      begin: () => ({
        finish: async () => ({ ok: true, peakMb: 10, cpuMs: 1, samples: 1, reason: null }),
      }),
    },
    watch: {
      readStat: () => {
        polls += 1;
        // 第一次为基线（空索引），随后一次性重写并保持稳定
        return polls === 1 ? { size: 170, mtimeMs: 1000 } : { size: 40213, mtimeMs: 2000 };
      },
      pollMs: 5,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(result.fs_observation !== null, '运行期观测到索引写入');
  assert.equal(result.fs_observation.reason, null);
  assert.ok(result.fs_observation.changed_ms !== null && result.fs_observation.stable_ms !== null);
});

test('T1 编排：真机独立进程断言（真实采样器 + 真实子进程，内存确实被量到）', async () => {
  const child = [
    'const keep = Buffer.alloc(96 * 1024 * 1024, 7);',
    'if (keep.length !== 96 * 1024 * 1024) process.exit(3);',
    'setTimeout(() => process.exit(0), 250);',
  ].join('');
  const session = createSamplerSession({ platform: process.platform });
  try {
    const warmed = await session.warmup();
    assert.equal(warmed.ok, true, `预热采样应成功（原因：${String(warmed.reason)}）`);
    const result = await runOnce({
      command: process.execPath,
      args: ['-e', child],
      sampler: session,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.rss_ok, true, `真实采样应成功（原因：${String(result.rss_reason)}）`);
    assert.ok(
      typeof result.peak_rss_mb === 'number' && result.peak_rss_mb > 60,
      `应量到已分配的 96 MB（实测 ${String(result.peak_rss_mb)} MB）`,
    );
    assert.ok(result.wall_ms >= 200, `墙钟应覆盖子进程存活期（实测 ${String(result.wall_ms)} ms）`);
    assert.ok(result.rss_samples >= 1);
  } finally {
    await session.close();
  }
});

test('T1 参数解析：默认值、多档位、非法取值与未知选项', () => {
  const defaults = parseArgs([]);
  assert.deepEqual(defaults.sizes, [100]);
  assert.equal(defaults.form, 'source');
  assert.equal(defaults.runs, null);
  assert.equal(defaults.profile, null);

  const multi = parseArgs([
    '--n',
    '100,1000 5000',
    '--form',
    'both',
    '--runs',
    '2',
    '--no-profile',
  ]);
  assert.deepEqual(multi.sizes, [100, 1000, 5000]);
  assert.equal(multi.form, 'both');
  assert.equal(multi.runs, 2);
  assert.equal(multi.profile, false);

  assert.throws(() => parseArgs(['--n', '0']), /--n 必须是正整数/);
  assert.throws(() => parseArgs(['--form', 'docker']), /--form 只支持/);
  assert.throws(() => parseArgs(['--runs']), /缺少取值/);
  assert.throws(() => parseArgs(['--bogus']), /未知选项/);
});

test('T1 编排：spawn 选项固定（独立进程、无 shell、隐藏窗口）', async () => {
  const seen: Array<{ command: string; options: SpawnOptions }> = [];
  const child = fakeChild({ exitCode: 0, delayMs: 1 });
  await runOnce({
    command: 'kernel',
    args: ['scan'],
    spawnChild: ((command: string, _args: string[], options: SpawnOptions) => {
      seen.push({ command, options });
      return child as unknown as ChildProcess;
    }) as unknown as typeof import('node:child_process').spawn,
    sampler: {
      begin: () => ({
        finish: async () => ({ ok: true, peakMb: 1, cpuMs: null, samples: 1, reason: null }),
      }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'kernel');
  assert.equal(seen[0].options.shell, undefined, '不经 shell 启动');
  assert.equal(seen[0].options.windowsHide, true);
  assert.deepEqual(seen[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});
