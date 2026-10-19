/** 宿主分发通道的取值解析与落位计划组装。 */
import { CODES, type Change, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import { adapterFor } from '../../core/adapters/index.ts';
import { rebasePlan } from '../../core/adapters/plan.ts';
import { resolveHostRoot, type HostRootResolution } from '../../core/adapters/roots.ts';
import type { AdapterForm, PlacementPlan } from '../../core/adapters/types.ts';
import type { RenderSource } from '../../core/render/types.ts';
import { hostIds as registeredHostIds } from '../../core/hosts/index.ts';
import type { RootKind } from '../../core/hosts/types.ts';
import {
  buildPluginHostPlan,
  pluginHostIds,
  type LoadedPluginCatalog,
} from '../../core/plugins/host.ts';
import type { ConfirmPlan } from '../policy/index.ts';

export interface HostChannel {
  hostId: string;
  form: AdapterForm;
  /** 解析后的宿主真实根；不可落盘的形态没有该值 */
  resolution?: HostRootResolution;
  plan: PlacementPlan;
  /** 第三方插件宿主上下文；内置宿主为 undefined */
  plugin?: import('../../core/plugins/host.ts').PluginHostPlan;
}

/** `--host` 的可用取值：注册表内每个有适配器的宿主，按其形态展开（规则路径类加后缀） */
export function hostOptionValues(pluginIds: readonly string[] = []): string[] {
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
export function hostTargetOf(value: string): { hostId: string; form: AdapterForm } | undefined {
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
export function buildHostChannel(input: {
  value: string;
  layout: WorkspaceLayout;
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
    return buildPluginChannel(
      {
        value: input.value,
        layout: input.layout,
        source: input.source,
        pluginCatalog: input.pluginCatalog,
      },
      findings,
    );
  }
  return buildBuiltinChannel(input, target, findings);
}

function buildPluginChannel(
  input: {
    value: string;
    layout: WorkspaceLayout;
    source: RenderSource;
    pluginCatalog: LoadedPluginCatalog;
  },
  findings: Finding[],
): { channel?: HostChannel; findings: Finding[] } {
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

function buildBuiltinChannel(
  input: {
    value: string;
    layout: WorkspaceLayout;
    index: SkillIndex;
    source: RenderSource;
    form?: AdapterForm;
  },
  target: { hostId: string; form: AdapterForm },
  findings: Finding[],
): { channel?: HostChannel; findings: Finding[] } {
  const adapter = adapterFor(target.hostId);
  if (adapter === undefined) {
    findings.push(
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--host',
        message: `该宿主没有适配器：${input.value}`,
        remedy: `可用取值为 ${hostOptionValues().join('、')}`,
      }),
    );
    return { findings };
  }
  const form = input.form ?? target.form;
  const plan = adapter.plan(input.source, form);
  findings.push(...plan.findings);
  if (!plan.entries.some((entry) => entry.landable)) {
    return { channel: { hostId: target.hostId, form, plan }, findings };
  }
  return resolveBuiltinChannel(input, target.hostId, form, plan, findings);
}

function resolveBuiltinChannel(
  input: { value: string; layout: WorkspaceLayout; index: SkillIndex },
  hostId: string,
  form: AdapterForm,
  plan: PlacementPlan,
  findings: Finding[],
): { channel?: HostChannel; findings: Finding[] } {
  const resolution = resolveHostRoot({
    hostId,
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
        remedy: `可用取值为 ${hostOptionValues().join('、')}`,
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
      hostId,
      form,
      resolution,
      plan: rebasePlan(plan, resolution.path, resolution.external),
    },
    findings,
  };
}

/** 宿主通道将写入的位置清单（供确认与预演呈现） */
export function hostWritesOf(plan: PlacementPlan): ConfirmPlan['writes'] {
  return plan.entries
    .filter((entry) => entry.landable)
    .map((entry) => ({ action: '写入', kind: entry.artifact_kind, path: entry.target_path }));
}

/** 通道是否涉及工作区之外的写入（用于确认级别升级与提示） */
export function hostWritesOutside(plan: PlacementPlan): boolean {
  return plan.entries.some((entry) => entry.landable && entry.external);
}

/** 宿主可见性切换的变更列表；失败或未改变时为空。 */
export function hostToggleChanges(
  findings: readonly Finding[],
  changed: boolean,
  path: string,
  hostId: string,
): Change[] {
  if (!changed || findings.some((item) => item.severity === 'error')) return [];
  return [
    {
      action: 'modify',
      kind: 'host-copy',
      path,
      detail: `宿主分发：${hostId}；目录与其余文件未改动`,
    },
  ];
}
