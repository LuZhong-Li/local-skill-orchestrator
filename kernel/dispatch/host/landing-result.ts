/** 宿主落位结果与内置账本写入。 */
import { CODES, finding, type Change, type Finding } from '../../store/contract.ts';
import { join } from 'node:path';
import { KernelError, toKernelError } from '../../store/errors.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { HostChannel } from './channel.ts';
import { hostWritesOutside } from './channel.ts';
import {
  isHostSkillDisabled,
  landPlan,
  rollbackLandWrites,
  setHostSkillVisibility,
  type LandWrite,
} from '../../core/adapters/land.ts';
import type { PlacementPlan } from '../../core/adapters/types.ts';
import { adapterFor } from '../../core/adapters/index.ts';
import { hostById } from '../../core/hosts/index.ts';
import { TOOL_VERSION } from '../../core/index/index.ts';
import { computeChecksum, computeLandingChecksum } from '../../core/integrity/index.ts';
import {
  loadHostLandingsForWrite,
  saveHostLandings,
  type HostLandingWriteView,
} from '../../store/host-landings/index.ts';
import {
  applyHostLandingRecords,
  buildHostLandingRecord,
  commitHostLandings,
  landingFormatOf,
  landingTargetPathOf,
  recordAdoptedVisibility,
  sourceMetaOf,
} from '../../core/host-landings/index.ts';
import { savePluginIndex } from '../../store/plugin-registry/index.ts';
import { upsertPluginLanding } from '../../core/plugins/host.ts';
import type { DeliveryPlanEntry } from '../../store/library-fs/index.ts';
import { buildResult, type Result } from '../result/index.ts';

export interface BuiltinLandingContext {
  format: 'skill' | 'rules';
  targetPath: string;
  index: import('@skill-manager/contract').HostLandingIndex;
}

/** enable/disable 写盘前读取账本；dryRun 与插件宿主不读取内置账本。 */
export function prepareToggleLedger(input: {
  channel: HostChannel;
  layout: WorkspaceLayout;
  now: string;
  dryRun: boolean;
  rootPath: string;
  skillId: string;
}): {
  index?: import('@skill-manager/contract').HostLandingIndex;
  beforeDisabled: boolean;
  findings: Finding[];
} {
  if (input.dryRun || input.channel.plugin !== undefined) {
    return { beforeDisabled: false, findings: [] };
  }
  const loaded = loadHostLandingsForWrite(input.layout.hostLandingsFile, input.now, TOOL_VERSION);
  if (loaded.index === null) return { beforeDisabled: false, findings: loaded.findings };
  const initialized = ensureLedgerInitialized(input.layout.hostLandingsFile, loaded);
  if (initialized !== null) {
    return { beforeDisabled: false, findings: [...loaded.findings, initialized] };
  }
  return {
    index: loaded.index,
    beforeDisabled: isHostSkillDisabled({
      rootPath: input.rootPath,
      skillId: input.skillId,
    }),
    findings: loaded.findings,
  };
}

/** 写盘前读取并校验内置账本；损坏时必须在 landPlan 之前中止。 */
export function prepareBuiltinLanding(input: {
  channel: HostChannel;
  layout: WorkspaceLayout;
  now: string;
  dryRun: boolean;
}): { context?: BuiltinLandingContext; findings: Finding[] } {
  if (input.dryRun || input.channel.plugin !== undefined) return { findings: [] };
  const format = landingFormatOf(input.channel.form);
  if (format === undefined) return { findings: [] };
  const targetPath = landingTargetPathOf(input.channel.plan, input.channel.form);
  if (targetPath === undefined) return { findings: [] };
  const loaded = loadHostLandingsForWrite(input.layout.hostLandingsFile, input.now, TOOL_VERSION);
  if (loaded.index === null) return { findings: loaded.findings };
  const initialized = ensureLedgerInitialized(input.layout.hostLandingsFile, loaded);
  if (initialized !== null) return { findings: [...loaded.findings, initialized] };
  return {
    context: { format, targetPath, index: loaded.index },
    findings: loaded.findings,
  };
}

/** 旧工作区首次写账本时幂等补建空文件；损坏文件不会被走到这里。 */
function ensureLedgerInitialized(file: string, loaded: HostLandingWriteView): Finding | null {
  if (!loaded.missing || loaded.index === null) return null;
  try {
    saveHostLandings(file, loaded.index);
    return null;
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_ATOMIC_FAILED);
    return finding(kernelError.code, {
      source: kernelError.source,
      target: kernelError.target,
      message: `无法创建旧工作区的 host_landings.yaml：${kernelError.message}`,
      remedy: '检查工作区根目录是否可写后重试；未写入任何宿主副本',
    });
  }
}

