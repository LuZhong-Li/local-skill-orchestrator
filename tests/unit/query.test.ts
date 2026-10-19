import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  inspectSkill,
  listSkills,
  readConfig,
  toListEntry,
} from '../../kernel/core/index/query.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-14T00:00:00Z';

function workspace(): string {
  const root = makeTempDir('sm-query-');
  mkdirSync(join(root, 'skills'), { recursive: true });
  return root;
}

function putSkill(root: string, id: string, extra = '', content = '# skill'): void {
  const dir = join(root, 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      'version: 1.0.0',
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
      extra,
      '',
    ].join('\n'),
  );
}

/**
 * 造一个混合场景：可用、失效、被禁用、依赖外部对象。
 * 索引中的启用状态是启用状态的事实源，不由元文件声明决定，因此这里直接改写记录取值。
 */
function scenario(): { root: string; index: SkillIndex } {
  const root = workspace();
  putSkill(root, 'alpha');
  putSkill(root, 'beta', 'dependencies:\n  skills:\n    - ghost');
  putSkill(root, 'gamma', 'dependencies:\n  skills:\n    - beta');
  const layout = layoutOf(root);
  const scanned = scanWorkspace({ layout, index: createInitialIndex(NOW), now: NOW });
  const index: SkillIndex = {
    ...scanned.index,
    skills: scanned.index.skills.map((record) =>
      record.id === 'gamma' ? { ...record, status: 'disabled' } : record,
    ),
  };
  return { root, index };
}

test('K-03 列表：空索引的计数与记录都为空', () => {
  const outcome = listSkills({ index: createInitialIndex(NOW), filter: {} });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.summary?.total, 0);
  assert.equal(outcome.summary?.filtered, 0);
  assert.deepEqual(outcome.summary?.by_state, { enabled: 0, disabled: 0 });
  assert.deepEqual(outcome.summary?.by_validation, { ok: 0, invalid: 0 });
});

test('K-03 列表：索引缺失时返回引导性结果而不报错', () => {
  const outcome = listSkills({ index: null, filter: {} });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.summary, null);
});

test('K-03 列表：分状态与分结论计数互不混用', () => {
  const { index } = scenario();
  const outcome = listSkills({ index, filter: {} });
  assert.equal(outcome.summary?.total, 3);
  assert.deepEqual(outcome.summary?.by_state, { enabled: 2, disabled: 1 });
  assert.deepEqual(outcome.summary?.by_validation, { ok: 1, invalid: 2 });
});

test('K-03 列表：按状态、来源与目标过滤，默认按标识升序', () => {
  const { index } = scenario();
  assert.deepEqual(
    listSkills({ index, filter: {} }).summary?.records.map((item) => item.id),
    ['alpha', 'beta', 'gamma'],
  );
  assert.deepEqual(
    listSkills({ index, filter: { state: 'disabled' } }).summary?.records.map((item) => item.id),
    ['gamma'],
  );
  assert.equal(listSkills({ index, filter: { state: 'enabled' } }).summary?.filtered, 2);
  assert.equal(listSkills({ index, filter: { source: 'local' } }).summary?.filtered, 3);
  assert.equal(listSkills({ index, filter: { source: 'git' } }).summary?.filtered, 0);
  assert.equal(listSkills({ index, filter: { target: 'claude' } }).summary?.filtered, 3);
  assert.equal(listSkills({ index, filter: { target: 'codex' } }).summary?.filtered, 0);

  const filtered = listSkills({ index, filter: { state: 'enabled', target: 'claude' } });
  assert.equal(filtered.summary?.total, 3, '总数是过滤前的值');
  assert.equal(filtered.summary?.filtered, 2);
});

test('K-03 列表：过滤取值非法时返回参数类问题', () => {
  const { index } = scenario();
  const state = listSkills({ index, filter: { state: 'paused' } });
  assert.deepEqual(
    state.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
  assert.equal(state.summary, null);
  const source = listSkills({ index, filter: { source: 'ftp' } });
  assert.deepEqual(
    source.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
});

test('K-03 列表：单条载荷只保留契约列明的字段', () => {
  const { index } = scenario();
  const entry = toListEntry(index.skills[0]!);
  assert.deepEqual(Object.keys(entry).sort(), [
    'id',
    'name',
    'source_type',
    'status',
    'targets',
    'updated_at',
    'validation',
    'version',
  ]);
});

test('K-03 配置读取：缺失的配置项不补默认值', () => {
  const full = readConfig(createInitialIndex(NOW));
  assert.deepEqual(full['skill_roots'], ['./skills']);
  assert.equal(full['default_target'], 'claude');
  assert.equal(full['default_mode'], 'copy');

  const bare = readConfig({
    ...createInitialIndex(NOW),
    config: { skill_roots: ['./skills'] },
  } as SkillIndex);
  assert.deepEqual(bare['skill_roots'], ['./skills']);
  assert.ok(!('default_target' in bare), '未定义的项按缺失处理');
  assert.ok(!('default_mode' in bare));
});

test('K-03 单个查看：输出完整元信息与指纹比对结论', () => {
  const { root, index } = scenario();
  const outcome = inspectSkill({ layout: layoutOf(root), index, id: 'beta' });
  assert.equal(outcome.data['meta_path'], 'skills/beta/skill_meta.yaml');
  assert.deepEqual(outcome.data['dependencies'], { skills: ['ghost'] });
  assert.equal(
    (outcome.data['targets'] as Array<{ file_map: Record<string, string> }>)[0]?.file_map[
      'SKILL.md'
    ],
    'SKILL.md',
    '落位目标含逐文件映射',
  );
  const checksum = outcome.data['checksum'] as { match: boolean; recorded: string };
  assert.equal(checksum.match, true);
  assert.equal(checksum.recorded, index.skills.find((item) => item.id === 'beta')?.checksum);
  assert.equal(
    outcome.data['last_updated_at'],
    index.skills.find((i) => i.id === 'beta')?.updated_at,
  );
});

test('K-03 单个查看：内容改动后给出漂移结论', () => {
  const { root, index } = scenario();
  writeFileSync(join(root, 'skills', 'beta', 'SKILL.md'), '# changed');
  const outcome = inspectSkill({ layout: layoutOf(root), index, id: 'beta' });
  const checksum = outcome.data['checksum'] as { match: boolean };
  assert.equal(checksum.match, false);
  assert.ok(
    outcome.findings.some((item) => item.code === CODES.DRIFT && item.severity === 'warning'),
  );
});

test('K-03 单个查看：元文件缺失时报语法类问题并给出空元数据', () => {
  const { root, index } = scenario();
  rmSync(join(root, 'skills', 'beta', 'skill_meta.yaml'));
  const outcome = inspectSkill({ layout: layoutOf(root), index, id: 'beta' });
  assert.equal(outcome.data['meta'], null);
  assert.equal(outcome.data['meta_exists'], false);
  assert.ok(outcome.findings.some((item) => item.code === CODES.YAML_INVALID));
});

test('K-03 单个查看：标识不在索引中时返回参数类问题', () => {
  const { root, index } = scenario();
  const outcome = inspectSkill({ layout: layoutOf(root), index, id: 'nosuch' });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
  assert.equal(outcome.findings[0]?.severity, 'error');
});
