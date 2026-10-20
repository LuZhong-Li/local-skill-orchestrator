/** 审计 source 与 projection 共享的内部类型。 */
import type {
  InventoryRootView,
  MissingInventoryCopy,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
  ReconciliationFormat,
  ReconciliationVisibility,
} from '@skill-manager/contract';
import type { SkillTarget } from '../../core/metadata/types.ts';

export type AuditCopy = ReconciledInventoryCopy | ReconciledInventoryCorruptCopy;

export interface AuditLedgerRecord {
  source: 'host_landings' | 'plugin_landings';
  host_id: string;
  skill_id: string;
  target_path: string;
  state: 'active' | 'orphaned';
  content_digest?: string;
  source_checksum?: string;
  source_version?: string;
  source_ref?: string;
  visibility?: ReconciliationVisibility;
  format?: ReconciliationFormat;
}

export interface AuditSkill {
  skill_id: string;
  targets: SkillTarget[];
  metaReadable: boolean;
}

export interface InventoryAuditSource {
  observed_at: string;
  workspace_root: string;
  skills: AuditSkill[];
  copies: AuditCopy[];
  missing: MissingInventoryCopy[];
  roots: InventoryRootView[];
  known_hosts: string[];
  ledger_states: {
    host_landings: 'ok' | 'missing' | 'unreadable';
    plugin_landings: 'ok' | 'missing' | 'unreadable';
  };
  ledger_records: AuditLedgerRecord[];
}
