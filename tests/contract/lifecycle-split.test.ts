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

test('架构：lifecycle 实现按命令拆分，index 只保留公共导出', () => {
  const index = read('kernel/core/lifecycle/index.ts');
  assert.ok(nonEmptyLines('kernel/core/lifecycle/index.ts') < 50, 'index 应只保留导出');
  assert.equal(/\bfunction\s+\w+/.test(index), false, 'index 不得再持有实现函数');

  const modules = {
    'install.ts': 'installSkill',
    'uninstall.ts': 'uninstallSkill',
    'toggle.ts': 'enableSkill',
    'update.ts': 'updateSkill',
    'restore.ts': 'restoreSkill',
  } as const;
  for (const [file, exported] of Object.entries(modules)) {
    const path = `kernel/core/lifecycle/${file}`;
    const text = read(path);
    assert.ok(nonEmptyLines(path) < 500, `${file} 应低于 500 行`);
    assert.match(text, new RegExp(`export (?:async )?function ${exported}`));
    assert.ok(index.includes(`from './${file}'`), `index 应从 ${file} 导出`);
  }
  assert.ok(nonEmptyLines('kernel/core/lifecycle/shared.ts') < 500, '共享工具文件应低于 500 行');
});
