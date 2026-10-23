import assert from 'node:assert/strict';
import test from 'node:test';
import type { InventoryAuditData, InventoryAuditRow } from '@skill-manager/contract';
import { buildAuditMatrix } from '../../gui/renderer/src/audit-matrix.ts';

function row(input: Partial<InventoryAuditRow> & Pick<InventoryAuditRow, 'skill_id' | 'target'>) {
  return {
    scope: 'global',
    host_id: input.target,
    expected_enabled: true,
    ledger_state: 'active',
    status: 'distributed',
    evidence: {
      managed: 'authoritative',
      content: 'authoritative',
      source: 'authoritative',
    },
    reasons: [],
    observed_at: '2026-10-23T00:00:00Z',
    ...input,
  } as InventoryAuditRow;
}

test('M6 GUI matrix：按 skill 分组、host 排序并保留同宿主多行证据', () => {
  const audit: InventoryAuditData = {
    observed_at: '2026-10-23T00:00:00Z',
    summary: {
      declared: 2,
      distributed: 1,
      missing: 1,
      drift: 1,
      visibility_mismatch: 0,
      undeclared: 0,
      unmapped: 0,
      workspace_only: 0,
      insufficient: 0,
      drift_by_subtype: { checksum: 0, frontmatter: 1, version: 0 },
    },
    rows: [
      row({ skill_id: 'z-skill', target: 'claude' }),
      row({ skill_id: 'a-skill', target: 'codex', status: 'missing' }),
      row({
        skill_id: 'a-skill',
        target: 'claude',
        status: 'drift',
        drift_subtype: 'frontmatter',
        reasons: ['frontmatter_drift'],
      }),
      row({
        skill_id: 'a-skill',
        target: 'claude',
        scope: 'project',
        status: 'insufficient',
      }),
    ],
  };

  const matrix = buildAuditMatrix(audit);

  assert.deepEqual(matrix.hosts, ['claude', 'codex']);
  assert.deepEqual(
    matrix.skills.map((item) => item.skill_id),
    ['a-skill', 'z-skill'],
  );
  const first = matrix.skills[0];
  assert.equal(first?.cells.claude.length, 2);
  assert.deepEqual(
    first?.cells.claude.map((item) => item.status),
    ['drift', 'insufficient'],
  );
  assert.equal(first?.cells.codex[0]?.status, 'missing');
});

test('M6 GUI matrix：drift 详情提取 subtype 与字段差异', () => {
  const audit: InventoryAuditData = {
    observed_at: '2026-10-23T00:00:00Z',
    summary: {
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
    },
    rows: [
      row({
        skill_id: 'demo',
        target: 'claude',
        status: 'drift',
        drift_subtype: 'frontmatter',
        frontmatter_diffs: [
          {
            field: 'description',
            values: [
              { host: 'claude', role: 'user', value: 'one' },
              { host: 'codex', role: 'user', value: 'two' },
            ],
          },
        ],
      }),
    ],
  };

  const matrix = buildAuditMatrix(audit);
  const detail = matrix.driftDetails[0];

  assert.equal(detail?.skill_id, 'demo');
  assert.equal(detail?.subtype, 'frontmatter');
  assert.equal(detail?.fields[0]?.field, 'description');
  assert.deepEqual(
    detail?.fields[0]?.values.map((item) => item.value),
    ['one', 'two'],
  );
});
