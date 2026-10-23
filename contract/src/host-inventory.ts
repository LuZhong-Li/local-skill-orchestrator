/** M4c-2 物理副本观察的跨层纯类型；不含目录遍历或文件读取逻辑。 */
import type { HostRootRole } from './host-roots.ts';
import type {
  ReconciliationClassification,
  ReconciliationEvidence,
  ReconciliationOutput,
} from './host-reconciliation.ts';
import type { ReconciliationFormat, ReconciliationVisibility } from './host-reconciliation.ts';

export type InventoryRootState =
  'ok' | 'empty' | 'missing' | 'unconfigured' | 'unreadable' | 'not_applicable';

export interface InventoryRootObservation {
  root_id: string;
  host_id: string;
  host_group: 'builtin' | 'plugin';
  root_role: HostRootRole;
  kind: 'skill' | 'rules' | 'external';
  path: string;
  recursive: boolean;
  origin: 'default' | 'legacy' | 'config';
  is_x_host: boolean;
  consumed_by: string[];
  configured: boolean;
  state: InventoryRootState;
  readable: boolean;
  copy_count: number;
  corrupt_count: number;
  reason?: string;
  platform_notes?: string;
  pending_verification?: boolean;
}

export interface InventoryCopySource {
  host_id: string;
  host_group: 'builtin' | 'plugin';
  root_id: string;
  root_role: HostRootRole;
  recursive: boolean;
}

export type InventoryCopyFormat = Exclude<ReconciliationFormat, 'unknown'>;
export type InventoryCopyVisibility = Exclude<ReconciliationVisibility, 'unknown'>;

export interface InventoryCopyObservation {
  physical_key: string;
  path: string;
  host_id: string;
  host_group: 'builtin' | 'plugin';
  root_id: string;
  root_role: HostRootRole;
  format: InventoryCopyFormat;
  visibility: InventoryCopyVisibility;
  recursive: boolean;
  skill_id?: string;
  version?: string;
  content_digest?: string;
  readable: boolean;
  exists: boolean;
  consumed_by: string[];
  root_ids: string[];
  sources: InventoryCopySource[];
}

export interface InventoryCorruptCopy {
  physical_key: string;
  path: string;
  host_id: string;
  host_group: 'builtin' | 'plugin';
  root_id: string;
  root_role: HostRootRole;
  format: ReconciliationFormat;
  visibility: ReconciliationVisibility;
  recursive: boolean;
  skill_id?: string;
  version?: string;
  content_digest?: string;
  readable: boolean;
  exists: boolean;
  consumed_by: string[];
  root_ids: string[];
  sources: InventoryCopySource[];
  reason: string;
}

export interface InventoryDiscoverySummary {
  roots_total: number;
  roots_ok: number;
  roots_empty: number;
  roots_missing: number;
  roots_unconfigured: number;
  roots_unreadable: number;
  roots_not_applicable: number;
  copies_before_dedup: number;
  copies_after_dedup: number;
  corrupt_before_dedup: number;
  corrupt_after_dedup: number;
  duplicates_removed: number;
  dedup_key: 'realpath+casefold';
}

export interface InventoryDiscoveryResult {
  roots: InventoryRootObservation[];
  copies: InventoryCopyObservation[];
  corrupt: InventoryCorruptCopy[];
  summary: InventoryDiscoverySummary;
}

export interface ReconciledInventoryCopy extends InventoryCopyObservation {
  reconciliation: ReconciliationOutput;
}

export interface ReconciledInventoryCorruptCopy extends InventoryCorruptCopy {
  reconciliation: ReconciliationOutput;
}

export interface MissingInventoryCopy extends ReconciliationOutput {
  host_id: string;
  host_group: 'builtin' | 'plugin';
  root_id?: string;
  root_role?: HostRootRole;
  target_path: string;
  format?: InventoryCopyFormat;
  visibility?: InventoryCopyVisibility;
  skill_id?: string;
  consumed_by: string[];
  is_x_host: boolean;
}

export type InventoryClassificationKey =
  | 'managed_consistent'
  | 'drift'
  | 'inferred_consistent'
  | 'inferred_drift'
  | 'untracked'
  | 'missing'
  | 'undetermined'
  | 'unreadable'
  | 'not_distributed'
  | 'orphaned'
  | 'orphaned_with_workspace'
  | 'orphaned_without_workspace';

/** 跨宿主审计矩阵的单行状态；与 reconcile 分类复用同一证据。 */
export type InventoryAuditStatus =
  | 'distributed'
  | 'missing'
  | 'drift'
  | 'visibility_mismatch'
  | 'undeclared'
  | 'unmapped'
  | 'workspace_only'
  | 'insufficient';

