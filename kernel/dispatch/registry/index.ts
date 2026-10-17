/**
 * L2 指令注册与路由。
 *
 * 把参数转成对内核服务的调用，
 * 捕获内核抛出的错误并转换为标准结果封装。领域规则一律不在本层实现。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createInitialIndex,
  loadIndex,
  saveIndex,
  setConfig,
  TOOL_VERSION,
} from '../../core/index/index.ts';
import { scanWorkspace } from '../../core/discovery/index.ts';
import {
  disableSkill,
  enableSkill,
  installSkill,
  restoreSkill,
  uninstallSkill,
  updateSkill,
  type LifecycleOutcome,
} from '../../core/lifecycle/index.ts';
import { validateWorkspace, type ValidationReport } from '../../core/validation/index.ts';
import { inspectSkill, listSkills, readConfig, toListEntry } from '../../core/index/query.ts';
import { analyzeDependencies, splitDeclaration } from '../../core/dependency/index.ts';
import { probeRuntimes } from '../../core/dependency/runtime.ts';
import { exportIndex, importIndex } from '../../core/backup/index.ts';
import { listAllBackups, listBackups } from '../../store/backup-fs/index.ts';
import { createInitialPluginIndex, savePluginIndex } from '../../store/plugin-registry/index.ts';
import { loadPluginIndex } from '../../store/plugin-registry/index.ts';
import { ID_PATTERN, META_FILE_NAME } from '../../core/metadata/constants.ts';
import { declaredRuntimeOf, declaredSkillsOf, readMetaFile } from '../../core/metadata/read.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import {
  ensureWorkspaceDirs,
  layoutOf,
  resolveWorkspaceRoot,
  WORKSPACE_ENV,
} from '../../store/workspace/index.ts';
import { withLock } from '../../store/locking/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { categoryOf, CODES, finding, type Finding } from '../../store/contract.ts';
import { adapterFor } from '../../core/adapters/index.ts';
import { landPlan, setHostSkillVisibility } from '../../core/adapters/land.ts';
import { rebasePlan } from '../../core/adapters/plan.ts';
import { resolveHostRoot } from '../../core/adapters/roots.ts';
import type { AdapterForm, PlacementPlan } from '../../core/adapters/types.ts';
import type { RenderSource } from '../../core/render/types.ts';
import { hostIds as registeredHostIds } from '../../core/hosts/index.ts';
import { loadHostRegistry } from '../../core/hosts/index.ts';
import type { HostRootResolution } from '../../core/adapters/roots.ts';
import type { RootKind } from '../../core/hosts/types.ts';
import type { DeliveryPlanEntry } from '../../store/library-fs/index.ts';
import { buildResult, type Change, type Result } from '../result/index.ts';
import { flag, option, optionList, type ParsedArgs } from '../parsers/index.ts';
import { acquireFromPath, looksRemote, releaseSource } from '../../core/lifecycle/source.ts';
import { inspectPluginPackage } from '../../core/plugins/discovery.ts';
import { createPluginRecord } from '../../core/plugins/record.ts';
import {
  buildPluginHostPlan,
  loadPluginCatalog,
  orphanPluginLandings,
  pluginHostIds,
  upsertPluginLanding,
  type LoadedPluginCatalog,
} from '../../core/plugins/host.ts';
import { countTreeFiles } from '../../store/library-fs/index.ts';
import { buildHostCatalog } from '../../core/plugins/catalog.ts';
import type { PluginIndex } from '../../core/plugins/types.ts';
import {
  confirmLevelOf,
  decideConfirmation,
  isAffirmative,
  type ConfirmLevel,
  type ConfirmPlan,
  type Interaction,
} from '../policy/index.ts';

export interface CommandContext {
  args: ParsedArgs;
  /** 当前时间戳，由入口注入以便测试确定化 */
  now: string;
  /** 交互通道，由入口注入；无终端环境下禁止等待输入 */
  interaction: Interaction;
}

export type CommandHandler = (context: CommandContext) => Promise<Result<unknown>>;

export interface CommandSpec {
  name: string;
  handler: CommandHandler;
}

/** 一期已注册的指令名 */
export const REGISTERED_COMMANDS = [
  'init',
  'config get',
  'config set',
  'scan',
  'list',
  'inspect',
  'install',
  'uninstall',
  'enable',
  'disable',
  'update',
  'validate',
  'deps',
  'export',
  'import',
  'restore',
] as const;

const handlers = new Map<string, CommandHandler>();

/** 指令注册 */
export function register(spec: CommandSpec): void {
  handlers.set(spec.name, spec.handler);
}

const KIND_COMMANDS = new Set([
  'scan',
  'list',
  'inspect',
  'install',
  'uninstall',
  'enable',
  'disable',
]);

/** 指令路由：未注册的指令返回输入类错误 */
export async function dispatch(context: CommandContext): Promise<Result<unknown>> {
  const kind = option(context.args, 'kind');
  if (kind !== undefined) {
    if (!KIND_COMMANDS.has(context.args.command)) {
      return buildResult(context.args.command, [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: '--kind',
          message: `指令 ${context.args.command} 不接受 --kind`,
          remedy: '--kind 只用于 scan、list、inspect、install、uninstall、enable、disable',
        }),
      ]);
    }
    if (kind !== 'skill' && kind !== 'plugin') {
      return buildResult(context.args.command, [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: '--kind',
          message: `--kind 取值非法：${kind}`,
          remedy: '仅允许 skill 或 plugin',
        }),
      ]);
    }
  }
  const handler = handlers.get(context.args.command);
  if (handler === undefined) {
    return buildResult(context.args.command, [
      finding(CODES.INPUT_UNKNOWN_COMMAND, {
        source: 'input',
        target: context.args.command,
        message: `未知指令：${context.args.command}`,
        remedy: `一期可用指令：${REGISTERED_COMMANDS.join('、')}`,
      }),
    ]);
  }
  return handler(context);
}

function pluginKind(args: ParsedArgs): boolean {
  return option(args, 'kind') === 'plugin';
}

/** 插件分支只接受 plugin-format 明确列出的选项；Skill 专用选项必须显式拒绝。 */
function rejectPluginOptions(
  command: string,
  args: ParsedArgs,
  disallowed: readonly string[],
): Result<unknown> | null {
  for (const name of disallowed) {
    if (option(args, name) !== undefined || flag(args, name)) {
      return buildResult(command, [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: `--${name}`,
          message: `插件分支不接受 --${name}`,
          remedy: '使用 --kind plugin 的插件专用语义；Skill 目标/宿主选项不适用于插件对象',
        }),
      ]);
    }
  }
  return null;
}

/** 解析工作区根目录：命令行选项优先，其次环境变量，最后用户主目录 */
function workspaceRootOf(args: ParsedArgs): string {
  return resolveWorkspaceRoot(option(args, 'workspace'));
}

/**
 * 宿主分发通道（指令契约规范 2.2 与 4.3 节）：`--host <宿主>` 决定分发到哪个宿主的真实根，
 * 与 `--target` 正交——后者决定工作区内的目标位置，语义与一期完全一致。
 *
 * 该通道只在给出 `--host` 时介入：未给出时四条指令的执行路径与一期一字不差。
 */
interface HostChannel {
  hostId: string;
  form: AdapterForm;
  /** 解析后的宿主真实根；不可落盘的形态没有该值 */
  resolution?: HostRootResolution;
  plan: PlacementPlan;
  /** 第三方插件宿主上下文；内置宿主为 undefined */
  plugin?: import('../../core/plugins/host.ts').PluginHostPlan;
}

/** `--host` 的可用取值：注册表内每个有适配器的宿主，按其形态展开（规则路径类加后缀） */
function hostOptionValues(pluginIds: readonly string[] = []): string[] {
  const values: string[] = [];
  for (const hostId of registeredHostIds()) {
    const adapter = adapterFor(hostId);
    if (adapter === undefined) continue;
    for (const form of adapter.forms) {
      values.push(form === 'rules' ? `${hostId}-rules` : hostId);
    }
  }
  return [...values, ...pluginIds].sort();
}

/** 解析 `--host` 取值：宿主标识 + 形态；非法取值返回 undefined */
function hostTargetOf(value: string): { hostId: string; form: AdapterForm } | undefined {
  const rulesSuffixed = value.endsWith('-rules');
  const hostId = rulesSuffixed ? value.slice(0, -'-rules'.length) : value;
  const adapter = adapterFor(hostId);
  if (adapter === undefined) return undefined;
  if (rulesSuffixed) {
    return adapter.forms.includes('rules') ? { hostId, form: 'rules' } : undefined;
  }
  const defaultForm = adapter.forms[0];
  return defaultForm === undefined ? undefined : { hostId, form: defaultForm };
}

/** 组装宿主分发通道：校验取值 → 渲染与落位计划 → 解析宿主真实根 → 重定基到真实根 */
function buildHostChannel(input: {
  value: string;
  layout: ReturnType<typeof layoutOf>;
  index: SkillIndex;
  source: RenderSource;
  form?: AdapterForm;
  pluginCatalog?: LoadedPluginCatalog;
}): { channel?: HostChannel; findings: Finding[] } {
  const findings: Finding[] = [];
  const pluginIds = input.pluginCatalog === undefined ? [] : pluginHostIds(input.pluginCatalog);
  const target = hostTargetOf(input.value);
  if (target === undefined) {
    findings.push(
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--host',
        message: `--host 取值非法：${input.value}`,
        remedy: `可用取值为 ${hostOptionValues(pluginIds).join('、')}`,
      }),
    );
    if (!input.value.startsWith('x-') || input.pluginCatalog === undefined) return { findings };
    const plugin = buildPluginHostPlan({
      layout: input.layout,
      catalog: input.pluginCatalog,
      hostId: input.value,
      source: input.source,
    });
    findings.length = 0;
    findings.push(...plugin.findings);
    if (plugin.plan === undefined) return { findings };
    return {
      channel: {
        hostId: plugin.plan.hostId,
        form: plugin.plan.form,
        resolution: plugin.plan.resolution,
        plan: plugin.plan.plan,
        plugin: plugin.plan,
      },
      findings,
    };
  }
  const adapter = adapterFor(target.hostId);
  if (adapter === undefined) {
    findings.push(
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--host',
        message: `该宿主没有适配器：${input.value}`,
        remedy: `可用取值为 ${hostOptionValues(pluginIds).join('、')}`,
      }),
    );
    return { findings };
  }
  const form = input.form ?? target.form;
  const plan = adapter.plan(input.source, form);
  findings.push(...plan.findings);

  // 不可落盘的形态（如指令文件载体）：只登记不落盘，无需解析宿主根
  if (!plan.entries.some((entry) => entry.landable)) {
    return { channel: { hostId: target.hostId, form, plan }, findings };
  }

  const resolution = resolveHostRoot({
    hostId: target.hostId,
    workspaceRoot: input.layout.root,
    config: input.index.config as Record<string, unknown>,
    ...(form === 'rules' ? { rootKind: 'rules' as RootKind } : {}),
  });
  if (resolution === undefined) {
    findings.push(
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--host',
        message: `该宿主没有可用于分发的落位根：${input.value}`,
        remedy: `可用取值为 ${hostOptionValues(pluginIds).join('、')}`,
      }),
    );
    return { findings };
  }
  findings.push(...resolution.findings);
  if (resolution.findings.some((item) => item.severity === 'error') || resolution.path === '') {
    return { findings };
  }
  return {
    channel: {
      hostId: target.hostId,
      form,
      resolution,
      plan: rebasePlan(plan, resolution.path, resolution.external),
    },
    findings,
  };
}

