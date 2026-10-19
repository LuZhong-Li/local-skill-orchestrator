/** T3 clean：用同卷临时快照移走宿主残留，提交账本后再删除。 */
import { existsSync, mkdtempSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CODES,
  type Change,
  type Finding,
  type HostLanding,
  type HostLandingIndex,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { TOOL_VERSION } from '../../core/index/index.ts';
import { removeTree } from '../../store/library-fs/index.ts';
import {
  loadHostLandingsForWrite,
  removeHostLanding,
  saveHostLandings,
} from '../../store/host-landings/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
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
  loaded: HostLandingIndex;
  matching: HostLanding[];
  snapshot: { root: string; path: string };
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

function snapshotOf(hostPath: string): { root: string; path: string } {
  const root = mkdtempSync(join(dirname(hostPath), '.clean-'));
  return { root, path: join(root, basename(hostPath)) };
}

function matchingRecords(index: HostLandingIndex, item: ReconcilePlanItem): HostLanding[] {
  const hostId = item.host_ids[0] ?? '';
  return index.landings.filter(
    (record) =>
      record.target_path === item.target_path &&
      record.host_id === hostId &&
      (item.skill_id === undefined || record.skill_id === item.skill_id),
  );
}

function cleanContext(input: CleanInput): CleanContext {
  const { item, layout, now } = input;
  if (item.host_ids.length !== 1 || item.consumed_by.length > 1) {
    throw new CleanError([
      finding(CODES.RECONCILE_SHARED_GROUP, {
        source: 'reconcile',
        target: item.target_path,
        message: '共享根整组 clean 留到 T4',
        remedy: '请等待共享根事务组支持后再执行',
      }),
    ]);
  }
  const hostId = item.host_ids[0] ?? '';
  if (hostId.startsWith('x-')) {
    throw new CleanError([invalid(hostId, '插件 x- 宿主的 clean 留到 T4', '插件副本由插件包维护')]);
  }
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
  const loaded = loadHostLandingsForWrite(layout.hostLandingsFile, now, TOOL_VERSION);
  if (loaded.index === null) throw new CleanError(loaded.findings);
  const matching = matchingRecords(loaded.index, item);
  if (matching.some((record) => record.state === 'active')) {
    throw new CleanError([
      invalid(
        item.target_path,
        'clean 不允许删除仍有 active 账本记录的副本',
        '请先使用 uninstall --host 或 forget 处理账本',
      ),
    ]);
  }
  return { loaded: loaded.index, matching, snapshot: snapshotOf(item.target_path) };
}

function rollback(input: {
  layout: WorkspaceLayout;
  snapshot: { root: string; path: string };
  hostPath: string;
  previousLedger: HostLandingIndex | null;
}): Finding[] {
  const findings: Finding[] = [];
  try {
    if (input.previousLedger !== null) {
      saveHostLandings(input.layout.hostLandingsFile, input.previousLedger);
    }
  } catch (error) {
    findings.push(errorFinding(error, input.layout.hostLandingsFile));
  }
  try {
    renameSync(input.snapshot.path, input.hostPath);
  } catch (error) {
    findings.push(errorFinding(error, input.hostPath));
  }
  try {
    removeTree(input.snapshot.root);
  } catch (error) {
    findings.push(errorFinding(error, input.snapshot.root));
  }
  return findings;
}

function moveToSnapshot(
  input: CleanInput,
  context: CleanContext,
): ReconcileExecutionItem | undefined {
  try {
    renameSync(input.item.target_path, context.snapshot.path);
    return undefined;
  } catch (error) {
    removeTree(context.snapshot.root);
    return failure(input.item, [errorFinding(error, input.item.target_path)]);
  }
}

function commitLedger(
  input: CleanInput,
  context: CleanContext,
): {
  written: boolean;
  failure?: ReconcileExecutionItem;
} {
  if (context.matching.length === 0) return { written: false };
  let next = context.loaded;
  for (const record of context.matching) next = removeHostLanding(next, record);
  try {
    input.hooks?.beforeLedger?.();
    saveHostLandings(input.layout.hostLandingsFile, { ...next, generated_at: input.now });
    return { written: true };
  } catch (error) {
    return {
      written: false,
      failure: failure(input.item, [
        errorFinding(error, input.layout.hostLandingsFile),
        ...rollback({
          layout: input.layout,
          snapshot: context.snapshot,
          hostPath: input.item.target_path,
          previousLedger: null,
        }),
      ]),
    };
  }
}

function deleteSnapshot(
  input: CleanInput,
  context: CleanContext,
  ledgerWritten: boolean,
): ReconcileExecutionItem | undefined {
  try {
    input.hooks?.beforeDelete?.();
    removeTree(context.snapshot.path);
    removeTree(context.snapshot.root);
    return undefined;
  } catch (error) {
    return failure(input.item, [
      errorFinding(error, context.snapshot.path),
      ...rollback({
        layout: input.layout,
        snapshot: context.snapshot,
        hostPath: input.item.target_path,
        previousLedger: ledgerWritten ? context.loaded : null,
      }),
    ]);
  }
}

function success(input: CleanInput, ledgerWritten: boolean): ReconcileExecutionItem {
  const changes: Change[] = [
    {
      action: 'remove',
      kind: input.item.format === 'rules' ? 'rule_file' : 'host_copy',
      path: input.item.target_path,
    },
    ...(ledgerWritten
      ? [{ action: 'modify' as const, kind: 'host_landings', path: input.layout.hostLandingsFile }]
      : []),
  ];
  return {
    result: {
      item_id: input.item.item_id,
      status: 'succeeded',
      target_path: input.item.target_path,
      after: input.item.after,
      message: ledgerWritten ? '已删除残留副本并清理 orphaned 账本' : '已删除残留副本',
      changes,
    },
    findings: [],
    changes,
  };
}

/** 执行单个 clean；成功删除临时快照，失败恢复物理副本与账本。 */
export function cleanItem(input: CleanInput): ReconcileExecutionItem {
  let context: CleanContext;
  try {
    context = cleanContext(input);
  } catch (error) {
    return failure(
      input.item,
      error instanceof CleanError ? error.findings : [errorFinding(error, input.item.target_path)],
    );
  }
  const moved = moveToSnapshot(input, context);
  if (moved !== undefined) return moved;
  const ledger = commitLedger(input, context);
  if (ledger.failure !== undefined) return ledger.failure;
  const deleted = deleteSnapshot(input, context, ledger.written);
  if (deleted !== undefined) return deleted;
  return success(input, ledger.written);
}