export type DriftSubtype = 'checksum' | 'frontmatter' | 'version';

export interface FrontmatterFieldValue {
  host: string;
  role: HostRootRole;
  value: string | null;
}

export interface FrontmatterFieldDiff {
  field: 'name' | 'description' | 'license' | 'compatibility' | 'allowed-tools';
  values: FrontmatterFieldValue[];
}

export interface VersionFieldValue {
  host: string;
  role: HostRootRole;
  version: string | null;
}

export interface VersionDiff {
  values: VersionFieldValue[];
}

export type InventoryAuditLedgerState = 'active' | 'orphaned' | 'missing' | 'none' | 'unreadable';

/** 一行表示 skill × targets[] 声明项 × scope。 */
export interface InventoryAuditRow {
  skill_id: string;
  target: string;
  scope: 'global' | 'project';
  host_id?: string;
  expected_enabled: boolean;
  ledger_state: InventoryAuditLedgerState;
  target_path?: string;
  copy_path?: string;
  copy_version?: string;
  source_checksum?: string;
  source_version?: string;
  content_digest?: string;
  status: InventoryAuditStatus;
  classification?: ReconciliationClassification;
  evidence: ReconciliationEvidence;
  reasons: string[];
  observed_at: string;
  /** 仅 status=drift 时存在。 */
  drift_subtype?: DriftSubtype;
  frontmatter_diffs?: FrontmatterFieldDiff[];
  version_diff?: VersionDiff;
}

export interface InventoryAuditSummary {
  declared: number;
  distributed: number;
  missing: number;
  drift: number;
  visibility_mismatch: number;
  undeclared: number;
  unmapped: number;
  workspace_only: number;
  insufficient: number;
  /** 旧消费者可忽略；仅对 drift 行按 subtype 分项计数。 */
  drift_by_subtype?: {
    checksum: number;
    frontmatter: number;
    version: number;
  };
}

export interface InventoryAuditData {
  observed_at: string;
  summary: InventoryAuditSummary;
  rows: InventoryAuditRow[];
}

export type InventoryClassificationCounts = Record<InventoryClassificationKey, number>;

export interface InventoryClassificationGroups {
  managed: { total: number; authoritative: number; inferred: number };
  drift: { total: number; authoritative: number; inferred: number };
  missing: number;
  untracked: number;
  undetermined: number;
  unreadable: number;
  not_distributed: number;
  orphaned: { total: number; with_workspace: number; without_workspace: number };
}

export interface InventoryRoleSummary {
  total_copies: number;
  unique_skills: number;
  by_classification: InventoryClassificationCounts;
  corrupt_count: number;
  groups: InventoryClassificationGroups;
}

export interface InventorySummary extends InventoryDiscoverySummary {
  main: { total_copies: number; unique_skills: number };
  roles: Record<HostRootRole, InventoryRoleSummary>;
  classification_groups: InventoryClassificationGroups;
}

export interface InventoryHostRootNode {
  root: InventoryRootObservation;
  copies: ReconciledInventoryCopy[];
  corrupt: ReconciledInventoryCorruptCopy[];
  missing: MissingInventoryCopy[];
}

export interface InventoryHostNode {
  host_id: string;
  host_group: 'builtin' | 'plugin';
  display_name: string;
  roots: InventoryHostRootNode[];
  counts: {
    total_copies: number;
    unique_skills: number;
    corrupt_count: number;
    by_classification: InventoryClassificationCounts;
  };
}

/**
 * `scan --inventory` 的稳定结果载荷。
 *
 * 类型放在 contract 中，GUI 与内核读取同一份定义；本接口只描述结果形状，
 * 不包含目录遍历、对账或任何文件系统逻辑。
 */
export interface InventoryScanData {
  mode: 'inventory';
  workspace: {
    root: string;
    state: 'ok' | 'uninitialized' | 'unreadable';
  };
  roots: InventoryRootObservation[];
  hosts: InventoryHostNode[];
  copies: ReconciledInventoryCopy[];
  corrupt: ReconciledInventoryCorruptCopy[];
  missing: MissingInventoryCopy[];
  summary: InventorySummary;
  /** 仅在 scan --inventory --audit 时出现；旧消费者可忽略。 */
  audit?: InventoryAuditData;
  degradation: {
    host_landings: 'ok' | 'missing' | 'unreadable';
    plugin_landings: 'ok' | 'missing' | 'unreadable';
  };
}

/** GUI 导出结果：仅主进程写用户选择的目标文件。 */
export interface InventoryExportResult {
  canceled: boolean;
  path?: string;
  error?: string;
  code?: string;
}
