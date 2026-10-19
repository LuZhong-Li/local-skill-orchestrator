/** T4 clean：共享根按引用计数保留物理副本；插件/内置两本账本独立提交。 */
import { existsSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CODES,
  type Change,
  type Finding,
  type HostLanding,
  type HostLandingIndex,
  type PluginIndex,
  type PluginLanding,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { TOOL_VERSION } from '../../core/index/index.ts';
import { createInitialPluginIndex } from '../../store/plugin-registry/index.ts';
import { collectUnifiedLandings, type UnifiedLanding } from '../../core/host-landings/uninstall.ts';
import {
  loadHostLandingsForWrite,
  removeHostLanding,
  saveHostLandings,
} from '../../store/host-landings/index.ts';
import { loadPluginIndex, savePluginIndex } from '../../store/plugin-registry/index.ts';
import { inventoryPhysicalKey } from '../../core/inventory/discover.ts';
import { removeTree } from '../../store/library-fs/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import { renameWithRetry } from '../../store/atomic/index.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { ReconcileExecutionItem } from './execution-types.ts';

export interface CleanHooks {
  /** 测试注入：在提交账本前触发失败。 */
  beforeLedger?: () => void;
  /** 测试注入：在删除临时快照前触发失败。 */
  beforeDelete?: () => void;
}

interface CleanInput {
  item: ReconcilePlanItem;
  layout: WorkspaceLayout;
  now: string;
  hooks?: CleanHooks;
}

interface CleanContext {
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
  hostFile: string;
  pluginFile: string;
  selectedOrphaned: UnifiedLanding[];
  all: UnifiedLanding[];
  activeAny: boolean;
}

class CleanError extends Error {
  readonly findings: Finding[];

  constructor(findings: Finding[]) {
    super(findings[0]?.message ?? 'clean failed');
    this.findings = findings;
  }
}

function errorFinding(cause: unknown, target: string): Finding {
  const error = toKernelError(cause, CODES.IO_FAILED);
  return finding(error.code, {
    source: error.source,
    target: error.target || target,
    message: error.message,
    remedy: error.remedy,
  });
}

function failure(item: ReconcilePlanItem, findings: Finding[]): ReconcileExecutionItem {
  return {
    result: {
      item_id: item.item_id,
      status: 'failed',
      target_path: item.target_path,
      findings,
      ...(item.after === undefined ? {} : { after: item.after }),
    },
    findings,
    changes: [],
  };
}

function invalid(target: string, message: string, remedy: string): Finding {
  return finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
    source: 'reconcile',
    target,
    message,
    remedy,
  });
}

function contextOf(input: CleanInput): CleanContext {
  const { item, layout, now } = input;
  if (!existsSync(item.target_path)) {
    throw new CleanError([
      finding(CODES.RECONCILE_PLAN_STALE, {
        source: 'reconcile',
        target: item.target_path,
        message: 'clean 目标已不存在，计划已过期',
        remedy: '重新盘点后再执行',
      }),
    ]);
  }
  const hostLoaded = loadHostLandingsForWrite(layout.hostLandingsFile, now, TOOL_VERSION);
  if (hostLoaded.index === null) throw new CleanError(hostLoaded.findings);
  const pluginLoaded = loadPluginIndex(layout.pluginIndexFile);
  if (pluginLoaded.index === null && pluginLoaded.exists) {
    throw new CleanError(pluginLoaded.findings);
  }
  const pluginIndex = pluginLoaded.index ?? createInitialPluginIndex(now, TOOL_VERSION);
  const physicalKey = inventoryPhysicalKey(item.target_path);
  const all =
    item.skill_id === undefined
      ? []
      : collectUnifiedLandings(hostLoaded.index, pluginIndex, item.skill_id).filter(
          (record) => inventoryPhysicalKey(record.physical_path) === physicalKey,
        );
  const selected = new Set(item.host_ids);
  const selectedOrphaned = all.filter(
    (record) => selected.has(record.host_id) && record.state === 'orphaned',
  );
  const activeAny = all.some((record) => record.state === 'active');
  if (selectedOrphaned.length === 0 && all.length > 0) {
    throw new CleanError([
      invalid(
        item.target_path,
        activeAny
          ? 'clean 不允许删除仍有 active 账本记录的副本'
          : 'clean 找不到可清理的 orphaned 记录',
        '请先使用 uninstall --host 或 forget 处理账本',
      ),
    ]);
  }
  return {
    hostIndex: hostLoaded.index,
    pluginIndex,
    hostFile: layout.hostLandingsFile,
    pluginFile: layout.pluginIndexFile,
    selectedOrphaned,
    all,
    activeAny,
  };
}

