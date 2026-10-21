import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  HostRootRole,
  InventoryClassificationKey,
  ReconciledInventoryCopy,
} from '@skill-manager/contract';
import {
  availableBatchActions,
  batchTargetOf,
  copyKey,
  isCopySelectable,
  type BatchSelectionState,
} from '../../gui/renderer/src/inventory-batch.ts';

function copy(
  id: string,
  classification: InventoryClassificationKey,
  options: {
    role?: HostRootRole;
    hostGroup?: 'builtin' | 'plugin';
  } = {},
): ReconciledInventoryCopy {
  const role = options.role ?? 'user';
  const hostGroup = options.hostGroup ?? 'builtin';
  return {
    physical_key: `/host/${id}`,
    path: `/host/${id}`,
    host_id: hostGroup === 'plugin' ? 'x-test' : 'claude',
    host_group: hostGroup,
    root_id: `${hostGroup}/${role}`,
    root_role: role,
    format: 'skill',
    visibility: 'visible',
    recursive: false,
    skill_id: id,
    version: '1.0.0',
    readable: true,
    exists: true,
    consumed_by: [],
    root_ids: [`${hostGroup}/${role}`],
    sources: [],
    reconciliation: {
      classification,
      ledger_source: 'none',
      authority: 'insufficient',
      evidence: {
        managed: 'insufficient',
        content: 'insufficient',
        source: 'insufficient',
      },
      reasons: [],
      drift_reasons: [],
      untracked_candidate: classification === 'untracked',
    },
  };
}

function selection(keys: string[]): BatchSelectionState {
  return { selected: new Set(keys) };
}

test('T7 批量：只有 user 且存在可执行动作的副本可选', () => {
  const user = copy('user-copy', 'untracked');
  const system = copy('system-copy', 'untracked', { role: 'system' });
  const plugin = copy('plugin-copy', 'untracked', { hostGroup: 'plugin' });

  assert.equal(isCopySelectable(user), true);
  assert.equal(isCopySelectable(system), false);
  assert.equal(isCopySelectable(plugin), false);
});

test('T7 批量：动作取选中副本的共同可执行动作', () => {
  const first = copy('first', 'untracked');
  const second = copy('second', 'untracked');
  const drift = copy('drift', 'drift');
  const state = selection([copyKey(first), copyKey(second)]);

  assert.deepEqual(
    availableBatchActions(state, [first, second]).map((item) => item.action),
    ['adopt'],
  );
  assert.deepEqual(
    availableBatchActions(selection([copyKey(first), copyKey(drift)]), [first, drift]),
    [],
  );
});

test('T7 批量：missing 副本使用稳定的 target_path 键', () => {
  const path = '/host/missing-skill';
  assert.equal(
    copyKey({
      host_id: 'claude',
      host_group: 'builtin',
      target_path: path,
      classification: 'missing',
      ledger_source: 'host_landings',
      authority: 'authoritative',
      evidence: {
        managed: 'authoritative',
        content: 'authoritative',
        source: 'authoritative',
      },
      reasons: [],
      drift_reasons: [],
      untracked_candidate: false,
      consumed_by: [],
      is_x_host: false,
    }),
    `missing:claude:${path}`,
  );
});

test('T7 批量：普通副本按 path 收敛，not_distributed 按 id+host 收敛', () => {
  assert.deepEqual(batchTargetOf(copy('ordinary', 'untracked')), {
    path: '/host/ordinary',
  });
  const missing = {
    host_id: 'codex',
    host_group: 'builtin' as const,
    target_path: '/host/target/skill',
    classification: 'not_distributed' as const,
    ledger_source: 'none' as const,
    authority: 'insufficient' as const,
    evidence: {
      managed: 'insufficient' as const,
      content: 'insufficient' as const,
      source: 'insufficient' as const,
    },
    reasons: [],
    drift_reasons: [],
    untracked_candidate: false,
    consumed_by: [],
    is_x_host: false,
    skill_id: 'target-skill',
  };
  assert.deepEqual(batchTargetOf(missing), {
    id: 'target-skill',
    host: 'codex',
  });
});
