/** 读取工作区元数据与两套账本，组装审计投影所需的只读 source。 */
import { dirname, join, resolve } from 'node:path';
import {
  DISABLED_SUFFIX,
  SKILL_MD_NAME,
  type InventoryAuditData,
  type ReconciledInventoryCopy,
  type ReconciledInventoryCorruptCopy,
} from '@skill-manager/contract';
import { loadHostRegistry } from '../../core/hosts/index.ts';
import { inventoryPhysicalKey, readSkillFrontmatter } from '../../core/inventory/discover.ts';
import { loadPluginIndex } from '../../store/plugin-registry/index.ts';
import { loadHostLandings } from '../../store/host-landings/index.ts';
import { readMetaFile } from '../../core/metadata/read.ts';
import type { SkillTarget } from '../../core/metadata/types.ts';
import type { InventorySnapshot } from './snapshot.ts';
import { buildInventoryAudit } from './audit-projection.ts';
import type {
  AuditCopy,
  AuditLedgerRecord,
  AuditSkill,
  InventoryAuditSource,
} from './audit-types.ts';

type SnapshotCopy = ReconciledInventoryCopy | ReconciledInventoryCorruptCopy;

function objectOf(item: unknown): Record<string, unknown> | undefined {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
  return item as Record<string, unknown>;
}

function requiredFieldsOf(
  value: Record<string, unknown>,
): { target: string; scope: SkillTarget['scope']; enabled: boolean } | undefined {
  if (typeof value['target'] !== 'string' || value['target'].trim() === '') return undefined;
  if (value['scope'] !== 'global' && value['scope'] !== 'project') return undefined;
  if (typeof value['enabled'] !== 'boolean') return undefined;
  return { target: value['target'], scope: value['scope'], enabled: value['enabled'] };
}

function fileMapOf(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, string>;
}

function targetOf(item: unknown): SkillTarget[] {
  const value = objectOf(item);
  if (value === undefined) return [];
  const required = requiredFieldsOf(value);
  if (required === undefined) return [];
  return [
    {
      ...required,
      path: typeof value['path'] === 'string' ? value['path'] : '',
      mode: value['mode'] === 'link' ? 'link' : 'copy',
      file_map: fileMapOf(value['file_map']),
    },
  ];
}

function targetsOf(raw: Record<string, unknown> | null): SkillTarget[] {
  if (raw === null || !Array.isArray(raw['targets'])) return [];
  return raw['targets'].flatMap(targetOf);
}

function auditSkillsOf(snapshot: InventorySnapshot): AuditSkill[] {
  if (snapshot.workspace.index === null) return [];
  return snapshot.workspace.index.skills.map((record) => {
    const meta = readMetaFile(resolve(snapshot.layout.root, record.path), record.id);
    return {
      skill_id: record.id,
      targets: targetsOf(meta.raw),
      metaReadable: meta.raw !== null,
    };
  });
}

function pluginHostIds(snapshot: InventorySnapshot): string[] {
  return (
    loadPluginIndex(snapshot.layout.pluginIndexFile).index?.plugins.flatMap((plugin) =>
      plugin.hosts.map((host) => host.host_id),
    ) ?? []
  );
}

function knownHostsOf(snapshot: InventorySnapshot): string[] {
  return [
    ...new Set([
      ...loadHostRegistry().hosts.map((host) => host.host_id),
      ...snapshot.roots.map((root) => root.host_id),
      ...pluginHostIds(snapshot),
    ]),
  ];
}

function hostLedgerRecords(loaded: ReturnType<typeof loadHostLandings>): AuditLedgerRecord[] {
  return (loaded.index?.landings ?? []).map((record) => ({
    source: 'host_landings',
    host_id: record.host_id,
    skill_id: record.skill_id,
    target_path: record.target_path,
    state: record.state,
    content_digest: record.content_digest,
    source_checksum: record.source_checksum,
    ...(record.source_version === undefined ? {} : { source_version: record.source_version }),
    ...(record.source_ref === undefined ? {} : { source_ref: record.source_ref }),
    visibility: record.visibility,
    format: record.format,
  }));
}

