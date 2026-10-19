/** 只读生成 reconcile 动作计划；不执行任何写操作。 */
import { join } from 'node:path';
import type {
  InventoryClassificationKey,
  ReconciliationLedgerSource,
  ReconcileAction,
  ReconcileLedgerChange,
  ReconcileLedgerState,
  ReconcilePlanItem,
  ReconcilePreviewData,
  ReconcileSelection,
  ReconcileSourceOfTruth,
  ReconcileTransactionGroup,
  ReconcileWriteKind,
} from '@skill-manager/contract';
import { inventoryPhysicalKey } from '../../core/inventory/discover.ts';
import type { InventoryRootView } from '@skill-manager/contract';
import type { InventorySnapshot } from '../scan/inventory.ts';
import { allCandidates, notDistributedCandidates, unique, type Candidate } from './candidates.ts';

interface ActionShape {
  status: 'planned' | 'skipped';
  reason?: string;
  source_of_truth: ReconcileSourceOfTruth;
  after: ReconcilePlanItem['after'];
  writes: ReconcilePlanItem['writes'];
  ledger_changes: ReconcileLedgerChange[];
}

function classificationKeyOf(candidate: Candidate): InventoryClassificationKey {
  const output = candidate.reconciliation;
  if (output.classification === 'orphaned') {
    return output.orphaned?.workspace_record_present
      ? 'orphaned_with_workspace'
      : 'orphaned_without_workspace';
  }
  return output.classification;
}

function actionableKeyOf(candidate: Candidate): InventoryClassificationKey {
  const key = classificationKeyOf(candidate);
  return key === 'undetermined' && candidate.reconciliation.untracked_candidate ? 'untracked' : key;
}

function hostMatches(candidate: Candidate, host: string | undefined): boolean {
  return host === undefined || host === 'all' || candidate.host_ids.includes(host);
}

function rootPathMatches(targetPath: string, root: InventoryRootView): boolean {
  const target = inventoryPhysicalKey(targetPath);
  const base = inventoryPhysicalKey(root.path);
  return target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
}

function rootMatches(
  candidate: Candidate,
  selectedRoots: readonly string[],
  roots: readonly InventoryRootView[],
): boolean {
  if (selectedRoots.length === 0) return true;
  return (
    roots.some(
      (root) =>
        selectedRoots.includes(root.root_id) &&
        (candidate.root_ids.includes(root.root_id) || rootPathMatches(candidate.target_path, root)),
    ) || selectedRoots.some((value) => candidate.root_ids.includes(value))
  );
}

function classificationMatches(candidate: Candidate, classification: string): boolean {
  return actionableKeyOf(candidate) === classification;
}

function selectCandidates(snapshot: InventorySnapshot, selection: ReconcileSelection): Candidate[] {
  const candidates = allCandidates(snapshot);
  const selected = selectObservedCandidates(candidates, snapshot, selection);
  if (selected.length > 0 || selection.mode === 'path') return selected;
  return [...selected, ...notDistributedCandidates(snapshot, selection, selected)];
}

function selectObservedCandidates(
  candidates: Candidate[],
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
): Candidate[] {
  if (selection.mode === 'path') {
    const key = inventoryPhysicalKey(selection.path ?? '');
    return candidates.filter((item) => item.physical_key === key);
  }
  if (selection.mode === 'id-host') {
    return candidates.filter(
      (item) => item.skill_id === selection.id && hostMatches(item, selection.host),
    );
  }
  return candidates.filter(
    (item) =>
      classificationMatches(item, selection.classification ?? '') &&
      hostMatches(item, selection.host) &&
      rootMatches(item, selection.roots, snapshot.roots),
  );
}

function sourceOfAction(action: ReconcileAction): ReconcileSourceOfTruth {
  if (action === 'adopt' || action === 'accept' || action === 'track' || action === 'clean') {
    return 'host';
  }
  if (action === 'repair') return 'workspace';
  return 'ledger';
}

