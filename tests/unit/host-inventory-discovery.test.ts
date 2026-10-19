import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverInventoryCopies } from '../../kernel/core/inventory/discover.ts';
import type { InventoryRootView } from '@skill-manager/contract';
import {
  makeHostRoot,
  makeSharedHostRoot,
  writeCorruptHostSkill,
  writeHostSkill,
} from '../helpers/host.ts';

function rootView(
  hostId: string,
  rootId: string,
  path: string,
  options: Partial<InventoryRootView> = {},
): InventoryRootView {
  return {
    root_id: rootId,
    host_id: hostId,
    host_group: 'builtin',
    role: 'user',
    kind: 'skill',
    path,
    depth: 'direct',
    origin: 'default',
    consumed_by: [hostId],
    configured: true,
    ...options,
  };
}

test('M4c-2 识别：VALID、bad YAML、缺 name、无 SKILL.md、嵌套与 .disabled', () => {
  const root = makeHostRoot('sm-discovery-skill-');
  writeHostSkill(root, 'valid');
  writeCorruptHostSkill(root, 'bad-yaml', 'bad-yaml');
  writeCorruptHostSkill(root, 'missing-name', 'missing-name');
  writeCorruptHostSkill(root, 'no-skill', 'missing');
  const nested = join(root, 'valid', 'references', 'nested');
  mkdirSync(nested, { recursive: true });
  writeHostSkill(root, 'disabled', { disabled: true });
  const skillNested = join(root, 'valid', 'sub-skill');
  mkdirSync(skillNested, { recursive: true });
  writeHostSkill(skillNested, 'inner');

  const direct = discoverInventoryCopies([rootView('claude', 'claude/direct', root)]);
  assert.equal(direct.copies.length, 2, '直接根只计一级技能目录');
  assert.equal(direct.corrupt.length, 2);
  assert.ok(direct.copies.some((copy) => copy.visibility === 'disabled'));
  assert.ok(direct.corrupt.some((copy) => copy.reason === 'bad_yaml'));
  assert.ok(direct.corrupt.some((copy) => copy.reason === 'missing_name'));
  assert.equal(
    direct.copies.some((copy) => copy.skill_id === 'inner'),
    false,
  );
  assert.equal(
    direct.corrupt.some((copy) => copy.path.endsWith('no-skill')),
    false,
  );

  const recursive = discoverInventoryCopies([
    rootView('cursor', 'cursor/recursive', root, { depth: 'recursive' }),
  ]);
  assert.ok(recursive.copies.some((copy) => copy.skill_id === 'inner'));
  assert.equal(
    recursive.copies.some((copy) => copy.recursive === true),
    true,
  );
  assert.equal(
    recursive.copies.some((copy) => copy.path.endsWith('nested')),
    false,
  );
});

test('M4c-2 规则与入口：只识别 .mdc，agents-md entry 跳过', () => {
  const root = makeHostRoot('sm-discovery-rules-');
  writeFileSync(join(root, 'alpha.mdc'), '---\nalwaysApply: false\n---\n');
  writeFileSync(join(root, 'alpha.md'), 'not a cursor rule\n');
  const nestedRules = join(root, 'nested');
  mkdirSync(nestedRules, { recursive: true });
  writeFileSync(join(nestedRules, 'beta.mdc'), '---\nalwaysApply: false\n---\n');

  const direct = discoverInventoryCopies([
    rootView('cursor', 'cursor/rules', root, { kind: 'rules' }),
  ]);
  assert.equal(direct.copies.length, 1);
  assert.equal(direct.copies[0]?.format, 'rules');
  assert.equal(direct.copies[0]?.skill_id, 'alpha');

  const recursive = discoverInventoryCopies([
    rootView('cursor', 'cursor/rules-recursive', root, {
      kind: 'rules',
      depth: 'recursive',
    }),
  ]);
  assert.equal(recursive.copies.length, 2);

  const pluginRules = makeHostRoot('sm-discovery-plugin-rules-');
  writeFileSync(join(pluginRules, 'gamma.md'), '---\nalwaysApply: false\n---\n');
  const plugin = discoverInventoryCopies([
    rootView('x-smoke-tools-zed', 'plugin/zed/rules', pluginRules, {
      kind: 'rules',
      host_group: 'plugin',
    }),
  ]);
  assert.equal(plugin.copies.length, 1, '插件 rules 宿主的 .md 模板应被识别');
  assert.equal(plugin.copies[0]?.skill_id, 'gamma');
  assert.equal(plugin.copies[0]?.format, 'rules');

  const entry = discoverInventoryCopies([
    rootView('agents-md', 'agents-md/project', join(root, 'AGENTS.md'), { kind: 'rules' }),
  ]);
  assert.equal(entry.copies.length, 0);
  assert.equal(entry.roots[0]?.state, 'not_applicable');
});

test('M4c-2 去重：共享物理根合并 consumed_by，同 id 多根不合并', (t) => {
  const shared = makeSharedHostRoot('sm-discovery-shared-');
  writeHostSkill(shared, 'alpha');
  const duplicate = makeHostRoot('sm-discovery-copy-');
  writeHostSkill(duplicate, 'alpha');

  const result = discoverInventoryCopies([
    rootView('codex', 'codex/shared', shared, { consumed_by: ['codex', 'cursor', 'dsh'] }),
    rootView('cursor', 'cursor/shared', shared, { consumed_by: ['cursor'] }),
    rootView('claude', 'claude/other', duplicate),
  ]);
  assert.equal(result.copies.length, 2, '同一物理根去重，不同物理根保留');
  const merged = result.copies.find((copy) => copy.path === join(shared, 'alpha'));
  assert.ok(merged?.consumed_by.includes('codex'));
  assert.ok(merged?.consumed_by.includes('cursor'));
  assert.ok(merged?.consumed_by.includes('dsh'));
  assert.deepEqual(merged?.root_ids.sort(), ['codex/shared', 'cursor/shared']);
  assert.equal(result.summary.copies_before_dedup, 3);
  assert.equal(result.summary.copies_after_dedup, 2);
  assert.equal(result.summary.duplicates_removed, 1);

  const linkRoot = join(makeHostRoot('sm-discovery-link-'), 'linked');
  try {
    symlinkSync(shared, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.diagnostic('当前平台不允许创建目录符号链接，已跳过 symlink 断言');
    return;
  }
  const linked = discoverInventoryCopies([
    rootView('codex', 'codex/shared', shared),
    rootView('claude', 'claude/link', linkRoot),
  ]);
  assert.equal(linked.copies.length, 1, '符号链接指向同一物理副本时只保留一条');
  assert.equal(linked.copies[0]?.root_ids.length, 2);
});

test('M4c-2 根状态：missing、unconfigured、非目录隔离', () => {
  const missing = discoverInventoryCopies([
    rootView('claude', 'claude/missing', join(makeHostRoot('sm-discovery-missing-'), 'nope')),
  ]);
  assert.equal(missing.roots[0]?.state, 'missing');

  const unconfigured = discoverInventoryCopies([
    rootView('claude', 'claude/unconfigured', '', { configured: false, reason: 'missing_home' }),
  ]);
  assert.equal(unconfigured.roots[0]?.state, 'unconfigured');

  const file = join(makeHostRoot('sm-discovery-file-'), 'not-a-root');
  writeFileSync(file, 'file');
  const notDirectory = discoverInventoryCopies([rootView('claude', 'claude/file', file)]);
  assert.equal(notDirectory.roots[0]?.state, 'unreadable');
  assert.equal(notDirectory.roots[0]?.reason, 'not_directory');
});