/** 共享根的消费宿主；外部消费方（如 dsh）只出现在视图，不立账本记录。 */
function registeredConsumerIds(plan: PlacementPlan, hostId: string): string[] {
  const ids = new Set([hostId, ...plan.entries.flatMap((entry) => entry.consumed_by)]);
  return [...ids]
    .filter(
      (id) => !id.startsWith('x-') && hostById(id) !== undefined && adapterFor(id) !== undefined,
    )
    .sort();
}

function rollbackFinding(error: KernelError): Finding {
  return finding(error.code, {
    source: error.source,
    target: error.target,
    message: `宿主副本回滚失败：${error.message}`,
    remedy: error.remedy,
  });
}

function commitFailureFindings(
  commit: {
    error?: KernelError;
    rollbackError?: KernelError;
  },
  file: string,
): Finding[] {
  const findings: Finding[] = [
    finding(commit.error?.code ?? CODES.IO_ATOMIC_FAILED, {
      source: commit.error?.source ?? 'host-landings',
      target: commit.error?.target ?? file,
      message: `内置宿主账本写入失败：${commit.error?.message ?? '未知错误'}`,
      remedy: '检查 host_landings.yaml 是否可写；本次宿主副本已回滚',
    }),
  ];
  if (commit.rollbackError !== undefined) findings.push(rollbackFinding(commit.rollbackError));
  return findings;
}

/** 落位成功后写内置账本；失败时回滚本次全部物理写入。 */
export function commitBuiltinLanding(input: {
  channel: HostChannel;
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  sourceDir: string;
  sourceMeta: Record<string, unknown>;
  context: BuiltinLandingContext;
  writes: readonly LandWrite[];
}): { recorded: boolean; findings: Finding[] } {
  try {
    return commitBuiltinLandingUnchecked(input);
  } catch (error) {
    const kernelError = toKernelError(error, CODES.LANDING_LEDGER_INVALID);
    const findings: Finding[] = [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: `内置宿主账本落账失败：${kernelError.message}`,
        remedy: '检查宿主副本摘要与 host_landings.yaml；本次宿主副本已回滚',
      }),
    ];
    try {
      rollbackLandWrites(input.writes);
    } catch (rollbackCause) {
      findings.push(rollbackFinding(toKernelError(rollbackCause, CODES.LANDING_LEDGER_INVALID)));
    }
    return { recorded: false, findings };
  }
}

function commitBuiltinLandingUnchecked(input: {
  channel: HostChannel;
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  sourceDir: string;
  sourceMeta: Record<string, unknown>;
  context: BuiltinLandingContext;
  writes: readonly LandWrite[];
}): { recorded: boolean; findings: Finding[] } {
  const sourceChecksum = computeChecksum(input.sourceDir);
  const contentDigest = computeLandingChecksum({
    targetPath: input.context.targetPath,
    format: input.context.format,
  });
  const hostIds = registeredConsumerIds(input.channel.plan, input.channel.hostId);
  const records = hostIds.map((hostId) =>
    buildHostLandingRecord({
      skillId: input.skillId,
      hostId,
      targetPath: input.context.targetPath,
      format: input.context.format,
      visibility: 'visible',
      origin: 'distributed',
      sourceChecksum,
      contentDigest,
      sourceMeta: sourceMetaOf(input.sourceMeta),
      now: input.now,
    }),
  );
  const next = applyHostLandingRecords(input.context.index, records);
  const commit = commitHostLandings({
    file: input.layout.hostLandingsFile,
    index: { ...next, generated_at: input.now },
    rollback: () => rollbackLandWrites(input.writes),
  });
  return commit.ok
    ? { recorded: true, findings: [] }
    : { recorded: false, findings: commitFailureFindings(commit, input.layout.hostLandingsFile) };
}

