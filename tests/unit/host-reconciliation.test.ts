import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/temp.ts';
import { reconcileHostCopy } from '../../kernel/core/host-landings/reconcile.ts';
import { loadHostLandings } from '../../kernel/store/host-landings/index.ts';
import type {
  ReconciliationInput,
  ReconciliationLedgerRecord,
  ReconciliationWorkspaceRecord,
} from '../../contract/src/index.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const TARGET = '/virtual/hosts/alpha';

const workspace: ReconciliationWorkspaceRecord = {
  skill_id: 'alpha',
  version: '1.0.0',
  source_ref: 'main',
  checksum: DIGEST,
  expected_content_digest: DIGEST,
  expected_visibility: 'visible',
};

const hostLedger: ReconciliationLedgerRecord = {
  source: 'host_landings',
  state: 'active',
  target_path: TARGET,
  content_digest: DIGEST,
  source_checksum: DIGEST,
  source_version: '1.0.0',
  source_ref: 'main',
  visibility: 'visible',
  format: 'skill',
};

function input(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    observed: {
      host_id: 'claude',
      target_path: TARGET,
      exists: true,
      readable: true,
      format: 'skill',
      visibility: 'visible',
      content_digest: DIGEST,
      skill_id: 'alpha',
      version: '1.0.0',
    },
    ledger: hostLedger,
    ledger_state: 'ok',
    workspace: { state: 'ok', record: workspace },
    root_readable: true,
    ...overrides,
  };
}

test('对账：host_landings active 一致为三轴权威 managed', () => {
  const result = reconcileHostCopy(input());
  assert.equal(result.classification, 'managed_consistent');
  assert.equal(result.ledger_source, 'host_landings');
  assert.deepEqual(result.evidence, {
    managed: 'authoritative',
    content: 'authoritative',
    source: 'authoritative',
  });
  assert.equal(result.authority, 'authoritative');
});

test('对账：host_landings 内容、可见性、来源与版本漂移', () => {
  const content = reconcileHostCopy(
    input({
      observed: { ...input().observed, content_digest: OTHER },
      workspace: {
        state: 'ok',
        record: { ...workspace, expected_content_digest: DIGEST },
      },
    }),
  );
  assert.equal(content.classification, 'drift');
  assert.ok(content.drift_reasons.includes('content_drift'));

  const visibility = reconcileHostCopy(
    input({ observed: { ...input().observed, visibility: 'disabled' } }),
  );
  assert.equal(visibility.classification, 'drift');
  assert.ok(visibility.drift_reasons.includes('visibility_mismatch'));

  const source = reconcileHostCopy(
    input({
      workspace: { state: 'ok', record: { ...workspace, checksum: OTHER } },
    }),
  );
  assert.equal(source.classification, 'drift');
  assert.ok(source.drift_reasons.includes('source_changed'));

  const version = reconcileHostCopy(
    input({
      workspace: { state: 'ok', record: { ...workspace, version: '2.0.0' } },
    }),
  );
  assert.equal(version.classification, 'drift');
  assert.ok(version.drift_reasons.includes('version_mismatch'));
});

test('对账：渲染基线变化不算漂移，content 降为 inferred', () => {
  const result = reconcileHostCopy(
    input({
      ledger: { ...hostLedger, content_digest: OTHER },
      workspace: {
        state: 'ok',
        record: { ...workspace, expected_content_digest: DIGEST },
      },
    }),
  );
  assert.equal(result.classification, 'managed_consistent');
  assert.ok(result.reasons.includes('render_baseline_changed'));
  assert.equal(result.evidence.content, 'inferred');
});

test('对账：active 缺失与不可读分别为 missing / unreadable', () => {
  const missing = reconcileHostCopy(input({ observed: { ...input().observed, exists: false } }));
  assert.equal(missing.classification, 'missing');
  assert.equal(missing.evidence.managed, 'authoritative');

  const unreadable = reconcileHostCopy(
    input({
      observed: {
        ...input().observed,
        readable: false,
        unreadable_reason: 'invalid_skill_file',
      },
    }),
  );
  assert.equal(unreadable.classification, 'unreadable');
  assert.equal(unreadable.evidence.managed, 'authoritative');
  assert.ok(unreadable.reasons.includes('invalid_skill_file'));
});

test('对账：orphaned 副本残留区分工作区在/不在', () => {
  const present = reconcileHostCopy(input({ ledger: { ...hostLedger, state: 'orphaned' } }));
  assert.equal(present.classification, 'orphaned');
  assert.deepEqual(present.orphaned, { copy_present: true, workspace_record_present: true });
  assert.equal(present.evidence.managed, 'insufficient');
  assert.equal(present.evidence.content, 'inferred');
  assert.ok(present.reasons.includes('orphaned_inferred_consistent'));

  const absent = reconcileHostCopy(
    input({
      ledger: { ...hostLedger, state: 'orphaned' },
      workspace: { state: 'ok' },
    }),
  );
  assert.equal(absent.classification, 'orphaned');
  assert.equal(absent.untracked_candidate, true);
  assert.ok(absent.reasons.includes('workspace_record_absent'));

  const missingCopy = reconcileHostCopy(
    input({
      ledger: { ...hostLedger, state: 'orphaned' },
      observed: { ...input().observed, exists: false },
    }),
  );
  assert.equal(missingCopy.classification, 'orphaned');
  assert.deepEqual(missingCopy.orphaned, {
    copy_present: false,
    workspace_record_present: true,
  });
});

