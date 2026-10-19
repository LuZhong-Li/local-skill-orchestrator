/** 宿主技能副本卸载：单宿主 / all、共享根保护、两账本孤儿化与原件卸载阻断。 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { toKernelError } from '../../store/errors.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import {
  createInitialHostLandings,
  loadHostLandings,
  saveHostLandings,
} from '../../store/host-landings/index.ts';
import { createInitialPluginIndex, loadPluginIndex } from '../../store/plugin-registry/index.ts';
import { TOOL_VERSION } from '../../core/index/index.ts';
import type { HostLandingIndex, PluginIndex } from '@skill-manager/contract';
import type { SkillIndex } from '../../core/metadata/types.ts';
import type { LifecycleOutcome } from '../../core/lifecycle/index.ts';
import {
  activeBlockers,
  collectUnifiedLandings,
  groupByPhysicalPath,
  physicalExists,
  purgeHostOrphanedLandings,
  type UnifiedLanding,
} from '../../core/host-landings/uninstall.ts';
import { hostTargetOf } from './channel.ts';
import { executeHostUninstall } from './uninstall-execute.ts';
export { executeHostUninstall } from './uninstall-execute.ts';
import { buildResult, type Result } from '../result/index.ts';
import type { ConfirmPlan, Interaction } from '../policy/index.ts';
import type { ParsedArgs } from '../parsers/index.ts';

export type ConfirmGate = (input: {
  command: string;
  args: ParsedArgs;
  interaction: Interaction;
  preview: LifecycleOutcome;
  plan: ConfirmPlan;
}) => Promise<Result<unknown> | null>;

export * from './uninstall-options.ts';
import type {
  HostUninstallGroup,
  HostUninstallHooks,
  HostUninstallPlan,
} from './uninstall-types.ts';
export type {
  HostUninstallExecution,
  HostUninstallGroup,
  HostUninstallHooks,
  HostUninstallPlan,
  HostUninstallResultItem,
} from './uninstall-types.ts';

function invalidHost(target: string, message: string, remedy: string): Finding {
  return finding(CODES.INPUT_INVALID_ARG, {
    source: 'input',
    target,
    message,
    remedy,
  });
}

function selectedLandings(
  input: {
    hostValue: string;
    skillId: string;
    hostIndex: HostLandingIndex;
    pluginIndex: PluginIndex;
  },
  all: UnifiedLanding[],
): UnifiedLanding[] {
  if (input.hostValue === 'all') return all;
  if (input.hostValue.startsWith('x-')) {
    return all.filter(
      (item) => item.ledger_source === 'plugin_landings' && item.host_id === input.hostValue,
    );
  }
  const target = hostTargetOf(input.hostValue);
  if (target === undefined) return [];
  return all.filter(
    (item) =>
      item.ledger_source === 'host_landings' &&
      item.host_id === target.hostId &&
      item.format === target.form,
  );
}

/** 生成卸载计划；单宿主共享根冲突在这里直接拒绝。 */
export function planHostUninstall(input: {
  hostValue: string;
  skillId: string;
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
}): HostUninstallPlan {
  const all = collectUnifiedLandings(input.hostIndex, input.pluginIndex, input.skillId);
  const selected = selectedLandings(input, all);
  if (selected.length === 0) {
    const target = input.hostValue === 'all' ? '--host' : input.hostValue;
    return {
      hostValue: input.hostValue,
      groups: [],
      findings: [
        invalidHost(
          target,
          input.hostValue === 'all'
            ? `Skill ${input.skillId} 没有可清理的宿主副本记录`
            : `Skill ${input.skillId} 在宿主 ${input.hostValue} 没有宿主副本记录`,
          '先用 install/update --host 分发，或确认宿主标识是否正确',
        ),
      ],
    };
  }
  const findings: Finding[] = [];
  const groups: HostUninstallGroup[] = [];
  for (const [physicalPath, landings] of groupByPhysicalPath(selected)) {
    const shared = new Set(landings.map((item) => item.host_id)).size > 1;
    if (input.hostValue !== 'all' && hasOtherActive(all, landings, physicalPath)) {
      findings.push(
        finding(CODES.LANDING_LEDGER_INVALID, {
          source: 'host-landings',
          target: physicalPath,
          message: `共享根仍被其他活跃宿主消费，不能只清理 ${input.hostValue}：${physicalPath}`,
          remedy: `先执行 skill-manager uninstall ${input.skillId} --host all 一次清理全部宿主副本`,
        }),
      );
    }
    groups.push({
      physical_path: physicalPath,
      exists: physicalExists(physicalPath),
      format: landings[0]?.format ?? 'unknown',
      shared,
      landings,
    });
  }
  return { hostValue: input.hostValue, groups, findings };
}

