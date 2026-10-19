import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODES, type Change, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { toKernelError } from '../../store/errors.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { saveHostLandings } from '../../store/host-landings/index.ts';
import { savePluginIndex } from '../../store/plugin-registry/index.ts';
import { isDirectory, removeTree } from '../../store/library-fs/index.ts';
import { renameWithRetry } from '../../store/atomic/index.ts';
import type { HostLandingIndex, PluginIndex } from '@skill-manager/contract';
import {
  orphanHostLandingsForPaths,
  orphanPluginLandingsForPaths,
  type UnifiedFormat,
} from '../../core/host-landings/uninstall.ts';
import type {
  HostUninstallExecution,
  HostUninstallGroup,
  HostUninstallHooks,
  HostUninstallPlan,
  HostUninstallResultItem,
} from './uninstall-types.ts';
interface GroupExecution {
  results: HostUninstallResultItem[];
  findings: Finding[];
  changes: Change[];
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
  orphaned: number;
}

function groupHas(group: HostUninstallGroup, source: 'host_landings' | 'plugin_landings'): boolean {
  return group.landings.some((item) => item.ledger_source === source);
}

function saveGroupIndexes(input: {
  layout: WorkspaceLayout;
  now: string;
  group: HostUninstallGroup;
  previousHost: HostLandingIndex;
  previousPlugin: PluginIndex;
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
}): { ok: boolean; error?: unknown; rollbackError?: unknown } {
  let hostSaved = false;
  let pluginSaved = false;
  try {
    if (groupHas(input.group, 'host_landings')) {
      saveHostLandings(input.layout.hostLandingsFile, {
        ...input.hostIndex,
        generated_at: input.now,
      });
      hostSaved = true;
    }
    if (groupHas(input.group, 'plugin_landings')) {
      savePluginIndex(input.layout.pluginIndexFile, {
        ...input.pluginIndex,
        generated_at: input.now,
      });
      pluginSaved = true;
    }
    return { ok: true };
  } catch (error) {
    let rollbackError: unknown;
    try {
      if (hostSaved) saveHostLandings(input.layout.hostLandingsFile, input.previousHost);
      if (pluginSaved) savePluginIndex(input.layout.pluginIndexFile, input.previousPlugin);
    } catch (cause) {
      rollbackError = cause;
    }
    return { ok: false, error, ...(rollbackError === undefined ? {} : { rollbackError }) };
  }
}

function restorePhysical(tempPath: string, physicalPath: string): void {
  renameWithRetry(tempPath, physicalPath);
}

function deletePhysical(path: string, format: UnifiedFormat): void {
  if (format === 'skill' || (format === 'unknown' && isDirectory(path))) {
    removeTree(path);
    return;
  }
  rmSync(path, { force: true });
}

function resultItems(
  group: HostUninstallGroup,
  status: HostUninstallResultItem['status'],
  message?: string,
): HostUninstallResultItem[] {
  return group.landings.map((item) => ({
    host_id: item.host_id,
    ledger_source: item.ledger_source,
    target_path: item.physical_path,
    status,
    ...(message === undefined ? {} : { message }),
  }));
}

/**
 * 执行卸载。每个物理副本组独立提交：成功组保留结果，失败组恢复副本与账本；
 * 多宿主 --host all 因此呈现逐组成功/失败，而不是一半账本一半磁盘。
 */
export function executeHostUninstall(input: {
  plan: HostUninstallPlan;
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
  hooks?: HostUninstallHooks;
}): HostUninstallExecution {
  let hostIndex = input.hostIndex;
  let pluginIndex = input.pluginIndex;
  const results: HostUninstallResultItem[] = [];
  const findings: Finding[] = [];
  const changes: Change[] = [];
  let orphaned = 0;
  for (const group of input.plan.groups) {
    const execution = executeGroup({
      group,
      layout: input.layout,
      now: input.now,
      skillId: input.skillId,
      hostIndex,
      pluginIndex,
      ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    });
    results.push(...execution.results);
    findings.push(...execution.findings);
    changes.push(...execution.changes);
    hostIndex = execution.hostIndex;
    pluginIndex = execution.pluginIndex;
    orphaned += execution.orphaned;
  }
  return { results, findings, changes, hostIndex, pluginIndex, orphaned_records: orphaned };
}

