import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialIndex, setConfig } from '../../kernel/core/index/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';

const NOW = '2026-10-15T00:00:00Z';

function workspace(): { root: string; index: ReturnType<typeof createInitialIndex> } {
  const root = makeTempDir('sm-config-');
  mkdirSync(join(root, 'skills'), { recursive: true });
  return { root, index: { ...createInitialIndex(NOW), extension_flag: 'x' } };
}

function apply(key: string, value: string, root?: string) {
  const ws = workspace();
  return setConfig({
    index: ws.index,
    key,
    value,
    workspaceRoot: root ?? layoutOf(ws.root).root,
  });
}

test('K-03 配置写入：三个可修改项都能写入并回报新旧取值', () => {
  const roots = apply('skill_roots', './skills, ./extra');
  assert.deepEqual(roots.data, {
    key: 'skill_roots',
    previous_value: ['./skills'],
    new_value: ['./skills', './extra'],
  });
  assert.deepEqual(roots.index?.config.skill_roots, ['./skills', './extra']);

  const target = apply('default_target', 'codex');
  assert.equal(target.index?.config.default_target, 'codex');
  assert.equal(target.data['previous_value'], 'claude');

  const mode = apply('default_mode', 'link');
  assert.equal(mode.index?.config.default_mode, 'link');
  assert.deepEqual(mode.findings, []);
});

test('K-03 配置写入：只改动目标配置项，其余字段与未识别字段原样保留', () => {
  const outcome = apply('default_target', 'codex');
  assert.equal(outcome.index?.config.skill_roots.length, 1);
  assert.equal(outcome.index?.config.default_mode, 'copy');
  assert.equal((outcome.index as unknown as Record<string, unknown>)['extension_flag'], 'x');
  assert.deepEqual(outcome.index?.skills, []);
});

test('K-03 配置写入：配置键不在可修改范围内时返回参数类问题', () => {
  const outcome = apply('tool_version', '9.9.9');
  assert.equal(outcome.index, null, '校验不通过时不得给出可写入的索引');
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
  assert.match(String(outcome.findings[0]?.remedy), /skill_roots/);
});

test('K-03 配置写入：根目录列表为空时拒绝', () => {
  for (const value of ['', ' , ', ',']) {
    const outcome = apply('skill_roots', value);
    assert.deepEqual(
      outcome.findings.map((item) => item.code),
      [CODES.INPUT_INVALID_ARG],
      `取值 ${JSON.stringify(value)} 应被拒绝`,
    );
  }
});

test('K-03 配置写入：根目录越出工作区时按路径类问题拒绝', () => {
  const outcome = apply('skill_roots', '../outside');
  assert.equal(outcome.index, null);
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.PATH_INVALID],
  );
});

test('K-03 配置写入：落位方式取值域受限', () => {
  const outcome = apply('default_mode', '硬链接');
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
  assert.match(String(outcome.findings[0]?.remedy), /copy 或 link/);
});

test('K-03 配置写入：默认目标不能为空', () => {
  const outcome = apply('default_target', '   ');
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
});