test('对账：无账本 inferred 一致 / 漂移 / untracked / not_distributed', () => {
  const consistent = reconcileHostCopy(input({ ledger: undefined, ledger_state: 'missing' }));
  assert.equal(consistent.classification, 'inferred_consistent');
  assert.deepEqual(consistent.evidence, {
    managed: 'inferred',
    content: 'inferred',
    source: 'inferred',
  });

  const drift = reconcileHostCopy(
    input({
      ledger: undefined,
      ledger_state: 'missing',
      observed: { ...input().observed, content_digest: OTHER },
    }),
  );
  assert.equal(drift.classification, 'inferred_drift');
  assert.ok(drift.drift_reasons.includes('content_drift'));

  const untracked = reconcileHostCopy(
    input({
      ledger: undefined,
      ledger_state: 'missing',
      workspace: { state: 'ok' },
    }),
  );
  assert.equal(untracked.classification, 'untracked');
  assert.equal(untracked.untracked_candidate, true);
  assert.equal(untracked.evidence.managed, 'insufficient');

  const notDistributed = reconcileHostCopy(
    input({
      ledger: undefined,
      ledger_state: 'missing',
      observed: { ...input().observed, exists: false },
    }),
  );
  assert.equal(notDistributed.classification, 'not_distributed');
});

test('对账：无账本任何情形都不判 missing', () => {
  const cases = [
    input({ ledger: undefined, ledger_state: 'missing' }),
    input({ ledger: undefined, ledger_state: 'missing', workspace: { state: 'missing' } }),
    input({
      ledger: undefined,
      ledger_state: 'missing',
      observed: { ...input().observed, exists: false },
    }),
    input({
      ledger: undefined,
      ledger_state: 'missing',
      observed: { ...input().observed, readable: false },
    }),
  ];
  for (const item of cases) {
    assert.notEqual(reconcileHostCopy(item).classification, 'missing');
  }
});

test('对账：插件账本 managed/missing 权威，content/source 永不为 authoritative', () => {
  const plugin: ReconciliationLedgerRecord = {
    source: 'plugin_landings',
    state: 'active',
    target_path: TARGET,
  };
  const consistent = reconcileHostCopy(input({ ledger: plugin }));
  assert.equal(consistent.classification, 'managed_consistent');
  assert.equal(consistent.evidence.managed, 'authoritative');
  assert.notEqual(consistent.evidence.content, 'authoritative');
  assert.notEqual(consistent.evidence.source, 'authoritative');

  const drift = reconcileHostCopy(
    input({
      ledger: plugin,
      observed: { ...input().observed, content_digest: OTHER },
    }),
  );
  assert.equal(drift.classification, 'drift');
  assert.notEqual(drift.evidence.content, 'authoritative');
  assert.notEqual(drift.evidence.source, 'authoritative');

  const missing = reconcileHostCopy(
    input({ ledger: plugin, observed: { ...input().observed, exists: false } }),
  );
  assert.equal(missing.classification, 'missing');
  assert.equal(missing.evidence.managed, 'authoritative');

  const noBaseline = reconcileHostCopy(
    input({
      ledger: plugin,
      workspace: { state: 'ok', record: { skill_id: 'alpha' } },
    }),
  );
  assert.equal(noBaseline.classification, 'undetermined');
  assert.notEqual(noBaseline.evidence.content, 'authoritative');
  assert.notEqual(noBaseline.evidence.source, 'authoritative');
});

test('对账：无工作区只出 undetermined，三轴不足且不判 missing/drift', () => {
  const present = reconcileHostCopy(input({ workspace: { state: 'missing' } }));
  assert.equal(present.classification, 'undetermined');
  assert.equal(present.untracked_candidate, true);
  assert.deepEqual(present.evidence, {
    managed: 'insufficient',
    content: 'insufficient',
    source: 'insufficient',
  });

  const absent = reconcileHostCopy(
    input({
      workspace: { state: 'unreadable' },
      observed: { ...input().observed, exists: false },
    }),
  );
  assert.equal(absent.classification, 'undetermined');
  assert.notEqual(absent.classification, 'missing');
});

test('对账：根不可读与账本损坏安全降级', () => {
  const root = reconcileHostCopy(input({ root_readable: false }));
  assert.equal(root.classification, 'undetermined');
  assert.ok(root.reasons.includes('root_unreadable'));

  const corrupt = reconcileHostCopy(input({ ledger_state: 'unreadable' }));
  assert.equal(corrupt.classification, 'inferred_consistent');
  assert.ok(corrupt.reasons.includes('ledger_unavailable_degraded'));
  assert.notEqual(corrupt.evidence.managed, 'authoritative');

  const missingLedger = reconcileHostCopy(input({ ledger: undefined, ledger_state: 'missing' }));
  assert.equal(missingLedger.classification, 'inferred_consistent');
  assert.notEqual(missingLedger.evidence.managed, 'authoritative');
});

test('对账：实际损坏的 host_landings 加载失败后按无账本降级', () => {
  const file = join(makeTempDir('sm-reconcile-ledger-'), 'host_landings.yaml');
  writeFileSync(file, 'schema_version: "1"\nlandings: [\n');
  const loaded = loadHostLandings(file);
  assert.equal(loaded.index, null);
  const result = reconcileHostCopy(input({ ledger: undefined, ledger_state: 'unreadable' }));
  assert.equal(result.classification, 'inferred_consistent');
  assert.ok(result.reasons.includes('ledger_unavailable_degraded'));
  assert.notEqual(result.evidence.managed, 'authoritative');
});

test('对账：共享根的两个宿主视图各自独立分类', () => {
  const codex = reconcileHostCopy(input({ observed: { ...input().observed, host_id: 'codex' } }));
  const cursor = reconcileHostCopy(input({ observed: { ...input().observed, host_id: 'cursor' } }));
  assert.equal(codex.classification, 'managed_consistent');
  assert.equal(cursor.classification, 'managed_consistent');
});