/** enable/disable 成功后更新账本；失败时把物理改名反向恢复。 */
export function commitBuiltinVisibility(input: {
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  hostId: string;
  sourceMeta: Record<string, unknown>;
  index: import('@skill-manager/contract').HostLandingIndex;
  targetPath: string;
  rootPath: string;
  visibility: 'visible' | 'disabled';
  beforeDisabled: boolean;
  changed: boolean;
}): { recorded: boolean; adopted: boolean; origin: string; findings: Finding[] } {
  try {
    return commitBuiltinVisibilityUnchecked(input);
  } catch (error) {
    const kernelError = toKernelError(error, CODES.LANDING_LEDGER_INVALID);
    const findings: Finding[] = [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: `内置宿主账本落账失败：${kernelError.message}`,
        remedy: '检查宿主副本摘要与 host_landings.yaml；本次可见性变更已回滚',
      }),
    ];
    rollbackVisibility(input, findings);
    return { recorded: false, adopted: false, origin: 'adopted', findings };
  }
}

function commitBuiltinVisibilityUnchecked(input: {
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  hostId: string;
  sourceMeta: Record<string, unknown>;
  index: import('@skill-manager/contract').HostLandingIndex;
  targetPath: string;
  rootPath: string;
  visibility: 'visible' | 'disabled';
  beforeDisabled: boolean;
  changed: boolean;
}): { recorded: boolean; adopted: boolean; origin: string; findings: Finding[] } {
  const sourceChecksum = computeChecksum(join(input.layout.skillsDir, input.skillId));
  const contentDigest = computeLandingChecksum({
    targetPath: input.targetPath,
    format: 'skill',
  });
  const updated = recordAdoptedVisibility({
    index: input.index,
    skillId: input.skillId,
    hostId: input.hostId,
    targetPath: input.targetPath,
    visibility: input.visibility,
    sourceChecksum,
    contentDigest,
    sourceMeta: sourceMetaOf(input.sourceMeta),
    now: input.now,
  });
  const commit = commitHostLandings({
    file: input.layout.hostLandingsFile,
    index: { ...updated.index, generated_at: input.now },
    rollback: () => rollbackVisibilityState(input),
  });
  if (commit.ok) {
    return {
      recorded: true,
      adopted: updated.adopted,
      origin: updated.origin,
      findings: [],
    };
  }
  return {
    recorded: false,
    adopted: updated.adopted,
    origin: updated.origin,
    findings: commitFailureFindings(commit, input.layout.hostLandingsFile),
  };
}

function rollbackVisibility(
  input: {
    layout: WorkspaceLayout;
    skillId: string;
    rootPath: string;
    beforeDisabled: boolean;
    changed: boolean;
  },
  findings: Finding[],
): void {
  if (!input.changed) return;
  try {
    setHostSkillVisibility({
      rootPath: input.rootPath,
      skillId: input.skillId,
      enabled: !input.beforeDisabled,
    });
  } catch (rollbackCause) {
    findings.push(rollbackFinding(toKernelError(rollbackCause, CODES.LANDING_LEDGER_INVALID)));
  }
}

function rollbackVisibilityState(input: {
  skillId: string;
  rootPath: string;
  beforeDisabled: boolean;
  changed: boolean;
}): void {
  if (!input.changed) return;
  setHostSkillVisibility({
    rootPath: input.rootPath,
    skillId: input.skillId,
    enabled: !input.beforeDisabled,
  });
}

/** 把落位执行结果转换为结果封装的变更与数据 */
export function hostLandingResult(input: {
  command: string;
  channel: HostChannel;
  layout: WorkspaceLayout;
  now: string;
  skillId: string;
  sourceMeta: Record<string, unknown>;
  sourceDir?: string;
  fileMap?: DeliveryPlanEntry[];
  dryRun: boolean;
}): Result<unknown> {
  const prepared = prepareBuiltinLanding(input);
  if (prepared.findings.some((item) => item.severity === 'error')) {
    return buildResult(input.command, prepared.findings, [], {
      data: {
        host: input.channel.hostId,
        host_root: input.channel.resolution?.path ?? '',
        ledger_recorded: false,
      },
    });
  }
  const landed = landPlan({
    plan: input.channel.plan,
    workspace: input.layout,
    now: input.now,
    ...(input.sourceDir === undefined ? {} : { sourceDir: input.sourceDir }),
    ...(input.fileMap === undefined ? {} : { fileMap: input.fileMap }),
    ...(input.dryRun ? { dryRun: true } : {}),
  });
  const changes: Change[] = landed.changes.map((item) => ({
    ...item,
    detail: `${item.detail ?? ''}（宿主分发：${input.channel.hostId}）`.trim(),
  }));
  const findings = [...landed.findings];
  rollbackLandingErrors(input.dryRun, landed.writes, findings);
  const ledger = commitLedger(input, prepared.context, landed.writes, findings);
  return buildLandingResult(
    input,
    landed,
    findings.some((item) => item.severity === 'error') ? [] : changes,
    findings,
    ledger,
  );
}

