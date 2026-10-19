import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('契约：T6 reconcile 写动作探针接入三平台 verify', () => {
  const workflow = read('.github/workflows/verify.yml');
  const job = workflow.slice(workflow.indexOf('  reconcile-probe:'));
  assert.ok(job.length > 0, 'verify.yml 应包含 reconcile-probe job');
  for (const runner of ['ubuntu-24.04', 'windows-latest', 'macos-15']) {
    assert.ok(job.includes(runner), `写动作探针矩阵应包含 ${runner}`);
  }
  assert.match(job, /fail-fast: false/);
  assert.match(job, /npm ci/);
  assert.match(job, /npm run probe:reconcile/);
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts['probe:reconcile'], 'node scripts/probe-reconcile-actions.mjs');
});

test('契约：写动作探针覆盖六动作、共享根、插件、批量与预览零写入', () => {
  const probe = read('scripts/probe-reconcile-actions.mjs');
  for (const marker of [
    'function checkAdopt',
    'function checkTrack',
    'function checkRepair',
    'function checkAccept',
    'function checkForget',
    'function checkClean',
    'function checkSharedRoot',
    'function checkBatch',
    'function checkFailureIsolation',
    '预览零写入',
    '共享根消费宿主包含 codex/cursor',
    '分类批量逐项 succeeded',
    '目标占用零半成品',
    "process.platform !== 'win32'",
    'symlink=',
  ]) {
    assert.ok(probe.includes(marker), `写动作探针应覆盖 ${marker}`);
  }
  assert.match(probe, /symlinkSync\(fixture\.shared, fixture\.cursor, 'dir'\)/);
  const plugin = read('scripts/probe-reconcile-plugin.mjs');
  for (const marker of [
    'function checkRepair',
    'function checkTrackForget',
    'function checkClean',
    '插件 track succeeded',
    '插件 clean succeeded',
    '插件副本拒绝 adopt',
    '插件副本拒绝 accept',
  ]) {
    assert.ok(plugin.includes(marker), `插件探针应覆盖 ${marker}`);
  }
});

test('契约：失败矩阵覆盖 track / forget / accept 的账本与计划过期', () => {
  const matrix = read('tests/e2e/reconcile-failure-matrix.test.ts');
  for (const marker of [
    'track 账本损坏',
    'forget 账本损坏',
    'accept 计划过期',
    'accept 账本写入失败',
    'E-RECONCILE-002',
    'E-LANDING-001',
    'executeReconcilePlan',
  ]) {
    assert.ok(matrix.includes(marker), `失败矩阵应覆盖 ${marker}`);
  }
});

test('契约：SEA 可执行入口的大 JSON 管道回归接入三平台', () => {
  const workflow = read('.github/workflows/verify.yml');
  const job = workflow.slice(workflow.indexOf('  sea-pipe-probe:'));
  assert.ok(job.length > 0, 'verify.yml 应包含 sea-pipe-probe job');
  for (const runner of ['ubuntu-24.04', 'windows-latest', 'macos-15']) {
    assert.ok(job.includes(runner), `SEA 管道探针应覆盖 ${runner}`);
  }
  assert.match(job, /npm run build:kernel/);
  assert.match(job, /node scripts\/probe-production-kernel\.mjs/);
  const probe = read('scripts/probe-production-kernel.mjs');
  assert.match(probe, /大 JSON 管道不截断/);
  assert.match(probe, /scanThroughPipe/);
});
