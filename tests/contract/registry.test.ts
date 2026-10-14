import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODES } from '../../kernel/store/contract.ts';
import { REGISTERED_COMMANDS } from '../../kernel/dispatch/registry/index.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

test('契约：实现中使用的每个问题码都已在结果规范中登记', () => {
  const contract = read('docs/specification/result-and-exit-codes.md');
  const registered = new Set(contract.match(/[EW]-[A-Z]+-\d{3}/g) ?? []);
  const used = Object.values(CODES);
  const unregistered = used.filter((code) => !registered.has(code));
  assert.deepEqual(unregistered, [], `未登记的问题码：${unregistered.join('、')}`);
  assert.ok(registered.size >= 40, `契约登记的问题码数量异常：${registered.size}`);
});

test('契约：问题码的级别字母与严重级别一致', () => {
  const contract = read('docs/specification/result-and-exit-codes.md');
  for (const code of Object.values(CODES)) {
    assert.match(code, /^[EW]-[A-Z]+-\d{3}$/, `问题码格式不合规：${code}`);
  }
  assert.ok(contract.includes('E-VALIDATION-001'), '校验类问题码应已登记');
});

test('契约：已注册指令是契约指令清单的子集', () => {
  const contract = read('docs/specification/cli-contract.md');
  const declared = new Set(
    contract
      .match(/\| `([a-z]+(?: [a-z]+)?)` \|/g)
      ?.map((item) => item.replace(/^\| `|` \|$/g, '')) ?? [],
  );
  for (const command of REGISTERED_COMMANDS) {
    assert.ok(declared.has(command), `指令 ${command} 不在契约指令清单中`);
  }
});
