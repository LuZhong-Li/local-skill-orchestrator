import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InventoryCopyObservation,
  InventoryDiscoveryResult,
  InventoryRootObservation,
  MissingInventoryCopy,
  ReconciliationOutput,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
} from '@skill-manager/contract';
import { aggregateInventory } from '../../kernel/dispatch/scan/aggregate.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function reconciliation(classification: string): ReconciliationOutput {
  return {
    classification: classification as ReconciliationOutput['classification'],
    ledger_source: 'host_landings',
    authority: 'authoritative',
    evidence: { managed: 'authoritative', content: 'authoritative', source: 'authoritative' },
    reasons: [],
    drift_reasons: [],
    untracked_candidate: false,
  };
}

function root(
  role: InventoryRootObservation['root_role'],
  hostId: string,
): InventoryRootObservation {
  return {
    root_id: `${hostId}/${role}`,
    host_id: hostId,
    host_group: 'builtin',
    root_role: role,
    kind: 'skill',
    path: `/hosts/${hostId}/${role}`,
    recursive: false,
    origin: 'default',
    is_x_host: false,
    consumed_by: [hostId],
    configured: true,
    state: 'ok',
    readable: true,
    copy_count: 1,
    corrupt_count: 0,
  };
}

function copy(
  id: string,
  role: InventoryRootObservation['root_role'],
  hostId: string,
  path: string,
  classification: string,
): ReconciledInventoryCopy {
  const observation: InventoryCopyObservation = {
    physical_key: path,
    path,
    host_id: hostId,
    host_group: 'builtin',
    root_id: `${hostId}/${role}`,
    root_role: role,
    format: 'skill',
    visibility: 'visible',
    recursive: false,
    skill_id: id,
    content_digest: DIGEST,
    readable: true,
    exists: true,
    consumed_by: [hostId],
    root_ids: [`${hostId}/${role}`],
    sources: [
      {
        host_id: hostId,
        host_group: 'builtin',
        root_id: `${hostId}/${role}`,
        root_role: role,
        recursive: false,
      },
    ],
  };
  return { ...observation, reconciliation: reconciliation(classification) };
}

function discovery(roots: InventoryRootObservation[]): InventoryDiscoveryResult {
  return {
    roots,
    copies: [],
    corrupt: [],
    summary: {
      roots_total: roots.length,
      roots_ok: roots.length,
      roots_empty: 0,
      roots_missing: 0,
      roots_unconfigured: 0,
      roots_unreadable: 0,
      roots_not_applicable: 0,
      copies_before_dedup: 0,
      copies_after_dedup: 0,
      corrupt_before_dedup: 0,
      corrupt_after_dedup: 0,
      duplicates_removed: 0,
      dedup_key: 'realpath+casefold',
    },
  };
}

test('M4c-4 聚合：user 主计数、unique_skills、role 分组与分类映射', () => {
  const roots = [
    root('user', 'claude'),
    root('system', 'codex'),
    root('platform', 'doubao'),
    root('project', 'cursor'),
  ];
  const copies = [
    copy('alpha', 'user', 'claude', '/hosts/claude/user/alpha', 'managed_consistent'),
    copy('alpha', 'user', 'claude', '/hosts/claude/user/alpha-copy', 'inferred_consistent'),
    copy('beta', 'user', 'claude', '/hosts/claude/user/beta', 'drift'),
    copy('alpha', 'system', 'codex', '/hosts/codex/system/alpha', 'managed_consistent'),
    copy('alpha', 'platform', 'doubao', '/hosts/doubao/platform/alpha', 'managed_consistent'),
    copy('beta', 'project', 'cursor', '/hosts/cursor/project/beta', 'managed_consistent'),
  ];
  const corrupt: ReconciledInventoryCorruptCopy = {
    ...copy('bad', 'user', 'claude', '/hosts/claude/user/bad', 'unreadable'),
    reason: 'bad_yaml',
  };
  const missing: MissingInventoryCopy = {
    ...reconciliation('missing'),
    host_id: 'claude',
    host_group: 'builtin',
    root_id: 'claude/user',
    root_role: 'user',
    target_path: '/hosts/claude/user/gone',
    skill_id: 'gone',
    consumed_by: ['claude'],
    is_x_host: false,
  };
  const summary = aggregateInventory({
    discovery: discovery(roots),
    copies,
    corrupt: [corrupt],
    missing: [missing],
  });
  assert.deepEqual(summary.summary.main, { total_copies: 3, unique_skills: 2 });
  assert.equal(summary.summary.roles.user.total_copies, 3);
  assert.equal(summary.summary.roles.user.unique_skills, 2);
  assert.equal(summary.summary.roles.user.corrupt_count, 1);
  assert.equal(summary.summary.roles.user.groups.managed.total, 2);
  assert.equal(summary.summary.roles.user.groups.managed.authoritative, 1);
  assert.equal(summary.summary.roles.user.groups.managed.inferred, 1);
  assert.equal(summary.summary.roles.user.groups.drift.total, 1);
  assert.equal(summary.summary.roles.user.groups.missing, 1);
  assert.equal(summary.summary.roles.system.total_copies, 1);
  assert.equal(summary.summary.roles.platform.unique_skills, 1);
  assert.equal(summary.summary.roles.project.total_copies, 1);
  assert.equal(summary.summary.classification_groups.managed.total, 5);
  assert.equal(summary.summary.classification_groups.untracked, 0);
  assert.equal(summary.hosts.length, 4);
});

test('M4c-4 聚合：损坏只进 corrupt_count，missing 不增加有效副本', () => {
  const roots = [root('user', 'claude')];
  const corrupt: ReconciledInventoryCorruptCopy = {
    ...copy('bad', 'user', 'claude', '/hosts/claude/user/bad', 'unreadable'),
    reason: 'missing_name',
  };
  const missing: MissingInventoryCopy = {
    ...reconciliation('missing'),
    host_id: 'claude',
    host_group: 'builtin',
    root_id: 'claude/user',
    root_role: 'user',
    target_path: '/hosts/claude/user/gone',
    skill_id: 'gone',
    consumed_by: ['claude'],
    is_x_host: false,
  };
  const result = aggregateInventory({
    discovery: discovery(roots),
    copies: [],
    corrupt: [corrupt],
    missing: [missing],
  });
  assert.deepEqual(result.summary.main, { total_copies: 0, unique_skills: 0 });
  assert.equal(result.summary.roles.user.corrupt_count, 1);
  assert.equal(result.summary.roles.user.groups.missing, 1);
  assert.equal(result.summary.roles.user.by_classification.unreadable, 0);
});