function snapshotOf(hostPath: string): { root: string; path: string } {
  const root = mkdtempSync(join(dirname(hostPath), '.clean-'));
  return { root, path: join(root, basename(hostPath)) };
}

function removeRecords(
  context: CleanContext,
  records: readonly UnifiedLanding[],
): {
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
  hostChanged: boolean;
  pluginChanged: boolean;
} {
  let hostIndex = context.hostIndex;
  let pluginIndex = context.pluginIndex;
  let hostChanged = false;
  let pluginChanged = false;
  for (const record of records) {
    if (record.ledger_source === 'host_landings') {
      hostIndex = removeHostLanding(hostIndex, record.record as HostLanding);
      hostChanged = true;
    } else {
      pluginIndex = {
        ...pluginIndex,
        landings: pluginIndex.landings.filter((item) => item !== (record.record as PluginLanding)),
      };
      pluginChanged = true;
    }
  }
  return { hostIndex, pluginIndex, hostChanged, pluginChanged };
}

function saveIndexes(input: {
  layout: WorkspaceLayout;
  now: string;
  previousHost: HostLandingIndex;
  previousPlugin: PluginIndex;
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
  hostChanged: boolean;
  pluginChanged: boolean;
  hooks?: CleanHooks;
}): { ok: boolean; findings: Finding[] } {
  let hostSaved = false;
  let pluginSaved = false;
  try {
    input.hooks?.beforeLedger?.();
    if (input.hostChanged) {
      saveHostLandings(input.layout.hostLandingsFile, {
        ...input.hostIndex,
        generated_at: input.now,
      });
      hostSaved = true;
    }
    if (input.pluginChanged) {
      savePluginIndex(input.layout.pluginIndexFile, {
        ...input.pluginIndex,
        generated_at: input.now,
      });
      pluginSaved = true;
    }
    return { ok: true, findings: [] };
  } catch (error) {
    const findings = [errorFinding(error, input.layout.hostLandingsFile)];
    try {
      if (hostSaved) saveHostLandings(input.layout.hostLandingsFile, input.previousHost);
      if (pluginSaved) savePluginIndex(input.layout.pluginIndexFile, input.previousPlugin);
    } catch (rollbackCause) {
      findings.push(errorFinding(rollbackCause, input.layout.pluginIndexFile));
    }
    return { ok: false, findings };
  }
}

function movePhysical(
  input: CleanInput,
  snapshot: { root: string; path: string },
): Finding[] | undefined {
  try {
    input.hooks?.beforeDelete?.();
    renameWithRetry(input.item.target_path, snapshot.path);
    return undefined;
  } catch (error) {
    removeTree(snapshot.root);
    return [errorFinding(error, input.item.target_path)];
  }
}

function restorePhysical(snapshot: { root: string; path: string }, hostPath: string): Finding[] {
  const findings: Finding[] = [];
  try {
    renameWithRetry(snapshot.path, hostPath);
  } catch (error) {
    findings.push(errorFinding(error, hostPath));
  }
  try {
    removeTree(snapshot.root);
  } catch (error) {
    findings.push(errorFinding(error, snapshot.root));
  }
  return findings;
}

