/** 宿主根内启用/禁用与规则切换。 */
import { confirmationGate } from './shared.ts';
import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TOOL_VERSION } from '../../core/index/index.ts';
import { type LifecycleOutcome } from '../../core/lifecycle/index.ts';
import { readMetaFile } from '../../core/metadata/read.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import { layoutOf } from '../../store/workspace/index.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { setHostSkillVisibility } from '../../core/adapters/land.ts';
import { loadHostRegistry } from '../../core/hosts/index.ts';
import { buildResult, type Change, type Result } from '../result/index.ts';
import { type ParsedArgs } from '../parsers/index.ts';
import { loadPluginCatalog } from '../../core/plugins/host.ts';
import {
  buildHostChannel,
  commitBuiltinVisibility,
  hostToggleChanges,
  hostWritesOf,
  prepareToggleLedger,
  renderSourceOf,
  type HostChannel,
} from '../host/index.ts';
import { type ConfirmPlan, type Interaction } from '../policy/index.ts';
async function runPluginRuleToggle(input: {
  command: 'enable' | 'disable';
  id: string;
  index: SkillIndex;
  args: ParsedArgs;
  interaction: Interaction;
  dryRun: boolean;
  findings: Finding[];
  channel: HostChannel;
}): Promise<Result<unknown>> {
  const target = input.channel.plan.entries.find((entry) => entry.landable)?.target_path;
  if (target === undefined) {
    return buildResult(input.command, [
      ...input.findings,
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--host',
        message: '插件规则形态没有可切换的 Skill 副本',
        remedy: '先安装/分发该 Skill 到该插件宿主',
      }),
    ]);
  }
  const paths = ruleTogglePaths(input.command, target);
  const plan = ruleTogglePlan(input.command, input.id, input.channel.hostId, target);
  if (!input.dryRun) {
    const blocked = await confirmationGate({
      command: input.command,
      args: input.args,
      interaction: input.interaction,
      preview: {
        index: input.index,
        findings: [],
        changes: [],
        data: {},
      } satisfies LifecycleOutcome,
      plan,
      ...ruleToggleEscalation(input.channel),
    });
    if (blocked !== null) return blocked;
  }
  if (input.dryRun) {
    return buildResult(input.command, input.findings, [], {
      data: {
        host: input.channel.hostId,
        host_root: dirname(target),
        preview_writes: plan.writes,
      },
      preview: true,
    });
  }
  const changed = existsSync(paths.from);
  if (changed) renameSync(paths.from, paths.to);
  return buildResult(
    input.command,
    input.findings,
    ruleToggleChanges(changed, paths.to, input.channel.hostId),
    { data: { host: input.channel.hostId, host_root: dirname(target), idempotent: !changed } },
  );
}
function ruleTogglePaths(
  command: 'enable' | 'disable',
  target: string,
): {
  from: string;
  to: string;
  writeAction: string;
} {
  const disabled = `${target}.disabled`;
  return command === 'disable'
    ? { from: target, to: disabled, writeAction: '改名' }
    : { from: disabled, to: target, writeAction: '恢复' };
}
function ruleTogglePlan(
  command: 'enable' | 'disable',
  id: string,
  hostId: string,
  target: string,
): ConfirmPlan {
  const paths = ruleTogglePaths(command, target);
  return {
    action: command === 'enable' ? '启用' : '禁用',
    subject: `${id}（插件宿主 ${hostId}）`,
    writes: [{ action: paths.writeAction, kind: 'rule_file', path: target }],
    notes: [`插件规则副本：${target}`, '只切换规则文件后缀，不改动 Skill 索引或插件登记'],
  };
}
function ruleToggleChanges(changed: boolean, to: string, hostId: string): Change[] {
  return changed
    ? [{ action: 'modify', kind: 'host-copy', path: to, detail: `插件宿主：${hostId}` }]
    : [];
}
function ruleToggleEscalation(channel: HostChannel): {
  escalateTo?: 'light';
} {
  return channel.resolution?.external === true ? { escalateTo: 'light' } : {};
}
export async function runHostToggle(input: {
  command: 'enable' | 'disable';
  hostValue: string;
  id: string;
  layout: ReturnType<typeof layoutOf>;
  index: SkillIndex;
  now: string;
  args: ParsedArgs;
  interaction: Interaction;
  dryRun: boolean;
}): Promise<Result<unknown>> {
  const { command, hostValue, id, layout, index, now, args, interaction, dryRun } = input;
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
    return runPluginRuleToggle({
      command,
      id,
      index,
      args,
      interaction,
      dryRun,
      findings: built.findings,
      channel,
    });
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
  if (channel.plugin === undefined && channel.form === 'rules') {
    return buildResult(
      command,
      [
        ...built.findings,
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: '--host',
          message: `规则形态没有可切换的可见性标记：${hostValue}`,
          remedy: 'rules 记录只允许 visible；请重新分发以刷新规则文件',
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
  const prepared = prepareToggleLedger({
    channel,
    layout,
    now,
    dryRun,
    rootPath,
    skillId: id,
  });
  if (prepared.findings.some((item) => item.severity === 'error')) {
    return buildResult(command, [...built.findings, ...prepared.findings], [], {
      data: { host: channel.hostId, ledger_recorded: false },
    });
  }
  const visibility = setHostSkillVisibility({
    rootPath: visibilityRoot,
    skillId: id,
    enabled: command === 'enable',
  });
  const changed = visibility === 'changed';
  let ledgerRecorded = false;
  let adopted = false;
  let origin = '';
  const findings = [...built.findings];
  if (channel.plugin === undefined && prepared.index !== undefined) {
    const committed = commitBuiltinVisibility({
      layout,
      now,
      skillId: id,
      hostId: channel.hostId,
      sourceMeta: metaRead.raw,
      index: prepared.index,
      targetPath: copyDir,
      rootPath,
      visibility: command === 'enable' ? 'visible' : 'disabled',
      beforeDisabled: prepared.beforeDisabled,
      changed,
    });
    ledgerRecorded = committed.recorded;
    adopted = committed.adopted;
    origin = committed.origin;
    findings.push(...committed.findings);
  }
  const hostChanges = hostToggleChanges(findings, changed, targetPath, channel.hostId);
  return buildResult(
    command,
    findings,
    findings.some((item) => item.severity === 'error') ? [] : hostChanges,
    {
      data: {
        host: channel.hostId,
        host_root: rootPath,
        host_writes_outside_workspace: true,
        idempotent: !changed,
        ...(channel.plugin === undefined
          ? {
              ledger_source: 'host_landings',
              ledger_recorded: ledgerRecorded,
              adopted,
              origin,
            }
          : {}),
        consumed_by: [
          ...new Set(channel.plan.entries.flatMap((entry) => entry.consumed_by)),
        ].sort(),
      },
    },
  );
}
