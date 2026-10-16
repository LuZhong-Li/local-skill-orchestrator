import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  RSS_FAILURE_REASONS,
  SAMPLE_INTERVAL_MS,
  SUPPORTED_PLATFORMS,
  collectSamples,
  createSamplerSession,
  parseHelperSample,
  parsePowerShellSample,
  parseProcStatCpuMs,
  parsePsSample,
  parseVmHwm,
  samplerSessionScript,
} from '../../scripts/bench/rss.mjs';

const VmHWM_STATUS = [
  'Name:\tnode',
  'VmPeak:\t 2500000 kB',
  'VmHWM:\t  243456 kB',
  'VmRSS:\t  241000 kB',
].join('\n');

/** 造一个「按请求吐出固定输出」的假助手：stdin 收到 pid 后异步输出该 pid 的样本行 */
function fakeHelper(script: Record<number, string[]>) {
  const stream = new PassThrough();
  return {
    stdout: stream,
    stdin: {
      write: (chunk: string) => {
        const pid = Number(String(chunk).trim().split(/\s+/)[0]);
        for (const line of script[pid] ?? []) setImmediate(() => stream.write(`${line}\n`));
        return true;
      },
      end: () => stream.end(),
    },
    kill: () => undefined,
    on: () => undefined,
  } as unknown as ChildProcess;
}

test('T1 RSS：三平台解析口径（正常 / 空 / 非法值一律不当作 0）', () => {
  assert.equal(parseVmHwm(VmHWM_STATUS), 237.8, 'Linux VmHWM 按 kB → MB');
  assert.equal(parseVmHwm('VmHWM:\t 0 kB'), null, '0 值必须判为无效采样');
  assert.equal(parseVmHwm('Name:\tnode'), null, '缺少 VmHWM 行判为无效');

  assert.deepEqual(parsePsSample('243456 0:01.23'), { peakMb: 237.8, cpuMs: 1230 });
  assert.deepEqual(parsePsSample('1048576 01:02:03.50'), { peakMb: 1024, cpuMs: 3_723_500 });
  assert.equal(parsePsSample(''), null);
  assert.equal(parsePsSample('0 0:00.00'), null, 'macOS 空读/0 必须判为无效采样');
  assert.equal(parsePsSample('not-a-number'), null);

  assert.deepEqual(parsePowerShellSample('242221056 1.5'), { peakMb: 231, cpuMs: 1500 });
  assert.equal(parsePowerShellSample('0 0'), null, 'Windows 空读/0 必须判为无效采样');
  assert.equal(parsePowerShellSample(''), null);

  const stat = '1234 (node (worker)) S 1 2 3 4 5 6 7 8 9 10 250 150 0 0 20 0 1 0 100 200';
  assert.equal(parseProcStatCpuMs(stat), 4000, 'utime+stime = 400 ticks → 4000 ms');
  assert.equal(parseProcStatCpuMs('garbage'), null);
});

test('T1 RSS：助手输出行按平台解析，pid 不符不认', () => {
  assert.deepEqual(parseHelperSample('darwin', 'SAMPLE 4242 243456 0:01.23', 4242), {
    peakMb: 237.8,
    cpuMs: 1230,
  });
  assert.deepEqual(parseHelperSample('win32', 'SAMPLE 7 242221056 1.5', 7), {
    peakMb: 231,
    cpuMs: 1500,
  });
  assert.equal(parseHelperSample('win32', 'SAMPLE 9 242221056 1.5', 7), null, 'pid 不符');
  assert.equal(parseHelperSample('win32', 'END 7', 7), null);
  assert.equal(parseHelperSample('win32', 'SAMPLE 7 0 0', 7), null, '0 值无效');

  assert.deepEqual(
    collectSamples([
      { peakMb: 10, cpuMs: 1 },
      { peakMb: 30, cpuMs: 2 },
      { peakMb: 20, cpuMs: 3 },
    ]),
    { peakMb: 30, cpuMs: 3, samples: 3 },
    '峰值取最大、CPU 取末次',
  );
});

test('T1 RSS：长驻助手脚本（macOS sh 循环 / Windows PowerShell 循环，不用只读 $pid）', () => {
  const mac = samplerSessionScript('darwin', 25);
  assert.equal(mac.command, 'sh');
  const shell = String(mac.args[1]);
  assert.ok(shell.includes('while read -r target count'));
  assert.ok(shell.includes('ps -o rss=,time= -p "$target"'));
  assert.ok(shell.includes('echo "END $target"'));

  const win = samplerSessionScript('win32', SAMPLE_INTERVAL_MS.win32);
  assert.equal(win.command, 'powershell.exe');
  const script = String(win.args.at(-1));
  assert.ok(script.includes('$targetPid = [int]$parts[0]'), '不用只读自动变量 $pid');
  assert.ok(script.includes('PeakWorkingSet64'));
  assert.ok(script.includes('TotalProcessorTime'));
  assert.ok(script.includes('[Console]::Out.Flush()'), '逐行刷新，避免管道缓冲吃掉样本');
  assert.ok(script.includes(`Start-Sleep -Milliseconds ${String(SAMPLE_INTERVAL_MS.win32)}`));

  assert.throws(() => samplerSessionScript('freebsd', 10), /未实现的采样平台/);
  assert.deepEqual(SUPPORTED_PLATFORMS, ['linux', 'darwin', 'win32']);
});