function restoreIndexes(
  context: CleanContext,
  hostChanged: boolean,
  pluginChanged: boolean,
): Finding[] {
  const findings: Finding[] = [];
  try {
    if (hostChanged) saveHostLandings(context.hostFile, context.hostIndex);
  } catch (error) {
    findings.push(errorFinding(error, 'host_landings.yaml'));
  }
  try {
    if (pluginChanged) savePluginIndex(context.pluginFile, context.pluginIndex);
  } catch (error) {
    findings.push(errorFinding(error, 'plugin_index.yaml'));
  }
  return findings;
}

function changesOf(
  input: CleanInput,
  removed: boolean,
  hostChanged: boolean,
  pluginChanged: boolean,
): Change[] {
  return [
    ...(removed
      ? [
          {
            action: 'remove' as const,
            kind: input.item.format === 'rules' ? 'rule_file' : 'host_copy',
            path: input.item.target_path,
          },
        ]
      : []),
    ...(hostChanged
      ? [{ action: 'modify' as const, kind: 'host_landings', path: input.layout.hostLandingsFile }]
      : []),
    ...(pluginChanged
      ? [{ action: 'modify' as const, kind: 'plugin_index', path: input.layout.pluginIndexFile }]
      : []),
  ];
}

function succeeded(
  input: CleanInput,
  removed: boolean,
  hostChanged: boolean,
  pluginChanged: boolean,
): ReconcileExecutionItem {
  const changes = changesOf(input, removed, hostChanged, pluginChanged);
  return {
    result: {
      item_id: input.item.item_id,
      status: 'succeeded',
      target_path: input.item.target_path,
      after: input.item.after,
      message: removed
        ? '已删除无消费者需要的副本并清理账本'
        : '已清理选中宿主的 orphaned 记录；物理副本仍被其他宿主消费',
      changes,
    },
    findings: [],
    changes,
  };
}

function cleanLedgerOnly(
  input: CleanInput,
  context: CleanContext,
  next: ReturnType<typeof removeRecords>,
): ReconcileExecutionItem {
  const saved = saveIndexes({
    layout: input.layout,
    now: input.now,
    previousHost: context.hostIndex,
    previousPlugin: context.pluginIndex,
    ...next,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  if (!saved.ok) return failure(input.item, saved.findings);
  return succeeded(input, false, next.hostChanged, next.pluginChanged);
}

function cleanPhysical(
  input: CleanInput,
  context: CleanContext,
  next: ReturnType<typeof removeRecords>,
): ReconcileExecutionItem {
  const snapshot = snapshotOf(input.item.target_path);
  const moved = movePhysical(input, snapshot);
  if (moved !== undefined) return failure(input.item, moved);
  const saved = saveIndexes({
    layout: input.layout,
    now: input.now,
    previousHost: context.hostIndex,
    previousPlugin: context.pluginIndex,
    ...next,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  if (!saved.ok) {
    return failure(input.item, [
      ...saved.findings,
      ...restorePhysical(snapshot, input.item.target_path),
    ]);
  }
  try {
    removeTree(snapshot.path);
    removeTree(snapshot.root);
  } catch (error) {
    return failure(input.item, [
      errorFinding(error, snapshot.path),
      ...restorePhysical(snapshot, input.item.target_path),
      ...restoreIndexes(context, next.hostChanged, next.pluginChanged),
    ]);
  }
  return succeeded(input, true, next.hostChanged, next.pluginChanged);
}

/** 执行单个 clean；active 消费者存在时只清账本，不删物理副本。 */
export function cleanItem(input: CleanInput): ReconcileExecutionItem {
  let context: CleanContext;
  try {
    context = contextOf(input);
  } catch (error) {
    return failure(
      input.item,
      error instanceof CleanError ? error.findings : [errorFinding(error, input.item.target_path)],
    );
  }
  const remove = context.activeAny ? context.selectedOrphaned : context.all;
  const next = removeRecords(context, remove);
  return context.activeAny
    ? cleanLedgerOnly(input, context, next)
    : cleanPhysical(input, context, next);
}