/** 宿主通道将写入的位置清单（供确认与预演呈现） */
function hostWritesOf(plan: PlacementPlan): ConfirmPlan['writes'] {
  return plan.entries
    .filter((entry) => entry.landable)
    .map((entry) => ({ action: '写入', kind: entry.artifact_kind, path: entry.target_path }));
}

/** 通道是否涉及工作区之外的写入（用于确认级别升级与提示） */
function hostWritesOutside(plan: PlacementPlan): boolean {
  return plan.entries.some((entry) => entry.landable && entry.external);
}

/** 把落位执行结果转换为结果封装的变更与数据 */
function hostLandingResult(input: {
  command: string;
  channel: HostChannel;
  layout: ReturnType<typeof layoutOf>;
  now: string;
  skillId: string;
  sourceDir?: string;
  fileMap?: DeliveryPlanEntry[];
  dryRun: boolean;
}): Result<unknown> {
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
  const consumedBy = [
    ...new Set(input.channel.plan.entries.flatMap((entry) => entry.consumed_by)),
  ].sort();
  const findings = [...landed.findings];
  let ledgerRecorded = false;
  if (
    !input.dryRun &&
    input.channel.plugin !== undefined &&
    !findings.some((item) => item.severity === 'error')
  ) {
    const placement = input.channel.plan.entries.find((entry) => entry.landable);
    if (placement !== undefined) {
      try {
        const updated = upsertPluginLanding(input.channel.plugin.catalog.index, {
          pluginId: input.channel.plugin.pluginId,
          skillId: input.skillId,
          hostId: input.channel.plugin.hostId,
          hostKey: input.channel.plugin.hostKey,
          targetPath: placement.target_path,
          now: input.now,
        });
        savePluginIndex(input.layout.pluginIndexFile, updated);
        ledgerRecorded = true;
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
      }
    }
  }
  return buildResult(input.command, findings, changes, {
    data: {
      host: input.channel.hostId,
      ...(input.channel.plugin === undefined
        ? {}
        : { plugin_id: input.channel.plugin.pluginId, ledger_recorded: ledgerRecorded }),
      host_root: input.channel.resolution?.path ?? '',
      host_writes_outside_workspace: hostWritesOutside(input.channel.plan),
      skipped: landed.skipped,
      backups: landed.backups,
      consumed_by: consumedBy,
    },
    ...(input.dryRun ? { preview: true } : {}),
  });
}

/** 读取中心库副本的 SKILL.md 正文（去掉元数据块），作为渲染产物的指令正文 */
function skillBodyOf(skillDir: string): string | undefined {
  const file = join(skillDir, 'SKILL.md');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/** 由元文件字段与指令正文组装渲染输入 */
function renderSourceOf(skillDir: string, raw: Record<string, unknown>): RenderSource {
  const source: RenderSource = { id: String(raw['id']) };
  for (const key of ['description', 'license', 'version', 'author'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') source[key] = value;
  }
  const keywords = raw['trigger_keywords'];
  if (Array.isArray(keywords)) {
    source.trigger_keywords = keywords.filter((item): item is string => typeof item === 'string');
  }
  const dependencies = raw['dependencies'];
  if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    const record = dependencies as Record<string, unknown>;
    const skills = record['skills'];
    if (Array.isArray(skills)) {
      source.skill_dependencies = skills.filter((item): item is string => typeof item === 'string');
    }
    const runtime = record['runtime'];
    if (runtime !== null && typeof runtime === 'object' && !Array.isArray(runtime)) {
      const map: Record<string, string> = {};
      for (const [name, constraint] of Object.entries(runtime as Record<string, unknown>)) {
        if (typeof constraint === 'string') map[name] = constraint;
      }
      source.runtime_dependencies = map;
    }
  }
  const body = skillBodyOf(skillDir);
  if (body !== undefined) source.body = body;
  return source;
}

/** 元文件所在目录：安装来源既可以是目录，也可以直接指向元文件 */
function metaDirOf(sourcePath: string): string {
  return sourcePath.endsWith(META_FILE_NAME) ? dirname(sourcePath) : sourcePath;
}

/**
 * 安装与刷新的宿主分发：把中心库原件按落位计划分发到宿主真实根。
 *
 * 调用时机在中心库就位之后（安装完成、刷新完成）；调用前该指令自身的确认门已通过，
 * 因此这里不再重复确认（指令契约规范 2.4 节：一次调用一次确认）。
 */
function runHostLanding(input: {
  command: 'install' | 'update';
  hostValue: string;
  layout: ReturnType<typeof layoutOf>;
  index: SkillIndex;
  /** 读取元文件与指令正文的位置：安装完成后的中心库副本，预演时为来源目录 */
  skillDir: string;
  now: string;
  dryRun: boolean;
}): { findings: Finding[]; changes: Change[]; data: Record<string, unknown> } {
  const metaRead = readMetaFile(input.skillDir, input.skillDir);
  if (metaRead.raw === null) {
    return { findings: metaRead.findings, changes: [], data: {} };
  }
  const pluginCatalog = input.hostValue.startsWith('x-')
    ? loadPluginCatalog({
        layout: input.layout,
        builtins: loadHostRegistry().hosts,
        toolVersion: TOOL_VERSION,
      })
    : undefined;
  const built = buildHostChannel({
    value: input.hostValue,
    layout: input.layout,
    index: input.index,
    source: renderSourceOf(input.skillDir, metaRead.raw),
    ...(pluginCatalog === undefined ? {} : { pluginCatalog }),
  });
  if (
    built.channel === undefined ||
    (built.channel.plugin !== undefined && built.findings.some((item) => item.severity === 'error'))
  ) {
    return { findings: built.findings, changes: [], data: {} };
  }
  const landed = hostLandingResult({
    command: input.command,
    channel: built.channel,
    layout: input.layout,
    now: input.now,
    skillId: String(metaRead.raw['id']),
    sourceDir: input.skillDir,
    dryRun: input.dryRun,
  });
  return {
    findings: landed.findings,
    changes: landed.changes,
    data: (landed.data ?? {}) as Record<string, unknown>,
  };
}

/**
 * 宿主根内的启用 / 禁用：改名或还原宿主副本内的技能元数据文件，目录一律不动。
 *
 * 写工作区之外属高影响操作，因此把确认级别**升到轻确认**（该两条指令在工作区内本为「无需确认」）：
 * 非终端环境必须给出 `--yes`，否则按参数类错误拒绝；`--dry-run` 只列出将变更的路径。
 */
async function runHostToggle(input: {
  command: 'enable' | 'disable';
  hostValue: string;
  id: string;
  layout: ReturnType<typeof layoutOf>;
  index: SkillIndex;
  args: ParsedArgs;
  interaction: Interaction;
  dryRun: boolean;
}): Promise<Result<unknown>> {
  const { command, hostValue, id, layout, index, args, interaction, dryRun } = input;
  const metaRead = readMetaFile(join(layout.skillsDir, id), id);
  if (metaRead.raw === null) {
    return buildResult(command, metaRead.findings, [], { data: { host: hostValue } });
  }
  const pluginCatalog = hostValue.startsWith('x-')
    ? loadPluginCatalog({
        layout,
        builtins: loadHostRegistry().hosts,
        toolVersion: TOOL_VERSION,
      })
    : undefined;
  const built = buildHostChannel({
    value: hostValue,
    layout,
    index,
    source: renderSourceOf(join(layout.skillsDir, id), metaRead.raw),
    ...(pluginCatalog === undefined ? {} : { pluginCatalog }),
  });
  if (built.channel === undefined) {
    return buildResult(command, built.findings, [], { data: { host: hostValue } });
  }
  const channel = built.channel;
  if (channel.plugin?.form === 'rules') {
    const target = channel.plan.entries.find((entry) => entry.landable)?.target_path;
    if (target === undefined) {
      return buildResult(command, [
        ...built.findings,
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: '--host',
          message: '插件规则形态没有可切换的 Skill 副本',
          remedy: '先安装/分发该 Skill 到该插件宿主',
        }),
      ]);
    }
    const disabled = `${target}.disabled`;
    const from = command === 'disable' ? target : disabled;
    const to = command === 'disable' ? disabled : target;
    const plan: ConfirmPlan = {
      action: command === 'enable' ? '启用' : '禁用',
      subject: `${id}（插件宿主 ${channel.hostId}）`,
      writes: [
        { action: command === 'disable' ? '改名' : '恢复', kind: 'rule_file', path: target },
      ],
      notes: [`插件规则副本：${target}`, '只切换规则文件后缀，不改动 Skill 索引或插件登记'],
    };
    if (!dryRun) {
      const blocked = await confirmationGate({
        command,
        args,
        interaction,
        preview: { index: index, findings: [], changes: [], data: {} } satisfies LifecycleOutcome,
        plan,
        ...(channel.resolution?.external === true ? { escalateTo: 'light' as const } : {}),
      });
      if (blocked !== null) return blocked;
    }
    if (dryRun) {
      return buildResult(command, built.findings, [], {
        data: { host: channel.hostId, host_root: dirname(target), preview_writes: plan.writes },
        preview: true,
      });
    }
    const changed = existsSync(from);
    if (changed) renameSync(from, to);
    return buildResult(
      command,
      built.findings,
      changed
        ? [{ action: 'modify', kind: 'host-copy', path: to, detail: `插件宿主：${channel.hostId}` }]
        : [],
      { data: { host: channel.hostId, host_root: dirname(target), idempotent: !changed } },
    );
  }
  const rootPath = channel.resolution?.path ?? '';
  if (rootPath === '') {
    // 该宿主的该形态不落盘（例如指令文件载体只产出片段），没有副本可供切换可见性
    return buildResult(
      command,
      [
        ...built.findings,
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: '--host',
          message: `该宿主的该形态不落盘，没有可切换可见性的副本：${hostValue}`,
          remedy: '按路径类改用会落位的取值（例如宿主标识本身而非其片段形态）',
        }),
      ],
      [],
      { data: { host: channel.hostId } },
    );
  }

  const visibilityRoot = channel.plugin?.form === 'skill' ? dirname(rootPath) : rootPath;
  const copyDir = join(visibilityRoot, id);
  const targetPath = join(copyDir, command === 'disable' ? `${'SKILL.md'}.disabled` : 'SKILL.md');
  const plan: ConfirmPlan = {
    action: command === 'enable' ? '启用' : '禁用',
    subject: `${id}（宿主 ${channel.hostId}）`,
    writes: hostWritesOf(channel.plan),
    notes: [`目标位于工作区之外：${rootPath}`, '只切换宿主副本的可见性，不改动索引状态与目录结构'],
  };
  if (!dryRun) {
    const blocked = await confirmationGate({
      command,
      args,
      interaction,
      // 该两条指令在工作区内无需确认，此处传入空的预览结果，只借用统一确认入口；
      // 级别由 confirmationGate 按「工作区外写入升到轻确认」的规则判定
      preview: {
        index,
        findings: [],
        changes: [],
        data: {},
      } satisfies LifecycleOutcome,
      plan,
      escalateTo: 'light',
    });
    if (blocked !== null) {
      return buildResult(command, [...built.findings, ...blocked.findings], [], {
        data: { host: channel.hostId, host_root: rootPath },
      });
    }
  }

  if (dryRun) {
    return buildResult(command, built.findings, [], {
      data: {
        host: channel.hostId,
        host_root: rootPath,
        host_writes_outside_workspace: true,
        preview_writes: plan.writes,
      },
      preview: true,
    });
  }

  const visibility = setHostSkillVisibility({
    rootPath: visibilityRoot,
    skillId: id,
    enabled: command === 'enable',
  });
  const changed = visibility === 'changed';
  return buildResult(
    command,
    built.findings,
    changed
      ? [
          {
            action: 'modify',
            kind: 'host-copy',
            path: targetPath,
            detail: `宿主分发：${channel.hostId}；目录与其余文件未改动`,
          },
        ]
      : [],
    {
      data: {
        host: channel.hostId,
        host_root: rootPath,
        host_writes_outside_workspace: true,
        idempotent: !changed,
        consumed_by: [
          ...new Set(channel.plan.entries.flatMap((entry) => entry.consumed_by)),
        ].sort(),
      },
    },
  );
}

