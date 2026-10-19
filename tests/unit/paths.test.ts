import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithin, resolveWithin, toPortablePath } from '../../kernel/store/paths/index.ts';
import { KernelError } from '../../kernel/store/errors.ts';
import { CODES } from '@skill-manager/contract';

const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

test('S-04 工作区内的相对路径被接受', () => {
  const resolved = resolveWithin(root, 'skills/code-review');
  assert.ok(resolved.includes('code-review'));
  assert.ok(isWithin(root, 'skills/code-review'));
});

test('S-04 上级目录穿越被拒绝', () => {
  assert.throws(
    () => resolveWithin(root, '../../etc/passwd'),
    (error: unknown) => error instanceof KernelError && error.code === CODES.PATH_INVALID,
  );
});

test('S-04 中间夹带的穿越被拒绝', () => {
  assert.throws(
    () => resolveWithin(root, 'skills/../../outside'),
    (error: unknown) => error instanceof KernelError && error.code === CODES.PATH_INVALID,
  );
});

test('S-04 工作区之外的绝对路径被拒绝', () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
  assert.throws(
    () => resolveWithin(root, outside),
    (error: unknown) => error instanceof KernelError && error.code === CODES.PATH_INVALID,
  );
});

test('S-04 同前缀的兄弟目录不被误判为工作区内', () => {
  const sibling = process.platform === 'win32' ? 'C:\\workspace-evil' : '/workspace-evil';
  assert.equal(isWithin(root, sibling), false);
});

test('S-04 空路径与含空字节的路径被拒绝', () => {
  for (const bad of ['', '   ', 'skills/\0evil']) {
    assert.throws(
      () => resolveWithin(root, bad),
      (error: unknown) => error instanceof KernelError && error.code === CODES.PATH_INVALID,
    );
  }
});

test('S-04 可移植路径统一使用正斜杠', () => {
  const portable = toPortablePath(root, resolveWithin(root, 'skills/a/b'));
  assert.equal(portable, 'skills/a/b');
});
