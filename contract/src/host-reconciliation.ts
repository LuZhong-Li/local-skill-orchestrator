/** M4c 对账纯函数的输入/输出类型；不含 IO、扫描或渲染逻辑。 */
export type ReconciliationEvidenceLevel = 'authoritative' | 'inferred' | 'insufficient';
export type ReconciliationLedgerSource = 'host_landings' | 'plugin_landings' | 'none';
export type ReconciliationLedgerState = 'ok' | 'missing' | 'unreadable';
export type ReconciliationFormat = 'skill' | 'rules' | 'unknown';
export type ReconciliationVisibility = 'visible' | 'disabled' | 'unknown';

export type ReconciliationClassification =
  | 'managed_consistent'
  | 'drift'
  | 'untracked'
  | 'missing'
  | 'inferred_consistent'
  | 'inferred_drift'
  | 'undetermined'
  | 'not_distributed'
  | 'unreadable'
  | 'orphaned';

export interface ObservedHostCopy {
  host_id: string;
  target_path: string;
  exists: boolean;
  /** 有有效 SKILL.md 且 frontmatter 可解析 */
  readable: boolean;
  format: ReconciliationFormat;
  visibility: ReconciliationVisibility;
  content_digest?: string;
  skill_id?: string;
  version?: string;
  unreadable_reason?: string;
}

export interface ReconciliationLedgerRecord {
  source: Exclude<ReconciliationLedgerSource, 'none'>;
  state: 'active' | 'orphaned';
  target_path: string;
  content_digest?: string;
  source_checksum?: string;
  source_version?: string;
  source_ref?: string;
  visibility?: ReconciliationVisibility;
  format?: ReconciliationFormat;
  adapter_ref?: string;
  registry_version?: string;
}

export interface ReconciliationWorkspaceRecord {
  skill_id: string;
  version?: string;
  source_ref?: string;
  checksum?: string;
  /** 按当前注册表与适配器确定性重渲染后的摘要 */
  expected_content_digest?: string;
  expected_visibility?: ReconciliationVisibility;
}

export interface ReconciliationWorkspaceEvidence {
  state: 'ok' | 'missing' | 'unreadable';
  record?: ReconciliationWorkspaceRecord;
}

export interface ReconciliationInput {
  observed: ObservedHostCopy;
  ledger?: ReconciliationLedgerRecord | undefined;
  /** missing / unreadable 都按无账本降级；不得伪造权威结论 */
  ledger_state?: ReconciliationLedgerState | undefined;
  workspace: ReconciliationWorkspaceEvidence;
  root_readable: boolean;
}

export interface ReconciliationEvidence {
  managed: ReconciliationEvidenceLevel;
  content: ReconciliationEvidenceLevel;
  source: ReconciliationEvidenceLevel;
}

export interface ReconciliationOutput {
  classification: ReconciliationClassification;
  ledger_source: ReconciliationLedgerSource;
  authority: ReconciliationEvidenceLevel;
  evidence: ReconciliationEvidence;
  reasons: string[];
  drift_reasons: string[];
  untracked_candidate: boolean;
  orphaned?: {
    copy_present: boolean;
    workspace_record_present: boolean;
  };
}