const initHandler: CommandHandler = async ({ args, now }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const changes: Change[] = [];
  try {
    const existed = existsSync(layout.indexFile);
    ensureWorkspaceDirs(layout);
    let pluginIndexCreated = false;
    if (!existsSync(layout.pluginIndexFile)) {
      savePluginIndex(layout.pluginIndexFile, createInitialPluginIndex(now, TOOL_VERSION));
      pluginIndexCreated = true;
      changes.push({ action: 'add', kind: 'plugin_index', path: layout.pluginIndexFile });
    }
    if (existed) {
      // 幂等：工作区已存在时不覆盖既有索引与配置
      return buildResult('init', [], changes, {
        data: {
          root: layout.root,
          index: layout.indexFile,
          plugin_index: layout.pluginIndexFile,
          created: false,
          plugin_index_created: pluginIndexCreated,
          tool_version: TOOL_VERSION,
        },
      });
    }
    const index = createInitialIndex(now);
    await withLock(layout.indexFile, () => {
      saveIndex(layout.indexFile, index);
    });
    changes.push({ action: 'add', kind: 'index', path: layout.indexFile });
    return buildResult('init', [], changes, {
      data: {
        root: layout.root,
        index: layout.indexFile,
        plugin_index: layout.pluginIndexFile,
        created: true,
        plugin_index_created: pluginIndexCreated,
        tool_version: TOOL_VERSION,
      },
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return buildResult('init', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
};

function emptyPluginIndex(now: string): PluginIndex {
  return {
    schema_version: '1',
    tool_version: TOOL_VERSION,
    generated_at: now,
    config: {},
    plugins: [],
    landings: [],
  };
}

function loadPluginsForRead(layout: ReturnType<typeof layoutOf>): {
  index: PluginIndex | null;
  findings: Finding[];
  initialized: boolean;
} {
  if (!existsSync(layout.pluginIndexFile)) {
    return { index: null, findings: [], initialized: false };
  }
  const loaded = loadPluginIndex(layout.pluginIndexFile);
  return { index: loaded.index, findings: [...loaded.findings], initialized: true };
}

function loadPluginsForWrite(
  layout: ReturnType<typeof layoutOf>,
  now: string,
): { index: PluginIndex | null; findings: Finding[]; missing: boolean } {
  if (!existsSync(layout.pluginIndexFile)) {
    return { index: null, findings: [], missing: true };
  }
  const loaded = loadPluginIndex(layout.pluginIndexFile);
  return {
    index:
      loaded.index ??
      (loaded.findings.some((item) => item.severity === 'error') ? null : emptyPluginIndex(now)),
    findings: [...loaded.findings],
    missing: false,
  };
}

function pluginUnreadable(
  command: string,
  layout: ReturnType<typeof layoutOf>,
  findings: Finding[],
  missing: boolean,
): Result<unknown> {
  return buildResult(command, [
    ...findings,
    missing
      ? finding(CODES.ENV_NOT_INITIALIZED, {
          source: 'workspace',
          target: layout.root,
          message: '工作区尚未初始化',
          remedy: '请先执行 init',
        })
      : finding(CODES.ENV_INCOMPLETE, {
          source: 'workspace',
          target: layout.pluginIndexFile,
          message: '插件索引无法读取，不能执行该操作',
          remedy: '修复 plugin_index.yaml 或重新初始化工作区',
        }),
  ]);
}

async function pluginInstallCommand(context: CommandContext): Promise<Result<unknown>> {
  const { args, now } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const source = args.positionals[0];
  const rejected = rejectPluginOptions('install', args, [
    'target',
    'host',
    'scope',
    'mode',
    'library-only',
  ]);
  if (rejected !== null) return rejected;
  if (source === undefined || source === '') {
    return buildResult('install', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'source',
        message: 'install --kind plugin 需要给出来源',
        remedy: '提供包含 plugin.json 的目录、归档或远端仓库',
      }),
    ]);
  }
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable('install', layout, loaded.findings, loaded.missing);

  let acquired;
  try {
    acquired = await acquireFromPath(source, 'plugin.json');
  } catch (error) {
    const kernelError = toKernelError(error, CODES.SRC_UNRESOLVED);
    return buildResult('install', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
  try {
    const inspected = inspectPluginPackage(acquired.dir, TOOL_VERSION);
    if (
      inspected.manifest === null ||
      inspected.findings.some((item) => item.severity === 'error')
    ) {
      return buildResult('install', inspected.findings, []);
    }
    const manifest = inspected.manifest;
    const existing = loaded.index.plugins.find((item) => item.id === manifest.plugin_id);
    if (existing !== undefined) {
      if (existing.manifest_hash === inspected.manifest_hash) {
        return buildResult('install', [], [], {
          data: { kind: 'plugin', plugin: existing, idempotent: true },
        });
      }
      return buildResult('install', [
        finding(CODES.CONFLICT_NAMING, {
          source: 'plugin-install',
          target: manifest.plugin_id,
          message: `插件 ${manifest.plugin_id} 已登记且版本内容不同`,
          remedy: '如需替换，请先 uninstall --kind plugin，再重新安装；插件本期不做 update',
        }),
      ]);
    }
    const destination = join(layout.pluginsDir, manifest.plugin_id);
    if (existsSync(destination)) {
      return buildResult('install', [
        finding(CODES.CONFLICT_NAMING, {
          source: 'plugin-install',
          target: manifest.plugin_id,
          message: `插件目录已存在但未登记：${destination}`,
          remedy: '先清理该目录，或运行 scan --kind plugin 确认候选',
        }),
      ]);
    }
    const relativeManifest = `./plugins/${manifest.plugin_id}/plugin.json`;
    const record = createPluginRecord({
      manifest,
      manifestPath: relativeManifest,
      manifestHash: inspected.manifest_hash,
      now,
      ...(looksRemote(source) ? { sourceUrl: source } : {}),
    });
    const dryRun = flag(args, 'dry-run');
    const preview: LifecycleOutcome = {
      index: {} as SkillIndex,
      findings: [],
      changes: [
        { action: 'add', kind: 'plugin', path: destination },
        { action: 'add', kind: 'plugin_index', path: layout.pluginIndexFile },
      ],
      data: {},
    };
    if (!dryRun) {
      const blocked = await confirmationGate({
        command: 'install',
        args,
        interaction: context.interaction,
        preview,
        plan: planOf('install', manifest.plugin_id, preview, [
          `将把插件包复制到 ${destination}`,
          '安装只登记插件，默认状态为 disabled；启用需要显式 enable --kind plugin',
        ]),
      });
      if (blocked !== null) return blocked;
    }
    if (dryRun) {
      return buildResult('install', [], [], {
        data: {
          kind: 'plugin',
          plugin: record,
          manifest_hash: inspected.manifest_hash,
          target: destination,
          state: 'disabled',
        },
        preview: true,
      });
    }

    const temp = join(layout.pluginsDir, `.${manifest.plugin_id}.tmp-${randomUUID()}`);
    try {
      mkdirSync(temp, { recursive: true });
      cpSync(acquired.dir, temp, {
        recursive: true,
        filter: (path) => basename(path) !== '.git',
      });
      const copied = inspectPluginPackage(temp, TOOL_VERSION);
      if (
        copied.manifest === null ||
        copied.manifest.plugin_id !== manifest.plugin_id ||
        copied.manifest_hash !== inspected.manifest_hash
      ) {
        return buildResult('install', [
          ...copied.findings,
          finding(CODES.IO_FAILED, {
            source: 'plugin-install',
            target: temp,
            message: '插件复制后校验失败',
            remedy: '删除临时目录后重试',
          }),
        ]);
      }
      renameSync(temp, destination);
    } finally {
      if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
    }
    const next: PluginIndex = {
      ...loaded.index,
      generated_at: now,
      plugins: [...loaded.index.plugins, record],
    };
    try {
      savePluginIndex(layout.pluginIndexFile, next);
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return buildResult(
      'install',
      [],
      [
        { action: 'add', kind: 'plugin', path: destination },
        { action: 'add', kind: 'plugin_index', path: layout.pluginIndexFile },
      ],
      { data: { kind: 'plugin', plugin: record, state: 'disabled' } },
    );
  } finally {
    releaseSource(acquired);
  }
}

function pluginScanCommand(context: { args: ParsedArgs; now: string }): Result<unknown> {
  const { args, now } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const rejected = rejectPluginOptions('scan', args, ['root']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable('scan', layout, loaded.findings, loaded.missing);
  const dryRun = flag(args, 'dry-run');
  const unregistered: Array<Record<string, unknown>> = [];
  const findings: Finding[] = [...loaded.findings];
  const byId = new Map(loaded.index.plugins.map((item) => [item.id, item]));
  const discovered = inspectPluginPackagesForScan(layout, TOOL_VERSION);
  for (const candidate of discovered) {
    if (!byId.has(candidate.plugin_id)) {
      unregistered.push({
        plugin_id: candidate.plugin_id,
        path: candidate.dir,
        manifest_hash: candidate.manifest_hash,
      });
      continue;
    }
  }
  const plugins = loaded.index.plugins.map((record) => {
    const packageDir = join(layout.pluginsDir, record.id);
    const inspected = inspectPluginPackage(packageDir, TOOL_VERSION);
    const errors = inspected.findings.filter((item) => item.severity === 'error');
    if (errors.length > 0 || inspected.manifest === null) {
      findings.push(...errors);
      return {
        ...record,
        state: 'invalid' as const,
        validation: {
          status: 'invalid' as const,
          errors: errors.map((item) => item.code),
          last_scan_at: now,
        },
        updated_at: now,
      };
    }
    if (
      inspected.manifest_hash !== record.manifest_hash ||
      inspected.manifest.plugin_id !== record.id
    ) {
      findings.push(
        finding(CODES.HASH_FORMAT, {
          source: 'plugin-scan',
          target: record.id,
          message: 'manifest 哈希或标识与登记不一致',
          remedy: '确认插件包未被修改；必要时重新安装',
        }),
      );
      return {
        ...record,
        state: 'invalid' as const,
        validation: {
          status: 'invalid' as const,
          errors: [CODES.HASH_FORMAT],
          last_scan_at: now,
        },
        updated_at: now,
      };
    }
    return {
      ...record,
      validation: { ...record.validation, status: 'ok' as const, errors: [], last_scan_at: now },
      updated_at: now,
    };
  });
  const orphaned = loaded.index.landings.filter((item) => !byId.has(item.plugin_id));
  const next: PluginIndex = { ...loaded.index, generated_at: now, plugins };
  if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
  return buildResult('scan', findings, [], {
    data: {
      kind: 'plugin',
      registered: plugins.length,
      invalid: plugins.filter((item) => item.state === 'invalid').length,
      unregistered,
      orphaned_landings: orphaned,
    },
    ...(dryRun ? { preview: true } : {}),
  });
}

function inspectPluginPackagesForScan(
  layout: ReturnType<typeof layoutOf>,
  toolVersion: string,
): Array<{ plugin_id: string; dir: string; manifest_hash: string }> {
  if (!existsSync(layout.pluginsDir)) return [];
  const result: Array<{ plugin_id: string; dir: string; manifest_hash: string }> = [];
  for (const entry of readdirSync(layout.pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const inspected = inspectPluginPackage(join(layout.pluginsDir, entry.name), toolVersion);
    result.push({
      plugin_id: inspected.manifest?.plugin_id ?? entry.name,
      dir: inspected.dir,
      manifest_hash: inspected.manifest_hash,
    });
  }
  return result;
}

function pluginListCommand(context: { args: ParsedArgs }): Result<unknown> {
  const { args } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const rejected = rejectPluginOptions('list', args, ['target']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForRead(layout);
  const index = loaded.index ?? emptyPluginIndex('');
  const state = option(args, 'state');
  if (state !== undefined && !['enabled', 'disabled', 'invalid'].includes(state)) {
    return buildResult('list', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--state',
        message: `插件状态取值非法：${state}`,
        remedy: '仅允许 enabled、disabled 或 invalid',
      }),
    ]);
  }
  const source = option(args, 'source');
  const records = index.plugins
    .filter((item) => (state === undefined ? true : item.state === state))
    .filter((item) => (source === undefined ? true : (item.source_url ?? 'local') === source))
    .map((item) => ({
      id: item.id,
      version: item.version,
      state: item.state,
      hosts: item.hosts.length,
      validation: item.validation,
    }));
  const orphaned = index.landings.filter(
    (item) =>
      item.state === 'orphaned' || !index.plugins.some((plugin) => plugin.id === item.plugin_id),
  );
  const builtinHosts = loadHostRegistry().hosts.map((host) => ({
    host_id: host.host_id,
    display_name: host.display_name,
    adapter_state: host.adapter_state,
    support_state: host.support_state,
    roots: host.roots ?? [],
  }));
  const pluginHosts = index.plugins.flatMap((plugin) =>
    plugin.hosts.map((host) => ({
      host_id: host.host_id,
      host_key: host.host_key,
      display_name: host.display_name,
      form: host.form,
      plugin_id: plugin.id,
      plugin_name: plugin.name,
      plugin_state: plugin.state,
      roots: host.roots,
      root_config: host.roots.map((root) => ({
        key: `plugin.${plugin.id}.${host.host_key}.${
          root.kind === 'rules' ? 'rules_root' : 'root'
        }`,
        scope: root.scope,
        configured:
          index.config[
            `plugin.${plugin.id}.${host.host_key}.${root.kind === 'rules' ? 'rules_root' : 'root'}`
          ] ?? null,
      })),
    })),
  );
  return buildResult('list', loaded.findings, [], {
    data: {
      kind: 'plugin',
      initialized: loaded.initialized,
      total: index.plugins.length,
      filtered: records.length,
      plugins: records,
      builtin_hosts: builtinHosts,
      plugin_hosts: pluginHosts,
      config: index.config,
      orphaned_landings: orphaned,
    },
  });
}

function pluginInspectCommand(context: { args: ParsedArgs }): Result<unknown> {
  const { args } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('inspect', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'inspect --kind plugin 需要给出插件标识',
        remedy: '请提供已登记的插件标识',
      }),
    ]);
  }
  const loaded = loadPluginsForRead(layout);
  const record = loaded.index?.plugins.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult('inspect', [
      ...loaded.findings,
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `插件 ${id} 不在插件登记中`,
        remedy: '先用 list --kind plugin 确认插件标识',
      }),
    ]);
  }
  const inspected = inspectPluginPackage(join(layout.pluginsDir, id), TOOL_VERSION);
  return buildResult('inspect', [...loaded.findings, ...inspected.findings], [], {
    data: {
      kind: 'plugin',
      plugin: record,
      manifest: inspected.manifest,
      manifest_hash: inspected.manifest_hash,
      config: loaded.index?.config ?? {},
      root_config: record.hosts.map((host) => ({
        host_id: host.host_id,
        host_key: host.host_key,
        keys: host.roots.map((root) => {
          const key = `plugin.${id}.${host.host_key}.${
            root.kind === 'rules' ? 'rules_root' : 'root'
          }`;
          return {
            key,
            scope: root.scope,
            value: loaded.index?.config[key] ?? null,
          };
        }),
      })),
      landings: (loaded.index?.landings ?? []).filter((item) => item.plugin_id === id),
    },
  });
}

