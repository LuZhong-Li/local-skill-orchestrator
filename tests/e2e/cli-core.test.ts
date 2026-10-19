import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { TOOL_VERSION } from '../../kernel/core/index/index.ts';
import { validMeta } from '../helpers/skill.ts';
import {
  indexPath,
  kernelPackageVersion,
  rootPackageVersion,
  skill,
  sourceSkill,
  workspace,
} from '../helpers/cli.ts';
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
test('--version 输出版本号并返回 0（版本号与 TOOL_VERSION / package.json 同源）', async () => {
  assert.equal(await run(['--version']), 0);
  assert.equal(TOOL_VERSION, kernelPackageVersion(), '内核版本常量与内核包版本一致');
  assert.equal(TOOL_VERSION, rootPackageVersion(), '内核版本常量与根包版本一致');
});
/** 造一份可安装的来源目录 */
test('验收：install 写入中心库、创建副本并登记索引', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']), 0);
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')));
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review', 'SKILL.md')));
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('id: code-review'));
});
test('验收：install 缺少来源参数返回输入类错误', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['install', '--workspace', root, '--yes']), 2);
});
test('验收：install 重复标识返回冲突错误与退出码 1', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']), 1);
});
test('验收：uninstall 默认保留中心库原件，--hard 一并删除', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--yes']), 0);
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '副本应被清理');
  assert.ok(existsSync(join(root, 'skills', 'code-review')), '原件默认保留');
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--hard', '--yes']), 0);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '--hard 应删除原件');
});
test('验收：uninstall 不存在的标识返回输入类错误与退出码 2', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(await run(['uninstall', 'ghost', '--workspace', root, '--yes']), 2);
});
test('验收：install --dry-run 不写入任何文件', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(
    await run(['install', sourceSkill('code-review'), '--workspace', root, '--dry-run']),
    0,
  );
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '预演不得写入中心库');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得创建副本');
  assert.ok(!readFileSync(indexPath(root), 'utf8').includes('id: code-review'), '预演不得登记记录');
});
test('验收：install --library-only 只落库，不分发到目标位置', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  assert.equal(
    await run([
      'install',
      sourceSkill('code-review'),
      '--workspace',
      root,
      '--library-only',
      '--yes',
    ]),
    0,
  );
  assert.ok(existsSync(join(root, 'skills', 'code-review', 'SKILL.md')), '中心库原件应落位');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '不得分发到目标位置');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('status: disabled'));
});
test('验收：uninstall 接受契约中的 --keep-library 选项', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(
    await run(['uninstall', 'code-review', '--workspace', root, '--keep-library', '--yes']),
    0,
  );
  assert.ok(existsSync(join(root, 'skills', 'code-review')), '中心库原件应保留');
});
test('验收：uninstall --dry-run 不删除任何文件', async () => {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  assert.equal(await run(['uninstall', 'code-review', '--workspace', root, '--dry-run']), 0);
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得清理副本');
  assert.ok(readFileSync(indexPath(root), 'utf8').includes('id: code-review'), '预演不得移除记录');
});
