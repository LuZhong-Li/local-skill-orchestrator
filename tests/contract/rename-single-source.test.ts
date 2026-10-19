import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

test('契约：renameSync 只在统一原子换名工具中直接调用', () => {
  const atomic = join(ROOT, 'kernel', 'store', 'atomic', 'index.ts');
  const offenders = sourceFiles(join(ROOT, 'kernel'))
    .filter((path) => path !== atomic)
    .filter((path) => readFileSync(path, 'utf8').includes('renameSync'))
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'));
  assert.deepEqual(offenders, [], `以下文件绕过了 renameWithRetry：${offenders.join(', ')}`);

  const source = readFileSync(atomic, 'utf8');
  assert.match(source, /export function renameWithRetry/);
  assert.match(source, /RENAME_ATTEMPTS = 5/);
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    assert.ok(source.includes(`code === '${code}'`), `应识别瞬时错误 ${code}`);
  }
});

test('契约：reconcile 的目录级移动全部走退避重试', () => {
  for (const path of [
    'kernel/dispatch/reconcile/adopt.ts',
    'kernel/dispatch/reconcile/adopt-source.ts',
    'kernel/dispatch/reconcile/accept.ts',
    'kernel/dispatch/reconcile/clean.ts',
  ]) {
    const source = readFileSync(join(ROOT, path), 'utf8');
    assert.match(source, /renameWithRetry/);
    assert.equal(source.includes('renameSync'), false, `${path} 不得直接调用 renameSync`);
  }
});
