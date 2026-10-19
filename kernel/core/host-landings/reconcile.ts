/**
 * M4c 对账纯函数。
 *
 * 只消费调用方已经枚举/读取好的事实，不访问文件系统；账本缺失或损坏由
 * ledger_state 表达，分类器安全降级到无账本推断路径。
 */
import type {
  ReconciliationClassification,
  ReconciliationEvidence,
  ReconciliationEvidenceLevel,
  ReconciliationInput,
  ReconciliationLedgerRecord,
  ReconciliationOutput,
  ReconciliationWorkspaceRecord,
} from '@skill-manager/contract';

type Decision = Omit<ReconciliationOutput, 'ledger_source' | 'authority'>;

function recordOf(input: ReconciliationInput): ReconciliationWorkspaceRecord | undefined {
  return input.workspace.state === 'ok' ? input.workspace.record : undefined;
}

function usableLedger(input: ReconciliationInput): ReconciliationLedgerRecord | undefined {
  const state = input.ledger_state ?? (input.ledger === undefined ? 'missing' : 'ok');
  return state === 'ok' ? input.ledger : undefined;
}

function degradedReasons(input: ReconciliationInput): string[] {
  return input.ledger_state === 'unreadable' ? ['ledger_unavailable_degraded'] : [];
}

function evidence(
  managed: ReconciliationEvidenceLevel,
  content: ReconciliationEvidenceLevel,
  source: ReconciliationEvidenceLevel,
): ReconciliationEvidence {
  return { managed, content, source };
}

function decision(
  classification: ReconciliationClassification,
  evidenceValue: ReconciliationEvidence,
  reasons: string[],
  driftReasons: string[] = [],
  untrackedCandidate = false,
  orphaned?: { copy_present: boolean; workspace_record_present: boolean },
): Decision {
  return {
    classification,
    evidence: evidenceValue,
    reasons,
    drift_reasons: driftReasons,
    untracked_candidate: untrackedCandidate,
    ...(orphaned === undefined ? {} : { orphaned }),
  };
}

function authorityOf(
  classification: ReconciliationClassification,
  value: ReconciliationEvidence,
): ReconciliationEvidenceLevel {
  if (
    classification === 'managed_consistent' ||
    classification === 'drift' ||
    classification === 'missing' ||
    classification === 'unreadable'
  ) {
    return value.managed;
  }
  return classification === 'inferred_consistent' || classification === 'inferred_drift'
    ? 'inferred'
    : 'insufficient';
}

function finish(input: ReconciliationInput, result: Decision): ReconciliationOutput {
  return {
    ...result,
    ledger_source: usableLedger(input)?.source ?? 'none',
    authority: authorityOf(result.classification, result.evidence),
  };
}

/** 对单个物理副本做对账；调用方负责提供可读性与摘要等事实。 */
export function reconcileHostCopy(input: ReconciliationInput): ReconciliationOutput {
  if (!input.root_readable) {
    return finish(
      input,
      decision('undetermined', evidence('insufficient', 'insufficient', 'insufficient'), [
        'root_unreadable',
        ...degradedReasons(input),
      ]),
    );
  }
  if (input.workspace.state !== 'ok') {
    return finish(
      input,
      decision(
        'undetermined',
        evidence('insufficient', 'insufficient', 'insufficient'),
        [`workspace_${input.workspace.state}`, ...degradedReasons(input)],
        [],
        input.observed.exists,
      ),
    );
  }
  if (!input.observed.exists) {
    return finish(input, classifyAbsent(input));
  }
  if (!input.observed.readable) {
    return finish(input, classifyUnreadable(input));
  }
  return finish(input, classifyPresent(input));
}

function classifyAbsent(input: ReconciliationInput): Decision {
  const ledger = usableLedger(input);
  const workspaceRecord = recordOf(input);
  if (ledger?.state === 'active') {
    return decision('missing', evidence('authoritative', 'insufficient', 'insufficient'), [
      'copy_missing',
      ...degradedReasons(input),
    ]);
  }
  if (ledger?.state === 'orphaned') {
    return decision(
      'orphaned',
      evidence('insufficient', 'insufficient', 'insufficient'),
      ['orphaned_copy_absent', ...degradedReasons(input)],
      [],
      false,
      { copy_present: false, workspace_record_present: workspaceRecord !== undefined },
    );
  }
  if (workspaceRecord !== undefined) {
    return decision('not_distributed', evidence('insufficient', 'insufficient', 'insufficient'), [
      'no_copy_no_ledger',
      ...degradedReasons(input),
    ]);
  }
  return decision('undetermined', evidence('insufficient', 'insufficient', 'insufficient'), [
    'no_copy_no_workspace_record',
    ...degradedReasons(input),
  ]);
}