function executeGroup(input: {
  group: HostUninstallGroup;
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
  hooks?: HostUninstallHooks;
}): GroupExecution {
  const activeCount = input.group.landings.filter((item) => item.state === 'active').length;
  const moved = moveGroup(input.group, input.hooks);
  if (moved.error !== undefined) {
    return failedGroup(
      input.group,
      input.hostIndex,
      input.pluginIndex,
      activeCount,
      `宿主副本移动失败，账本未改变：${toKernelError(moved.error, CODES.IO_FAILED).message}`,
    );
  }
  const hostIndex = orphanHostLandingsForPaths(
    input.hostIndex,
    input.skillId,
    [input.group.physical_path],
    input.now,
  );
  const pluginIndex = orphanPluginLandingsForPaths(
    input.pluginIndex,
    input.skillId,
    [input.group.physical_path],
    input.now,
  );
  const saved = saveGroupIndexes({
    layout: input.layout,
    now: input.now,
    group: input.group,
    previousHost: input.hostIndex,
    previousPlugin: input.pluginIndex,
    hostIndex,
    pluginIndex,
  });
  if (!saved.ok) {
    if (moved.tempPath !== undefined) safeRestore(moved.tempPath, input.group.physical_path);
    const execution = failedGroup(
      input.group,
      input.hostIndex,
      input.pluginIndex,
      activeCount,
      `账本写入失败，副本已恢复：${toKernelError(saved.error, CODES.IO_ATOMIC_FAILED).message}`,
    );
    if (saved.rollbackError !== undefined) {
      execution.findings.push(
        finding(CODES.LANDING_LEDGER_INVALID, {
          source: 'host-uninstall',
          target: input.group.physical_path,
          message: `账本回滚失败：${toKernelError(saved.rollbackError, CODES.LANDING_LEDGER_INVALID).message}`,
          remedy: '停止继续卸载，检查两本账本与宿主副本的实际状态',
        }),
      );
    }
    return execution;
  }
  const finalized = finalizeGroup(input.group, moved.tempPath, activeCount);
  return { ...finalized, hostIndex, pluginIndex, orphaned: activeCount };
}

function moveGroup(
  group: HostUninstallGroup,
  hooks: HostUninstallHooks | undefined,
): { tempPath?: string; error?: unknown } {
  if (!group.exists) return {};
  const tempPath = join(dirname(group.physical_path), `.sm-uninstall-${randomUUID()}`);
  try {
    hooks?.onBeforeDelete?.(group.physical_path);
    renameWithRetry(group.physical_path, tempPath);
    return { tempPath };
  } catch (error) {
    return { error };
  }
}

function finalizeGroup(
  group: HostUninstallGroup,
  tempPath: string | undefined,
  activeCount: number,
): { results: HostUninstallResultItem[]; findings: Finding[]; changes: Change[] } {
  if (tempPath === undefined) {
    return {
      results: resultItems(group, activeCount > 0 ? 'missing' : 'unchanged'),
      findings: [],
      changes: [],
    };
  }
  try {
    deletePhysical(tempPath, group.format);
    return {
      results: resultItems(group, 'removed'),
      findings: [],
      changes: [
        {
          action: 'remove',
          kind: group.format === 'rules' ? 'rule_file' : 'host-copy',
          path: group.physical_path,
          detail: group.shared ? '共享根副本只删除一次' : '宿主副本已删除',
        },
      ],
    };
  } catch (error) {
    const restoreError = safeRestore(tempPath, group.physical_path);
    const findings: Finding[] = [
      finding(CODES.IO_FAILED, {
        source: 'host-uninstall',
        target: group.physical_path,
        message: `宿主副本删除失败：${toKernelError(error, CODES.IO_FAILED).message}`,
        remedy: '检查文件占用与权限；账本已标记 orphaned，副本保留',
      }),
    ];
    if (restoreError !== undefined) {
      findings.push(
        finding(CODES.LANDING_LEDGER_INVALID, {
          source: 'host-uninstall',
          target: group.physical_path,
          message: `副本删除失败且无法恢复：${toKernelError(restoreError, CODES.IO_FAILED).message}`,
          remedy: '停止继续卸载，检查宿主副本与账本的实际状态',
        }),
      );
    }
    return {
      results: resultItems(group, 'failed', '副本删除失败，账本已标记 orphaned'),
      findings,
      changes: [],
    };
  }
}

function failedGroup(
  group: HostUninstallGroup,
  hostIndex: HostLandingIndex,
  pluginIndex: PluginIndex,
  activeCount: number,
  message: string,
): GroupExecution {
  return {
    results: resultItems(group, 'failed', message),
    findings: [
      finding(CODES.IO_FAILED, {
        source: 'host-uninstall',
        target: group.physical_path,
        message,
        remedy: '检查副本占用、权限与两本账本后重试',
      }),
    ],
    changes: [],
    hostIndex,
    pluginIndex,
    orphaned: activeCount,
  };
}

function safeRestore(tempPath: string, physicalPath: string): unknown | undefined {
  try {
    restorePhysical(tempPath, physicalPath);
    return undefined;
  } catch (error) {
    return error;
  }
}
