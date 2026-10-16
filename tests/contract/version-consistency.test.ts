import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_VERSION } from '../../kernel/core/index/index.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const readVersion = (path: string) =>
  (JSON.parse(readFileSync(join(root, path), 'utf8')) as { version: string }).version;

test('契约：三处 package.json 与内核 TOOL_VERSION 同源（发布前不得分叉）', () => {
  const rootVersion = readVersion('package.json');
  assert.match(rootVersion, /^\d+\.\d+\.\d+$/, '版本号必须是三段式');
  assert.equal(readVersion('gui/package.json'), rootVersion, '界面包与根包版本一致');
  assert.equal(readVersion('kernel/package.json'), rootVersion, '内核包与根包版本一致');
  assert.equal(
    TOOL_VERSION,
    rootVersion,
    '内核 TOOL_VERSION 必须与 package.json 一致（它是 --version 与索引 tool_version 的唯一来源）',
  );
});

test('契约：CHANGELOG 顶部已定版段与 package.json 版本一致（发布准备工作可自查）', () => {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const topVersioned = /^## (\d+\.\d+\.\d+)$/m.exec(changelog);
  assert.ok(topVersioned !== null, 'CHANGELOG 应含形如 `## 0.1.1` 的版本段');
  assert.equal(
    topVersioned[1],
    readVersion('package.json'),
    'CHANGELOG 顶部版本段应与当前 package.json 版本一致（否则版本守卫会拦下发布）',
  );
});
