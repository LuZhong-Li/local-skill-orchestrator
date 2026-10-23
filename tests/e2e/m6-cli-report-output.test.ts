import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { capture, initWorkspace } from '../helpers/m6-fixtures.ts';
import { makeTempDir } from '../helpers/temp.ts';

test('M6 CLI：scan --format markdown 无 output 时 stdout 直出报告原文', async (t) => {
  const root = makeTempDir('sm-m6-cli-report-raw-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root);

  const executed = await capture([
    'scan',
    '--inventory',
    '--audit',
    '--format',
    'markdown',
    '--workspace',
    root,
  ]);

  assert.equal(executed.code, 0, executed.out);
  assert.match(executed.out, /^# Skill audit report/m);
  assert.doesNotMatch(executed.out, /^指令 scan/m);
});

test('M6 CLI：--output 写报告并返回既有 Result，报告元信息可读', async (t) => {
  const root = makeTempDir('sm-m6-cli-report-output-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root);
  const output = join(root, 'audit.sarif');

  const executed = await capture([
    'scan',
    '--inventory',
    '--audit',
    '--format',
    'sarif',
    '--output',
    output,
    '--workspace',
    root,
    '--json',
  ]);

  assert.equal(executed.code, 0, executed.out);
  const result = JSON.parse(executed.out) as {
    data: { report: { format: string; path: string; bytes: number } };
  };
  assert.equal(result.data.report.format, 'sarif');
  assert.equal(result.data.report.path, output);
  assert.ok(result.data.report.bytes > 0);
  assert.equal(existsSync(output), true);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).version, '2.1.0');
});

test('M6 CLI：format / output / json 的非法组合按参数类问题拒绝', async (t) => {
  const root = makeTempDir('sm-m6-cli-report-errors-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root);

  for (const argv of [
    ['scan', '--inventory', '--format', 'markdown', '--workspace', root],
    ['scan', '--inventory', '--audit', '--format', 'markdown', '--workspace', root, '--json'],
    ['scan', '--inventory', '--audit', '--output', join(root, 'x.md'), '--workspace', root],
  ]) {
    const executed = await capture(argv);
    assert.equal(executed.code, 2, executed.out);
  }
});