function classifyUnreadable(input: ReconciliationInput): Decision {
  const ledger = usableLedger(input);
  const managed =
    ledger?.state === 'active' ? ('authoritative' as const) : ('insufficient' as const);
  return decision(
    'unreadable',
    evidence(managed, 'insufficient', 'insufficient'),
    [
      'unreadable_copy',
      ...(input.observed.unreadable_reason === undefined ? [] : [input.observed.unreadable_reason]),
      ...(ledger?.state === 'orphaned' ? ['orphaned_ledger'] : []),
      ...degradedReasons(input),
    ],
    [],
    false,
    ledger?.state === 'orphaned'
      ? { copy_present: true, workspace_record_present: recordOf(input) !== undefined }
      : undefined,
  );
}

function classifyPresent(input: ReconciliationInput): Decision {
  const ledger = usableLedger(input);
  if (ledger?.source === 'host_landings') {
    return ledger.state === 'orphaned'
      ? classifyOrphaned(input, ledger)
      : classifyHostActive(input, ledger);
  }
  if (ledger?.source === 'plugin_landings') {
    return ledger.state === 'orphaned'
      ? classifyOrphaned(input, ledger)
      : classifyPluginActive(input);
  }
  return classifyNoLedger(input);
}

function classifyHostActive(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
): Decision {
  const drift = hostDriftReasons(input, ledger);
  const content = contentAuthority(input, ledger);
  const source = sourceAuthority(input, ledger);
  return decision(
    drift.drift.length > 0 ? 'drift' : 'managed_consistent',
    evidence('authoritative', content, source),
    ['managed_by_host_ledger', ...drift.reasons, ...degradedReasons(input)],
    drift.drift,
  );
}

function hostDriftReasons(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
): { drift: string[]; reasons: string[] } {
  const content = hostContentDrift(input, ledger);
  return {
    drift: [...visibilityDrift(input, ledger), ...content.drift, ...sourceDrift(input, ledger)],
    reasons: content.reasons,
  };
}

function visibilityDrift(input: ReconciliationInput, ledger: ReconciliationLedgerRecord): string[] {
  return ledger.visibility !== undefined &&
    input.observed.visibility !== 'unknown' &&
    ledger.visibility !== input.observed.visibility
    ? ['visibility_mismatch']
    : [];
}

function hostContentDrift(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
): { drift: string[]; reasons: string[] } {
  const workspaceRecord = recordOf(input);
  const drift: string[] = [];
  const reasons: string[] = [];
  const contentMismatch =
    ledger.content_digest !== undefined &&
    input.observed.content_digest !== undefined &&
    ledger.content_digest !== input.observed.content_digest;
  const renderBaselineChanged =
    contentMismatch &&
    workspaceRecord?.expected_content_digest !== undefined &&
    workspaceRecord.expected_content_digest === input.observed.content_digest;
  if (contentMismatch && !renderBaselineChanged) drift.push('content_drift');
  if (renderBaselineChanged) reasons.push('render_baseline_changed');
  return { drift, reasons };
}

function sourceDrift(input: ReconciliationInput, ledger: ReconciliationLedgerRecord): string[] {
  return [
    ...checksumDrift(input, ledger),
    ...versionDrift(input, ledger),
    ...refDrift(input, ledger),
  ];
}

function checksumDrift(input: ReconciliationInput, ledger: ReconciliationLedgerRecord): string[] {
  const workspaceRecord = recordOf(input);
  return ledger.source_checksum !== undefined &&
    workspaceRecord?.checksum !== undefined &&
    ledger.source_checksum !== workspaceRecord.checksum
    ? ['source_changed']
    : [];
}

