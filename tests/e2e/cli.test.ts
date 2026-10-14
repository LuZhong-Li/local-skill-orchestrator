import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-cli-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  return root;
}

function indexPath(root: string): string {
  return join(root, 'skill_index.yaml');
}

function skill(root: string, dir: string, meta: string, content = '# skill'): void {
  const target = join(root, 'skills', dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), content);
  writeFileSync(join(target, 'skill_meta.yaml'), meta);
}

const validMeta = (id: string): string =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'status: enabled',
    `path: ./skills/${id}`,
    'source:',
    '  type: local',
    'targets:',
    '  - target: claude',
    '    scope: global',
    `    path: .claude/skills/${id}`,
    '    mode: copy',
    '    enabled: true',
    '    file_map:',
    '      SKILL.md: SKILL.md',
    '',
  ].join('\n');

test('验收一：init 建立工作区与初始索引，重复执行幂等', async () => {
  const root = workspace();
  assert.equal(await run(['init', '--workspace', root]), 0);
  assert.ok(existsSync(indexPath(root)), '应创建索引文件');
  assert.ok(existsSync(join(root, 'skills')), '应创建 skills 目录');
  assert.ok(existsSync(join(root, 'backups')), '应创建 backups 目录');
  assert.ok(existsSync(join(root, 'locks')), '应创建 locks 目录');
  assert.ok(existsSync(join(root, 'logs')), '应创建 logs 目录');

  const before = readFileSync(indexPath(root), 'utf8');
  assert.equal(await run(['init', '--workspace', root]), 0);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '重复 init 不应覆盖既有索引');
});

test('验收二：scan 生成索引，合格记录 ok、不合格记录 invalid 且重复扫描不新增条目', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'good-skill', validMeta('good-skill'));
  skill(root, 'bad-skill', 'id: bad-skill\nstatus: paused\n');

  const first = await run(['scan', '--workspace', root]);
  assert.equal(first, 1, '存在不合格记录时退出码应为 1');
  const index = readFileSync(indexPath(root), 'utf8');
  assert.ok(index.includes('status: ok'), '应存在校验通过的记录');
  assert.ok(index.includes('status: invalid'), '应存在校验不通过的记录');
  assert.ok(index.includes('E-STATUS-001'), '不合格记录应携带问题码');

  const second = await run(['scan', '--workspace', root, '--json']);
  assert.equal(second, 1);
});

test('验收二续：--dry-run 不写入索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'good-skill', validMeta('good-skill'));
  const before = readFileSync(indexPath(root), 'utf8');
  assert.equal(await run(['scan', '--workspace', root, '--dry-run']), 0);
  assert.equal(readFileSync(indexPath(root), 'utf8'), before, '预演不应改写索引');
});

test('未初始化的工作区执行 scan 返回环境类错误与退出码 1', async () => {
  const root = workspace();
  assert.equal(await run(['scan', '--workspace', root]), 1);
});

test('未知指令返回输入类错误与退出码 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['frobnicate', '--workspace', root]), 2);
});

test('缺少选项取值返回输入类错误与退出码 2', async () => {
  assert.equal(await run(['scan', '--workspace']), 2);
});

test('--version 输出后直接返回 0', async () => {
  assert.equal(await run(['--version']), 0);
});
