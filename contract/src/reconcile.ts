/** M4c 二期 reconcile 动作计划的跨层纯类型；不含 IO、执行或界面逻辑。 */
import type { InventoryClassificationKey, InventoryCopyVisibility } from './host-inventory.ts';
import type {
  ReconciliationClassification,
  ReconciliationEvidence,
  ReconciliationEvidenceLevel,
  ReconciliationFormat,
  ReconciliationLedgerSource,
} from './host-reconciliation.ts';
import type { Change, Finding } from './result.ts';

export const RECONCILE_ACTIONS = ['adopt', 'track', 'repair', 'accept', 'clean', 'forget'] as const;

export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];
export type ReconcileSelectionMode = 'path' | 'id-host' | 'classification';
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
  host?: string;
  classification?: InventoryClassificationKey;
  roots: string[];
  target?: string;
  apply: boolean;
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
  notes: string[];
}

export interface ReconcileResultItem {
  item_id: string;
  status: 'succeeded' | 'failed' | 'skipped';
  target_path: string;
  message?: string;
  findings?: Finding[];
  changes?: Change[];
  after?: ReconcileExpected;
}

/** `reconcile --apply` 的稳定结果载荷；写入结果逐项保留。 */
export interface ReconcileApplyData extends Omit<ReconcilePreviewData, 'applied'> {
  applied: boolean;
  results: ReconcileResultItem[];
}