function versionDrift(input: ReconciliationInput, ledger: ReconciliationLedgerRecord): string[] {
  const workspaceRecord = recordOf(input);
  return ledger.source_version !== undefined &&
    workspaceRecord?.version !== undefined &&
    ledger.source_version !== workspaceRecord.version
    ? ['version_mismatch']
    : [];
}

function refDrift(input: ReconciliationInput, ledger: ReconciliationLedgerRecord): string[] {
  const workspaceRecord = recordOf(input);
  return ledger.source_ref !== undefined &&
    workspaceRecord?.source_ref !== undefined &&
    ledger.source_ref !== workspaceRecord.source_ref
    ? ['source_ref_mismatch']
    : [];
}

function contentAuthority(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
): ReconciliationEvidenceLevel {
  if (ledger.content_digest === undefined || input.observed.content_digest === undefined) {
    return 'insufficient';
  }
  const workspaceRecord = recordOf(input);
  return workspaceRecord?.expected_content_digest !== undefined &&
    workspaceRecord.expected_content_digest !== ledger.content_digest
    ? 'inferred'
    : 'authoritative';
}

function sourceAuthority(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
): ReconciliationEvidenceLevel {
  const workspaceRecord = recordOf(input);
  if (workspaceRecord === undefined) return 'insufficient';
  return ledger.source_checksum !== undefined ||
    ledger.source_version !== undefined ||
    ledger.source_ref !== undefined
    ? 'authoritative'
    : 'insufficient';
}

function classifyPluginActive(input: ReconciliationInput): Decision {
  const workspaceRecord = recordOf(input);
  const expected = workspaceRecord?.expected_content_digest;
  const visibilityMismatch = pluginVisibilityMismatch(input, workspaceRecord);
  if (expected === undefined || input.observed.content_digest === undefined) {
    return pluginWithoutBaseline(visibilityMismatch);
  }
  const source: ReconciliationEvidenceLevel =
    workspaceRecord === undefined ? 'insufficient' : 'inferred';
  const drift = pluginDrift(input, expected, visibilityMismatch);
  return decision(
    drift.length > 0 ? 'drift' : 'managed_consistent',
    evidence('authoritative', 'inferred', source),
    ['managed_by_plugin_ledger', 'content_inferred_by_rerender'],
    drift,
  );
}

function pluginVisibilityMismatch(
  input: ReconciliationInput,
  workspaceRecord: ReconciliationWorkspaceRecord | undefined,
): boolean {
  return (
    workspaceRecord?.expected_visibility !== undefined &&
    input.observed.visibility !== 'unknown' &&
    workspaceRecord.expected_visibility !== input.observed.visibility
  );
}

function pluginDrift(
  input: ReconciliationInput,
  expected: string,
  visibilityMismatch: boolean,
): string[] {
  const drift: string[] = [];
  if (input.observed.content_digest !== expected) drift.push('content_drift');
  if (visibilityMismatch) drift.push('visibility_mismatch');
  return drift;
}

function pluginWithoutBaseline(visibilityMismatch: boolean): Decision {
  if (visibilityMismatch) {
    return decision(
      'drift',
      evidence('authoritative', 'insufficient', 'inferred'),
      ['managed_by_plugin_ledger', 'content_baseline_missing'],
      ['visibility_mismatch'],
    );
  }
  return decision('undetermined', evidence('authoritative', 'insufficient', 'insufficient'), [
    'managed_by_plugin_ledger',
    'content_baseline_missing',
  ]);
}

function classifyNoLedger(input: ReconciliationInput): Decision {
  const workspaceRecord = recordOf(input);
  if (workspaceRecord === undefined) return classifyUntracked(input);
  return classifyNoLedgerWithRecord(input, workspaceRecord);
}

function classifyUntracked(input: ReconciliationInput): Decision {
  return decision(
    'untracked',
    evidence('insufficient', 'insufficient', 'insufficient'),
    ['no_ledger_no_workspace_record', ...degradedReasons(input)],
    [],
    true,
  );
}

