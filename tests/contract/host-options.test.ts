import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialIndex, setConfig } from '../../kernel/core/index/index.ts';
import { BOOLEAN_OPTIONS, VALUE_OPTIONS } from '../../kernel/dispatch/parsers/index.ts';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const NOW = '2026-10-15T00:00:00Z';

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

test('契约：--host 已登记为取值选项，且四条指令的契约语法均含该选项', () => {
  assert.equal(VALUE_OPTIONS.has('host'), true, '--host 应登记为取值选项');
  assert.equal(BOOLEAN_OPTIONS.has('host'), false, '--host 不应登记为布尔选项');

  const contract = read('docs/specification/cli-contract.md');
  const syntaxLines = contract
    .split('\n')
    .filter((line) => line.startsWith('**语法**：`skill-manager'));
  for (const command of ['install', 'enable', 'disable', 'update']) {
    const line = syntaxLines.find((item) => item.includes(`${command} `));
    assert.ok(line !== undefined, `契约应含 ${command} 的语法行`);
    assert.match(String(line), /--host <宿主>/, `${command} 的语法应含 --host`);
  }
  assert.match(contract, /--host\b[\s\S]{0,80}正交/, '契约应写明 --host 与 --target 正交');
  assert.match(contract, /host\.<宿主标识>\.rules_root/, '契约应登记规则路径根配置键');
});

test('契约：宿主真实根配置键的取值校验', () => {
  const index: SkillIndex = createInitialIndex(NOW);
  const workspaceRoot = 'C:/ws';

  // 合法：已登记宿主 + 非空路径
  const ok = setConfig({
    index,
    key: 'host.claude.root',
    value: 'C:/Users/u/.claude/skills',
    workspaceRoot,
  });
  assert.notEqual(ok.index, null, '已登记宿主的落位根配置应被接受');
  assert.equal(
    (ok.index?.config as Record<string, unknown>)['host.claude.root'],
    'C:/Users/u/.claude/skills',
  );

  const rulesOk = setConfig({
    index,
    key: 'host.cursor.rules_root',
    value: 'C:/Users/u/.cursor/rules',
    workspaceRoot,
  });
  assert.notEqual(rulesOk.index, null, 'Cursor 规则路径根配置应被接受');

  // 未登记宿主标识
  const unknownHost = setConfig({
    index,
    key: 'host.not-registered.root',
    value: 'C:/tmp/x',
    workspaceRoot,
  });
  assert.equal(unknownHost.index, null);
  assert.match(String(unknownHost.findings[0]?.message), /不在宿主注册表内/);

  // 不适用宿主
  const notApplicable = setConfig({
    index,
    key: 'host.deepseek.root',
    value: 'C:/tmp/x',
    workspaceRoot,
  });
  assert.equal(notApplicable.index, null);
  assert.match(String(notApplicable.findings[0]?.message), /没有落位根/);

  // 类别不匹配：Claude 没有规则路径根
  const wrongSlot = setConfig({
    index,
    key: 'host.claude.rules_root',
    value: 'C:/tmp/x',
    workspaceRoot,
  });
  assert.equal(wrongSlot.index, null);
  assert.match(String(wrongSlot.findings[0]?.message), /没有 rules 类落位根/);

  // 空取值
  const empty = setConfig({ index, key: 'host.codex.root', value: '   ', workspaceRoot });
  assert.equal(empty.index, null);
  assert.match(String(empty.findings[0]?.message), /不能为空/);

  // 既有的固定配置键仍然可用；其余未登记键仍被拒
  const stillOk = setConfig({ index, key: 'default_mode', value: 'copy', workspaceRoot });
  assert.notEqual(stillOk.index, null, '既有配置键不受影响');
  const other = setConfig({ index, key: 'not.a.key', value: 'x', workspaceRoot });
  assert.equal(other.index, null);
});

test('契约：需求文档 M5-R9 已完成 --host 修订且无旧表述残留', () => {
  const requirements = read('docs/requirements.md');
  assert.match(
    requirements,
    /M5-R9 `--host` 宿主分发入口与两级路径粒度（2026-10-15 修订）/,
    'M5-R9 标题应为修订后表述',
  );
  assert.match(
    requirements,
    /`--target` \*\*保持一期语义不变\*\*/,
    'M5-R9 应写明 --target 语义不变',
  );
  assert.match(requirements, /正交/, 'M5-R9 应写明两者正交');

  // 旧表述（--target 的宿主标识）只允许出现在变更记录的历史批次行中
  const stray = requirements
    .split('\n')
    .filter((line) => line.includes('`--target` 的宿主标识'))
    .filter((line) => !line.startsWith('|'));
  assert.deepEqual(stray, [], `正文不应残留「--target 的宿主标识」表述：${stray.join(' / ')}`);
});
