import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SOURCE_ERROR_CODES,
  UPDATE_CHECK_MAX_OUTPUT_BYTES,
  UPDATE_CHECK_TIMEOUT_MS,
} from '../../gui/main/update-check/index.ts';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function numericDefault(source: string, name: string): number {
  const match = new RegExp(
    `const ${name} =\\s*Number\\(process\\.env\\[[^\\]]+\\] \\?\\? ''\\) \\|\\| ([0-9_*\\s]+);`,
  ).exec(source);
  assert.ok(match !== null, `内核源码应保留 ${name} 的默认值`);
  return match[1]!
    .replaceAll('_', '')
    .split('*')
    .map((piece) => Number(piece.trim()))
    .reduce((left, right) => left * right, 1);
}

test('契约：GUI 检查常量与内核远端获取口径逐项一致（任一侧漂移即红）', () => {
  const source = readFileSync(join(ROOT, 'kernel', 'core', 'lifecycle', 'source.ts'), 'utf8');
  assert.equal(UPDATE_CHECK_TIMEOUT_MS, numericDefault(source, 'REMOTE_TIMEOUT_MS'));
  assert.equal(UPDATE_CHECK_TIMEOUT_MS, 60_000);
  assert.equal(UPDATE_CHECK_MAX_OUTPUT_BYTES, numericDefault(source, 'REMOTE_MAX_BYTES'));
  assert.equal(UPDATE_CHECK_MAX_OUTPUT_BYTES, 128 * 1024 * 1024);
});

test('契约：GUI 侧问题码表引用的 E-SRC 码均存在于内核契约词汇表', () => {
  const source = readFileSync(join(ROOT, 'kernel', 'store', 'contract.ts'), 'utf8');
  for (const code of Object.values(SOURCE_ERROR_CODES)) {
    assert.ok(source.includes(`'${code}'`), `内核契约应定义 ${code}`);
  }
  assert.deepEqual(Object.values(SOURCE_ERROR_CODES).sort(), [
    'E-SRC-005',
    'E-SRC-006',
    'E-SRC-007',
    'E-SRC-008',
    'E-SRC-009',
    'E-SRC-010',
  ]);
});

test('契约：设计与计划使用 T1 的四个规范状态名', () => {
  const design = readFileSync(join(ROOT, 'docs', 'design', 'm4a-auto-update.md'), 'utf8');
  for (const state of ['update-available', 'up-to-date', 'not-checkable', 'failed']) {
    assert.ok(design.includes(state), `设计应使用状态名 ${state}`);
  }
  assert.equal(design.includes('`updatable` / `current`'), false, '旧状态名不得残留');
});