async function pluginToggleCommand(
  command: 'enable' | 'disable',
  context: CommandContext,
): Promise<Result<unknown>> {
  const { args, now } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult(command, [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: `${command} --kind plugin 需要给出插件标识`,
        remedy: '请提供已登记的插件标识',
      }),
    ]);
  }
  const rejected = rejectPluginOptions(command, args, ['target', 'host', 'scope']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable(command, layout, loaded.findings, loaded.missing);
  const record = loaded.index.plugins.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult(command, [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `插件 ${id} 不在插件登记中`,
        remedy: '先用 list --kind plugin 确认插件标识',
      }),
    ]);
  }
  const dryRun = flag(args, 'dry-run');
  if (command === 'disable') {
    const next: PluginIndex = {
      ...loaded.index,
      generated_at: now,
      plugins: loaded.index.plugins.map((item) =>
        item.id === id ? { ...item, state: 'disabled' as const, updated_at: now } : item,
      ),
    };
    if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
    return buildResult(command, loaded.findings, [], {
      data: { kind: 'plugin', plugin: next.plugins.find((item) => item.id === id) },
      ...(dryRun ? { preview: true } : {}),
    });
  }

  const inspected = inspectPluginPackage(join(layout.pluginsDir, id), TOOL_VERSION);
  const errors = [...inspected.findings.filter((item) => item.severity === 'error')];
  if (inspected.manifest === null || inspected.manifest.plugin_id !== id) {
    errors.push(
      finding(CODES.ID_PLUGIN_INVALID, {
        source: 'plugin-enable',
        target: id,
        message: '插件包 manifest 无法通过校验',
        remedy: '修复 plugin.json 后重新安装',
      }),
    );
  }
  if (inspected.manifest !== null && inspected.manifest_hash !== record.manifest_hash) {
    errors.push(
      finding(CODES.HASH_FORMAT, {
        source: 'plugin-enable',
        target: id,
        message: '插件包 manifest 哈希与登记不一致',
        remedy: '重新安装插件，或运行 scan --kind plugin 确认变更',
      }),
    );
  }
  if (errors.length > 0 || inspected.manifest === null) {
    const next: PluginIndex = {
      ...loaded.index,
      generated_at: now,
      plugins: loaded.index.plugins.map((item) =>
        item.id === id
          ? {
              ...item,
              state: 'invalid' as const,
              updated_at: now,
              validation: {
                status: 'invalid' as const,
                errors: errors.map((item) => item.code),
                last_scan_at: now,
              },
            }
          : item,
      ),
    };
    if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
    return buildResult(command, [...loaded.findings, ...errors], [], { data: { kind: 'plugin' } });
  }
  const base = loadPluginCatalog({
    layout,
    builtins: loadHostRegistry().hosts,
    toolVersion: TOOL_VERSION,
  });
  const entries = base.entries
    .filter(
      (entry) =>
        entry.record.id === id ||
        (entry.record.state === 'enabled' &&
          entry.manifest !== null &&
          !(entry.findings ?? []).some((item) => item.severity === 'error')),
    )
    .map((entry) =>
      entry.record.id === id
        ? {
            ...entry,
            manifest: inspected.manifest,
            findings: [],
            record: {
              ...entry.record,
              state: 'enabled' as const,
              validation: { status: 'ok' as const, errors: [] },
            },
          }
        : entry,
    );
  const candidateView = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries,
  });
  if (candidateView.findings.some((item) => item.severity === 'error')) {
    return buildResult(command, [...loaded.findings, ...candidateView.findings], [], {
      data: { kind: 'plugin' },
    });
  }
  const next: PluginIndex = {
    ...loaded.index,
    generated_at: now,
    plugins: loaded.index.plugins.map((item) =>
      item.id === id
        ? {
            ...item,
            state: 'enabled' as const,
            updated_at: now,
            validation: { status: 'ok' as const, errors: [], last_scan_at: now },
          }
        : item,
    ),
  };
  if (!dryRun) savePluginIndex(layout.pluginIndexFile, next);
  return buildResult(command, [...loaded.findings, ...inspected.findings], [], {
    data: {
      kind: 'plugin',
      plugin: next.plugins.find((item) => item.id === id),
      hosts: candidateView.pluginHosts.map((item) => item.host_id),
    },
    ...(dryRun ? { preview: true } : {}),
  });
}

