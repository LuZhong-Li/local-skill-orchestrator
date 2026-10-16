import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMS,
  MEASURED_SCENARIOS,
  REPORT_SCHEMA,
  SCENARIO_STATE,
  STARTUP_SCENARIO,
  buildMatrix,
  buildReport,
  defaultRuns,
  formatReportText,
  scenarioArgv,
  summarize,
  summarizeScenario,
} from '../../scripts/bench/measure.mjs';

test('T1 矩阵：三档 × 四场景 + 每形态一次启动开销（档位无关）', () => {
  const matrix = buildMatrix({ form: 'source', sizes: [100, 1000, 5000], platform: 'darwin' });
  assert.equal(matrix.length, 3 * MEASURED_SCENARIOS.length + 1);
  assert.equal(matrix.filter((entry) => entry.scenario === STARTUP_SCENARIO).length, 1);
  const startup = matrix.at(-1)!;
  assert.equal(startup.n, null, '启动开销与档位无关');
  assert.equal(startup.state, null);
  for (const entry of matrix) {
    assert.equal(entry.form, 'source');
    if (entry.scenario !== STARTUP_SCENARIO) {
      assert.equal(entry.state, SCENARIO_STATE[entry.scenario]);
    }
  }
  assert.deepEqual(
    matrix.filter((entry) => entry.n === 1000).map((entry) => entry.scenario),
    MEASURED_SCENARIOS,
  );
});

test('T1 矩阵：重复次数口径（默认 3；Windows N=5000 默认 1；--runs 覆盖）', () => {
  assert.equal(defaultRuns({ platform: 'darwin', n: 5000, requested: null }), 3);
  assert.equal(defaultRuns({ platform: 'win32', n: 5000, requested: null }), 1, 'BX-03 显式例外');
  assert.equal(defaultRuns({ platform: 'win32', n: 1000, requested: null }), 3);
  assert.equal(defaultRuns({ platform: 'win32', n: 5000, requested: 5 }), 5, '命令行取值优先');
  assert.equal(
    buildMatrix({ form: 'sea', sizes: [5000], platform: 'win32', runs: null }).find(
      (entry) => entry.scenario === 'scan-cold',
    )!.runs,
    1,
  );
  assert.equal(FORMS.join('/'), 'source/sea');
});

test('T1 命令拼装：四场景 + 启动开销；源码线可挂剖面、SEA 线不挂', () => {
  const base = {
    workspace: '/tmp/ws',
    exportFile: '/tmp/out.yaml',
    sourceEntry: '/repo/kernel/entry/cli.ts',
  };
  assert.deepEqual(scenarioArgv({ ...base, scenario: 'scan-cold' }).args.slice(-4), [
    '/repo/kernel/entry/cli.ts',
    'scan',
    '--workspace',
    '/tmp/ws',
  ]);
  assert.deepEqual(scenarioArgv({ ...base, scenario: 'validate' }).args.slice(-3), [
    'validate',
    '--workspace',
    '/tmp/ws',
  ]);
  assert.deepEqual(scenarioArgv({ ...base, scenario: 'export' }).args.slice(-4), [
    'export',
    '/tmp/out.yaml',
    '--workspace',
    '/tmp/ws',
  ]);
  assert.deepEqual(scenarioArgv({ ...base, scenario: STARTUP_SCENARIO }).args.slice(-1), [
    '--version',
  ]);

  const profiled = scenarioArgv({
    ...base,
    scenario: 'scan-hot',
    profileDir: '/tmp/prof',
    profileName: 'x.cpuprofile',
  });
  assert.deepEqual(profiled.args.slice(0, 5), [
    '--cpu-prof',
    '--cpu-prof-dir',
    '/tmp/prof',
    '--cpu-prof-name',
    'x.cpuprofile',
  ]);

  const sea = scenarioArgv({
    scenario: 'scan-hot',
    workspace: '/tmp/ws',
    kernelPath: '/repo/build/kernel/skill-manager.exe',
    profileDir: '/tmp/prof',
  });
  assert.equal(sea.command, '/repo/build/kernel/skill-manager.exe');
  assert.equal(sea.args.includes('--cpu-prof'), false, 'SEA 线不带 Node 侧参数');
});

test('T1 汇总：中位与极值（奇偶样本）、空值不参与、全空即 null', () => {
  assert.deepEqual(summarize([30, 10, 20]), { min: 10, median: 20, max: 30 });
  assert.deepEqual(summarize([10, 20, 30, 40]), { min: 10, median: 25, max: 40 });
  assert.deepEqual(summarize([null, 12]), { min: 12, median: 12, max: 12 });
  assert.deepEqual(summarize([null, null]), { min: null, median: null, max: null });
});

test('T1 报告：场景条目字段齐备（退出码、逐次明细、阶段与 fs 观测可空）', () => {
  const entry = {
    scenario: 'scan-cold',
    state: 'cold',
    n: 1000,
    form: 'source',
    runs: 2,
  };
  const runs = [
    {
      run: 1,
      wall_ms: 100,
      peak_rss_mb: 50,
      rss_ok: true,
      rss_samples: 5,
      rss_reason: null,
      cpu_time_ms: 10,
      exit_code: 0,
      profile: null,
      fs_observation: { appeared_ms: 20, stable_ms: 60, size: 1024, polls: 9, reason: null },
    },
    {
      run: 2,
      wall_ms: 120,
      peak_rss_mb: null,
      rss_ok: false,
      rss_samples: 0,
      rss_reason: 'no-sample-before-exit',
      cpu_time_ms: null,
      exit_code: 1,
      profile: null,
      fs_observation: null,
    },
  ];
  const sample = summarizeScenario(entry, runs, { index_bytes: 2048, startup_ms: 59 });
  assert.deepEqual(sample.wall_ms, { min: 100, median: 110, max: 120 });
  assert.deepEqual(sample.peak_rss_mb, { min: 50, median: 50, max: 50 }, '失败样本不计入峰值');
  assert.deepEqual(sample.cpu_time_ms, { min: 10, median: 10, max: 10 });
  assert.deepEqual(sample.exit_codes, [0, 1]);
  assert.equal(sample.run_details.length, 2);
  assert.equal(sample.run_details[1].rss_reason, 'no-sample-before-exit');
  assert.equal(sample.index_bytes, 2048);
  assert.equal(sample.startup_ms, 59);
  assert.equal(sample.export_bytes, null);
  assert.equal(sample.stages, null);

  const report = buildReport({
    environment: { platform: 'win32', arch: 'x64', node: 'v24.14.1', kernel_form: 'source' },
    fixture: { seed: 23063, n: 1000, files: 2968, bytes: 1, generation_ms: 1 },
    samples: [sample],
    generatedAt: '2026-10-17T00:00:00.000Z',
  });
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.deepEqual(Object.keys(report), [
    'schema',
    'generated_at',
    'environment',
    'fixture',
    'samples',
  ]);
  assert.ok(formatReportText(report).includes('scan-cold'));
});
