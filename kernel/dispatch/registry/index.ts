/**
 * L2 指令注册与路由。
 *
 * 一期只注册 init 与 scan 两条指令的最小闭环：把参数转成对内核服务的调用，
 * 捕获内核抛出的错误并转换为标准结果封装。领域规则一律不在本层实现。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialIndex, loadIndex, saveIndex, TOOL_VERSION } from '../../core/index/index.ts';
import { scanWorkspace } from '../../core/discovery/index.ts';
import { installSkill, uninstallSkill, type LifecycleOutcome } from '../../core/lifecycle/index.ts';
import { validateWorkspace, type ValidationReport } from '../../core/validation/index.ts';
import { inspectSkill, listSkills, readConfig, toListEntry } from '../../core/index/query.ts';
import { analyzeDependencies, splitDeclaration } from '../../core/dependency/index.ts';
import { exportIndex } from '../../core/backup/index.ts';
import { declaredSkillsOf, readMetaFile } from '../../core/metadata/read.ts';
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
import { buildResult, type Change, type Result } from '../result/index.ts';
import { flag, option, optionList, type ParsedArgs } from '../parsers/index.ts';
import {
  confirmLevelOf,
  decideConfirmation,
  isAffirmative,
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
  'scan',
  'list',
  'inspect',
  'install',
  'uninstall',
  'validate',
  'deps',
  'export',
] as const;

const handlers = new Map<string, CommandHandler>();

/** 指令注册 */
export function register(spec: CommandSpec): void {
  handlers.set(spec.name, spec.handler);
}

/** 指令路由：未注册的指令返回输入类错误 */
export async function dispatch(context: CommandContext): Promise<Result<unknown>> {
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

/** 解析工作区根目录：命令行选项优先，其次环境变量，最后用户主目录 */
function workspaceRootOf(args: ParsedArgs): string {
  return resolveWorkspaceRoot(option(args, 'workspace'));
}

const initHandler: CommandHandler = async ({ args, now }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const changes: Change[] = [];
  try {
    const existed = existsSync(layout.indexFile);
    ensureWorkspaceDirs(layout);
    if (existed) {
      // 幂等：工作区已存在时不覆盖既有索引与配置
      return buildResult('init', [], [], {
        data: {
          root: layout.root,
          index: layout.indexFile,
          created: false,
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
        created: true,
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

const scanHandler: CommandHandler = async ({ args, now }) => {
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
}): Promise<Result<unknown> | null> {
  const { command, args, interaction, preview, plan } = options;

  if (preview.data['rejected'] !== undefined) {
    return buildResult(command, preview.findings, [], { data: preview.data });
  }
  if (preview.findings.some((item) => item.severity === 'error') && preview.changes.length === 0) {
    return buildResult(command, preview.findings, [], { data: preview.data });
  }

  const decision = decideConfirmation({
    level: confirmLevelOf(command, { hard: flag(args, 'hard') }),
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

/** 由预览结果与附加提示组装预期变更摘要 */
function planOf(
  command: string,
  subject: string,
  preview: LifecycleOutcome,
  notes: string[],
): ConfirmPlan {
  return {
    action: command === 'install' ? '安装' : '卸载',
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
      };

      // 需要确认且不是预演时，先跑一次只读预览取得影响范围
      if (!dryRun) {
        const preview = installSkill({ ...installInput, dryRun: true });
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

      const outcome = installSkill({ ...installInput, dryRun });
      if (!dryRun && outcome.index !== loaded.index) saveIndex(layout.indexFile, outcome.index);
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
  return buildResult('config get', findings, [], { data: readConfig(index) });
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

  const all = [...findings, ...metaRead.findings, ...report.findings];
  const result = buildResult('deps', all, [], {
    data: {
      id,
      declared_from: declaredFromMeta === null ? 'index' : 'meta',
      entries: report.entries,
      affected: report.affected,
      cycles: report.cycles,
    },
  });

  /**
   * 契约 4.13 规定「存在未满足的依赖时返回 6」，这是本指令的专属规定，
   * 按结果规范 5.2 的专属优先条款覆盖通用派生——通用派生只把 DEP 类别映射到 6，
   * 而「被依赖对象校验不通过」按 4.4 的对照表是校验类问题码，需要在这里一并归入未满足。
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