test('T1 RSS：Linux 会话直读 /proc（不启动外部助手），取存活期最大值', async () => {
  let alive = true;
  let reads = 0;
  let iterations = 0;
  const session = createSamplerSession({
    platform: 'linux',
    spawn: () => {
      throw new Error('Linux 不应启动外部采样器');
    },
    readFile: (path: string) => {
      reads += 1;
      if (!alive) throw new Error('ENOENT');
      if (path.endsWith('/status')) {
        return `VmHWM:\t  ${String(reads < 3 ? 100000 : 243456)} kB\n`;
      }
      return '1234 (node) S 1 2 3 4 5 6 7 8 9 10 30 20 0 0';
    },
    sleep: async () => {
      iterations += 1;
      if (iterations >= 3) alive = false;
    },
    intervalMs: 1,
  });
  const handle = session.begin(4242, { isAlive: () => alive });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const result = await handle.finish();
  assert.equal(result.ok, true);
  assert.equal(result.peakMb, 237.8, '取存活期内的最大值');
  assert.equal(result.cpuMs, 500, 'utime+stime 末次值 50 ticks → 500 ms');
  assert.ok(result.samples >= 2);
  assert.equal((await session.warmup()).ok, true, 'Linux 无需预热');
});

test('T1 RSS：未就绪 / 不支持平台 / 助手不可用都判为测量失败（峰值记 null）', async () => {
  const dead = createSamplerSession({
    platform: 'linux',
    readFile: () => {
      throw new Error('ENOENT');
    },
    // 用 setImmediate 让出宏任务：注入空 sleep 会把 setImmediate 饿死（测试专用陷阱）
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    intervalMs: 1,
  });
  const failed = await dead.begin(1, { isAlive: () => false }).finish();
  assert.equal(failed.ok, false);
  assert.equal(failed.peakMb, null, '失败时绝不用 0 兜底');
  assert.equal(failed.reason, RSS_FAILURE_REASONS.NO_SAMPLE);

  const unsupported = createSamplerSession({ platform: 'freebsd' });
  const unsupportedResult = await unsupported.begin(1, { isAlive: () => true }).finish();
  assert.equal(unsupportedResult.ok, false);
  assert.equal(unsupportedResult.reason, RSS_FAILURE_REASONS.UNSUPPORTED_PLATFORM);

  const broken = createSamplerSession({
    platform: 'win32',
    spawn: () => {
      throw new Error('spawn 失败');
    },
    sleep: async () => undefined,
  });
  const brokenResult = await broken.begin(1, { isAlive: () => true }).finish();
  assert.equal(brokenResult.ok, false);
  assert.equal(brokenResult.reason, RSS_FAILURE_REASONS.HELPER_UNAVAILABLE);
});

test('T1 RSS：Windows 会话只启动一个助手、逐行解析、END 后收尾', async () => {
  let spawnCount = 0;
  const session = createSamplerSession({
    platform: 'win32',
    spawn: () => {
      spawnCount += 1;
      return fakeHelper({
        [process.pid]: [
          `SAMPLE ${String(process.pid)} 100000000 0.1`,
          `END ${String(process.pid)}`,
        ],
        4242: [
          'SAMPLE 4242 100000000 0.4',
          'SAMPLE 4242 242221056 1.5',
          'SAMPLE 4242 0 0',
          'END 4242',
        ],
      });
    },
    // 注入空 sleep 会把 setImmediate 饿死（测试专用陷阱）：这里让出宏任务
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    intervalMs: 1,
    graceMs: 100,
    maxWaitMs: 300,
  });
  const warmed = await session.warmup(1);
  assert.equal(warmed.ok, true, `预热采样应拿到样本（原因：${String(warmed.reason)}）`);
  const handle = session.begin(4242, { isAlive: () => true });
  const result = await handle.finish();
  assert.equal(spawnCount, 1, '长驻助手只 spawn 一次');
  assert.equal(result.ok, true);
  assert.equal(result.peakMb, 231);
  assert.equal(result.cpuMs, 1500);
  assert.equal(result.samples, 2, '0 值不算合法样本');
  await session.close();
});