function rollbackLandingErrors(
  dryRun: boolean,
  writes: readonly LandWrite[],
  findings: Finding[],
): void {
  if (dryRun || !findings.some((item) => item.severity === 'error')) return;
  try {
    rollbackLandWrites(writes);
  } catch (rollbackCause) {
    findings.push(rollbackFinding(toKernelError(rollbackCause, CODES.LANDING_LEDGER_INVALID)));
  }
}

function commitLedger(
  input: {
    channel: HostChannel;
    layout: WorkspaceLayout;
    now: string;
    skillId: string;
    sourceMeta: Record<string, unknown>;
    sourceDir?: string;
    dryRun: boolean;
  },
  context: BuiltinLandingContext | undefined,
  writes: readonly LandWrite[],
  findings: Finding[],
): { recorded: boolean; source: 'host_landings' | 'plugin_landings' | 'none' } {
  if (input.dryRun || findings.some((item) => item.severity === 'error')) {
    return { recorded: false, source: context === undefined ? 'none' : 'host_landings' };
  }
  if (input.channel.plugin !== undefined) {
    return commitPluginLedger(input, writes, findings);
  }
  if (context === undefined || input.sourceDir === undefined) {
    return { recorded: false, source: 'none' };
  }
  const committed = commitBuiltinLanding({
    channel: input.channel,
    layout: input.layout,
    now: input.now,
    skillId: input.skillId,
    sourceDir: input.sourceDir,
    sourceMeta: input.sourceMeta,
    context,
    writes,
  });
  findings.push(...committed.findings);
  return { recorded: committed.recorded, source: 'host_landings' };
}

function commitPluginLedger(
  input: {
    channel: HostChannel;
    layout: WorkspaceLayout;
    now: string;
    skillId: string;
  },
  writes: readonly LandWrite[],
  findings: Finding[],
): { recorded: boolean; source: 'plugin_landings' } {
  const plugin = input.channel.plugin;
  const placement = input.channel.plan.entries.find((entry) => entry.landable);
  if (plugin === undefined || placement === undefined) {
    return { recorded: false, source: 'plugin_landings' };
  }
  try {
    const updated = upsertPluginLanding(plugin.catalog.index, {
      pluginId: plugin.pluginId,
      skillId: input.skillId,
      hostId: plugin.hostId,
      hostKey: plugin.hostKey,
      targetPath: placement.target_path,
      now: input.now,
    });
    savePluginIndex(input.layout.pluginIndexFile, updated);
    return { recorded: true, source: 'plugin_landings' };
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    findings.push(
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: `插件落位账本写入失败：${kernelError.message}`,
        remedy: '检查 plugin_index.yaml 是否可写；下次分发前先修复账本',
      }),
    );
    try {
      rollbackLandWrites(writes);
    } catch (rollbackCause) {
      findings.push(rollbackFinding(toKernelError(rollbackCause, CODES.LANDING_LEDGER_INVALID)));
    }
    return { recorded: false, source: 'plugin_landings' };
  }
}

function buildLandingResult(
  input: {
    command: string;
    channel: HostChannel;
    dryRun: boolean;
  },
  landed: {
    skipped: Array<{ target_path: string; reason: string }>;
    backups: string[];
  },
  changes: Change[],
  findings: Finding[],
  ledger: { recorded: boolean; source: 'host_landings' | 'plugin_landings' | 'none' },
): Result<unknown> {
  return buildResult(input.command, findings, changes, {
    data: {
      host: input.channel.hostId,
      ...(input.channel.plugin === undefined
        ? { ledger_source: ledger.source, ledger_recorded: ledger.recorded }
        : { plugin_id: input.channel.plugin.pluginId, ledger_recorded: ledger.recorded }),
      host_root: input.channel.resolution?.path ?? '',
      host_writes_outside_workspace: hostWritesOutside(input.channel.plan),
      skipped: landed.skipped,
      backups: landed.backups,
      consumed_by: [
        ...new Set(input.channel.plan.entries.flatMap((entry) => entry.consumed_by)),
      ].sort(),
    },
    ...(input.dryRun ? { preview: true } : {}),
  });
}
