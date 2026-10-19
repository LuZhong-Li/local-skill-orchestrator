/** install / uninstall 处理器。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadIndex, saveIndex } from '../../../core/index/index.ts';
import { installSkill, uninstallSkill } from '../../../core/lifecycle/index.ts';
import { readMetaFile } from '../../../core/metadata/read.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { withLock } from '../../../store/locking/index.ts';
import { toKernelError } from '../../../store/errors.ts';
import { CODES, finding } from '../../../store/contract.ts';
import { buildResult } from '../../result/index.ts';
import { flag, option } from '../../parsers/index.ts';
import { metaDirOf, runHostLanding } from '../../host/index.ts';
import {
  confirmOriginalUninstall,
  finishOriginalUninstall,
  rejectHostUninstallOptions,
  rejectUninstallBase,
  runHostOrBlockedUninstall,
} from '../../host/uninstall.ts';
import { pluginKind, workspaceRootOf } from '../../shared/options.ts';
import type { CommandHandler } from '../types.ts';
import { confirmationGate, planOf } from '../shared.ts';
import { pluginInstallCommand } from './plugin-install.ts';
import { pluginUninstallCommand } from './plugin-uninstall.ts';
export const installHandler: CommandHandler = async ({ args, now, interaction }) => {
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
export const uninstallHandler: CommandHandler = async ({ args, now, interaction }) => {
  const hostValue = option(args, 'host');
  const kindPlugin = pluginKind(args);
  const rejected = rejectHostUninstallOptions({
    hostValue,
    kindPlugin,
    hard: flag(args, 'hard'),
  });
  if (rejected !== null) return rejected;
  if (kindPlugin) return pluginUninstallCommand({ args, now, interaction });
  const layout = layoutOf(workspaceRootOf(args));
  const dryRun = flag(args, 'dry-run');
  const invalid = rejectUninstallBase({ layout, id: args.positionals[0] });
  if (invalid !== null) return invalid;
  const skillId = args.positionals[0] as string;
  const early = await runHostOrBlockedUninstall({
    layout,
    now,
    hostValue,
    skillId,
    dryRun,
    args,
    interaction,
    confirm: confirmationGate,
  });
  if (early !== null) return early;
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
        id: skillId,
        now,
        ...(hard ? { hard: true } : {}),
      };
      const blocked = await confirmOriginalUninstall({
        args,
        interaction,
        skillId,
        hard,
        dryRun,
        runPreview: () => uninstallSkill({ ...uninstallInput, dryRun: true }),
        confirm: confirmationGate,
      });
      if (blocked !== null) return blocked;
      const outcome = uninstallSkill({ ...uninstallInput, dryRun });
      if (!dryRun && outcome.index !== loaded.index) saveIndex(layout.indexFile, outcome.index);
      return finishOriginalUninstall({
        layout,
        now,
        skillId,
        dryRun,
        outcome,
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
/**
 * validate 的退出口径。
 *
 * 契约 4.12 规定「存在错误级问题时返回 1；仅存在警告时返回 0」，指令总表把本指令的范围限定为 0 至 3。
 * 二者共同约束下：参数类问题按通用派生规则返回 2，其余错误级问题返回 1，仅警告时返回 0，
 * --strict 下警告也视为失败返回 1。只读指令，不产生变更，因此 changes 恒为空。
 */