function expectedOf(action: ReconcileAction): ReconcilePlanItem['after'] {
  if (action === 'clean' || action === 'forget') {
    return {
      classification: 'orphaned',
      authority: 'insufficient',
      reason: `${action}_completes_without_copy`,
    };
  }
  return {
    classification: 'managed_consistent',
    authority: action === 'repair' || action === 'track' ? 'authoritative' : 'inferred',
    reason: `${action}_makes_copy_managed`,
  };
}

function ledgerSourceOf(
  candidate: Candidate,
  action: ReconcileAction,
): Exclude<ReconciliationLedgerSource, 'none'> | undefined {
  const existing = candidate.reconciliation.ledger_source;
  if (existing !== 'none') return existing;
  if (action === 'adopt' || action === 'track' || action === 'repair') {
    return candidate.is_plugin ? 'plugin_landings' : 'host_landings';
  }
  return undefined;
}

function ledgerPath(
  snapshot: InventorySnapshot,
  source: Exclude<ReconciliationLedgerSource, 'none'>,
): string {
  return source === 'plugin_landings'
    ? snapshot.layout.pluginIndexFile
    : snapshot.layout.hostLandingsFile;
}

function ledgerStateOf(candidate: Candidate): ReconcileLedgerState | 'missing' {
  if (candidate.reconciliation.ledger_source === 'none') return 'missing';
  return candidate.reconciliation.classification === 'orphaned' ? 'orphaned' : 'active';
}

function ledgerChange(
  candidate: Candidate,
  action: ReconcileAction,
): ReconcileLedgerChange | undefined {
  const source = ledgerSourceOf(candidate, action);
  if (source === undefined) return undefined;
  const next = action === 'clean' || action === 'forget' ? 'orphaned' : 'active';
  return {
    source,
    record_key: `${candidate.host_ids[0] ?? candidate.host_ids.join(',')}:${candidate.target_path}`,
    from_state: ledgerStateOf(candidate),
    to_state: next,
  };
}

function writeKindOf(candidate: Candidate): ReconcileWriteKind {
  return candidate.format === 'rules' ? 'rule_file' : 'host_copy';
}

function hostWritePath(candidate: Candidate): string {
  return candidate.target_path;
}

function targetIdOf(snapshot: InventorySnapshot, selection: ReconcileSelection): string {
  const configured = snapshot.workspace.config['default_target'];
  return (
    selection.target ??
    (typeof configured === 'string' && configured !== '' ? configured : 'claude')
  );
}

function libraryPathOf(snapshot: InventorySnapshot, skillId: string | undefined): string {
  return join(snapshot.layout.skillsDir, skillId ?? 'unknown-skill');
}

function targetCopyPathOf(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  skillId: string | undefined,
): string {
  return join(
    snapshot.layout.root,
    `.${targetIdOf(snapshot, selection)}`,
    'skills',
    skillId ?? 'unknown-skill',
  );
}

