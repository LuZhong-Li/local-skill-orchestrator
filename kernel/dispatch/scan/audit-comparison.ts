/** 将 frontmatter/version 组比较合入审计行与汇总。 */
import type { InventoryAuditRow, InventoryAuditSummary } from '@skill-manager/contract';
import {
  compareFrontmatterGroup,
  type AuditFrontmatterComparison,
  type AuditFrontmatterCopy,
} from '../../audit/index.ts';
import type { AuditCopy, InventoryAuditSource } from './audit-types.ts';

const CHECKSUM_DRIFT_REASONS = new Set(['content_drift', 'source_changed', 'source_ref_mismatch']);

function comparisonCopy(copy: AuditCopy, skillId: string): AuditFrontmatterCopy {
  return {
    skill_id: skillId,
    host_id: copy.host_id,
    root_role: copy.root_role,
    copy_path: copy.path,
    frontmatter: copy.frontmatter,
    ...(copy.checksum_matches === undefined ? {} : { checksum_matches: copy.checksum_matches }),
    ...(copy.unreadable_reason === undefined ? {} : { unreadable_reason: copy.unreadable_reason }),
  };
}

function comparisonOf(source: InventoryAuditSource, skillId: string): AuditFrontmatterComparison {
  return compareFrontmatterGroup(
    source.copies
      .filter((copy) => copy.format === 'skill' && copy.audit_skill_id === skillId)
      .map((copy) => comparisonCopy(copy, skillId)),
  );
}

function fallbackSubtype(row: InventoryAuditRow): InventoryAuditRow['drift_subtype'] {
  if (row.reasons.some((reason) => CHECKSUM_DRIFT_REASONS.has(reason))) return 'checksum';
  if (row.reasons.includes('version_mismatch')) return 'version';
  return undefined;
}

function withComparisonReasons(
  row: InventoryAuditRow,
  comparison: AuditFrontmatterComparison,
  subtype: InventoryAuditRow['drift_subtype'],
): string[] {
  return [
    ...row.reasons,
    ...(subtype === undefined ? [] : [`${subtype}_drift`]),
    ...(comparison.metadata_incomplete ? ['metadata_incomplete'] : []),
  ].filter((reason, index, reasons) => reasons.indexOf(reason) === index);
}

function comparisonSubtype(
  row: InventoryAuditRow,
  comparison: AuditFrontmatterComparison,
): InventoryAuditRow['drift_subtype'] {
  if (comparison.drift_subtype !== undefined) return comparison.drift_subtype;
  return row.status === 'drift' ? fallbackSubtype(row) : undefined;
}

function comparisonEvidence(comparison: AuditFrontmatterComparison) {
  return {
    ...(comparison.frontmatter_diffs.length === 0
      ? {}
      : { frontmatter_diffs: comparison.frontmatter_diffs }),
    ...(comparison.version_diff === undefined ? {} : { version_diff: comparison.version_diff }),
  };
}

function withFrontmatterComparison(
  row: InventoryAuditRow,
  comparison: AuditFrontmatterComparison,
): InventoryAuditRow {
  if (row.status !== 'distributed' && row.status !== 'drift') return row;
  const subtype = comparisonSubtype(row, comparison);
  if (subtype === 'checksum' && row.status !== 'drift') return row;
  const status = subtype === 'frontmatter' || subtype === 'version' ? 'drift' : row.status;
  return {
    ...row,
    status,
    ...(subtype === undefined ? {} : { drift_subtype: subtype }),
    ...comparisonEvidence(comparison),
    reasons: withComparisonReasons(row, comparison, subtype),
  };
}

export function withGroupComparisons(
  source: InventoryAuditSource,
  rows: readonly InventoryAuditRow[],
): InventoryAuditRow[] {
  const comparisons = new Map(
    source.skills.map((skill) => [skill.skill_id, comparisonOf(source, skill.skill_id)]),
  );
  return rows.map((row) => {
    const comparison = comparisons.get(row.skill_id);
    return comparison === undefined ? row : withFrontmatterComparison(row, comparison);
  });
}

function emptySummary(): InventoryAuditSummary {
  return {
    declared: 0,
    distributed: 0,
    missing: 0,
    drift: 0,
    visibility_mismatch: 0,
    undeclared: 0,
    unmapped: 0,
    workspace_only: 0,
    insufficient: 0,
  };
}

export function summaryOf(
  source: InventoryAuditSource,
  rows: readonly InventoryAuditRow[],
): InventoryAuditSummary {
  const summary = emptySummary();
  summary.declared = source.skills.reduce((count, skill) => count + skill.targets.length, 0);
  for (const row of rows) summary[row.status] += 1;
  summary.drift_by_subtype = { checksum: 0, frontmatter: 0, version: 0 };
  for (const row of rows) {
    if (row.status === 'drift' && row.drift_subtype !== undefined) {
      summary.drift_by_subtype[row.drift_subtype] += 1;
    }
  }
  return summary;
}
