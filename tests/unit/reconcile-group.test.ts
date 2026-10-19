import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type {
  InventoryCopyObservation,
  ReconciliationOutput,
  ReconcileSelection,
} from '@skill-manager/contract';
import { allCandidates } from '../../kernel/dispatch/reconcile/candidates.ts';
import { buildReconcilePreview } from '../../kernel/dispatch/reconcile/plan.ts';
import type { InventorySnapshot } from '../../kernel/dispatch/scan/inventory.ts';
import { makeTempDir } from '../helpers/temp.ts';

function reconciliation(): ReconciliationOutput {
  return {
    classification: 'managed_consistent',
    ledger_source: 'host_landings',
    authority: 'authoritative',
    evidence: { managed: 'authoritative', content: 'authoritative', source: 'authoritative' },
    reasons: [],
    drift_reasons: [],
    untracked_candidate: false,
  };
}

function copy(hostId: string, format: 'skill' | 'rules', rootId: string): InventoryCopyObservation {
  return {
    physical_key: 'same-physical-key',
    path: 'same-path',
    host_id: hostId,
    host_group: 'builtin',
    root_id: rootId,
    root_role: 'user',
    format,
    visibility: 'visible',
    recursive: false,
    skill_id: 'demo',
    content_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    readable: true,
    exists: true,
    consumed_by: [hostId],
    root_ids: [rootId],
    sources: [
      {
        host_id: hostId,
        host_group: 'builtin',
        root_id: rootId,
        root_role: 'user',
        recursive: false,
      },
    ],
  };
}

test('T4 candidate：同一物理副本不同 form 标记冲突，计划拒绝而不是任选', () => {
  const root = makeTempDir('sm-t4-group-unit-');
  const snapshot = {
    layout: {
      root,
      indexFile: join(root, 'skill_index.yaml'),
      skillsDir: join(root, 'skills'),
      pluginsDir: join(root, 'plugins'),
      backupsDir: join(root, 'backups'),
      locksDir: join(root, 'locks'),
      logsDir: join(root, 'logs'),
      pluginIndexFile: join(root, 'plugin_index.yaml'),
      hostLandingsFile: join(root, 'host_landings.yaml'),
    },
    workspace: { state: 'ok', index: null, config: {}, findings: [] },
    roots: [],
    discovered: { roots: [], copies: [], corrupt: [], summary: {} },
    reconciled: {
      copies: [
        {
          ...copy('codex', 'skill', 'codex/root'),
          reconciliation: reconciliation(),
        },
        {
          ...copy('cursor-rules', 'rules', 'cursor/rules'),
          reconciliation: reconciliation(),
        },
      ],
      corrupt: [],
      missing: [],
      degradation: { host_landings: 'missing', plugin_landings: 'missing' },
    },
    aggregated: {},
    findings: [],
  } as unknown as InventorySnapshot;

  const candidates = allCandidates(snapshot);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.format_conflict, true);

  const selection: ReconcileSelection = {
    mode: 'classification',
    action: 'clean',
    classification: 'managed_consistent',
    roots: [],
    apply: false,
  };
  const plan = buildReconcilePreview(snapshot, selection);
  assert.equal(plan.items[0]?.status, 'skipped');
  assert.equal(plan.items[0]?.reason, 'shared_root_form_conflict');
});
