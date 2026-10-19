import { join } from 'node:path';
import { saveIndex, setConfig } from '../../../core/index/index.ts';
import { disableSkill, enableSkill, updateSkill } from '../../../core/lifecycle/index.ts';
import type { SkillIndex } from '../../../core/metadata/types.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { withLock } from '../../../store/locking/index.ts';
import { toKernelError } from '../../../store/errors.ts';
import { CODES, type Finding, type Result } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { buildResult } from '../../result/index.ts';
import { flag, option, type ParsedArgs } from '../../parsers/index.ts';
import { runHostLanding } from '../../host/index.ts';
import { pluginKind, workspaceRootOf } from '../../shared/options.ts';
import type { CommandHandler } from '../types.ts';
import { confirmationGate, loadForWrite, planOf, unreadableIndex } from '../shared.ts';
import { configSetPluginCommand } from './plugin-config.ts';
import { pluginToggleCommand } from './plugin-toggle.ts';
import { runHostToggle } from '../host-toggle.ts';
export const configSetHandler: CommandHandler = async ({ args, now, interaction }) => {
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
export function toggleHandler(command: 'enable' | 'disable'): CommandHandler {
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
      return runHostToggle({
        command,
        hostValue,
        id,
        layout,
        index,
        now,
        args,
        interaction,
        dryRun,
      });
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

function updatePreflight(input: {
  args: ParsedArgs;
  layout: ReturnType<typeof layoutOf>;
  index: SkillIndex;
  id: string;
  now: string;
  findings: readonly Finding[];
}): Result<unknown> | null {
  const check = flag(input.args, 'check');
  const targetRef = option(input.args, 'ref');
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
  const hostValue = option(input.args, 'host');
  if (hostValue === undefined || check) return null;
  const hostCheck = runHostLanding({
    command: 'update',
    hostValue,
    layout: input.layout,
    index: input.index,
    skillDir: join(input.layout.skillsDir, input.id),
    now: input.now,
    dryRun: true,
    requireExisting: true,
  });
  if (!hostCheck.findings.some((item) => item.severity === 'error')) return null;
  return buildResult('update', [...input.findings, ...hostCheck.findings], [], {
    data: hostCheck.data,
  });
}

export const updateHandler: CommandHandler = async ({ args, now, interaction }) => {
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
  const hostValue = option(args, 'host');
  const preflight = updatePreflight({ args, layout, index, id, now, findings });
  if (preflight !== null) return preflight;
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
      requireExisting: true,
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