async function pluginUninstallCommand(context: CommandContext): Promise<Result<unknown>> {
  const { args, now } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('uninstall', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'uninstall --kind plugin 需要给出插件标识',
        remedy: '请提供已登记的插件标识',
      }),
    ]);
  }
  const rejected = rejectPluginOptions('uninstall', args, ['keep-library', 'hard']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForWrite(layout, now);
  if (loaded.index === null)
    return pluginUnreadable('uninstall', layout, loaded.findings, loaded.missing);
  const record = loaded.index.plugins.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult('uninstall', [
      ...loaded.findings,
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `插件 ${id} 不在插件登记中`,
        remedy: '先用 list --kind plugin 确认插件标识',
      }),
    ]);
  }
  const pluginDir = join(layout.pluginsDir, id);
  const fileCount = countTreeFiles(pluginDir);
  const orphaned = loaded.index.landings.filter((item) => item.plugin_id === id);
  const preview: LifecycleOutcome = {
    index: {} as SkillIndex,
    findings: [],
    changes: [
      { action: 'remove', kind: 'plugin', path: pluginDir, detail: `${fileCount} 个文件` },
      { action: 'remove', kind: 'plugin_index', path: layout.pluginIndexFile },
    ],
    data: {
      notes: [
        `将删除插件包：${pluginDir}（${fileCount} 个文件）`,
        '插件登记将从 plugin_index.yaml 移除；Skill 索引不会被触碰',
        orphaned.length > 0
          ? `已有 ${orphaned.length} 个宿主副本会保留并标记为孤儿：${orphaned
              .map((item) => item.target_path)
              .join('、')}`
          : '没有已记录的插件宿主副本',
      ],
      plugin_dir: pluginDir,
      file_count: fileCount,
      orphaned_landings: orphaned,
    },
  };
  const dryRun = flag(args, 'dry-run');
  if (!dryRun) {
    const blocked = await confirmationGate({
      command: 'uninstall',
      args,
      interaction: context.interaction,
      preview,
      plan: planOf('uninstall', id, preview, [
        `将删除插件包：${pluginDir}（${fileCount} 个文件）`,
        '插件登记将从 plugin_index.yaml 移除；Skill 索引不会被触碰',
        orphaned.length > 0
          ? `已有 ${orphaned.length} 个宿主副本会保留并标记为孤儿：${orphaned
              .map((item) => item.target_path)
              .join('、')}`
          : '没有已记录的插件宿主副本',
      ]),
    });
    if (blocked !== null) return blocked;
  }
  const marked = orphanPluginLandings(loaded.index, id, now);
  const next: PluginIndex = {
    ...marked.index,
    generated_at: now,
    plugins: marked.index.plugins.filter((item) => item.id !== id),
  };
  if (!dryRun) {
    rmSync(pluginDir, { recursive: true, force: true });
    savePluginIndex(layout.pluginIndexFile, next);
  }
  return buildResult('uninstall', loaded.findings, preview.changes, {
    data: {
      kind: 'plugin',
      removed: !dryRun,
      plugin_dir: pluginDir,
      file_count: fileCount,
      orphaned_landings: marked.orphaned,
      notes: preview.data['notes'],
    },
    ...(dryRun ? { preview: true } : {}),
  });
}