function pluginLedgerRecords(loaded: ReturnType<typeof loadPluginIndex>): AuditLedgerRecord[] {
  return (loaded.index?.landings ?? []).map((record) => ({
    source: 'plugin_landings',
    host_id: record.host_id,
    skill_id: record.skill_id,
    target_path: record.target_path,
    state: record.state,
  }));
}

function ledgerStateOf(loaded: {
  exists: boolean;
  index: unknown;
}): 'ok' | 'missing' | 'unreadable' {
  if (!loaded.exists) return 'missing';
  return loaded.index === null ? 'unreadable' : 'ok';
}

function sameCopyPath(copyPath: string, ledgerPath: string): boolean {
  const copyKey = inventoryPhysicalKey(copyPath);
  const ledgerKey = inventoryPhysicalKey(ledgerPath);
  return ledgerKey === copyKey || inventoryPhysicalKey(dirname(ledgerPath)) === copyKey;
}

function ledgerOfCopy(
  copy: SnapshotCopy,
  records: readonly AuditLedgerRecord[],
): AuditLedgerRecord | undefined {
  return records.find(
    (record) =>
      sameCopyPath(copy.path, record.target_path) &&
      (record.host_id === copy.host_id || copy.consumed_by.includes(record.host_id)),
  );
}

function checksumMatches(copy: SnapshotCopy): boolean {
  const checksumReasons = new Set(['content_drift', 'source_changed', 'source_ref_mismatch']);
  return !copy.reconciliation.drift_reasons.some((reason) => checksumReasons.has(reason));
}

function auditCopy(copy: SnapshotCopy, records: readonly AuditLedgerRecord[]): AuditCopy {
  const ledger = ledgerOfCopy(copy, records);
  const marker =
    copy.format === 'skill'
      ? join(
          copy.path,
          copy.visibility === 'disabled' ? `${SKILL_MD_NAME}${DISABLED_SUFFIX}` : SKILL_MD_NAME,
        )
      : undefined;
  const frontmatter = marker === undefined ? { raw: null } : readSkillFrontmatter(marker);
  return {
    ...copy,
    audit_skill_id: ledger?.skill_id ?? copy.skill_id ?? '',
    frontmatter: frontmatter.raw,
    checksum_matches: checksumMatches(copy),
    ...('reason' in frontmatter ? { unreadable_reason: frontmatter.reason } : {}),
  };
}

function sourceOf(input: {
  snapshot: InventorySnapshot;
  observedAt: string;
  hostLedger: ReturnType<typeof loadHostLandings>;
  pluginLedger: ReturnType<typeof loadPluginIndex>;
}): InventoryAuditSource {
  const ledgerRecords = [
    ...hostLedgerRecords(input.hostLedger),
    ...pluginLedgerRecords(input.pluginLedger),
  ];
  return {
    observed_at: input.observedAt,
    workspace_root: input.snapshot.layout.root,
    skills: auditSkillsOf(input.snapshot),
    copies: [...input.snapshot.reconciled.copies, ...input.snapshot.reconciled.corrupt].map(
      (copy) => auditCopy(copy, ledgerRecords),
    ),
    missing: input.snapshot.reconciled.missing,
    roots: input.snapshot.roots,
    known_hosts: knownHostsOf(input.snapshot),
    ledger_states: {
      host_landings: ledgerStateOf(input.hostLedger),
      plugin_landings: ledgerStateOf(input.pluginLedger),
    },
    ledger_records: ledgerRecords,
  };
}

export function inventoryAuditOf(
  snapshot: InventorySnapshot,
  observedAt: string,
): InventoryAuditData {
  const hostLedger = loadHostLandings(snapshot.layout.hostLandingsFile);
  const pluginLedger = loadPluginIndex(snapshot.layout.pluginIndexFile);
  return buildInventoryAudit(
    sourceOf({
      snapshot,
      observedAt,
      hostLedger,
      pluginLedger,
    }),
  );
}
