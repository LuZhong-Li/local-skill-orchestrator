import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOLEAN_OPTIONS,
  REPEATABLE_OPTIONS,
  VALUE_OPTIONS,
  isRepeatableOption,
  parseArgs,
} from '../../kernel/dispatch/parsers/index.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

test('硬化：每个非可重复取值选项重复给出都按参数类错误拒绝', () => {
  const singleValued = [...VALUE_OPTIONS].filter((name) => !REPEATABLE_OPTIONS.has(name));
  assert.ok(singleValued.length > 0, '应存在单值取值选项');
  for (const name of singleValued) {
    const outcome = parseArgs(['list', `--${name}`, 'first', `--${name}`, 'second']);
    const repeated = outcome.findings.filter((item) =>
      item.message.includes(`选项重复给出：--${name}`),
    );
    assert.equal(repeated.length, 1, `--${name} 重复给出应报一条参数类错误`);
    assert.equal(repeated[0]?.code, 'E-INPUT-002', `--${name} 的重复问题应归参数类`);
    assert.equal(repeated[0]?.severity, 'error');
    // 不静默取最后值：重复时既不写入新值，也不覆盖既有值
    assert.equal(outcome.args.options[name], 'first', `--${name} 不应被后一个取值覆盖`);
  }
});

test('硬化：布尔选项重复给出同样按参数类错误拒绝（与取值选项同口径）', () => {
  for (const name of BOOLEAN_OPTIONS) {
    const outcome = parseArgs(['list', `--${name}`, `--${name}`]);
    const repeated = outcome.findings.filter((item) =>
      item.message.includes(`选项重复给出：--${name}`),
    );
    assert.equal(repeated.length, 1, `--${name} 重复给出应报一条参数类错误`);
    assert.equal(repeated[0]?.code, 'E-INPUT-002');
    assert.equal(outcome.args.options[name], true, `--${name} 仍按已给出处理，不因重复被撤销`);
  }
});

test('硬化：可重复选项仍按数组聚合，且登记与契约语法一致', () => {
  const aggregated = parseArgs(['scan', '--root', 'a', '--root', 'b']);
  assert.deepEqual(aggregated.findings, [], '可重复选项重复给出不报错');
  assert.deepEqual(aggregated.args.options['root'], ['a', 'b']);

  // 登记表自身的一致性：可重复项必须是取值选项
  for (const name of REPEATABLE_OPTIONS) {
    assert.equal(VALUE_OPTIONS.has(name), true, `可重复选项 ${name} 应同时是取值选项`);
    assert.equal(isRepeatableOption(name), true);
    assert.equal(BOOLEAN_OPTIONS.has(name), false, '布尔选项不支持重复聚合');
  }

  // 契约语法中的 `...` 与登记表一一对应：有 `...` 的必在登记表内，反之亦然
  const contract = read('docs/specification/cli-contract.md');
  const repeatableInContract = new Set(
    (contract.match(/--[a-z][a-z-]* <[^>]+>\.\.\./g) ?? []).map((item) =>
      (item.match(/--[a-z][a-z-]*/) as RegExpMatchArray)[0].replace(/^--/, ''),
    ),
  );
  assert.deepEqual(
    [...repeatableInContract].sort(),
    [...REPEATABLE_OPTIONS].sort(),
    '契约中标记为可重复的选项应与解析器登记表一致',
  );
});

test('硬化：契约写明重复给出的处理规则', () => {
  const contract = read('docs/specification/cli-contract.md');
  assert.match(contract, /重复给出的处理/, '契约应登记重复给出的处理');
  assert.match(contract, /不静默取最后值/, '契约应写明不静默取最后值');
});