function uniqueWrites(writes: ReconcilePlanItem['writes']): ReconcilePlanItem['writes'] {
  const seen = new Set<string>();
  return writes.filter((write) => {
    const key = `${write.action}\0${write.kind}\0${write.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function writesOf(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  candidate: Candidate,
  action: ReconcileAction,
  ledger: Exclude<ReconciliationLedgerSource, 'none'> | undefined,
): ReconcilePlanItem['writes'] {
  const writes: ReconcilePlanItem['writes'] = [];
  if (action === 'adopt') {
    writes.push({
      action: 'add',
      kind: 'library',
      path: libraryPathOf(snapshot, candidate.skill_id),
    });
    writes.push({
      action: 'add',
      kind: 'skill_meta',
      path: join(libraryPathOf(snapshot, candidate.skill_id), 'skill_meta.yaml'),
    });
    writes.push({
      action: 'add',
      kind: 'target_copy',
      path: targetCopyPathOf(snapshot, selection, candidate.skill_id),
    });
    writes.push({ action: 'add', kind: 'index', path: snapshot.layout.indexFile });
  } else if (action === 'accept') {
    writes.push({
      action: 'modify',
      kind: 'library',
      path: libraryPathOf(snapshot, candidate.skill_id),
    });
    writes.push({ action: 'modify', kind: 'index', path: snapshot.layout.indexFile });
  } else if (action === 'repair') {
    writes.push({ action: 'modify', kind: writeKindOf(candidate), path: hostWritePath(candidate) });
  } else if (action === 'clean') {
    writes.push({ action: 'remove', kind: writeKindOf(candidate), path: hostWritePath(candidate) });
  }
  if (ledger !== undefined) {
    writes.push({
      action: 'modify',
      kind: ledger === 'plugin_landings' ? 'plugin_index' : 'host_landings',
      path: ledgerPath(snapshot, ledger),
    });
  }
  return uniqueWrites(writes);
}

const ADOPTABLE = new Set<InventoryClassificationKey>(['untracked', 'orphaned_without_workspace']);
const REPAIRABLE = new Set<InventoryClassificationKey>([
  'missing',
  'not_distributed',
  'drift',
  'inferred_drift',
  'orphaned_with_workspace',
  'unreadable',
]);
const ACCEPTABLE = new Set<InventoryClassificationKey>(['drift', 'inferred_drift']);
const SOURCE_DRIFT = new Set(['source_changed', 'version_mismatch', 'source_ref_mismatch']);

function adoptUnsupported(
  candidate: Candidate,
  key: InventoryClassificationKey,
): string | undefined {
  if (candidate.is_plugin) return 'plugin_skill_source_is_plugin_package';
  if (candidate.skill_id === undefined || candidate.skill_id === '') return 'missing_skill_id';
  return ADOPTABLE.has(key) ? undefined : 'classification_not_adoptable';
}

function acceptUnsupported(
  candidate: Candidate,
  key: InventoryClassificationKey,
): string | undefined {
  if (candidate.is_plugin) return 'plugin_accept_not_supported';
  if (!ACCEPTABLE.has(key)) return 'accept_only_content_or_visibility';
  return candidate.reconciliation.drift_reasons.some((reason) => SOURCE_DRIFT.has(reason))
    ? 'accept_only_content_or_visibility'
    : undefined;
}

const ACTION_RULES: Record<
  ReconcileAction,
  (candidate: Candidate, key: InventoryClassificationKey) => string | undefined
> = {
  adopt: adoptUnsupported,
  track: (_candidate, key) =>
    key === 'inferred_consistent' ? undefined : 'classification_not_trackable',
  repair: (_candidate, key) => (REPAIRABLE.has(key) ? undefined : 'classification_not_repairable'),
  accept: acceptUnsupported,
  clean: (_candidate, key) => (key === 'missing' ? 'missing_has_no_copy' : undefined),
  forget: (_candidate, key) => (key === 'missing' ? undefined : 'forget_requires_missing_copy'),
};

function unsupportedReason(candidate: Candidate, action: ReconcileAction): string | undefined {
  return ACTION_RULES[action](candidate, actionableKeyOf(candidate));
}

function t1EligibilityReason(
  snapshot: InventorySnapshot,
  candidate: Candidate,
  action: ReconcileAction,
): string | undefined {
  if (action !== 'repair' && action !== 'forget') return undefined;
  if (candidate.is_plugin) return 'plugin_host_t4';
  if (candidate.consumed_by.length > 1 || candidate.host_ids.length > 1) {
    return 'shared_root_t4';
  }
  if (action === 'repair') {
    const record =
      snapshot.workspace.index === null || candidate.skill_id === undefined
        ? undefined
        : snapshot.workspace.index.skills.find((item) => item.id === candidate.skill_id);
    if (record === undefined) return 'workspace_baseline_missing';
  }
  return undefined;
}

function actionShape(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  candidate: Candidate,
): ActionShape {
  const reason =
    t1EligibilityReason(snapshot, candidate, selection.action) ??
    unsupportedReason(candidate, selection.action);
  const ledger = ledgerSourceOf(candidate, selection.action);
  if (reason !== undefined) {
    return {
      status: 'skipped',
      reason,
      source_of_truth: sourceOfAction(selection.action),
      after: expectedOf(selection.action),
      writes: [],
      ledger_changes: [],
    };
  }
  const change = ledgerChange(candidate, selection.action);
  return {
    status: 'planned',
    source_of_truth: sourceOfAction(selection.action),
    after: expectedOf(selection.action),
    writes: writesOf(snapshot, selection, candidate, selection.action, ledger),
    ledger_changes: change === undefined ? [] : [change],
  };
}

function itemOf(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  candidate: Candidate,
  index: number,
): ReconcilePlanItem {
  const shape = actionShape(snapshot, selection, candidate);
  return {
    item_id: `reconcile-${index + 1}`,
    physical_key: candidate.physical_key,
    target_path: candidate.target_path,
    ...(candidate.skill_id === undefined ? {} : { skill_id: candidate.skill_id }),
    host_ids: candidate.host_ids,
    consumed_by: candidate.consumed_by,
    format: candidate.format,
    ...(candidate.visibility === undefined ? {} : { visibility: candidate.visibility }),
    transaction_group: `group-${candidate.physical_key}`,
    status: shape.status,
    ...(shape.reason === undefined ? {} : { reason: shape.reason }),
    before: {
      classification: candidate.reconciliation.classification,
      classification_key: classificationKeyOf(candidate),
      ledger_source: candidate.reconciliation.ledger_source,
      evidence: candidate.reconciliation.evidence,
      drift_reasons: candidate.reconciliation.drift_reasons,
      exists: candidate.exists,
      ...(candidate.content_digest === undefined
        ? {}
        : { content_digest: candidate.content_digest }),
      ...(candidate.visibility === undefined ? {} : { visibility: candidate.visibility }),
    },
    action: selection.action,
    source_of_truth: shape.source_of_truth,
    after: shape.after,
    writes: shape.writes,
    ledger_changes: shape.ledger_changes,
    backups: [],
    warnings: candidate.consumed_by.length > 1 ? ['shared_root'] : [],
  };
}

function transactionGroups(items: ReconcilePlanItem[]): ReconcileTransactionGroup[] {
  const groups = new Map<string, ReconcileTransactionGroup>();
  for (const item of items) {
    const current = groups.get(item.transaction_group) ?? {
      group_id: item.transaction_group,
      physical_path: item.target_path,
      item_ids: [],
      host_ids: [],
      ledger_sources: [],
      shared: false,
    };
    current.item_ids.push(item.item_id);
    current.host_ids = unique([...current.host_ids, ...item.host_ids]);
    for (const change of item.ledger_changes) {
      if (!current.ledger_sources.includes(change.source))
        current.ledger_sources.push(change.source);
    }
    current.shared = current.host_ids.length > 1 || item.consumed_by.length > 1;
    groups.set(item.transaction_group, current);
  }
  return [...groups.values()];
}

/** 预览与执行间的计划指纹；任一选中副本事实变化都会改变结果。 */
export function reconcilePlanSignature(plan: ReconcilePreviewData): string {
  return JSON.stringify(
    plan.items.map((item) => ({
      item_id: item.item_id,
      action: item.action,
      target_path: item.target_path,
      status: item.status,
      before: item.before,
    })),
  );
}

/** 生成动作预览；调用方必须只读消费结果。 */
export function buildReconcilePreview(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
): ReconcilePreviewData {
  const candidates = selectCandidates(snapshot, selection);
  const items = candidates.map((candidate, index) => itemOf(snapshot, selection, candidate, index));
  const groups = transactionGroups(items);
  return {
    mode: 'reconcile',
    action: selection.action,
    selection,
    apply_requested: selection.apply,
    applied: false,
    items,
    transaction_groups: groups,
    summary: {
      selected: items.length,
      planned: items.filter((item) => item.status === 'planned').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      destructive: items.filter((item) => item.action === 'clean').length,
      shared_groups: groups.filter((group) => group.shared).length,
    },
    notes: ['T0 只生成预览，不执行任何写动作', 'reconcile 默认预览；--apply 将在后续动作批次启用'],
  };
}
