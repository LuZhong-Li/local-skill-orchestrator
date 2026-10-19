/** reconcile 的物理副本候选与 not_distributed 合成项；只读。 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  InventoryCopyVisibility,
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
import { loadHostLandings } from '../../store/host-landings/index.ts';
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
  reconciliation: ReconciliationOutput;
  is_plugin: boolean;
}

export function unique(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined && value !== '')),
  ];
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
    reconciliation: copy.reconciliation,
    is_plugin: copy.host_group === 'plugin',
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
    reconciliation: copy,
    is_plugin: copy.host_group === 'plugin',
  };
}

function mergeCandidate(left: Candidate | undefined, right: Candidate): Candidate {
  if (left === undefined) return right;
  return {
    ...left,
    host_ids: unique([...left.host_ids, ...right.host_ids]),
    consumed_by: unique([...left.consumed_by, ...right.consumed_by]),
    root_ids: unique([...left.root_ids, ...right.root_ids]),
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
  return [...map.values()];
}

function notDistributedRoots(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
): InventoryRootView[] {
  return snapshot.roots.filter(
    (root) =>
      root.host_group === 'builtin' &&
      root.kind !== 'rules' &&
      existsSync(root.path) &&
      (selection.host === undefined ||
        selection.host === 'all' ||
        root.host_id === selection.host) &&
      (selection.roots.length === 0 ||
        selection.roots.includes(root.root_id) ||
        selection.roots.some(
          (value) => inventoryPhysicalKey(value) === inventoryPhysicalKey(root.path),
        )),
  );
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
    reconciliation,
    is_plugin: false,
  };
}

export function notDistributedCandidates(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  observed: readonly Candidate[],
): Candidate[] {
  if (snapshot.workspace.index === null) return [];
  if (selection.mode !== 'id-host' && selection.classification !== 'not_distributed') return [];
  const ids =
    selection.mode === 'id-host'
      ? [selection.id].filter((id): id is string => id !== undefined)
      : snapshot.workspace.index.skills.map((item) => item.id);
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