const scanHandler: CommandHandler = async ({ args, now }) => {
  if (pluginKind(args)) return pluginScanCommand({ args, now });
  const layout = layoutOf(workspaceRootOf(args));
  const dryRun = flag(args, 'dry-run');
  const overrides = optionList(args, 'root');

  if (!existsSync(layout.indexFile)) {
    return buildResult('scan', [
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化',
        remedy: `请先执行 init，或设置环境变量 ${WORKSPACE_ENV} 指向已有工作区`,
      }),
    ]);
  }

  try {
    return await withLock(layout.indexFile, () => {
      const loaded = loadIndex(layout.indexFile);
      const findings: Finding[] = [...loaded.findings];
      if (loaded.index === null) {
        findings.push(
          finding(CODES.ENV_INCOMPLETE, {
            source: 'workspace',
            target: layout.indexFile,
            message: '索引无法读取，请重建后再扫描',
            remedy: '请先执行 init 建立新的索引，或修复索引文件',
          }),
        );
        return buildResult('scan', findings);
      }

      const index =
        overrides.length > 0
          ? { ...loaded.index, config: { ...loaded.index.config, skill_roots: overrides } }
          : loaded.index;

      const outcome = scanWorkspace({ layout, index, now });
      findings.push(...outcome.findings);

      if (!dryRun) saveIndex(layout.indexFile, outcome.index);

      const extra: {
        data: { root: string; summary: typeof outcome.summary; total: number };
        preview?: boolean;
      } = {
        data: {
          root: layout.root,
          summary: outcome.summary,
          total: outcome.index.skills.length,
        },
      };
      if (dryRun) extra.preview = true;
      return buildResult('scan', findings, outcome.changes, extra);
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return buildResult('scan', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
};

register({ name: 'init', handler: initHandler });
register({ name: 'scan', handler: scanHandler });

/**
 * 确认闸门。
 *
 * 传入的是一份**只读预览**的结果：调用方先以预演方式跑一遍，本函数据此组装影响范围、
 * 交给策略层裁决。业务知识（哪些文件、索引与副本会被写入）留在调用方，本函数只做编排。
 *
 * 返回非 null 表示闸门拦下，直接以该结果结束本次调用：
 *   预览已明确拒绝，或预览产生错误级问题且没有任何计划变更时，直接返回预览结果，
 *   不向用户索要确认——这类调用注定失败，打扰用户没有意义；
 *   无终端且未给出跳过确认选项时返回参数类问题；
 *   用户给出否定回答时返回「已取消」，不产生任何变更。
 */
async function confirmationGate(options: {
  command: string;
  args: ParsedArgs;
  interaction: Interaction;
  preview: LifecycleOutcome;
  plan: ConfirmPlan;
  /** 级别提升：宿主分发写工作区之外时，把「无需确认」的两条指令升到轻确认 */
  escalateTo?: ConfirmLevel;
}): Promise<Result<unknown> | null> {
  const { command, args, interaction, preview, plan, escalateTo } = options;

  if (preview.data['rejected'] !== undefined) {
    return buildResult(command, preview.findings, [], { data: preview.data });
  }
  if (preview.findings.some((item) => item.severity === 'error') && preview.changes.length === 0) {
    return buildResult(command, preview.findings, [], { data: preview.data });
  }

  const decision = decideConfirmation({
    level: escalateTo ?? confirmLevelOf(command, { hard: flag(args, 'hard') }),
    yes: flag(args, 'yes'),
    dryRun: flag(args, 'dry-run'),
    interaction,
    plan,
  });

  if (decision.kind === 'skip') return null;
  if (decision.kind === 'reject') return buildResult(command, [decision.finding]);

  interaction.write(`${decision.text}\n`);
  const answer = await interaction.read();
  if (isAffirmative(answer)) return null;

  // 用户取消：未做任何变更。契约 2.4 规定默认聚焦取消，因此空白与无法识别的回答同样按取消处理。
  return buildResult(command, [], [], {
    data: {
      aborted: 'user_declined',
      impact: plan.writes,
      notes: plan.notes,
    },
  });
}

/** 确认提示中的动作名称：与指令名一一对应，不得互相借用 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  install: '安装',
  uninstall: '卸载',
  enable: '启用',
  disable: '禁用',
  update: '刷新',
  import: '导入',
  restore: '恢复',
};

/** 由预览结果与附加提示组装预期变更摘要 */
function planOf(
  command: string,
  subject: string,
  preview: LifecycleOutcome,
  notes: string[],
): ConfirmPlan {
  return {
    action: ACTION_LABELS[command] ?? command,
    subject,
    writes: preview.changes.map((item) => ({
      action: item.action,
      kind: item.kind,
      path: item.path,
    })),
    notes,
  };
}

const installHandler: CommandHandler = async ({ args, now, interaction }) => {
  if (pluginKind(args)) return pluginInstallCommand({ args, now, interaction });
  const layout = layoutOf(workspaceRootOf(args));
  const source = args.positionals[0];
  const dryRun = flag(args, 'dry-run');
  if (source === undefined || source === '') {
    return buildResult('install', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'source',
        message: 'install 需要给出来源',
        remedy: '请提供本地 Skill 目录，或指向其 skill_meta.yaml',
      }),
    ]);
  }
  if (!existsSync(layout.indexFile)) {
    return buildResult('install', [
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化',
        remedy: '请先执行 init',
      }),
    ]);
  }
  // --mode 的取值域由契约定义（copy 或 link），但一期只实现副本方式
  const mode = option(args, 'mode');
  if (mode !== undefined && mode !== 'copy') {
    return buildResult('install', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--mode',
        message: `一期只支持副本落位，不接受 --mode ${mode}`,
        remedy: '请省略 --mode，或显式给出 copy；链接方式属后续迭代',
      }),
    ]);
  }
  const scope = option(args, 'scope');
  if (scope !== undefined && scope !== 'global' && scope !== 'project') {
    return buildResult('install', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--scope',
        message: `作用域取值非法：${scope}`,
        remedy: '仅允许 global 或 project',
      }),
    ]);
  }
  try {
    return await withLock(layout.indexFile, async () => {
      const loaded = loadIndex(layout.indexFile);
      if (loaded.index === null) {
        return buildResult('install', [
          finding(CODES.ENV_INCOMPLETE, {
            source: 'workspace',
            target: layout.indexFile,
            message: '索引无法读取，不能登记新的 Skill',
            remedy: '请先修复或重建索引',
          }),
        ]);
      }
      const installInput = {
        layout,
        index: loaded.index,
        sourcePath: source,
        now,
        libraryOnly: flag(args, 'library-only'),
        ...(option(args, 'target') !== undefined
          ? { target: option(args, 'target') as string }
          : {}),
        ...(scope !== undefined ? { scope } : {}),
      };

      // 需要确认且不是预演时，先跑一次只读预览取得影响范围
      if (!dryRun) {
        const preview = await installSkill({ ...installInput, dryRun: true });
        const notes = [
          '安装会把内容写入中心库并分发到声明的落位目标',
          flag(args, 'library-only') === true
            ? '本次为仅落库方式：不向目标位置分发，登记状态为已禁用'
            : '安装完成后该 Skill 的登记状态为已启用',
        ];
        const blocked = await confirmationGate({
          command: 'install',
          args,
          interaction,
          preview,
          plan: planOf('install', source, preview, notes),
        });
        if (blocked !== null) return blocked;
      }

      const outcome = await installSkill({ ...installInput, dryRun });
      if (!dryRun && outcome.index !== loaded.index) saveIndex(layout.indexFile, outcome.index);

      // 宿主分发通道：只在给出 --host 且安装本身无错误级问题时介入
      const hostValue = option(args, 'host');
      if (hostValue !== undefined && !outcome.findings.some((item) => item.severity === 'error')) {
        const sourceMeta = readMetaFile(metaDirOf(source), 'install 来源');
        const skillId =
          sourceMeta.raw !== null && typeof sourceMeta.raw['id'] === 'string'
            ? sourceMeta.raw['id']
            : undefined;
        if (skillId !== undefined) {
          // 预演时中心库尚未写入，渲染输入取自来源目录；实装时取自中心库副本
          const libraryDir = join(layout.skillsDir, skillId);
          const renderDir = dryRun && !existsSync(libraryDir) ? metaDirOf(source) : libraryDir;
          const host = runHostLanding({
            command: 'install',
            hostValue,
            layout,
            index: outcome.index ?? loaded.index,
            skillDir: renderDir,
            now,
            dryRun,
          });
          return buildResult(
            'install',
            [...outcome.findings, ...host.findings],
            [...outcome.changes, ...host.changes],
            {
              data: { ...(outcome.data as Record<string, unknown>), host: host.data },
              ...(outcome.preview === true || dryRun ? { preview: true } : {}),
            },
          );
        }
      }

      return buildResult('install', outcome.findings, outcome.changes, {
        data: outcome.data,
        ...(outcome.preview === true ? { preview: true } : {}),
      });
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return buildResult('install', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
};

const uninstallHandler: CommandHandler = async ({ args, now, interaction }) => {
  if (pluginKind(args)) return pluginUninstallCommand({ args, now, interaction });
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  const dryRun = flag(args, 'dry-run');
  if (id === undefined || id === '') {
    return buildResult('uninstall', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'uninstall 需要给出 Skill 标识',
        remedy: '请提供要卸载的 Skill 标识',
      }),
    ]);
  }
  if (!existsSync(layout.indexFile)) {
    return buildResult('uninstall', [
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化',
        remedy: '请先执行 init',
      }),
    ]);
  }
  try {
    return await withLock(layout.indexFile, async () => {
      const loaded = loadIndex(layout.indexFile);
      if (loaded.index === null) {
        return buildResult('uninstall', [
          finding(CODES.ENV_INCOMPLETE, {
            source: 'workspace',
            target: layout.indexFile,
            message: '索引无法读取，不能执行卸载',
            remedy: '请先修复或重建索引',
          }),
        ]);
      }
      const hard = flag(args, 'hard');
      const uninstallInput = {
        layout,
        index: loaded.index,
        id,
        now,
        ...(hard ? { hard: true } : {}),
      };

      // 需要确认且不是预演时，先跑一次只读预览；强制二次确认须逐条列出影响范围与文件数量
      if (!dryRun) {
        const preview = uninstallSkill({ ...uninstallInput, dryRun: true });
        const detail = preview.data['would_remove_detail'];
        const fileCount = String(preview.data['would_remove_file_count'] ?? 0);
        const notes = [
          `合计将移除 ${Array.isArray(detail) ? detail.length : 0} 个副本位置、${fileCount} 个文件`,
          '卸载前会先把中心库原件备份到工作区的备份目录',
          hard
            ? '中心库原件将被永久删除，本工具不再持有该 Skill 的任何原件'
            : '中心库原件将保留；保留后它不再属于已管理集合',
        ];
        const blocked = await confirmationGate({
          command: 'uninstall',
          args,
          interaction,
          preview,
          plan: planOf('uninstall', id, preview, notes),
        });
        if (blocked !== null) return blocked;
      }

      const outcome = uninstallSkill({ ...uninstallInput, dryRun });
      if (!dryRun && outcome.index !== loaded.index) saveIndex(layout.indexFile, outcome.index);
      return buildResult('uninstall', outcome.findings, outcome.changes, {
        data: outcome.data,
        ...(outcome.preview === true ? { preview: true } : {}),
      });
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return buildResult('uninstall', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
};

register({ name: 'install', handler: installHandler });
register({ name: 'uninstall', handler: uninstallHandler });

/**
 * validate 的退出口径。
 *
 * 契约 4.12 规定「存在错误级问题时返回 1；仅存在警告时返回 0」，指令总表把本指令的范围限定为 0 至 3。
 * 二者共同约束下：参数类问题按通用派生规则返回 2，其余错误级问题返回 1，仅警告时返回 0，
 * --strict 下警告也视为失败返回 1。只读指令，不产生变更，因此 changes 恒为空。
 */
function validateResult(
  findings: Finding[],
  report: ValidationReport | undefined,
  strict: boolean,
) {
  const errors = findings.filter((item) => item.severity === 'error');
  const warnings = findings.filter((item) => item.severity === 'warning');
  let exitCode = 0;
  if (errors.length > 0) {
    exitCode = errors.some((item) => categoryOf(item.code) === 'INPUT') ? 2 : 1;
  } else if (strict && warnings.length > 0) {
    exitCode = 1;
  }
  const result = buildResult(
    'validate',
    findings,
    [],
    report === undefined ? {} : { data: report },
  );
  result.exit_code = exitCode;
  result.ok = exitCode === 0;
  return result;
}

const validateHandler: CommandHandler = async ({ args }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const subject = args.positionals[0];
  const strict = flag(args, 'strict');

  // 前置条件为「无」：索引不存在时报告环境类问题而非崩溃
  if (!existsSync(layout.indexFile)) {
    return validateResult(
      [
        finding(CODES.ENV_NOT_INITIALIZED, {
          source: 'workspace',
          target: layout.root,
          message: '工作区尚未初始化，无法校验',
          remedy: '请先执行 init 建立工作区',
        }),
      ],
      undefined,
      strict,
    );
  }

  const loaded = loadIndex(layout.indexFile);
  const findings: Finding[] = [...loaded.findings];
  if (loaded.index === null) {
    findings.push(
      finding(CODES.ENV_INCOMPLETE, {
        source: 'workspace',
        target: layout.indexFile,
        message: '索引无法读取，无法校验',
        remedy: '请先修复或重建索引',
      }),
    );
    return validateResult(findings, undefined, strict);
  }

  const outcome = validateWorkspace({
    layout,
    index: loaded.index,
    ...(subject !== undefined && subject !== '' ? { subject } : {}),
  });
  return validateResult([...findings, ...outcome.findings], outcome.report, strict);
};

register({ name: 'validate', handler: validateHandler });

/**
 * 只读指令的公共前置：读取索引。
 * 与写操作不同，只读指令在索引缺失或损坏时不建立任何东西，只把问题交给调用方。
 */
function loadForRead(layout: ReturnType<typeof layoutOf>): {
  index: SkillIndex | null;
  findings: Finding[];
  initialized: boolean;
} {
  if (!existsSync(layout.indexFile)) {
    return { index: null, findings: [], initialized: false };
  }
  const loaded = loadIndex(layout.indexFile);
  return { index: loaded.index, findings: [...loaded.findings], initialized: true };
}

const listHandler: CommandHandler = async ({ args }) => {
  if (pluginKind(args)) {
    return pluginListCommand({ args });
  }
  const layout = layoutOf(workspaceRootOf(args));
  const { index, findings, initialized } = loadForRead(layout);
  const state = option(args, 'state');
  const source = option(args, 'source');
  const target = option(args, 'target');

  const outcome = listSkills({
    index,
    filter: {
      ...(state !== undefined ? { state } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(target !== undefined ? { target } : {}),
    },
  });
  const merged = [...findings, ...outcome.findings];

  // 契约 4.5 前置条件：索引不存在时返回引导性结果而非错误
  if (outcome.summary === null) {
    const guide =
      merged.length > 0
        ? '索引无法读取，请先修复或重建索引'
        : '工作区尚未初始化，请先执行 init 建立工作区';
    return buildResult('list', merged, [], {
      data: { initialized, total: 0, filtered: 0, records: [], guide },
    });
  }

  return buildResult('list', merged, [], {
    data: {
      initialized,
      total: outcome.summary.total,
      filtered: outcome.summary.filtered,
      by_state: outcome.summary.by_state,
      by_validation: outcome.summary.by_validation,
      records: outcome.summary.records.map(toListEntry),
    },
  });
};

const inspectHandler: CommandHandler = async ({ args }) => {
  if (pluginKind(args)) {
    return pluginInspectCommand({ args });
  }
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('inspect', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'inspect 需要给出 Skill 标识',
        remedy: '请提供要查看的 Skill 标识',
      }),
    ]);
  }
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('inspect', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }
  const outcome = inspectSkill({ layout, index, id });
  return buildResult('inspect', [...findings, ...outcome.findings], [], { data: outcome.data });
};

