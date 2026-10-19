import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKUP_NOTICE,
  CODES,
  SOURCE_MAX_OUTPUT_BYTES,
  SOURCE_TIMEOUT_MS,
} from '../../contract/src/index.ts';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('契约：来源检查常量只在 contract 定义一次', () => {
  assert.equal(SOURCE_TIMEOUT_MS, 60_000);
  assert.equal(SOURCE_MAX_OUTPUT_BYTES, 128 * 1024 * 1024);
  assert.equal(BACKUP_NOTICE, '执行前将先行备份');
  assert.deepEqual(
    [
      CODES.SRC_COMMAND_UNAVAILABLE,
      CODES.SRC_TIMEOUT,
      CODES.SRC_DOWNLOAD_FAILED,
      CODES.SRC_TOO_LARGE,
      CODES.SRC_PROTOCOL_REJECTED,
      CODES.SRC_AUTH_REQUIRED,
    ],
    ['E-SRC-005', 'E-SRC-006', 'E-SRC-007', 'E-SRC-008', 'E-SRC-009', 'E-SRC-010'],
  );
  assert.equal(CODES.CHANNEL_FAILED, 'E-CHANNEL-001');
});

test('契约：GUI/内核不再复制常量或结果类型', () => {
  const guiFiles = [
    'gui/main/update-check/ls-remote.ts',
    'gui/main/update-check/classify.ts',
    'gui/main/update-check/check.ts',
    'gui/main/update-check/index.ts',
  ];
  for (const file of guiFiles) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const forbidden of [
      'SOURCE_ERROR_CODES',
      'UPDATE_CHECK_TIMEOUT_MS',
      'UPDATE_CHECK_MAX_OUTPUT_BYTES',
      'UPDATE_CHECK_BACKUP_NOTICE',
      "'E-CHANNEL-001'",
      "'E-SRC-007'",
      '60_000',
      '128 * 1024 * 1024',
    ]) {
      assert.equal(source.includes(forbidden), false, `${file} 不得复制 ${forbidden}`);
    }
  }
  assert.equal(existsSync(join(ROOT, 'gui/main/update-check/constants.ts')), false);

  const source = readFileSync(join(ROOT, 'kernel/core/lifecycle/source-shared.ts'), 'utf8');
  assert.equal(source.includes('SOURCE_TIMEOUT_MS'), true);
  assert.equal(source.includes('SOURCE_MAX_OUTPUT_BYTES'), true);

  const bridge = readFileSync(join(ROOT, 'gui/bridge/kernel.ts'), 'utf8');
  assert.equal(bridge.includes("from '@skill-manager/contract'"), true);
  assert.equal(bridge.includes('export interface KernelResult'), false);
  const renderer = readFileSync(join(ROOT, 'gui/renderer/src/types.ts'), 'utf8');
  assert.equal(renderer.includes("from '@skill-manager/contract'"), true);
  assert.equal(renderer.includes('export interface KernelResult'), false);
});

test('契约：设计与计划使用 T1 的四个规范状态名', () => {
  const design = readFileSync(join(ROOT, 'docs', 'design', 'm4a-auto-update.md'), 'utf8');
  for (const state of ['update-available', 'up-to-date', 'not-checkable', 'failed']) {
    assert.ok(design.includes(state), `设计应使用状态名 ${state}`);
  }
  assert.equal(design.includes('`updatable` / `current`'), false, '旧状态名不得残留');
});
