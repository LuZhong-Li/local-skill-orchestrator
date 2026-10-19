/** 全机盘点的纯展示映射；分类、权威等级与计数全部来自内核结果。 */
import type {
  HostRootRole,
  InventoryClassificationGroups,
  InventoryClassificationKey,
  InventoryRootState,
  ReconciliationEvidenceLevel,
  ReconciliationLedgerSource,
} from '@skill-manager/contract';

export const SECONDARY_ROLES: HostRootRole[] = ['system', 'platform', 'project'];

const ROLE_LABELS: Record<HostRootRole, string> = {
  user: '用户安装',
  system: '系统内置',
  platform: '平台内置',
  project: '项目级',
};

const ROOT_STATE_LABELS: Record<InventoryRootState, string> = {
  ok: '已发现',
  empty: '空目录',
  missing: '不存在',
  unconfigured: '未配置',
  unreadable: '不可读',
  not_applicable: '不适用',
};

const CLASSIFICATION_LABELS: Record<InventoryClassificationKey, string> = {
  managed_consistent: '账本一致',
  drift: '漂移',
  inferred_consistent: '推断一致',
  inferred_drift: '推断漂移',
  untracked: '未纳管',
  missing: '缺失',
  undetermined: '无法判定',
  unreadable: '不可读',
  not_distributed: '未分发',
  orphaned: '孤儿记录',
  orphaned_with_workspace: '孤儿记录（工作区仍在）',
  orphaned_without_workspace: '孤儿记录（工作区已删）',
};

export function roleLabel(role: HostRootRole): string {
  return ROLE_LABELS[role];
}

export function roleFoldNote(role: HostRootRole): string {
  if (role === 'system') return '平台/系统内置，不参与用户主计数';
  if (role === 'platform') return '平台持有并刷新，不参与用户主计数';
  if (role === 'project') return '当前工作区项目级副本，不参与用户主计数';
  return '用户级安装副本';
}

export function classificationLabel(key: InventoryClassificationKey): string {
  return CLASSIFICATION_LABELS[key];
}

export function classificationKind(key: InventoryClassificationKey): string {
  if (key === 'managed_consistent' || key === 'inferred_consistent') return 'managed';
  if (key === 'drift' || key === 'inferred_drift') return 'drift';
  if (key === 'untracked') return 'untracked';
  if (key === 'missing') return 'missing';
  return 'other';
}

export function authorityLabel(level: ReconciliationEvidenceLevel): string {
  if (level === 'authoritative') return '权威';
  if (level === 'inferred') return '推断';
  return '证据不足';
}

export function authorityClass(level: ReconciliationEvidenceLevel): string {
  return `authority-${level}`;
}

export function ledgerSourceLabel(source: ReconciliationLedgerSource): string {
  if (source === 'host_landings') return '内置宿主账本';
  if (source === 'plugin_landings') return '插件账本';
  return '无账本';
}

export function rootStateLabel(state: InventoryRootState): string {
  return ROOT_STATE_LABELS[state];
}

export function visibilityLabel(visibility: 'visible' | 'disabled' | 'unknown'): string {
  if (visibility === 'visible') return '可见';
  if (visibility === 'disabled') return '已禁用';
  return '未知';
}

export function formatLabel(format: 'skill' | 'rules' | 'unknown'): string {
  if (format === 'skill') return 'Skill';
  if (format === 'rules') return '规则';
  return '未知';
}

export function evidenceText(evidence: {
  managed: ReconciliationEvidenceLevel;
  content: ReconciliationEvidenceLevel;
  source: ReconciliationEvidenceLevel;
}): string {
  return `管理 ${authorityLabel(evidence.managed)} / 内容 ${authorityLabel(
    evidence.content,
  )} / 来源 ${authorityLabel(evidence.source)}`;
}

export function reasonText(reconciliation: { reasons: string[]; drift_reasons: string[] }): string {
  return [...reconciliation.reasons, ...reconciliation.drift_reasons].join('；') || '无附加说明';
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
      label: '已纳管一致',
      count: groups.managed.total,
      detail: `权威 ${groups.managed.authoritative} / 推断 ${groups.managed.inferred}`,
    },
    {
      key: 'drift',
      label: '漂移',
      count: groups.drift.total,
      detail: `权威 ${groups.drift.authoritative} / 推断 ${groups.drift.inferred}`,
    },
    { key: 'missing', label: '缺失', count: groups.missing },
    { key: 'untracked', label: '未纳管', count: groups.untracked },
    { key: 'undetermined', label: '无法判定', count: groups.undetermined },
    { key: 'unreadable', label: '不可读', count: groups.unreadable },
    { key: 'not_distributed', label: '未分发', count: groups.not_distributed },
    {
      key: 'orphaned',
      label: '孤儿记录',
      count: groups.orphaned.total,
      detail: `工作区在 ${groups.orphaned.with_workspace} / 不在 ${groups.orphaned.without_workspace}`,
    },
  ];
}

export function nonZeroClassificationEntries(
  counts: Record<InventoryClassificationKey, number>,
): Array<{ key: InventoryClassificationKey; label: string; count: number }> {
  return (Object.keys(CLASSIFICATION_LABELS) as InventoryClassificationKey[])
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => ({ key, label: classificationLabel(key), count: counts[key] }));
}
