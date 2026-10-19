import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function walk(relative: string, output: string[]): void {
  for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) walk(child, output);
    else if (entry.name.endsWith('.ts')) output.push(child);
  }
}

function nonEmptyLines(path: string): number {
  return readFileSync(join(ROOT, path), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0).length;
}

test('P2-1：kernel 源文件全部低于 500 行，registry 只保留路由', () => {
  const files: string[] = [];
  walk('kernel', files);
  const over = files.filter((file) => nonEmptyLines(file) > 500);
  assert.deepEqual(over, [], `仍超过 500 行的 kernel 文件：${over.join('、')}`);

  const registry = readFileSync(join(ROOT, 'kernel/dispatch/registry/index.ts'), 'utf8');
  assert.ok(nonEmptyLines('kernel/dispatch/registry/index.ts') < 200);
  assert.equal(/\bconst\s+\w+Handler\b/.test(registry), false, 'registry 不应持有命令处理器');
  assert.equal(registry.includes("register({ name: 'scan'"), true, 'registry 仍负责注册');
});
