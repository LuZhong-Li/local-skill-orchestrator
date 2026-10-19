import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../kernel/dispatch/parsers/index.ts';
import { parseReconcileOptions } from '../../kernel/dispatch/reconcile/options.ts';

function parse(argv: string[]) {
  return parseReconcileOptions(parseArgs(['reconcile', ...argv]).args);
}

function codeOf(value: ReturnType<typeof parse>): string | undefined {
  return (value.error?.findings[0]?.code as string | undefined) ?? undefined;
}

test('reconcile 参数：默认预览，path 精确选择且不要求 target', () => {
  const result = parse(['--action', 'adopt', '--path', '/tmp/host/alpha']);
  assert.equal(result.error, undefined);
  assert.equal(result.selection?.mode, 'path');
  assert.equal(result.selection?.apply, false);
  assert.equal(result.selection?.path, '/tmp/host/alpha');
});

test('reconcile 参数：id + host 与分类批量均可用', () => {
  const byHost = parse(['--action', 'repair', '--id', 'alpha', '--host', 'all']);
  assert.equal(byHost.error, undefined);
  assert.equal(byHost.selection?.mode, 'id-host');
  const byClass = parse([
    '--action',
    'repair',
    '--classification',
    'missing',
    '--root',
    '/tmp/host',
  ]);
  assert.equal(byClass.error, undefined);
  assert.equal(byClass.selection?.mode, 'classification');
});

test('reconcile 参数：缺 action、未知 action、缺选择器均拒绝', () => {
  assert.equal(codeOf(parse(['--path', '/tmp/host/alpha'])), 'E-INPUT-001');
  assert.equal(codeOf(parse(['--action', 'invent', '--path', '/tmp/host/alpha'])), 'E-INPUT-002');
  assert.equal(codeOf(parse(['--action', 'repair'])), 'E-INPUT-001');
});

test('reconcile 参数：选择器与批量限制逐项拒绝', () => {
  assert.equal(
    codeOf(
      parse([
        '--action',
        'adopt',
        '--path',
        '/tmp/host/alpha',
        '--id',
        'alpha',
        '--host',
        'claude',
      ]),
    ),
    'E-INPUT-002',
  );
  assert.equal(codeOf(parse(['--action', 'repair', '--classification', 'missing'])), 'E-INPUT-002');
  assert.equal(
    codeOf(parse(['--action', 'clean', '--classification', 'orphaned', '--host', 'all'])),
    'E-INPUT-002',
  );
  assert.equal(
    codeOf(parse(['--action', 'adopt', '--all', '--path', '/tmp/host/alpha'])),
    'E-INPUT-002',
  );
  assert.equal(
    codeOf(parse(['--action', 'adopt', '--path', '/tmp/host/alpha', '--kind', 'plugin'])),
    'E-INPUT-002',
  );
  assert.equal(
    codeOf(parse(['--action', 'adopt', '--path', '/tmp/host/alpha', '--target', 'claude'])),
    undefined,
  );
});

test('reconcile 参数：--apply 与 --dry-run 互斥；target 只用于 adopt', () => {
  assert.equal(
    codeOf(parse(['--action', 'adopt', '--path', '/tmp/host/alpha', '--apply', '--dry-run'])),
    'E-INPUT-002',
  );
  assert.equal(
    codeOf(parse(['--action', 'repair', '--path', '/tmp/host/alpha', '--target', 'claude'])),
    'E-INPUT-002',
  );
});
