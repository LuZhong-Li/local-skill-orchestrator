/** M4c 二期 reconcile 动作计划的跨层纯类型；不含 IO、执行或界面逻辑。 */
import type { InventoryClassificationKey, InventoryCopyVisibility } from './host-inventory.ts';
import type { HostRootRole } from './host-roots.ts';
import type {
  ReconciliationClassification,
  ReconciliationEvidence,
  ReconciliationEvidenceLevel,
  ReconciliationFormat,
  ReconciliationLedgerSource,
} from './host-reconciliation.ts';
import type { Change, Finding } from './result.ts';

export const RECONCILE_ACTIONS = ['adopt', 'track', 'repair', 'accept', 'clean', 'forget'] as const;

/** 非 user 角色副本的稳定 skip 原因；系统 / 平台 / 项目副本由对应工具管理。 */
export const RECONCILE_REASON_NON_USER_ROLE = 'non_user_role_read_only';
/** 共享根同时被 user 与非 user 角色消费时的保守告警。 */
export const RECONCILE_WARNING_SHARED_NON_USER_ROLE = 'shared_root_non_user_role';

export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];
export type ReconcileSelectionMode = 'path' | 'id-host' | 'classification' | 'batch';
export type ReconcileSourceOfTruth = 'host' | 'workspace' | 'ledger';
export type ReconcileWriteAction = 'add' | 'modify' | 'remove';
export type ReconcileWriteKind =
  | 'library'
  | 'skill_meta'
  | 'target_copy'
  | 'index'
  | 'host_copy'
  | 'rule_file'
  | 'host_landings'
  | 'plugin_index';
export type ReconcileLedgerState = 'active' | 'orphaned';

export interface ReconcileSelection {
  mode: ReconcileSelectionMode;
  action: ReconcileAction;
  path?: string;
  id?: string;
  /** batch 选择器：多个 Skill 标识；T1 起由 parser 聚合为数组。 */
  ids?: string[];
  host?: string;
  classification?: InventoryClassificationKey;
  roots: string[];
  /** batch 选择器：按角色选择；写动作仍只执行 user。 */
  roles?: HostRootRole[];
  target?: string;
  apply: boolean;
}

/** 批量选择器在 flatten 前的分布摘要；T1 生成，GUI / CLI 只读消费。 */
export interface ReconcileSelectionSummary {
  total: number;
  by_skill: Record<string, number>;
  by_root: Record<string, number>;
  by_role: Partial<Record<HostRootRole, number>>;
  by_host: Record<string, number>;
  by_classification: Partial<Record<InventoryClassificationKey, number>>;
}

export interface ReconcileBefore {
  classification: ReconciliationClassification;
  classification_key: InventoryClassificationKey;
  ledger_source: ReconciliationLedgerSource;
  evidence: ReconciliationEvidence;
  drift_reasons: string[];
  exists: boolean;
  content_digest?: string;
  visibility?: InventoryCopyVisibility;
}

export interface ReconcileExpected {
  classification: InventoryClassificationKey;
  authority: ReconciliationEvidenceLevel;
  reason: string;
}

export interface ReconcilePlannedWrite {
  action: ReconcileWriteAction;
  kind: ReconcileWriteKind;
  path: string;
}

export interface ReconcileLedgerChange {
  source: Exclude<ReconciliationLedgerSource, 'none'>;
  record_key: string;
  from_state: ReconcileLedgerState | 'missing';
  to_state: ReconcileLedgerState | 'removed';
}

export interface ReconcilePlanItem {
  item_id: string;
  physical_key: string;
  target_path: string;
  skill_id?: string;
  host_ids: string[];
  consumed_by: string[];
  format: ReconciliationFormat;
  visibility?: InventoryCopyVisibility;
  /** 该物理副本被哪些角色消费；混合角色时整组保守跳过。 */
  root_roles: HostRootRole[];
  transaction_group: string;
  status: 'planned' | 'skipped';
  reason?: string;
  before: ReconcileBefore;
  action: ReconcileAction;
  source_of_truth: ReconcileSourceOfTruth;
  after: ReconcileExpected;
  writes: ReconcilePlannedWrite[];
  ledger_changes: ReconcileLedgerChange[];
  backups: string[];
  warnings: string[];
}

export interface ReconcileTransactionGroup {
  group_id: string;
  physical_path: string;
  item_ids: string[];
  host_ids: string[];
  ledger_sources: Array<Exclude<ReconciliationLedgerSource, 'none'>>;
  shared: boolean;
}

export interface ReconcilePlanSummary {
  selected: number;
  planned: number;
  skipped: number;
  destructive: number;
  shared_groups: number;
  /** T1 起执行结果可按同一字段形状回填；预览时保持缺省。 */
  succeeded?: number;
  failed?: number;
  cancelled?: number;
  duration_ms?: number;
}

/** `reconcile` 的稳定预览载荷；T0 只产出计划，不执行写入。 */
export interface ReconcilePreviewData {
  mode: 'reconcile';
  action: ReconcileAction;
  selection: ReconcileSelection;
  apply_requested: boolean;
  applied: false;
  items: ReconcilePlanItem[];
  transaction_groups: ReconcileTransactionGroup[];
  summary: ReconcilePlanSummary;
  selection_summary?: ReconcileSelectionSummary;
  notes: string[];
}

export interface ReconcileResultItem {
  item_id: string;
  status: 'succeeded' | 'failed' | 'skipped';
  target_path: string;
  message?: string;
  /** 失败发生的阶段，供 GUI 定位；T1 起填充。 */
  stage?: string;
  /** 稳定的单项失败 / 跳过原因；T1 起填充。 */
  reason?: string;
  findings?: Finding[];
  changes?: Change[];
  after?: ReconcileExpected;
}

/** `reconcile --apply` 的稳定结果载荷；写入结果逐项保留。 */
export interface ReconcileApplyData extends Omit<ReconcilePreviewData, 'applied'> {
  applied: boolean;
  results: ReconcileResultItem[];
}