const configGetHandler: CommandHandler = async ({ args }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('config get', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取，读不到配置区',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }
  const pluginLoaded = existsSync(layout.pluginIndexFile)
    ? loadPluginIndex(layout.pluginIndexFile)
    : { index: null, findings: [] };
  return buildResult('config get', [...findings, ...pluginLoaded.findings], [], {
    data: {
      ...readConfig(index),
      plugin_config: pluginLoaded.index?.config ?? {},
    },
  });
};

const depsHandler: CommandHandler = async ({ args }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('deps', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'deps 需要给出 Skill 标识',
        remedy: '请提供要检查依赖的 Skill 标识',
      }),
    ]);
  }
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('deps', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }

  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult('deps', [
      ...findings,
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `标识 ${id} 不在索引中`,
        remedy: '请先用列表指令确认该 Skill 是否已登记',
      }),
    ]);
  }

  // 依赖声明以元文件为准，读取失败时退回索引内的依赖摘要
  const metaRead = readMetaFile(join(layout.skillsDir, id), id);
  const declaredFromMeta = declaredSkillsOf(metaRead.raw);
  const declared = declaredFromMeta ?? record.dependencies ?? [];
  const availability = new Map(
    index.skills.map((item) => [item.id, item.validation.status === 'ok']),
  );
  const edges = new Map(
    index.skills.map((item) => [
      item.id,
      (item.dependencies ?? []).map((text) => splitDeclaration(text).name),
    ]),
  );
  const report = analyzeDependencies({ id, declared, availability, edges });

  // 运行时维度：实时探测环境，结果只入载荷与报告，不写入索引与运行期结论
  const runtime = await probeRuntimes(declaredRuntimeOf(metaRead.raw));

  const all = [...findings, ...metaRead.findings, ...report.findings, ...runtime.findings];
  const result = buildResult('deps', all, [], {
    data: {
      id,
      declared_from: declaredFromMeta === null ? 'index' : 'meta',
      entries: report.entries,
      runtime: runtime.entries,
      runtime_probed: runtime.entries.length > 0,
      affected: report.affected,
      cycles: report.cycles,
      ...(flag(args, 'tree') ? { tree: dependencyTreeOf(id, edges, availability) } : {}),
    },
  });

  /**
   * 契约 4.13 规定「存在未满足的依赖时返回 6」，这是本指令的专属规定，
   * 按结果规范 5.2 的专属优先条款覆盖通用派生——通用派生只把 DEP 类别映射到 6，
   * 而「被依赖对象校验不通过」按 4.4 的对照表是校验类问题码，需要在这里一并归入未满足。
   * 运行时类（`E-RUN-*`）已由通用派生归入依赖档，无需在此重复列出。
   */
  const unmet = all.some(
    (item) =>
      item.severity === 'error' &&
      ['E-DEP-001', 'E-DEP-002', 'E-DEP-003', CODES.VALIDATION_DEPENDENCY].includes(item.code),
  );
  if (unmet && result.exit_code !== 2) {
    result.exit_code = 6;
    result.ok = false;
  }
  return result;
};

const exportHandler: CommandHandler = async ({ args, now }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const target = args.positionals[0];
  if (target === undefined || target === '') {
    return buildResult('export', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'path',
        message: 'export 需要给出目标文件路径',
        remedy: '请提供工作区之内的相对路径，例如 backups/export.yaml',
      }),
    ]);
  }
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('export', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取，没有可导出的内容',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }
  const outcome = exportIndex({
    layout,
    index,
    target,
    now,
    noConfig: flag(args, 'no-config'),
    noSecrets: flag(args, 'no-secrets'),
  });
  return buildResult('export', [...findings, ...outcome.findings], [], { data: outcome.data });
};

register({ name: 'list', handler: listHandler });
register({ name: 'inspect', handler: inspectHandler });
register({ name: 'config get', handler: configGetHandler });
register({ name: 'deps', handler: depsHandler });
register({ name: 'export', handler: exportHandler });

/**
 * 依赖树：按 `--tree` 展开该标识的依赖层级。
 * 只呈现已登记的依赖关系，遇到环或已展开的节点即止，避免无限递归。
 */
function dependencyTreeOf(
  id: string,
  edges: Map<string, string[]>,
  availability: Map<string, boolean>,
): Record<string, unknown> {
  const expand = (name: string, seen: string[]): Record<string, unknown> => {
    const verdict = !availability.has(name) ? 'missing' : availability.get(name) ? 'ok' : 'invalid';
    const children = seen.includes(name)
      ? []
      : (edges.get(name) ?? []).map((child) => expand(child, [...seen, name]));
    return { name, status: verdict, children };
  };
  return expand(id, []);
}

/** 读写共用的路径：载入索引并在需要时写回 */
function loadForWrite(layout: ReturnType<typeof layoutOf>): {
  index: SkillIndex | null;
  findings: Finding[];
  missing: boolean;
} {
  if (!existsSync(layout.indexFile)) return { index: null, findings: [], missing: true };
  const loaded = loadIndex(layout.indexFile);
  return { index: loaded.index, findings: [...loaded.findings], missing: false };
}

/** 索引缺失或损坏时的统一回应：按写操作处理，索引不可用即不能继续 */
function unreadableIndex(
  command: string,
  layout: ReturnType<typeof layoutOf>,
  findings: Finding[],
  missing: boolean,
): Result<unknown> {
  return buildResult(command, [
    ...findings,
    missing
      ? finding(CODES.ENV_NOT_INITIALIZED, {
          source: 'workspace',
          target: layout.root,
          message: '工作区尚未初始化',
          remedy: '请先执行 init',
        })
      : finding(CODES.ENV_INCOMPLETE, {
          source: 'workspace',
          target: layout.indexFile,
          message: '索引无法读取，不能执行写操作',
          remedy: '请先修复或重建索引',
        }),
  ]);
}

const PLUGIN_CONFIG_PATTERN =
  /^plugin\.([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]+(?:-[a-z0-9]+)*)\.(root|rules_root)$/;

function configSetPluginCommand(
  context: CommandContext,
  key: string,
  value: string,
): Result<unknown> {
  const layout = layoutOf(workspaceRootOf(context.args));
  const loaded = loadPluginsForWrite(layout, context.now);
  if (loaded.index === null) {
    return pluginUnreadable('config set', layout, loaded.findings, loaded.missing);
  }
  const match = PLUGIN_CONFIG_PATTERN.exec(key);
  if (match === null) {
    return buildResult('config set', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: key,
        message: `插件配置键非法：${key}`,
        remedy:
          '使用 plugin.<plugin_id>.<host_key>.root 或 plugin.<plugin_id>.<host_key>.rules_root',
      }),
    ]);
  }
  const pluginId = match[1] as string;
  const hostKey = match[2] as string;
  const record = loaded.index.plugins.find((item) => item.id === pluginId);
  const host = record?.hosts.find((item) => item.host_key === hostKey);
  if (record === undefined || host === undefined) {
    return buildResult('config set', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: key,
        message: `插件或宿主未登记：${pluginId}/${hostKey}`,
        remedy: '先安装插件，并使用 list --kind plugin 查看可用宿主',
      }),
    ]);
  }
  const trimmed = value.trim();
  const relativeWithTraversal = !isAbsolute(trimmed) && trimmed.split(/[\\/]/).includes('..');
  if (trimmed === '' || trimmed.includes('\0') || relativeWithTraversal) {
    return buildResult('config set', [
      finding(CODES.PATH_INVALID, {
        source: 'input',
        target: key,
        message: '插件宿主根路径不能为空或包含空字节',
        remedy: '提供可写目录路径',
      }),
    ]);
  }
  const resolved = isAbsolute(trimmed) ? trimmed : resolve(layout.root, trimmed);
  if (resolved.includes('\0')) {
    return buildResult('config set', [
      finding(CODES.PATH_INVALID, {
        source: 'input',
        target: key,
        message: '插件宿主根路径非法',
        remedy: '提供合法路径',
      }),
    ]);
  }
  const config = { ...loaded.index.config, [key]: trimmed };
  const next: PluginIndex = { ...loaded.index, generated_at: context.now, config };
  savePluginIndex(layout.pluginIndexFile, next);
  return buildResult('config set', loaded.findings, [], {
    data: {
      key,
      previous_value: loaded.index.config[key] ?? null,
      new_value: trimmed,
      resolved_path: resolved,
    },
  });
}