function hasOtherActive(
  all: readonly UnifiedLanding[],
  selected: readonly UnifiedLanding[],
  physicalPath: string,
): boolean {
  const selectedSet = new Set(selected);
  return all.some(
    (item) =>
      item.physical_path === physicalPath && item.state === 'active' && !selectedSet.has(item),
  );
}

function emptyPluginIndex(now: string): PluginIndex {
  return createInitialPluginIndex(now, TOOL_VERSION);
}

/** 读取两本账本并生成 e2e/CLI 可消费的卸载计划。 */
export function prepareHostUninstall(input: {
  layout: WorkspaceLayout;
  now: string;
  hostValue: string;
  skillId: string;
}): {
  plan?: HostUninstallPlan;
  hostIndex?: HostLandingIndex;
  pluginIndex?: PluginIndex;
  findings: Finding[];
} {
  const hostLoaded = loadHostLandings(input.layout.hostLandingsFile);
  if (hostLoaded.index === null && hostLoaded.exists) {
    return { findings: hostLoaded.findings };
  }
  const hostIndex = hostLoaded.index ?? createInitialHostLandings(input.now, TOOL_VERSION);
  const pluginLoaded = loadPluginIndex(input.layout.pluginIndexFile);
  if (pluginLoaded.index === null && pluginLoaded.exists) {
    return { findings: pluginLoaded.findings };
  }
  const pluginIndex = pluginLoaded.index ?? emptyPluginIndex(input.now);
  const plan = planHostUninstall({
    hostValue: input.hostValue,
    skillId: input.skillId,
    hostIndex,
    pluginIndex,
  });
  return {
    plan,
    hostIndex,
    pluginIndex,
    findings: [...hostLoaded.findings, ...pluginLoaded.findings, ...plan.findings],
  };
}

function confirmPlan(plan: HostUninstallPlan): ConfirmPlan {
  return {
    action: '卸载',
    subject: plan.hostValue === 'all' ? '全部宿主副本' : `宿主 ${plan.hostValue}`,
    writes: plan.groups.map((group) => ({
      action: group.exists ? '删除' : '确认不存在',
      kind: group.format === 'rules' ? 'rule_file' : 'host-copy',
      path: group.physical_path,
    })),
    notes: [
      '宿主副本是可从工作区重新分发的派生物；本操作不创建 Skill 备份',
      '只删除宿主副本，不删除工作区原件',
      '插件包不会被卸载；插件安装状态不受影响',
      '共享物理副本只删除一次，账本记录标为 orphaned',
    ],
  };
}

