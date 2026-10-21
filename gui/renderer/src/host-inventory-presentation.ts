/** 全机盘点的纯展示映射；分类、权威等级与计数全部来自内核结果。 */
import type {
  HostRootRole,
  InventoryClassificationGroups,
  InventoryClassificationKey,
  InventoryRootState,
  ReconciliationEvidenceLevel,
  ReconciliationLedgerSource,
} from '@skill-manager/contract';
import { t } from './i18n/index.ts';

export const SECONDARY_ROLES: HostRootRole[] = ['system', 'platform', 'project'];

const CLASSIFICATION_KEYS: Record<InventoryClassificationKey, string> = {
  managed_consistent: 'managed',
  drift: 'drift',
  inferred_consistent: 'inferredConsistent',
  inferred_drift: 'inferredDrift',
  untracked: 'untracked',
  missing: 'missing',
  undetermined: 'undetermined',
  unreadable: 'unreadable',
  not_distributed: 'notDistributed',
  orphaned: 'orphaned',
  orphaned_with_workspace: 'orphanedWorkspace',
  orphaned_without_workspace: 'orphanedNoWorkspace',
};

export function roleLabel(role: HostRootRole): string {
  return t(`inventory.role.${role}`);
}

export function roleVisualClass(role: HostRootRole): string {
  return `role-${role}`;
}

export function roleFoldNote(role: HostRootRole): string {
  return t(`inventory.roleHint.${role}`);
}

export function classificationLabel(key: InventoryClassificationKey): string {
  return t(`inventory.classification.${CLASSIFICATION_KEYS[key]}`);
}

export function classificationKind(key: InventoryClassificationKey): string {
  if (key === 'managed_consistent' || key === 'inferred_consistent') return 'managed';
  if (key === 'drift' || key === 'inferred_drift') return 'drift';
  if (key === 'untracked') return 'untracked';
  if (key === 'missing') return 'missing';
  return 'other';
}

export function authorityLabel(level: ReconciliationEvidenceLevel): string {
  if (level === 'authoritative') return t('inventory.authority.authoritative');
  if (level === 'inferred') return t('inventory.authority.inferred');
  return t('inventory.authority.insufficient');
}

export function authorityClass(level: ReconciliationEvidenceLevel): string {
  return `authority-${level}`;
}

export function ledgerSourceLabel(source: ReconciliationLedgerSource): string {
  if (source === 'host_landings') return t('inventory.ledger.host');
  if (source === 'plugin_landings') return t('inventory.ledger.plugin');
  return t('inventory.ledger.none');
}

export function rootStateLabel(state: InventoryRootState): string {
  return state === 'not_applicable'
    ? t('inventory.rootState.notApplicable')
    : t(`inventory.rootState.${state}`);
}

export function rootStateVisualClass(state: InventoryRootState): string {
  return `root-state-${state.replaceAll('_', '-')}`;
}

export function rootStateHint(state: InventoryRootState): string | null {
  if (state === 'ok') return null;
  const key = state === 'not_applicable' ? 'notApplicable' : state;
  return t(`inventory.rootEmptyHint.${key}`);
}

export function visibilityLabel(visibility: 'visible' | 'disabled' | 'unknown'): string {
  return t(`inventory.visibility.${visibility}`);
}

export function formatLabel(format: 'skill' | 'rules' | 'unknown'): string {
  if (format === 'skill') return 'Skill';
  if (format === 'rules') return t('inventory.format.rules');
  return t('inventory.format.unknown');
}

export function evidenceText(evidence: {
  managed: ReconciliationEvidenceLevel;
  content: ReconciliationEvidenceLevel;
  source: ReconciliationEvidenceLevel;
}): string {
  return t('inventory.evidence', {
    managed: authorityLabel(evidence.managed),
    content: authorityLabel(evidence.content),
    source: authorityLabel(evidence.source),
  });
}

export function reasonText(reconciliation: { reasons: string[]; drift_reasons: string[] }): string {
  return (
    [...reconciliation.reasons, ...reconciliation.drift_reasons].join('; ') ||
    t('inventory.noReasons')
  );
}

export interface ClassificationGroupRow {
  key: string;
  label: string;
  count: number;
  detail?: string;
}

export function classificationGroupRows(
  groups: InventoryClassificationGroups,
): ClassificationGroupRow[] {
  return [
    {
      key: 'managed',
      label: t('inventory.managedConsistent'),
      count: groups.managed.total,
      detail: t('inventory.authorityCounts', {
        authoritative: groups.managed.authoritative,
        inferred: groups.managed.inferred,
      }),
    },
    {
      key: 'drift',
      label: classificationLabel('drift'),
      count: groups.drift.total,
      detail: t('inventory.authorityCounts', {
        authoritative: groups.drift.authoritative,
        inferred: groups.drift.inferred,
      }),
    },
    { key: 'missing', label: classificationLabel('missing'), count: groups.missing },
    { key: 'untracked', label: classificationLabel('untracked'), count: groups.untracked },
    {
      key: 'undetermined',
      label: classificationLabel('undetermined'),
      count: groups.undetermined,
    },
    { key: 'unreadable', label: classificationLabel('unreadable'), count: groups.unreadable },
    {
      key: 'not_distributed',
      label: classificationLabel('not_distributed'),
      count: groups.not_distributed,
    },
    {
      key: 'orphaned',
      label: classificationLabel('orphaned'),
      count: groups.orphaned.total,
      detail: t('inventory.workspacePresence', {
        present: groups.orphaned.with_workspace,
        absent: groups.orphaned.without_workspace,
      }),
    },
  ];
}

export function nonZeroClassificationEntries(
  counts: Record<InventoryClassificationKey, number>,
): Array<{ key: InventoryClassificationKey; label: string; count: number }> {
  return (Object.keys(CLASSIFICATION_KEYS) as InventoryClassificationKey[])
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => ({ key, label: classificationLabel(key), count: counts[key] }));
}
