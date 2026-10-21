import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  InventoryAuditRow,
  InventoryAuditStatus,
  ReconcilePlanSummary,
  ReconcileSelection,
  ReconcileSelectionSummary,
} from '@skill-manager/contract';
import { normalizeAdoptFrontmatter } from '../../kernel/dispatch/reconcile/adopt-frontmatter.ts';

test('M5 T9 contract：batch selection、展开摘要与执行摘要字段闭合', () => {
  const selection: ReconcileSelection = {
    mode: 'batch',
    action: 'repair',
    ids: ['alpha', 'beta'],
    roles: ['user', 'project'],
    roots: [],
    apply: false,
  };
  const selectionSummary: ReconcileSelectionSummary = {
    total: 4,
    by_skill: { alpha: 2, beta: 2 },
    by_root: { 'claude/user': 2, project: 2 },
    by_role: { user: 2, project: 2 },
    by_host: { claude: 2, codex: 2 },
    by_classification: { missing: 4 },
  };
  const planSummary: ReconcilePlanSummary = {
    selected: selectionSummary.total,
    planned: 3,
    skipped: 1,
    destructive: 0,
    shared_groups: 1,
    succeeded: 2,
    failed: 1,
    cancelled: 0,
    duration_ms: 12,
  };

  assert.deepEqual(selection.ids, ['alpha', 'beta']);
  assert.deepEqual(selection.roles, ['user', 'project']);
  assert.equal(
    Object.values(selectionSummary.by_skill).reduce((sum, count) => sum + count, 0),
    selectionSummary.total,
  );
  assert.equal(
    (planSummary.succeeded ?? 0) +
      (planSummary.failed ?? 0) +
      (planSummary.skipped ?? 0) +
      (planSummary.cancelled ?? 0),
    planSummary.selected,
  );
});

test('M5 T9 contract：audit 八种状态与行字段保持稳定', () => {
  const statuses: InventoryAuditStatus[] = [
    'distributed',
    'missing',
    'drift',
    'visibility_mismatch',
    'undeclared',
    'unmapped',
    'workspace_only',
    'insufficient',
  ];
  const row: InventoryAuditRow = {
    skill_id: 'alpha',
    target: 'claude',
    scope: 'global',
    host_id: 'claude',
    expected_enabled: true,
    ledger_state: 'missing',
    target_path: '.claude/skills/alpha',
    status: 'missing',
    evidence: {
      managed: 'authoritative',
      content: 'insufficient',
      source: 'insufficient',
    },
    reasons: ['ledger_missing'],
    observed_at: '2026-10-20T00:00:00Z',
  };

  assert.equal(new Set(statuses).size, 8);
  assert.equal(statuses.includes('visibility_mismatch'), true);
  for (const key of [
    'skill_id',
    'target',
    'scope',
    'expected_enabled',
    'ledger_state',
    'status',
    'evidence',
    'reasons',
    'observed_at',
  ]) {
    assert.equal(key in row, true, `audit row 缺少 ${key}`);
  }
});

test('M5 T9 contract：frontmatter 六字段归一化并将 metadata author/version 提升', () => {
  const normalized = normalizeAdoptFrontmatter(
    {
      name: 'alpha',
      description: 'Alpha skill',
      license: 'MIT',
      compatibility: 'Agent Skills',
      'allowed-tools': 'Read Grep',
      metadata: {
        author: 'Metadata Author',
        version: '2.3.4',
        custom: { nested: true },
      },
      activation: { trigger: 'manual' },
    },
    '/hosts/claude/alpha/SKILL.md',
  );

  assert.equal(normalized.skillId, 'alpha');
  assert.equal(normalized.description, 'Alpha skill');
  assert.equal(normalized.license, 'MIT');
  assert.equal(normalized.compatibility, 'Agent Skills');
  assert.equal(normalized.allowedTools, 'Read Grep');
  assert.equal(normalized.author, 'Metadata Author');
  assert.equal(normalized.version, '2.3.4');
  assert.deepEqual(normalized.metadata, {
    author: 'Metadata Author',
    version: '2.3.4',
    custom: { nested: true },
  });
  assert.deepEqual(normalized.extensions, { activation: { trigger: 'manual' } });
  assert.ok(normalized.findings.some((item) => item.target.endsWith(':activation')));
});
