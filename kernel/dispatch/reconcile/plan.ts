/** 只读生成 reconcile 动作计划；不执行任何写操作。 */
import { join } from 'node:path';
import type {
  InventoryClassificationKey,
  ReconciliationLedgerSource,
  ReconcileAction,
  ReconcileLedgerChange,
  ReconcilePlanItem,
  ReconcilePreviewData,
  ReconcileSelection,
  ReconcileSourceOfTruth,
  ReconcileTransactionGroup,
  ReconcileWriteKind,
} from '@skill-manager/contract';
import {
  RECONCILE_REASON_NON_USER_ROLE,
  RECONCILE_WARNING_SHARED_NON_USER_ROLE,
} from '@skill-manager/contract';
import { inventoryPhysicalKey } from '../../core/inventory/discover.ts';
import type { InventorySnapshot } from '../scan/inventory.ts';
import { allCandidates, notDistributedCandidates, unique, type Candidate } from './candidates.ts';
import { ledgerHostIds } from './group.ts';
import { notesOf } from './plan-notes.ts';
import { ledgerChanges, ledgerSourceOf } from './ledger-changes.ts';
import { rootMatches, selectBatchCandidates, selectionSummaryOf } from './selection.ts';

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

function classificationMatches(candidate: Candidate, classification: string): boolean {
  return actionableKeyOf(candidate) === classification;
}

