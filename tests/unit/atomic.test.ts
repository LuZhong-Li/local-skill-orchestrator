import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../../kernel/store/atomic/index.ts';
import { KernelError } from '../../kernel/store/errors.ts';
import { CODES } from '../../kernel/store/contract.ts';

function tempDir(): string {
  return makeTempDir('sm-atomic-');
}

test('S-03 正常写入产出目标文件', () => {
  const dir = tempDir();
  const target = join(dir, 'index.yaml');
  atomicWriteFile(target, 'a: 1\n');
  assert.equal(readFileSync(target, 'utf8'), 'a: 1\n');
  assert.deepEqual(readdirSync(dir), ['index.yaml'], '不应残留临时文件');
});

test('S-03 覆盖写入替换原内容', () => {
  const dir = tempDir();
  const target = join(dir, 'index.yaml');
  atomicWriteFile(target, 'a: 1\n');
  atomicWriteFile(target, 'a: 2\n');
  assert.equal(readFileSync(target, 'utf8'), 'a: 2\n');
});

test('S-03 替换前中断：目标保持原内容且清理临时文件', () => {
  const dir = tempDir();
  const target = join(dir, 'index.yaml');
  atomicWriteFile(target, 'before\n');

  assert.throws(
    () =>
      atomicWriteFile(target, 'after\n', {
        onBeforeRename: () => {
          throw new Error('模拟写入途中终止');
        },
      }),
    (error: unknown) => error instanceof KernelError && error.code === CODES.IO_ATOMIC_FAILED,
  );

  assert.equal(readFileSync(target, 'utf8'), 'before\n', '目标不应被改动');
  assert.deepEqual(readdirSync(dir), ['index.yaml'], '临时文件应被清理，不残留半写文件');
});

test('S-03 目标不可写时抛出文件系统问题且不残留临时文件', () => {
  const dir = tempDir();
  // 目标是一个已存在的目录，把文件换名到目录上必然失败
  const target = join(dir, 'busy');
  mkdirSync(target, { recursive: true });
  assert.throws(
    () => atomicWriteFile(target, 'content'),
    (error: unknown) => error instanceof KernelError && error.code === CODES.IO_ATOMIC_FAILED,
  );
  assert.ok(existsSync(target), '原有目录应保持存在');
  assert.ok(
    readdirSync(dir).every((name) => name === 'busy' || !name.endsWith('.tmp')),
    '临时文件应被清理',
  );
  assert.deepEqual(readdirSync(dir), ['busy'], '目录内不应残留临时文件');
});