/** CLI 卸载 --host 的完整执行入口；confirm 由 dispatch/registry 注入。 */
export async function runHostUninstallCommand(input: {
  layout: WorkspaceLayout;
  now: string;
  hostValue: string;
  skillId: string;
  dryRun: boolean;
  confirm: (plan: ConfirmPlan) => Promise<Result<unknown> | null>;
  hooks?: HostUninstallHooks;
}): Promise<Result<unknown>> {
  const prepared = prepareHostUninstall(input);
  if (
    prepared.plan === undefined ||
    prepared.hostIndex === undefined ||
    prepared.pluginIndex === undefined
  ) {
    return buildResult('uninstall', prepared.findings, [], { data: { host: input.hostValue } });
  }
  if (prepared.findings.some((item) => item.severity === 'error')) {
    return buildResult('uninstall', prepared.findings, [], { data: { host: input.hostValue } });
  }
  const plan = confirmPlan(prepared.plan);
  if (input.dryRun) {
    return buildResult('uninstall', prepared.findings, [], {
      data: {
        host: input.hostValue,
        groups: prepared.plan.groups,
        backup: null,
        workspace_unchanged: true,
        preview_writes: plan.writes,
      },
      preview: true,
    });
  }
  const blocked = await input.confirm(plan);
  if (blocked !== null) return blocked;
  const execution = executeHostUninstall({
    plan: prepared.plan,
    layout: input.layout,
    now: input.now,
    skillId: input.skillId,
    hostIndex: prepared.hostIndex,
    pluginIndex: prepared.pluginIndex,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  return buildResult('uninstall', execution.findings, execution.changes, {
    data: {
      host: input.hostValue,
      hosts: execution.results,
      orphaned_landings: execution.orphaned_records,
      removed: execution.results.filter((item) => item.status === 'removed').length,
      backup: null,
      workspace_unchanged: true,
    },
  });
}

/** 原件卸载前的 active 记录检查。 */
export function blockingLandings(input: {
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
}): {
  blockers: UnifiedLanding[];
  findings: Finding[];
  hostIndex?: HostLandingIndex;
  pluginIndex?: PluginIndex;
} {
  const hostLoaded = loadHostLandings(input.layout.hostLandingsFile);
  const pluginLoaded = loadPluginIndex(input.layout.pluginIndexFile);
  const findings = [...hostLoaded.findings, ...pluginLoaded.findings];
  if (hostLoaded.index === null && hostLoaded.exists) return { blockers: [], findings };
  if (pluginLoaded.index === null && pluginLoaded.exists) return { blockers: [], findings };
  const hostIndex = hostLoaded.index ?? createInitialHostLandings(input.now, TOOL_VERSION);
  const pluginIndex = pluginLoaded.index ?? emptyPluginIndex(input.now);
  return {
    blockers: activeBlockers(hostIndex, pluginIndex, input.skillId),
    findings,
    hostIndex,
    pluginIndex,
  };
}

/** 原件卸载前的统一阻断结果；无阻断时返回 null。 */
export function blockedOriginalUninstall(input: {
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
}): Result<unknown> | null {
  const blocking = blockingLandings(input);
  if (blocking.findings.some((item) => item.severity === 'error')) {
    return buildResult('uninstall', blocking.findings, [], { data: { id: input.skillId } });
  }
  if (blocking.blockers.length === 0) return null;
  return buildResult('uninstall', [blockingFinding(input.skillId, blocking.blockers)], [], {
    data: {
      id: input.skillId,
      active_hosts: blocking.blockers.map((item) => ({
        host_id: item.host_id,
        target_path: item.physical_path,
        ledger_source: item.ledger_source,
      })),
    },
  });
}

/** 原件卸载成功后的 host orphaned 清理；失败只追加 finding，不回滚原件。 */
export function purgeAfterOriginalUninstall(input: {
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  dryRun: boolean;
  findings: readonly Finding[];
}): Finding[] {
  if (input.dryRun || input.findings.some((item) => item.severity === 'error')) return [];
  return purgeHostOrphans(input);
}

/** 先分流 --host，再检查原件卸载阻断；返回 null 表示可以继续原件卸载。 */
export async function runHostOrBlockedUninstall(input: {
  layout: WorkspaceLayout;
  now: string;
  hostValue?: string | undefined;
  skillId: string;
  dryRun: boolean;
  args: ParsedArgs;
  interaction: Interaction;
  confirm: ConfirmGate;
}): Promise<Result<unknown> | null> {
  if (input.hostValue !== undefined) {
    return runHostUninstallCommand({
      layout: input.layout,
      now: input.now,
      hostValue: input.hostValue,
      skillId: input.skillId,
      dryRun: input.dryRun,
      confirm: (plan) =>
        input.confirm({
          command: 'uninstall',
          args: input.args,
          interaction: input.interaction,
          preview: { index: {} as SkillIndex, findings: [], changes: [], data: {} },
          plan,
        }),
    });
  }
  return blockedOriginalUninstall({
    layout: input.layout,
    now: input.now,
    skillId: input.skillId,
  });
}

/** 原件卸载的成功收尾：保留原结果并追加 host orphaned 清理 findings。 */
export function finishOriginalUninstall(input: {
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  dryRun: boolean;
  outcome: LifecycleOutcome;
}): Result<unknown> {
  const findings = [
    ...input.outcome.findings,
    ...purgeAfterOriginalUninstall({
      layout: input.layout,
      now: input.now,
      skillId: input.skillId,
      dryRun: input.dryRun,
      findings: input.outcome.findings,
    }),
  ];
  return buildResult('uninstall', findings, input.outcome.changes, {
    data: input.outcome.data,
    ...(input.outcome.preview === true ? { preview: true } : {}),
  });
}

/** 原件卸载的预览与确认；dry-run 直接放行，实际执行前由确认门裁决。 */
export async function confirmOriginalUninstall(input: {
  args: ParsedArgs;
  interaction: Interaction;
  skillId: string;
  hard: boolean;
  dryRun: boolean;
  runPreview: () => LifecycleOutcome;
  confirm: ConfirmGate;
}): Promise<Result<unknown> | null> {
  if (input.dryRun) return null;
  const preview = input.runPreview();
  const detail = preview.data['would_remove_detail'];
  const fileCount = String(preview.data['would_remove_file_count'] ?? 0);
  const notes = [
    `合计将移除 ${Array.isArray(detail) ? detail.length : 0} 个副本位置、${fileCount} 个文件`,
    '卸载前会先把中心库原件备份到工作区的备份目录',
    input.hard
      ? '中心库原件将被永久删除，本工具不再持有该 Skill 的任何原件'
      : '中心库原件将保留；保留后它不再属于已管理集合',
  ];
  const plan: ConfirmPlan = {
    action: '卸载',
    subject: input.skillId,
    writes: preview.changes.map((item) => ({
      action: item.action,
      kind: item.kind,
      path: item.path,
    })),
    notes,
  };
  return input.confirm({
    command: 'uninstall',
    args: input.args,
    interaction: input.interaction,
    preview,
    plan,
  });
}

export function blockingFinding(skillId: string, blockers: readonly UnifiedLanding[]): Finding {
  const list = blockers
    .map((item) => `${item.host_id}: ${item.physical_path}（${item.ledger_source}）`)
    .join('；');
  return finding(CODES.LANDING_UNINSTALL_BLOCKED, {
    source: 'host-landings',
    target: skillId,
    message: `无法卸载 ${skillId}：仍有 ${String(blockers.length)} 个活跃宿主副本（${list}）`,
    remedy: `先执行 skill-manager uninstall ${skillId} --host <host> 逐宿主清理，或执行 skill-manager uninstall ${skillId} --host all 一次清理全部宿主副本；确认后再卸载原件`,
  });
}

/** 原件卸载成功后清除内置账本的 orphaned 记录；插件孤儿账本保留。 */
export function purgeHostOrphans(input: {
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
}): Finding[] {
  if (!physicalExists(input.layout.hostLandingsFile)) return [];
  const loaded = loadHostLandings(input.layout.hostLandingsFile);
  if (loaded.index === null) return loaded.findings;
  const next = {
    ...purgeHostOrphanedLandings(loaded.index, input.skillId),
    generated_at: input.now,
  };
  if (next.landings.length === loaded.index.landings.length) return loaded.findings;
  try {
    saveHostLandings(input.layout.hostLandingsFile, next);
    return loaded.findings;
  } catch (error) {
    return [
      ...loaded.findings,
      finding(CODES.IO_ATOMIC_FAILED, {
        source: 'host-landings',
        target: input.layout.hostLandingsFile,
        message: `原件卸载后清理 host_landings 孤儿记录失败：${toKernelError(error, CODES.IO_ATOMIC_FAILED).message}`,
        remedy: '检查 host_landings.yaml 是否可写；工作区原件已经卸载',
      }),
    ];
  }
}
