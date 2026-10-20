import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryOptionsError } from '../../kernel/dispatch/scan/inventory.ts';
import { scanPlanOf } from '../../kernel/dispatch/scan/options.ts';
import type { ParsedArgs } from '../../kernel/dispatch/parsers/index.ts';
import { inventoryRootsForAll, inventoryRootsForHost } from '../../kernel/core/hosts/inventory.ts';

function args(options: Record<string, string | true | string[]>): ParsedArgs {
  return { command: 'scan', positionals: [], options };
}

test('M4c-1 参数：inventory 与 kind/root/dry-run 互斥，workspace 与输出选项允许', () => {
  assert.equal(inventoryOptionsError(args({ inventory: true, workspace: '/w' })), null);
  assert.equal(inventoryOptionsError(args({ inventory: true, workspace: '/w', json: true })), null);
  assert.equal(
    inventoryOptionsError(args({ inventory: true, workspace: '/w', audit: true })),
    null,
  );
  assert.equal(
    inventoryOptionsError(args({ workspace: '/w', audit: true }))?.findings[0]?.target,
    '--audit',
  );
  for (const [name, value] of [
    ['kind', 'skill'],
    ['root', ['skills']],
    ['dry-run', true],
  ] as const) {
    const rejected = inventoryOptionsError(args({ inventory: true, [name]: value }));
    assert.equal(rejected?.exit_code, 2, `${name} 应按参数类错误拒绝`);
    assert.match(rejected?.findings[0]?.message ?? '', /--inventory 与 --/);
  }
  const positional = inventoryOptionsError({
    ...args({ inventory: true }),
    positionals: ['unexpected'],
  });
  assert.equal(positional?.exit_code, 2, '位置参数应按参数类错误拒绝');
  const plan = scanPlanOf(args({ inventory: true, workspace: '/w', audit: true }));
  assert.equal(plan.mode, 'inventory');
  assert.equal(plan.audit, true);
});

test('M4c-1 根解析：环境变量缺失时保留根并标记原因，不抛错', () => {
  const context = {
    workspaceRoot: '/work',
    home: '/home/u',
    platform: 'win32' as const,
    env: {},
  };
  const doubao = inventoryRootsForHost('doubao', context);
  assert.equal(doubao.length, 2);
  for (const root of doubao) {
    assert.equal(root.path, '');
    assert.equal(root.configured, false);
    assert.equal(root.reason, 'missing_environment');
  }
  assert.doesNotThrow(() => inventoryRootsForAll(context));
});
