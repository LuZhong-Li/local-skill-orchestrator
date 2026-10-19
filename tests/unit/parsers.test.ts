import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOLEAN_OPTIONS, parseArgs, VALUE_OPTIONS } from '../../kernel/dispatch/parsers/index.ts';
import { CODES } from '@skill-manager/contract';

test('L2 参数解析：布尔选项与取值选项分别归位', () => {
  const { args, findings } = parseArgs([
    'install',
    'src',
    '--workspace',
    '/w',
    '--yes',
    '--dry-run',
    '--hard',
  ]);
  assert.deepEqual(findings, []);
  assert.equal(args.command, 'install');
  assert.deepEqual(args.positionals, ['src']);
  assert.equal(args.options['workspace'], '/w');
  assert.equal(args.options['yes'], true);
  assert.equal(args.options['dry-run'], true);
  assert.equal(args.options['hard'], true);
});

test('L2 参数解析：未知选项按参数类问题拒绝，不再吞掉后续位置参数', () => {
  const { args, findings } = parseArgs(['list', '--sttae', 'enabled', '--workspace', '/w']);
  assert.deepEqual(
    findings.map((item) => item.code),
    [CODES.INPUT_INVALID_ARG],
  );
  assert.equal(findings[0]?.severity, 'error');
  assert.match(String(findings[0]?.message), /--sttae/);
  assert.deepEqual(args.positionals, ['enabled'], '未知选项不应把后一个参数当成自己的取值');
  assert.equal(args.options['workspace'], '/w', '后续合法选项仍被正常解析');
});

test('L2 参数解析：可重复选项聚合为数组', () => {
  const { args, findings } = parseArgs(['scan', '--root', 'a', '--root', 'b']);
  assert.deepEqual(findings, []);
  assert.deepEqual(args.options['root'], ['a', 'b']);
});

test('L2 参数解析：两层指令只在 config 下成立', () => {
  assert.equal(parseArgs(['config', 'get']).args.command, 'config get');
  assert.equal(parseArgs(['config', 'set', 'k', 'v']).args.command, 'config set');
  assert.deepEqual(parseArgs(['config', 'set', 'k', 'v']).args.positionals, ['k', 'v']);
  const other = parseArgs(['scan', 'get']);
  assert.equal(other.args.command, 'scan');
  assert.deepEqual(other.args.positionals, ['get'], '其它指令的第二个词是位置参数');
});

test('L2 参数解析：布尔与取值选项的登记集合不含重叠项', () => {
  const overlap = [...BOOLEAN_OPTIONS].filter((name) => VALUE_OPTIONS.has(name));
  assert.deepEqual(overlap, [], '同一个选项不能既当布尔又当取值选项');
});