function selectCandidates(snapshot: InventorySnapshot, selection: ReconcileSelection): Candidate[] {
  const candidates = allCandidates(snapshot);
  const selected = selectObservedCandidates(candidates, snapshot, selection);
  if (selection.mode === 'path') return selected;
  const targets = notDistributedCandidates(snapshot, selection, candidates);
  return [...new Map([...selected, ...targets].map((item) => [item.physical_key, item])).values()];
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
  if (selection.mode === 'batch') {
    return selectBatchCandidates(candidates, snapshot.roots, selection, actionableKeyOf);
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

function ledgerPath(
  snapshot: InventorySnapshot,
  source: Exclude<ReconciliationLedgerSource, 'none'>,
): string {
  return source === 'plugin_landings'
    ? snapshot.layout.pluginIndexFile
    : snapshot.layout.hostLandingsFile;
}

function writeKindOf(candidate: Candidate): ReconcileWriteKind {
  return candidate.format === 'rules' ? 'rule_file' : 'host_copy';
}

function hostWritePath(candidate: Candidate): string {
  return candidate.target_path;
}

function libraryPathOf(snapshot: InventorySnapshot, skillId: string | undefined): string {
  return join(snapshot.layout.skillsDir, skillId ?? 'unknown-skill');
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
  if (candidate.format === 'rules') return 'rules_not_adoptable';
  if (candidate.skill_id === undefined || candidate.skill_id === '') return 'missing_skill_id';
  if (key === 'inferred_consistent') return 'content_already_matches_use_track';
  if (key === 'drift' || key === 'inferred_drift') return 'content_differs_use_accept_or_repair';
  return ADOPTABLE.has(key) ? undefined : 'classification_not_adoptable';
}

function acceptUnsupported(
  candidate: Candidate,
  key: InventoryClassificationKey,
): string | undefined {
  if (candidate.is_plugin) return 'plugin_accept_not_supported';
  if (candidate.format !== 'skill') return 'content_accept_requires_skill_copy';
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
    key === 'inferred_consistent'
      ? undefined
      : key === 'untracked'
        ? 'content_not_in_workspace_use_adopt'
        : key === 'inferred_drift' || key === 'drift'
          ? 'drift_use_accept_or_repair'
          : 'classification_not_trackable',
  repair: (_candidate, key) => (REPAIRABLE.has(key) ? undefined : 'classification_not_repairable'),
  accept: acceptUnsupported,
  clean: (_candidate, key) =>
    key === 'missing'
      ? 'missing_has_no_copy'
      : key === 'orphaned_without_workspace' || key === 'unreadable'
        ? undefined
        : 'clean_only_orphaned_or_unreadable',
  forget: (_candidate, key) => (key === 'missing' ? undefined : 'forget_requires_missing_copy'),
};

function unsupportedReason(candidate: Candidate, action: ReconcileAction): string | undefined {
  return ACTION_RULES[action](candidate, actionableKeyOf(candidate));
}

function groupConflictReason(candidate: Candidate): string | undefined {
  if (candidate.format_conflict) return 'shared_root_form_conflict';
  if (candidate.ledger_conflict) return 'shared_root_ledger_conflict';
  return undefined;
}

/** 写动作只允许全部消费角色均为 user 的物理副本。 */
function nonUserRoleReason(candidate: Candidate): string | undefined {
  return candidate.root_roles.length > 0 && candidate.root_roles.every((role) => role === 'user')
    ? undefined
    : RECONCILE_REASON_NON_USER_ROLE;
}

function t2EligibilityReason(
  snapshot: InventorySnapshot,
  candidate: Candidate,
  action: ReconcileAction,
): string | undefined {
  if (action !== 'adopt' && action !== 'track') return undefined;
  if (snapshot.workspace.index === null) return 'workspace_uninitialized';
  return groupConflictReason(candidate);
}

function t1EligibilityReason(
  snapshot: InventorySnapshot,
  candidate: Candidate,
  action: ReconcileAction,
): string | undefined {
  if (action !== 'repair' && action !== 'forget') return undefined;
  const conflict = groupConflictReason(candidate);
  if (conflict !== undefined) return conflict;
  if (action === 'repair') {
    const record =
      snapshot.workspace.index === null || candidate.skill_id === undefined
        ? undefined
        : snapshot.workspace.index.skills.find((item) => item.id === candidate.skill_id);
    if (record === undefined) return 'workspace_baseline_missing';
  }
  return undefined;
}

function actionEligibilityReason(
  snapshot: InventorySnapshot,
  candidate: Candidate,
  action: ReconcileAction,
): string | undefined {
  return (
    t2EligibilityReason(snapshot, candidate, action) ??
    t1EligibilityReason(snapshot, candidate, action)
  );
}

function cleanEligibilityReason(
  snapshot: InventorySnapshot,
  candidate: Candidate,
  action: ReconcileAction,
): string | undefined {
  if (action !== 'clean') return undefined;
  const conflict = groupConflictReason(candidate);
  if (conflict !== undefined) return conflict;
  const workspaceRecord =
    candidate.skill_id === undefined
      ? undefined
      : snapshot.workspace.index?.skills.find((item) => item.id === candidate.skill_id);
  if (workspaceRecord !== undefined) return 'clean_requires_no_workspace_baseline';
  if (
    candidate.reconciliation.ledger_source !== 'none' &&
    candidate.reconciliation.orphaned === undefined
  ) {
    return 'clean_requires_orphaned_or_no_ledger';
  }
  return undefined;
}

function actionShape(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  candidate: Candidate,
): ActionShape {
  const reason =
    candidate.unavailable_reason ??
    nonUserRoleReason(candidate) ??
    actionEligibilityReason(snapshot, candidate, selection.action) ??
    cleanEligibilityReason(snapshot, candidate, selection.action) ??
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
  const changes = ledgerChanges(snapshot, candidate, selection, selection.action);
  return {
    status: 'planned',
    source_of_truth: sourceOfAction(selection.action),
    after: expectedOf(selection.action),
    writes: writesOf(snapshot, candidate, selection.action, ledger),
    ledger_changes: changes,
  };
}

function itemHostIds(candidate: Candidate, selection: ReconcileSelection): string[] {
  if (selection.action !== 'clean' && selection.action !== 'forget') return candidate.host_ids;
  return ledgerHostIds(candidate, selection);
}

function beforeOf(candidate: Candidate): ReconcilePlanItem['before'] {
  return {
    classification: candidate.reconciliation.classification,
    classification_key: classificationKeyOf(candidate),
    ledger_source: candidate.reconciliation.ledger_source,
    evidence: candidate.reconciliation.evidence,
    drift_reasons: candidate.reconciliation.drift_reasons,
    exists: candidate.exists,
    ...(candidate.content_digest === undefined ? {} : { content_digest: candidate.content_digest }),
    ...(candidate.visibility === undefined ? {} : { visibility: candidate.visibility }),
  };
}

function warningsOf(candidate: Candidate): string[] {
  const hasNonUserRole = candidate.root_roles.some((role) => role !== 'user');
  return [
    ...(candidate.consumed_by.length > 1 || candidate.host_ids.length > 1 ? ['shared_root'] : []),
    ...(candidate.format_conflict ? ['shared_root_form_conflict'] : []),
    ...(candidate.ledger_conflict ? ['shared_root_ledger_conflict'] : []),
    ...(hasNonUserRole && candidate.root_roles.length > 1
      ? [RECONCILE_WARNING_SHARED_NON_USER_ROLE]
      : []),
  ];
}

function backupsOf(
  snapshot: InventorySnapshot,
  selection: ReconcileSelection,
  candidate: Candidate,
): string[] {
  return selection.action === 'accept' && candidate.skill_id !== undefined
    ? [join(snapshot.layout.backupsDir, candidate.skill_id)]
    : [];
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
    host_ids: itemHostIds(candidate, selection),
    consumed_by: candidate.consumed_by,
    format: candidate.format,
    ...(candidate.visibility === undefined ? {} : { visibility: candidate.visibility }),
    root_roles: candidate.root_roles,
    transaction_group: `group-${candidate.physical_key}`,
    status: shape.status,
    ...(shape.reason === undefined ? {} : { reason: shape.reason }),
    before: beforeOf(candidate),
    action: selection.action,
    source_of_truth: shape.source_of_truth,
    after: shape.after,
    writes: shape.writes,
    ledger_changes: shape.ledger_changes,
    backups: backupsOf(snapshot, selection, candidate),
    warnings: warningsOf(candidate),
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
  return JSON.stringify({
    selection: plan.selection,
    items: plan.items.map((item) => ({
      item_id: item.item_id,
      action: item.action,
      target_path: item.target_path,
      root_roles: item.root_roles,
      ...(item.skill_id === undefined ? {} : { skill_id: item.skill_id }),
      status: item.status,
      before: item.before,
      after: item.after,
      writes: item.writes,
      ledger_changes: item.ledger_changes,
    })),
  });
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
    selection_summary: selectionSummaryOf(candidates, actionableKeyOf),
    summary: {
      selected: items.length,
      planned: items.filter((item) => item.status === 'planned').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      destructive: items.filter((item) => item.action === 'clean').length,
      shared_groups: groups.filter((group) => group.shared).length,
    },
    notes: notesOf(selection.action),
  };
}