const configSetHandler: CommandHandler = async ({ args, now, interaction }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const key = args.positionals[0];
  const value = args.positionals[1];
  if (key === undefined || key === '') {
    return buildResult('config set', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'key',
        message: 'config set 需要给出配置键',
        remedy: '用法：config set <配置键> <配置值>',
      }),
    ]);
  }
  if (value === undefined) {
    return buildResult('config set', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'value',
        message: 'config set 需要给出配置值',
        remedy: '用法：config set <配置键> <配置值>',
      }),
    ]);
  }
  if (key.startsWith('plugin.'))
    return configSetPluginCommand({ args, now, interaction }, key, value);
  const { index, findings, missing } = loadForWrite(layout);
  if (index === null) return unreadableIndex('config set', layout, findings, missing);

  const outcome = setConfig({ index, key, value, workspaceRoot: layout.root });
  if (outcome.index === null) {
    return buildResult('config set', [...findings, ...outcome.findings], [], {
      data: outcome.data,
    });
  }
  try {
    return await withLock(layout.indexFile, () => {
      saveIndex(layout.indexFile, outcome.index as SkillIndex);
      return buildResult('config set', findings, [], { data: outcome.data });
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return buildResult('config set', [
      ...findings,
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
};

/** 启用与禁用共用同一套参数与载荷形状 */
function toggleHandler(command: 'enable' | 'disable'): CommandHandler {
  return async ({ args, now, interaction }) => {
    if (pluginKind(args)) return pluginToggleCommand(command, { args, now, interaction });
    const layout = layoutOf(workspaceRootOf(args));
    const id = args.positionals[0];
    if (id === undefined || id === '') {
      return buildResult(command, [
        finding(CODES.INPUT_MISSING_ARG, {
          source: 'input',
          target: 'id',
          message: `${command} 需要给出 Skill 标识`,
          remedy: `请提供要${command === 'enable' ? '启用' : '禁用'}的 Skill 标识`,
        }),
      ]);
    }
    const { index, findings, missing } = loadForWrite(layout);
    if (index === null) return unreadableIndex(command, layout, findings, missing);

    const dryRun = flag(args, 'dry-run');
    const target = option(args, 'target');
    const scope = option(args, 'scope');
    const hostValue = option(args, 'host');

    // 宿主分发通道：只在给出 --host 时介入，且只作用于宿主真实根内的副本，
    // 不修改索引状态（索引状态描述工作区内的目标），也不新建副本。
    if (hostValue !== undefined) {
      return runHostToggle({ command, hostValue, id, layout, index, args, interaction, dryRun });
    }

    const base = {
      layout,
      index,
      id,
      now,
      ...(target !== undefined ? { target } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
    const run = command === 'enable' ? enableSkill : disableSkill;

    // 启用与禁用的确认级别为「无需确认」，策略层判定为跳过后仍保留统一入口
    if (!dryRun) {
      const preview = run({ ...base, dryRun: true });
      const blocked = await confirmationGate({
        command,
        args,
        interaction,
        preview,
        plan: planOf(command, id, preview, []),
      });
      if (blocked !== null) return blocked;
    }

    const outcome = run({ ...base, dryRun });
    if (!dryRun && outcome.index !== index) saveIndex(layout.indexFile, outcome.index);
    return buildResult(command, [...findings, ...outcome.findings], outcome.changes, {
      data: outcome.data,
      ...(outcome.preview === true ? { preview: true } : {}),
    });
  };
}

const updateHandler: CommandHandler = async ({ args, now, interaction }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('update', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'update 需要给出 Skill 标识',
        remedy: '请提供要刷新的 Skill 标识',
      }),
    ]);
  }
  const { index, findings, missing } = loadForWrite(layout);
  if (index === null) return unreadableIndex('update', layout, findings, missing);

  const check = flag(args, 'check');
  const dryRun = flag(args, 'dry-run');
  const targetRef = option(args, 'ref');
  if (check && targetRef !== undefined) {
    return buildResult('update', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--ref',
        message: '--ref 不能与 --check 组合',
        remedy: '--check 只检查当前声明；请用 update --ref <tag> --dry-run 预览目标标签',
      }),
    ]);
  }
  const updateTarget = option(args, 'target');
  if (!check && !dryRun) {
    const preview = await updateSkill({
      layout,
      index,
      id,
      now,
      check: true,
      target: updateTarget,
      ref: targetRef,
    });
    const blocked = await confirmationGate({
      command: 'update',
      args,
      interaction,
      preview,
      plan: planOf('update', id, preview, [
        '刷新会先备份中心库原件，再更新索引记录与派生区字段',
        '目标标签会持久化为新的 source.ref，用户源文件不被改写',
      ]),
    });
    if (blocked !== null) return blocked;
  }

  const outcome = await updateSkill({
    layout,
    index,
    id,
    now,
    check: check || dryRun,
    target: updateTarget,
    ref: targetRef,
  });
  if (!check && !dryRun && outcome.index !== index) saveIndex(layout.indexFile, outcome.index);

  // 宿主分发通道：刷新后按落位计划把新内容重分发到宿主真实根（不新建副本）
  const hostValue = option(args, 'host');
  if (
    hostValue !== undefined &&
    !check &&
    !dryRun &&
    !outcome.findings.some((item) => item.severity === 'error')
  ) {
    const host = runHostLanding({
      command: 'update',
      hostValue,
      layout,
      index: outcome.index ?? index,
      skillDir: join(layout.skillsDir, id),
      now,
      dryRun: false,
    });
    return buildResult(
      'update',
      [...findings, ...outcome.findings, ...host.findings],
      [...outcome.changes, ...host.changes],
      { data: { ...(outcome.data as Record<string, unknown>), host: host.data } },
    );
  }

  return buildResult('update', [...findings, ...outcome.findings], outcome.changes, {
    data: outcome.data,
    ...(outcome.preview === true ? { preview: true } : {}),
  });
};

register({ name: 'config set', handler: configSetHandler });
register({ name: 'enable', handler: toggleHandler('enable') });
register({ name: 'disable', handler: toggleHandler('disable') });
register({ name: 'update', handler: updateHandler });

const importHandler: CommandHandler = async ({ args, now, interaction }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const source = args.positionals[0];
  if (source === undefined || source === '') {
    return buildResult('import', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'path',
        message: 'import 需要给出备份文件路径',
        remedy: '请提供工作区之内的相对路径，例如 backups/export.yaml',
      }),
    ]);
  }
  if (option(args, 'on-conflict') !== undefined) {
    // 一期导入不覆盖既有记录，冲突一律跳过，因此没有策略维度
    return buildResult('import', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--on-conflict',
        message: '一期导入不覆盖既有记录，冲突一律跳过，该选项没有可用语义',
        remedy: '请省略 --on-conflict；策略化覆盖属二期',
      }),
    ]);
  }
  const { index, findings, missing } = loadForWrite(layout);
  if (index === null) return unreadableIndex('import', layout, findings, missing);

  const dryRun = flag(args, 'dry-run');
  const preview = importIndex({ layout, index, source, now, dryRun: true });
  if (preview.refused === true) {
    // 校验失败整体拒绝，且按契约 4.15 的专属口径返回退出码 3
    return formatRejected('import', [...findings, ...preview.findings], preview.data);
  }

  if (!dryRun) {
    const planned = Number(preview.data['imported'] ?? 0);
    const blocked = await confirmationGate({
      command: 'import',
      args,
      interaction,
      preview: {
        index,
        findings: preview.findings,
        changes: preview.index.skills
          .filter((item) => !index.skills.some((old) => old.id === item.id))
          .map((item) => ({ action: 'add' as const, kind: 'index_record', path: item.path })),
        data: preview.data,
      },
      plan: {
        action: '导入',
        subject: source,
        writes: [],
        notes: [],
        inline: `将登记 ${planned} 条记录，冲突条目一律跳过`,
      },
    });
    if (blocked !== null) return blocked;
  }

  const outcome = importIndex({ layout, index, source, now, dryRun });
  if (outcome.refused === true) {
    return formatRejected('import', [...findings, ...outcome.findings], outcome.data);
  }
  if (!dryRun && outcome.index !== index) saveIndex(layout.indexFile, outcome.index);
  return buildResult('import', [...findings, ...outcome.findings], [], {
    data: outcome.data,
    ...(outcome.preview === true ? { preview: true } : {}),
  });
};

/**
 * 导入的整体拒绝：契约 4.15 规定「备份格式或指纹校验失败时返回 3」，这是本指令的专属规定，
 * 按结果规范 5.2 的专属优先条款覆盖通用派生——格式类问题的问题码本身按 4.4 的码表取，
 * 不为凑退出码改码。路径越界与来源不可读不属于格式失败，按通用派生分别返回 1 与 4。
 */
function formatRejected(
  command: string,
  findings: Finding[],
  data: Record<string, unknown>,
): Result<unknown> {
  const result = buildResult(command, findings, [], { data });
  if (data['rejected'] === 'invalid_format' && result.exit_code !== 2) {
    result.exit_code = 3;
    result.ok = false;
  }
  return result;
}

register({ name: 'import', handler: importHandler });

const restoreHandler: CommandHandler = async ({ args, now, interaction }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];

  // 备份列表出口：备份管理界面要列出可用备份，而界面不得直读工作区文件，
  // 因此由这条既有指令的取值选项给出列表。它不是写操作，不参与确认流程。
  if (flag(args, 'list')) {
    if (id !== undefined && id !== '' && !ID_PATTERN.test(id)) {
      return buildResult('restore', [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: id,
          message: `标识不符合命名规范：${id}`,
          remedy: '标识需为全小写、短横线分隔',
        }),
      ]);
    }
    const entries =
      id === undefined || id === ''
        ? listAllBackups(layout.root, layout.backupsDir)
        : listBackups(layout.root, layout.backupsDir, id);
    return buildResult('restore', [], [], {
      data: {
        backups: entries.map((entry) => ({
          id: entry.id,
          timestamp: entry.timestamp,
          type: entry.type,
          file_count: entry.fileCount,
          path: entry.portableDir,
        })),
        total: entries.length,
        filtered_by: id === undefined || id === '' ? null : id,
        notes: [
          '列表只读取备份清单，不校验载体内容；恢复时会逐份校验后再写回',
          entries.length === 0
            ? '没有可用备份：卸载 Skill 时会自动生成备份，也可以用 restore 之外的导出/导入流程迁移记录'
            : '按标识与时间戳恢复：restore <标识> --timestamp <时间戳>',
        ],
      },
    });
  }

  if (id === undefined || id === '') {
    return buildResult('restore', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'restore 需要给出 Skill 标识',
        remedy: '请提供要恢复的 Skill 标识；省略时间戳时取该标识最新的备份',
      }),
    ]);
  }
  const { index, findings, missing } = loadForWrite(layout);
  if (index === null) return unreadableIndex('restore', layout, findings, missing);

  const dryRun = flag(args, 'dry-run');
  const timestamp = option(args, 'timestamp');
  const base = {
    layout,
    index,
    id,
    now,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };

  // 恢复是覆盖性写操作：常规确认级别，预演先给出将写回的文件清单
  if (!dryRun) {
    const preview = restoreSkill({ ...base, dryRun: true });
    const blocked = await confirmationGate({
      command: 'restore',
      args,
      interaction,
      preview,
      plan: planOf('restore', id, preview, [
        '恢复会把备份内容写回中心库，覆盖该位置现有的原件',
        '恢复不判定校验结论，完成后请执行扫描',
      ]),
    });
    if (blocked !== null) return blocked;
  }

  const outcome = restoreSkill({ ...base, dryRun });
  if (!dryRun && outcome.index !== index) saveIndex(layout.indexFile, outcome.index);
  return buildResult('restore', [...findings, ...outcome.findings], outcome.changes, {
    data: outcome.data,
    ...(outcome.preview === true ? { preview: true } : {}),
  });
};

register({ name: 'restore', handler: restoreHandler });
