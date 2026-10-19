import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('契约：reconcile 写动作只对 user 角色生效，非 user 统一 skip', () => {
  const contract = read('contract/src/reconcile.ts');
  assert.match(contract, /RECONCILE_REASON_NON_USER_ROLE = 'non_user_role_read_only'/);
  assert.match(contract, /root_roles: HostRootRole\[\]/);

  const plan = read('kernel/dispatch/reconcile/plan.ts');
  assert.match(plan, /function nonUserRoleReason/);
  assert.match(
    plan,
    /nonUserRoleReason\(candidate\) \?\?\s*actionEligibilityReason/,
    '角色检查必须先于分类 / 基线 / 动作适配判断',
  );
  assert.match(plan, /RECONCILE_WARNING_SHARED_NON_USER_ROLE/);

  const execute = read('kernel/dispatch/reconcile/execute.ts');
  assert.match(execute, /function nonUserRoleFailure/);
  assert.match(execute, /root_roles\.every\(\(role\) => role === 'user'\)/);

  const view = read('gui/renderer/src/components/HostInventoryView.vue');
  assert.match(view, /copy\.root_role === 'user'/);
  const menu = read('gui/renderer/src/components/host-inventory/InventoryActionMenu.vue');
  assert.match(menu, /由对应工具管理/);

  const cliContract = read('docs/specification/cli-contract.md');
  assert.match(cliContract, /non_user_role_read_only/);
  assert.match(cliContract, /root_roles/);
  const probe = read('scripts/probe-reconcile-actions.mjs');
  assert.match(probe, /角色写保护 skipped/);
});
