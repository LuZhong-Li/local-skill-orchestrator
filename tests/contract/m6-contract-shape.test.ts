import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type {
  DriftSubtype,
  FrontmatterFieldDiff,
  InventoryAuditRow,
  InventoryAuditSummary,
  VersionDiff,
} from '../../contract/src/host-inventory.ts';
import type { AuditReportDocument, AuditReportFormat } from '../../contract/src/audit-report.ts';
import type {
  AdoptConflictPolicy,
  AdoptPreview,
  BulkAdoptSelection,
  BulkAdoptPolicy,
  ReconcileSelection,
} from '../../contract/src/reconcile.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

test('M6 T0：旧 audit payload 不需要新增字段', () => {
  const row: InventoryAuditRow = {
    skill_id: 'alpha',
    target: 'claude',
    scope: 'global',
    host_id: 'claude',
    expected_enabled: true,
    ledger_state: 'active',
    status: 'distributed',
    evidence: { managed: 'authoritative', content: 'authoritative', source: 'authoritative' },
    reasons: [],
    observed_at: '2026-10-23T00:00:00Z',
  };
  const summary: InventoryAuditSummary = {
    declared: 1,
    distributed: 1,
    missing: 0,
    drift: 0,
    visibility_mismatch: 0,
    undeclared: 0,
    unmapped: 0,
    workspace_only: 0,
    insufficient: 0,
  };
  assert.equal(row.status, 'distributed');
  assert.equal(summary.drift_by_subtype, undefined);
});

test('M6 T0：drift 细节类型为可选加法', () => {
  const subtype: DriftSubtype = 'frontmatter';
  const diff: FrontmatterFieldDiff = {
    field: 'description',
    values: [
      { host: 'claude', role: 'user', value: 'one' },
      { host: 'codex', role: 'user', value: 'two' },
    ],
  };
  const version: VersionDiff = {
    values: [
      { host: 'claude', role: 'user', version: '1.0.0' },
      { host: 'codex', role: 'user', version: null },
    ],
  };
  const row: InventoryAuditRow = {
    skill_id: 'alpha',
    target: 'claude',
    scope: 'global',
    expected_enabled: true,
    ledger_state: 'active',
    status: 'drift',
    evidence: { managed: 'authoritative', content: 'inferred', source: 'authoritative' },
    reasons: [],
    observed_at: '2026-10-23T00:00:00Z',
    drift_subtype: subtype,
    frontmatter_diffs: [diff],
    version_diff: version,
  };
  const summary: InventoryAuditSummary = {
    declared: 1,
    distributed: 0,
    missing: 0,
    drift: 1,
    visibility_mismatch: 0,
    undeclared: 0,
    unmapped: 0,
    workspace_only: 0,
    insufficient: 0,
    drift_by_subtype: { checksum: 0, frontmatter: 1, version: 0 },
  };
  assert.equal(row.drift_subtype, 'frontmatter');
  assert.equal(summary.drift_by_subtype?.frontmatter, 1);
  assert.match(read('contract/src/host-inventory.ts'), /drift_subtype\?: DriftSubtype/);
});

test('M6 T0：bulk adopt 与 report 类型已登记', () => {
  const policy: BulkAdoptPolicy = {
    enabled: true,
    roles: ['user'],
    limit: 10,
    conflict: 'skip',
    dry_run: true,
  };
  const conflict: AdoptConflictPolicy = policy.conflict;
  const preview: AdoptPreview = {
    source_path: '/hosts/claude/skills/alpha',
    requested_skill_id: 'alpha',
    target_skill_id: 'alpha',
    description: 'alpha skill',
    version: null,
    conflict: 'none',
    conflict_policy: conflict,
  };
  const candidates: BulkAdoptSelection = [
    {
      skill_id: 'alpha',
      source_path: '/hosts/claude/skills/alpha',
      host: 'claude',
      role: 'user',
      target_path: '/workspace/skills/alpha',
      conflict: 'none',
    },
  ];
  const selection: ReconcileSelection = {
    mode: 'batch',
    action: 'adopt',
    roots: [],
    apply: false,
    bulk: true,
    limit: 10,
    conflict: 'skip',
  };
  const format: AuditReportFormat = 'json';
  const document: AuditReportDocument = {
    format,
    media_type: 'application/json',
    extension: 'json',
    content: '{}',
  };
  assert.equal(candidates[0]?.skill_id, 'alpha');
  assert.equal(preview.target_skill_id, 'alpha');
  assert.equal(selection.bulk, true);
  assert.equal(format, 'json');
  assert.equal(document.media_type, 'application/json');
  assert.match(read('contract/src/reconcile.ts'), /export type BulkAdoptSelection/);
  assert.equal(existsSync(join(root, 'contract/src/audit-report.ts')), true);
});

test('M6 T0：CLI 契约登记 bulk adopt 与报告输出', () => {
  const contract = read('docs/specification/cli-contract.md');
  assert.match(contract, /--bulk/);
  assert.match(contract, /--limit <N>/);
  assert.match(contract, /--rename/);
  assert.match(contract, /--force/);
  assert.match(contract, /--format <markdown\|html\|sarif>/);
  assert.match(contract, /--output <路径>/);
  assert.match(contract, /--format.*--json.*互斥/s);
});
