import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml } from '../../kernel/store/yaml/index.ts';
import { KernelError } from '../../kernel/store/errors.ts';
import { CODES } from '@skill-manager/contract';

const ctx = { source: 'test', target: 'test.yaml' };

test('R1 解析合法 YAML 得到映射', () => {
  const value = parseYaml('id: code-review\nname: code-review\n', ctx);
  assert.equal(value['id'], 'code-review');
  assert.equal(value['name'], 'code-review');
});

test('R2 顶层不是映射时判为语法问题', () => {
  assert.throws(
    () => parseYaml('- a\n- b\n', ctx),
    (error: unknown) => error instanceof KernelError && error.code === CODES.YAML_INVALID,
  );
});

test('R3 重复键判为语法问题', () => {
  assert.throws(
    () => parseYaml('id: a\nid: b\n', ctx),
    (error: unknown) => error instanceof KernelError && error.code === CODES.YAML_INVALID,
  );
});

test('R4 空内容判为语法问题', () => {
  assert.throws(
    () => parseYaml('', ctx),
    (error: unknown) => error instanceof KernelError && error.code === CODES.YAML_INVALID,
  );
});

test('R5 序列化保持字段顺序，便于逐行比对', () => {
  const text = stringifyYaml({ b: 1, a: 2, c: 3 });
  assert.deepEqual(
    text
      .trim()
      .split('\n')
      .map((line) => line.split(':')[0]),
    ['b', 'a', 'c'],
  );
});

test('R6 序列化不使用锚点与别名', () => {
  const shared = { x: 1 };
  const text = stringifyYaml({ first: shared, second: shared });
  assert.ok(!text.includes('&'), '不应出现锚点');
  assert.ok(!text.includes('*'), '不应出现别名');
});
