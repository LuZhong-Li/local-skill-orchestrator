/** reconcile 候选共享模型；独立成文件避免候选实现与插件候选互相引用。 */
import type {
  HostRootRole,
  InventoryCopyVisibility,
  ReconciliationFormat,
  ReconciliationOutput,
} from '@skill-manager/contract';

export interface Candidate {
  physical_key: string;
  target_path: string;
  host_ids: string[];
  consumed_by: string[];
  format: ReconciliationFormat;
  visibility?: InventoryCopyVisibility;
  skill_id?: string;
  content_digest?: string;
  exists: boolean;
  root_ids: string[];
  /** 物理副本被哪些 root_role 消费；只有全为 user 才允许写动作。 */
  root_roles: HostRootRole[];
  reconciliation: ReconciliationOutput;
  is_plugin: boolean;
  /** 同一物理副本被不同 form 的根同时消费：T4 必须拒绝而不是任选。 */
  format_conflict: boolean;
  /** 同一物理副本同时被内置与插件账本消费：拒绝猜测归属。 */
  ledger_conflict: boolean;
  unavailable_reason?: string;
}

export function unique(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined && value !== '')),
  ];
}
