import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function nonEmptyLines(path: string): number {
  return read(path)
    .split(/\r?\n/)
    .filter((line) => line.length > 0).length;
}

test('架构：plugin manifest 按共享/root/host/顶层校验拆分，入口只保留导出', () => {
  const index = read('kernel/core/plugins/manifest.ts');
  assert.ok(nonEmptyLines('kernel/core/plugins/manifest.ts') < 50, 'manifest 入口应只保留导出');
  assert.equal(/\bfunction\s+\w+/.test(index), false, '入口不得再持有实现函数');
  assert.match(index, /manifest-shared\.ts/);
  assert.match(index, /manifest-validate\.ts/);

  const modules: Record<string, string> = {
    'manifest-shared.ts': 'canonicalHostId',
    'manifest-root.ts': 'validateRoot',
    'manifest-host.ts': 'validateHost',
    'manifest-validate.ts': 'validatePluginManifest',
  };
  for (const [file, exported] of Object.entries(modules)) {
    const path = `kernel/core/plugins/${file}`;
    assert.ok(nonEmptyLines(path) < 500, `${file} 应低于 500 行`);
    assert.match(read(path), new RegExp(`export (?:async )?function ${exported}`));
  }
});
