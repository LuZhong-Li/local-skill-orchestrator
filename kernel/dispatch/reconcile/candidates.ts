/** reconcile 的物理副本候选与 not_distributed 合成项；只读。 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  InventoryCopyVisibility,
  HostRootRole,
  InventoryRootView,
  MissingInventoryCopy,
  ReconciliationFormat,
  ReconciliationOutput,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
  ReconcileSelection,
} from '@skill-manager/contract';
import { inventoryPhysicalKey } from '../../core/inventory/discover.ts';
import { reconcileHostCopy } from '../../core/host-landings/reconcile.ts';
import { collectUnifiedLandings } from '../../core/host-landings/uninstall.ts';
import { computeLandingChecksum } from '../../core/integrity/index.ts';
import { loadHostLandings } from '../../store/host-landings/index.ts';
import { loadPluginIndex } from '../../store/plugin-registry/index.ts';
import type { InventorySnapshot } from '../scan/inventory.ts';

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
}

export function unique(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined && value !== '')),
  ];
}

function uniqueRoles(values: readonly HostRootRole[]): HostRootRole[] {
  return [...new Set(values)];
}

function candidateOfCopy(
  copy: ReconciledInventoryCopy | ReconciledInventoryCorruptCopy,
): Candidate {
  const inferredSkillId =
    copy.skill_id ?? (copy.format === 'skill' ? basename(copy.path) : undefined);
  return {
    physical_key: copy.physical_key,
    target_path: copy.path,
    host_ids: unique([copy.host_id, ...copy.sources.map((item) => item.host_id)]),
    consumed_by: unique(copy.consumed_by),
    format: copy.format,
    ...(copy.visibility === 'unknown' ? {} : { visibility: copy.visibility }),
    ...(inferredSkillId === undefined ? {} : { skill_id: inferredSkillId }),
    ...(copy.content_digest === undefined ? {} : { content_digest: copy.content_digest }),
    exists: true,
    root_ids: unique([copy.root_id, ...copy.root_ids]),
    root_roles: uniqueRoles([copy.root_role, ...copy.sources.map((item) => item.root_role)]),
    reconciliation: copy.reconciliation,
    is_plugin: copy.host_group === 'plugin',
    format_conflict: false,
    ledger_conflict: false,
  };
}

function candidateOfMissing(copy: MissingInventoryCopy): Candidate {
  return {
    physical_key: inventoryPhysicalKey(copy.target_path),
    target_path: copy.target_path,
    host_ids: [copy.host_id],
    consumed_by: unique(copy.consumed_by),
    format: copy.format ?? 'unknown',
    ...(copy.visibility === undefined ? {} : { visibility: copy.visibility }),
    ...(copy.skill_id === undefined ? {} : { skill_id: copy.skill_id }),
    exists: false,
    root_ids: unique([copy.root_id]),
    root_roles: [copy.root_role ?? 'user'],
    reconciliation: copy,
    is_plugin: copy.host_group === 'plugin',
    format_conflict: false,
    ledger_conflict: false,
  };
}

function mergeCandidate(left: Candidate | undefined, right: Candidate): Candidate {
  if (left === undefined) return right;
  return {
    ...left,
    host_ids: unique([...left.host_ids, ...right.host_ids]),
    consumed_by: unique([...left.consumed_by, ...right.consumed_by]),
    root_ids: unique([...left.root_ids, ...right.root_ids]),
    root_roles: uniqueRoles([...left.root_roles, ...right.root_roles]),
    format_conflict: left.format_conflict || right.format_conflict || left.format !== right.format,
    ledger_conflict:
      left.ledger_conflict || right.ledger_conflict || left.is_plugin !== right.is_plugin,
  };
}

export function allCandidates(snapshot: InventorySnapshot): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const copy of snapshot.reconciled.copies) {
    const candidate = candidateOfCopy(copy);
    map.set(candidate.physical_key, mergeCandidate(map.get(candidate.physical_key), candidate));
  }
  for (const copy of snapshot.reconciled.corrupt) {
    const candidate = candidateOfCopy(copy);
    map.set(candidate.physical_key, mergeCandidate(map.get(candidate.physical_key), candidate));
  }
  for (const copy of snapshot.reconciled.missing) {
    const candidate = candidateOfMissing(copy);
    map.set(candidate.physical_key, mergeCandidate(map.get(candidate.physical_key), candidate));
  }
  for (const candidate of pluginOrphanCandidates(snapshot)) {
    if (!map.has(candidate.physical_key)) map.set(candidate.physical_key, candidate);
  }
  return [...map.values()];
}

function pluginOrphanCandidates(snapshot: InventorySnapshot): Candidate[] {
  const loaded = loadPluginIndex(snapshot.layout.pluginIndexFile);
  if (loaded.index === null) return [];
  const result: Candidate[] = [];
  for (const record of loaded.index.landings) {
    if (record.state !== 'orphaned') continue;
    const unified = collectUnifiedLandings(null, loaded.index, record.skill_id).find(
      (item) => item.record === record,
    );
    if (unified === undefined) continue;
    const candidate = pluginOrphanCandidate(snapshot, record, unified);
    if (candidate !== undefined) result.push(candidate);
  }
  return result;
}

function pluginOrphanCandidate(
  snapshot: InventorySnapshot,
  record: import('@skill-manager/contract').PluginLanding,
  unified: ReturnType<typeof collectUnifiedLandings>[number],
): Candidate | undefined {
  if (!existsSync(unified.physical_path)) return undefined;
  const format = unified.format;
  const workspaceRecord = snapshot.workspace.index?.skills.find(
    (item) => item.id === record.skill_id,
  );
  const digest =
    format === 'skill' || format === 'rules'
      ? computeLandingChecksum({ targetPath: unified.physical_path, format })
      : undefined;
  return {
    physical_key: inventoryPhysicalKey(unified.physical_path),
    target_path: unified.physical_path,
    host_ids: [record.host_id],
    consumed_by: [record.host_id],
    format,
    ...(format === 'skill'
      ? {
          visibility: existsSync(join(unified.physical_path, 'SKILL.md.disabled'))
            ? ('disabled' as const)
            : ('visible' as const),
        }
      : {}),
    skill_id: record.skill_id,
    ...(digest === undefined ? {} : { content_digest: digest }),
    exists: true,
    root_ids: [],
    root_roles: [pluginRootRole(snapshot, record.host_id, unified.physical_path)],
    reconciliation: {
      classification: 'orphaned',
      ledger_source: 'plugin_landings',
      authority: 'authoritative',
      evidence: {
        managed: 'authoritative',
        content: 'insufficient',
        source: 'insufficient',
      },
      reasons: ['orphaned_plugin_ledger'],
      drift_reasons: [],
      untracked_candidate: false,
      orphaned: {
        copy_present: true,
        workspace_record_present: workspaceRecord !== undefined,
      },
    },
    is_plugin: true,
    format_conflict: false,
    ledger_conflict: false,
  };
}

function notDistributedRoots(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
): InventoryRootView[] {
  return snapshot.roots.filter((root) => notDistributedRootSelected(root, selection));
}

function hostSelected(root: InventoryRootView, selection: ReconcileSelection): boolean {
  return (
    selection.host === undefined || selection.host === 'all' || root.host_id === selection.host
  );
}

function roleSelected(root: InventoryRootView, selection: ReconcileSelection): boolean {
  return (
    selection.roles === undefined ||
    selection.roles.length === 0 ||
    selection.roles.includes(root.role)
  );
}

function rootSelected(root: InventoryRootView, selection: ReconcileSelection): boolean {
  if (selection.roots.length === 0) return true;
  if (selection.roots.includes(root.root_id)) return true;
  const rootKey = inventoryPhysicalKey(root.path);
  return selection.roots.some((value) => inventoryPhysicalKey(value) === rootKey);
}

function notDistributedRootSelected(
  root: InventoryRootView,
  selection: ReconcileSelection,
): boolean {
  if (root.host_group !== 'builtin') return false;
  if (root.kind === 'rules') return false;
  if (!existsSync(root.path)) return false;
  return (
    hostSelected(root, selection) && roleSelected(root, selection) && rootSelected(root, selection)
  );
}

function pluginRootRole(
  snapshot: InventorySnapshot,
  hostId: string,
  targetPath: string,
): HostRootRole {
  const key = inventoryPhysicalKey(targetPath);
  const root = snapshot.roots
    .filter((item) => {
      if (item.host_id !== hostId) return false;
      const base = inventoryPhysicalKey(item.path);
      return key === base || key.startsWith(`${base}/`) || key.startsWith(`${base}\\`);
    })
    .sort((left, right) => right.path.length - left.path.length)[0];
  return root?.role ?? 'user';
}

function notDistributedCandidate(
  snapshot: InventorySnapshot,
  id: string,
  root: InventoryRootView,
  observed: readonly Candidate[],
  result: readonly Candidate[],
): Candidate | undefined {
  const index = snapshot.workspace.index;
  const record = index?.skills.find((item) => item.id === id);
  if (record === undefined) return undefined;
  const targetPath = join(root.path, id);
  const physicalKey = inventoryPhysicalKey(targetPath);
  if (
    existsSync(targetPath) ||
    observed.some((item) => item.physical_key === physicalKey) ||
    result.some((item) => item.physical_key === physicalKey)
  ) {
    return undefined;
  }
  const ledgerRecord = loadHostLandings(snapshot.layout.hostLandingsFile).index?.landings.find(
    (item) =>
      item.skill_id === id && item.host_id === root.host_id && item.target_path === targetPath,
  );
  const reconciliation = reconcileHostCopy({
    observed: {
      host_id: root.host_id,
      target_path: targetPath,
      exists: false,
      readable: false,
      format: 'skill',
      visibility: 'visible',
    },
    ...(ledgerRecord === undefined
      ? { ledger_state: 'missing' as const }
      : {
          ledger: {
            source: 'host_landings' as const,
            state: ledgerRecord.state,
            target_path: ledgerRecord.target_path,
            content_digest: ledgerRecord.content_digest,
            source_checksum: ledgerRecord.source_checksum,
            visibility: ledgerRecord.visibility,
            format: ledgerRecord.format,
          },
          ledger_state: 'ok' as const,
        }),
    workspace: {
      state: 'ok',
      record: {
        skill_id: record.id,
        ...(record.version === undefined ? {} : { version: record.version }),
        checksum: record.checksum,
      },
    },
    root_readable: true,
  });
  return {
    physical_key: physicalKey,
    target_path: targetPath,
    host_ids: [root.host_id],
    consumed_by: unique([root.host_id, ...root.consumed_by]),
    format: 'skill',
    visibility: 'visible',
    skill_id: id,
    exists: false,
    root_ids: [root.root_id],
    root_roles: [root.role],
    reconciliation,
    is_plugin: false,
    format_conflict: false,
    ledger_conflict: false,
  };
}

export function notDistributedCandidates(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  observed: readonly Candidate[],
): Candidate[] {
  if (snapshot.workspace.index === null) return [];
  const explicitIds = unique([...(selection.ids ?? []), selection.id]);
  if (!notDistributedSelectionEnabled(selection, explicitIds)) return [];
  const ids = notDistributedIds(snapshot, selection, explicitIds);
  const roots = notDistributedRoots(snapshot, selection);
  const result: Candidate[] = [];
  for (const id of ids) {
    for (const root of roots) {
      const candidate = notDistributedCandidate(snapshot, id, root, observed, result);
      if (candidate !== undefined) result.push(candidate);
    }
  }
  return result;
}

function notDistributedSelectionEnabled(
  selection: ReconcileSelection,
  explicitIds: readonly string[],
): boolean {
  if (selection.classification === 'not_distributed') return true;
  if (selection.mode !== 'id-host' && selection.mode !== 'batch') return false;
  return explicitIds.length > 0;
}

function notDistributedIds(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  explicitIds: readonly string[],
): string[] {
  if (explicitIds.length > 0) return [...explicitIds];
  if (selection.classification !== 'not_distributed') return [];
  return snapshot.workspace.index?.skills.map((item) => item.id) ?? [];
}
