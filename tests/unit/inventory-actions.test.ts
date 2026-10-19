import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  HostRootRole,
  InventoryClassificationKey,
  MissingInventoryCopy,
  ReconciledInventoryCopy,
} from '@skill-manager/contract';
import {
  inventoryActionPath,
  inventoryActionsFor,
} from '../../gui/renderer/src/inventory-actions.ts';

function output(classification: InventoryClassificationKey) {
  if (classification === 'orphaned_with_workspace') {
    return {
      classification: 'orphaned' as const,
      orphaned: { copy_present: true, workspace_record_present: true },
    };
  }
  if (classification === 'orphaned_without_workspace') {
    return {
      classification: 'orphaned' as const,
      orphaned: { copy_present: true, workspace_record_present: false },
    };
  }
  return { classification };
}

function copy(
  classification: InventoryClassificationKey,
  hostGroup: 'builtin' | 'plugin' = 'builtin',
  role: HostRootRole = 'user',
): ReconciledInventoryCopy {
  return {
    host_group: hostGroup,
    root_role: role,
    path: `/hosts/${classification}`,
    reconciliation: {
      ...output(classification),
      ledger_source: 'none',
      authority: 'insufficient',
      evidence: { managed: 'insufficient', content: 'insufficient', source: 'insufficient' },
      reasons: [],
      drift_reasons: [],
      untracked_candidate: false,
    },
  } as ReconciledInventoryCopy;
}

function actions(
  classification: InventoryClassificationKey,
  hostGroup: 'builtin' | 'plugin' = 'builtin',
  role: HostRootRole = 'user',
) {
  return inventoryActionsFor(copy(classification, hostGroup, role));
}

test('T5 动作映射：分类到推荐动作', () => {
  assert.deepEqual(
    actions('untracked').map((item) => item.action),
    ['adopt'],
  );
  assert.deepEqual(
    actions('inferred_consistent').map((item) => item.action),
    ['track'],
  );
  assert.deepEqual(
    actions('drift').map((item) => item.action),
    ['repair', 'accept'],
  );
  assert.deepEqual(
    actions('missing').map((item) => item.action),
    ['repair', 'forget'],
  );
  assert.deepEqual(
    actions('not_distributed').map((item) => item.action),
    ['repair'],
  );
  assert.deepEqual(
    actions('orphaned_with_workspace').map((item) => item.action),
    ['repair'],
  );
  assert.deepEqual(
    actions('orphaned_without_workspace').map((item) => item.action),
    ['adopt', 'clean'],
  );
  assert.deepEqual(
    actions('unreadable').map((item) => item.action),
    ['repair', 'clean'],
  );
  assert.deepEqual(actions('managed_consistent'), []);
});

test('T5 动作映射：插件禁用 adopt/accept，破坏性动作标记', () => {
  const drift = actions('drift', 'plugin');
  assert.equal(drift.find((item) => item.action === 'accept')?.disabled, true);
  const untracked = actions('untracked', 'plugin');
  assert.equal(untracked[0]?.action, 'adopt');
  assert.equal(untracked[0]?.disabled, true);
  assert.equal(actions('missing')[0]?.destructive, false);
  assert.equal(actions('unreadable').find((item) => item.action === 'clean')?.destructive, true);
  assert.equal(actions('drift').find((item) => item.action === 'accept')?.destructive, true);
});

test('T5 动作路径：副本用 path，缺失记录用 target_path', () => {
  assert.equal(inventoryActionPath(copy('untracked')), '/hosts/untracked');
  const missing = {
    host_group: 'builtin',
    target_path: '/hosts/missing-target',
  } as MissingInventoryCopy;
  assert.equal(inventoryActionPath(missing), '/hosts/missing-target');
});

test('dogfood：system / platform / project 副本不提供任何写动作', () => {
  for (const role of ['system', 'platform', 'project'] as const) {
    for (const classification of [
      'untracked',
      'inferred_consistent',
      'drift',
      'inferred_drift',
      'missing',
      'orphaned_with_workspace',
      'orphaned_without_workspace',
      'unreadable',
      'not_distributed',
    ] as const) {
      assert.deepEqual(actions(classification, 'builtin', role), [], `${role}/${classification}`);
    }
  }
  assert.deepEqual(
    inventoryActionsFor({ ...copy('untracked'), root_role: undefined } as never),
    [],
  );
});
