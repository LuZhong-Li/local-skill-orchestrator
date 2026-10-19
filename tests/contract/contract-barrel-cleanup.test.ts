import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PUBLIC_REEXPORTS = new Set(['kernel/index.ts', 'kernel/dispatch/result/index.ts']);

function walk(relative: string, output: string[]): void {
  for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) walk(child, output);
    else if (entry.name.endsWith('.ts')) output.push(child);
  }
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('TD-06：兼容 barrel 已删除，kernel 仅公共入口保留 contract re-export', () => {
  for (const removed of ['kernel/store/contract.ts', 'kernel/core/plugins/types.ts']) {
    assert.equal(existsSync(join(ROOT, removed)), false, `${removed} 应已删除`);
  }
  assert.equal(
    read('kernel/core/metadata/constants.ts').includes("from '@skill-manager/contract'"),
    false,
  );
  assert.equal(
    /export\s+type\s*\{[\s\S]*\}\s+from\s+['"]@skill-manager\/contract['"]/.test(
      read('kernel/dispatch/scan/types.ts'),
    ),
    false,
  );

  const files: string[] = [];
  walk('kernel', files);
  const reexports = files.filter((file) =>
    /export\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"]@skill-manager\/contract['"]/s.test(read(file)),
  );
  assert.deepEqual(reexports.sort(), [...PUBLIC_REEXPORTS].sort());

  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes('store/contract'), false, `${file} 仍引用已删除的 store/contract`);
    assert.equal(
      source.includes('core/plugins/types.ts'),
      false,
      `${file} 仍引用已删除的 plugins/types`,
    );
  }
});
