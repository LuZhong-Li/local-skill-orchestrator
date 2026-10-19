import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import semver from 'semver';
import {
  parseVersionOutput,
  probeRuntime,
  probeRuntimes,
  type ProbeCommandResult,
  type ProbeRunner,
} from '../../kernel/core/dependency/runtime.ts';
import { declaredRuntimeOf } from '../../kernel/core/metadata/read.ts';
import { CODES } from '@skill-manager/contract';

interface Call {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

function ok(stdout: string): ProbeCommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

function failed(code: number | null, stdout = '', stderr = ''): ProbeCommandResult {
  return { code, stdout, stderr, timedOut: false };
}

/** 可注入的执行器：记录每次调用，按调用形态返回预置结果（默认「命令不存在」） */
function recordingRunner(answers: (command: string, args: string[]) => ProbeCommandResult | null): {
  runner: ProbeRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: ProbeRunner = async (command, args, env) => {
    calls.push({ command, args, env });
    return answers(command, args) ?? failed(1);
  };
  return { runner, calls };
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((item) => item.code);
}

test('K-06 运行时探测：POSIX 分支用 command -v 解析，版本满足时判 ok', async () => {
  const { runner, calls } = recordingRunner((command) =>
    command === 'sh' ? ok('/usr/local/bin/node\n') : ok('v22.1.0\n'),
  );
  const outcome = await probeRuntime(
    { name: 'node', constraint: '>=22.0.0' },
    { platform: 'linux', pathEnv: '/opt/fake/bin', runner },
  );

  assert.equal(calls.length, 2, '解析一次、取版本一次');
  assert.equal(calls[0]?.command, 'sh');
  assert.deepEqual(calls[0]?.args, ['-c', 'command -v "$1"', 'sh', 'node'], '名称只作位置参数传入');
  assert.equal(calls[0]?.env['PATH'], '/opt/fake/bin', '注入的 PATH 原样传给子进程');
  assert.equal(calls[1]?.command, '/usr/local/bin/node', '取版本时用解析到的路径');
  assert.deepEqual(calls[1]?.args, ['--version']);

  assert.equal(outcome.probe.status, 'ok');
  assert.equal(outcome.probe.version, '22.1.0');
  assert.equal(outcome.probe.command, '/usr/local/bin/node');
  assert.deepEqual(outcome.findings, []);
});

test('K-06 运行时探测：Windows 分支用 where 解析，输出里的版本号被解析出来', async () => {
  const { runner, calls } = recordingRunner((command) =>
    command === 'where' ? ok('C:\\Python312\\python.exe\r\n') : ok('Python 3.12.1\n'),
  );
  const outcome = await probeRuntime(
    { name: 'python', constraint: '>=3.10.0' },
    { platform: 'win32', runner },
  );

  assert.equal(calls[0]?.command, 'where');
  assert.deepEqual(calls[0]?.args, ['python']);
  assert.equal(outcome.probe.status, 'ok');
  assert.equal(outcome.probe.version, '3.12.1');
  assert.equal(outcome.probe.command, 'C:\\Python312\\python.exe');
});

test('验收一：语义化版本范围判定覆盖 ^ / ~ / >= / x 四种写法', async () => {
  const cases: Array<{ constraint: string; expected: string }> = [
    { constraint: '^1.2.0', expected: 'ok' },
    { constraint: '~1.2.0', expected: 'version_unsatisfied' },
    { constraint: '>=1.4.0', expected: 'ok' },
    { constraint: '1.4.x', expected: 'ok' },
    { constraint: '1.2.x', expected: 'version_unsatisfied' },
    { constraint: '<1.0.0', expected: 'version_unsatisfied' },
  ];
  for (const item of cases) {
    const { runner } = recordingRunner((command) =>
      command === 'where' ? ok('C:\\t.exe') : ok('1.4.2'),
    );
    const outcome = await probeRuntime(
      { name: 'tool', constraint: item.constraint },
      { platform: 'win32', runner },
    );
    assert.equal(outcome.probe.status, item.expected, `约束 ${item.constraint} 的判定`);
  }
});

test('验收二：运行时缺失报 E-RUN-001，版本不满足报 E-RUN-002 并给出期望约束', async () => {
  const missing = recordingRunner(() => failed(1));
  const missingOutcome = await probeRuntime(
    { name: 'not-installed-runtime', constraint: '>=1.0.0' },
    { platform: 'linux', pathEnv: '/nonexistent', runner: missing.runner },
  );
  assert.deepEqual(codes(missingOutcome.findings), [CODES.RUN_MISSING]);
  assert.equal(missingOutcome.probe.status, 'missing');
  assert.equal(missingOutcome.probe.version, null);
  assert.equal(missing.calls.length, 1, '命令不存在时不再执行 --version');

  const outdated = recordingRunner((command) =>
    command === 'where' ? ok('C:\\t.exe') : ok('1.0.0'),
  );
  const outdatedOutcome = await probeRuntime(
    { name: 'tool', constraint: '^2.0.0' },
    { platform: 'win32', runner: outdated.runner },
  );
  assert.deepEqual(codes(outdatedOutcome.findings), [CODES.RUN_VERSION_UNSATISFIED]);
  assert.equal(outdatedOutcome.probe.status, 'version_unsatisfied');
  assert.equal(outdatedOutcome.probe.version, '1.0.0');
  assert.equal(outdatedOutcome.probe.constraint, '^2.0.0', '载荷保留期望约束原文');
  assert.match(outdatedOutcome.probe.conclusion, /实际 1\.0\.0/);
  assert.match(outdatedOutcome.probe.conclusion, /\^2\.0\.0/);
});

test('验收三：无效约束与版本无法解析各归明确问题码，不静默忽略', async () => {
  const invalid = recordingRunner(() => ok('1.0.0'));
  const invalidOutcome = await probeRuntime(
    { name: 'tool', constraint: 'not-a-range' },
    { platform: 'win32', runner: invalid.runner },
  );
  assert.deepEqual(codes(invalidOutcome.findings), [CODES.RUN_CONSTRAINT_INVALID]);
  assert.equal(invalidOutcome.probe.status, 'invalid_constraint');
  assert.equal(invalid.calls.length, 0, '约束非法时不探测：拿非法约束比版本没有意义');

  const unparsable = recordingRunner((command) =>
    command === 'where' ? ok('C:\\t.exe') : ok('this tool has no version at all\n'),
  );
  const unparsableOutcome = await probeRuntime(
    { name: 'tool', constraint: '>=1.0.0' },
    { platform: 'win32', runner: unparsable.runner },
  );
  assert.deepEqual(codes(unparsableOutcome.findings), [CODES.RUN_VERSION_UNPARSABLE]);
  assert.equal(unparsableOutcome.probe.status, 'version_unparsable');
  assert.match(unparsableOutcome.findings[0]?.message ?? '', /no version at all/, '原始输出可见');

  const broken = recordingRunner(() => failed(null));
  const brokenOutcome = await probeRuntime(
    { name: 'tool', constraint: '>=1.0.0' },
    { platform: 'win32', runner: broken.runner },
  );
  assert.deepEqual(codes(brokenOutcome.findings), [CODES.RUN_PROBE_FAILED]);
  assert.equal(brokenOutcome.probe.status, 'probe_failed');

  const timedOut = recordingRunner((command) =>
    command === 'where' ? ok('C:\\t.exe') : { code: null, stdout: '', stderr: '', timedOut: true },
  );
  const timedOutOutcome = await probeRuntime(
    { name: 'tool', constraint: '>=1.0.0' },
    { platform: 'win32', timeoutMs: 50, runner: timedOut.runner },
  );
  assert.deepEqual(codes(timedOutOutcome.findings), [CODES.RUN_PROBE_FAILED]);
  assert.match(timedOutOutcome.probe.conclusion, /超时/);
});

test('验收四：注入的 PATH 决定命令解析结果，探测结论取自假命令的输出', async () => {
  const fakeDir = join(makeTempDir('sm-runtime-'), 'fakebin');
  mkdirSync(fakeDir, { recursive: true });
  const { runner, calls } = recordingRunner((command) =>
    command === 'where' ? ok(join(fakeDir, 'faketool.exe')) : ok('faketool version 3.4.5'),
  );

  const outcome = await probeRuntimes([{ name: 'faketool', constraint: '^3.0.0' }], {
    platform: 'win32',
    pathEnv: fakeDir,
    runner,
  });

  assert.equal(calls[0]?.env['PATH'], fakeDir);
  assert.equal(
    outcome.entries[0]?.command,
    join(fakeDir, 'faketool.exe'),
    '解析结果来自注入的 PATH',
  );
  assert.equal(outcome.entries[0]?.version, '3.4.5', '探测结论取自假命令输出');
  assert.equal(outcome.entries[0]?.status, 'ok');
  assert.deepEqual(outcome.findings, []);
});

test('验收四续：真实探测路径——缺失、可用与 PATH 注入各一条断言', async () => {
  const emptyDir = join(makeTempDir('sm-runtime-empty-'), 'empty');
  mkdirSync(emptyDir, { recursive: true });

  // 注入的 PATH 会一并发给子进程，连探测命令自身都解析不到时按探测失败上报
  const injected = await probeRuntime(
    { name: 'node', constraint: '>=22.0.0' },
    { pathEnv: emptyDir },
  );
  assert.equal(injected.probe.status, 'probe_failed', '注入的 PATH 生效到子进程的命令解析');
  assert.deepEqual(codes(injected.findings), [CODES.RUN_PROBE_FAILED]);

  // 真实 PATH 下探测一个必然不存在的运行时：走完真实解析路径后判缺失
  const missing = await probeRuntime({
    name: 'skill-manager-no-such-runtime',
    constraint: '>=1.0.0',
  });
  assert.equal(missing.probe.status, 'missing');
  assert.deepEqual(codes(missing.findings), [CODES.RUN_MISSING]);

  // 真实 PATH 下以本进程所用的 node 作为被探测运行时，覆盖真实解析与 --version 解析
  const real = await probeRuntime({ name: 'node', constraint: '>=22.0.0' });
  assert.equal(real.probe.status, 'ok');
  assert.equal(real.probe.version, semver.coerce(process.versions.node)?.version);
  assert.ok(semver.satisfies(String(real.probe.version), '>=22.0.0'));
  assert.deepEqual(real.findings, []);
});

test('K-06 版本解析：兼容各种 --version 输出写法，解析不出时返回 null', () => {
  assert.equal(parseVersionOutput('v22.1.0'), '22.1.0');
  assert.equal(parseVersionOutput('git version 2.43.0.windows.1'), '2.43.0');
  assert.equal(parseVersionOutput('Python 3.12.1'), '3.12.1');
  assert.equal(parseVersionOutput('1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(parseVersionOutput('no digits here'), null);
  assert.equal(parseVersionOutput(''), null);
});

test('K-01 元文件运行时声明：按声明顺序取出名称与约束原文，缺失时为空', () => {
  assert.deepEqual(
    declaredRuntimeOf({
      dependencies: { runtime: { node: '>=22.0.0', python: '^3.12.0' } },
    }),
    [
      { name: 'node', constraint: '>=22.0.0' },
      { name: 'python', constraint: '^3.12.0' },
    ],
  );
  assert.deepEqual(declaredRuntimeOf({ dependencies: { skills: ['alpha'] } }), []);
  assert.deepEqual(declaredRuntimeOf({ dependencies: { runtime: { node: 22 } } }), []);
  assert.deepEqual(declaredRuntimeOf(null), []);
});