function classifyNoLedgerWithRecord(
  input: ReconciliationInput,
  workspaceRecord: ReconciliationWorkspaceRecord,
): Decision {
  if (workspaceRecord.skill_id !== input.observed.skill_id) {
    return decision('undetermined', evidence('insufficient', 'insufficient', 'insufficient'), [
      'workspace_record_mismatch',
      ...degradedReasons(input),
    ]);
  }
  if (workspaceRecord.expected_content_digest === undefined) {
    return decision('undetermined', evidence('inferred', 'insufficient', 'insufficient'), [
      'no_render_baseline',
      ...degradedReasons(input),
    ]);
  }
  if (input.observed.content_digest === undefined) {
    return decision('undetermined', evidence('inferred', 'insufficient', 'insufficient'), [
      'content_observation_missing',
      ...degradedReasons(input),
    ]);
  }
  const drift = inferredDrift(input, workspaceRecord);
  return decision(
    drift.length > 0 ? 'inferred_drift' : 'inferred_consistent',
    evidence('inferred', 'inferred', 'inferred'),
    ['no_ledger_workspace_baseline', ...degradedReasons(input)],
    drift,
  );
}

function inferredDrift(
  input: ReconciliationInput,
  workspaceRecord: ReconciliationWorkspaceRecord,
): string[] {
  const drift: string[] = [];
  if (workspaceRecord.expected_content_digest !== input.observed.content_digest) {
    drift.push('content_drift');
  }
  if (
    workspaceRecord.expected_visibility !== undefined &&
    input.observed.visibility !== 'unknown' &&
    workspaceRecord.expected_visibility !== input.observed.visibility
  ) {
    drift.push('visibility_mismatch');
  }
  return drift;
}

function classifyOrphaned(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
): Decision {
  const workspaceRecord = recordOf(input);
  if (workspaceRecord === undefined) {
    return classifyOrphanedWithoutRecord(input, ledger);
  }
  return classifyOrphanedWithRecord(input, ledger, workspaceRecord);
}

function classifyOrphanedWithoutRecord(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
): Decision {
  const ledgerReason =
    ledger.source === 'host_landings' ? 'orphaned_host_ledger' : 'orphaned_plugin_ledger';
  return decision(
    'orphaned',
    evidence('insufficient', 'insufficient', 'insufficient'),
    ['orphaned_copy_present', 'workspace_record_absent', ledgerReason, ...degradedReasons(input)],
    [],
    true,
    { copy_present: true, workspace_record_present: false },
  );
}

function classifyOrphanedWithRecord(
  input: ReconciliationInput,
  ledger: ReconciliationLedgerRecord,
  workspaceRecord: ReconciliationWorkspaceRecord,
): Decision {
  const orphaned = {
    copy_present: true,
    workspace_record_present: workspaceRecord !== undefined,
  };
  const ledgerReason =
    ledger.source === 'host_landings' ? 'orphaned_host_ledger' : 'orphaned_plugin_ledger';
  const expected = workspaceRecord.expected_content_digest;
  const content: ReconciliationEvidenceLevel =
    expected !== undefined && input.observed.content_digest !== undefined
      ? 'inferred'
      : 'insufficient';
  const source: ReconciliationEvidenceLevel =
    workspaceRecord.checksum !== undefined ||
    workspaceRecord.version !== undefined ||
    workspaceRecord.source_ref !== undefined
      ? 'inferred'
      : 'insufficient';
  const drift = orphanDrift(input, workspaceRecord);
  return decision(
    'orphaned',
    evidence('insufficient', content, source),
    [
      'orphaned_copy_present',
      'workspace_record_present',
      ledgerReason,
      drift.length > 0 ? 'orphaned_inferred_drift' : 'orphaned_inferred_consistent',
      ...degradedReasons(input),
    ],
    drift,
    false,
    orphaned,
  );
}

function orphanDrift(
  input: ReconciliationInput,
  workspaceRecord: ReconciliationWorkspaceRecord,
): string[] {
  const drift: string[] = [];
  if (
    workspaceRecord.expected_content_digest !== undefined &&
    input.observed.content_digest !== undefined &&
    workspaceRecord.expected_content_digest !== input.observed.content_digest
  ) {
    drift.push('content_drift');
  }
  if (
    workspaceRecord.expected_visibility !== undefined &&
    input.observed.visibility !== 'unknown' &&
    workspaceRecord.expected_visibility !== input.observed.visibility
  ) {
    drift.push('visibility_mismatch');
  }
  return drift;
}
