/**
 * K-15 适配器层：落位计划构建。
 *
 * 依据：设计文档 4.1 节（plan 只产出计划、不写盘）、6.2 节（可推导布局与规则路径的关系）、
 * 6.3 节（重叠消费声明）；宿主注册表规范 3.5 节的模板粒度（skill / external 为目录模板，
 * rules 为文件模板）。
 *
 * 本模块只做路径展开与声明组装，不含任何写盘动作：写盘由 T5 的落位扩展执行。
 */
import { basename, join } from 'node:path';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { hostById } from '../hosts/index.ts';
import type { RootKind } from '../hosts/types.ts';
import type { ArtifactFile } from '../render/types.ts';
import type { AdapterForm, OverlapDeclaration, PlacementEntry, PlacementPlan } from './types.ts';

const SOURCE = 'adapters';

/** 模板占位符：目标标识与 Skill 标识 */
export const TARGET_PLACEHOLDER = '<目标标识>';
export const SKILL_PLACEHOLDER = '<Skill 标识>';

/** 展开落位模板：替换占位符；外部根保留未展开的其余占位符（如宿主工作区路径） */
export function expandTemplate(template: string, targetId: string, skillId: string): string {
  return template.split(TARGET_PLACEHOLDER).join(targetId).split(SKILL_PLACEHOLDER).join(skillId);
}

/** 该落位根模板是否指向文件而不是目录（规范 3.5 的模板粒度） */
export function isFileTemplate(rootKind: string): boolean {
  return rootKind === 'rules';
}

/** 形态 → 产物文件名（目录类落位根下拼接） */
export function fileNameOf(form: AdapterForm, skillId: string): string {
  if (form === 'rules') return `${skillId}.mdc`;
  if (form === 'entry') return 'AGENTS.md';
  return 'SKILL.md';
}

/**
 * 组装一条落位项。
 * 目录类落位根：target_path = 展开后的目录 + 产物文件名；文件类落位根：target_path = 展开后的文件路径。
 */
export function buildEntry(
  hostId: string,
  form: AdapterForm,
  skillId: string,
  artifact: ArtifactFile,
): PlacementEntry | undefined {
  const entry = hostById(hostId);
  if (entry === undefined) return undefined;
  const rootKind: RootKind = form === 'rules' ? 'rules' : rootKindOf(hostId, form);
  const root = (entry.roots ?? []).find((item) => item.kind === rootKind);
  if (root === undefined) return undefined;

  const rootPath = expandTemplate(root.path_template, entry.host_id, skillId);
  const external = rootKind === 'external';
  const fileTemplate = isFileTemplate(rootKind);
  const fileName = fileTemplate ? '' : fileNameOf(form, skillId);
  const target = fileTemplate ? rootPath : `${rootPath}/${fileName}`;

  // 指令文件载体：合并策略未定稿前只产出片段，不落盘（设计 5.4）
  const landable = form !== 'entry';
  const result: PlacementEntry = {
    artifact_kind: artifact.kind,
    root_path: rootPath,
    target_path: target,
    file_name: fileName,
    root_kind: rootKind,
    external,
    landable,
    consumed_by: [...(root.consumed_by ?? [])],
    content: artifact.content,
  };
  if (!landable) {
    result.hold_reason = '合并策略未定稿：只产出待合并片段，不写入宿主既有文件（设计 5.4）';
  }
  return result;
}

/** 技能形态或降级形态对应的落位根类别：技能形态取技能根（工作区内优先），降级形态取规则根 */
function rootKindOf(hostId: string, form: AdapterForm): RootKind {
  if (form === 'entry') return 'rules';
  const entry = hostById(hostId);
  const kinds = (entry?.roots ?? []).map((root) => root.kind);
  if (kinds.includes('skill')) return 'skill';
  if (kinds.includes('external')) return 'external';
  return 'rules';
}

/** 组装落位计划：产物 + 落位项 + 重叠消费声明（M5-R8） */
export function assemblePlan(input: {
  hostId: string;
  targetId: string;
  skillId: string;
  form: AdapterForm;
  degraded: boolean;
  capabilityGaps: string[];
  artifacts: ArtifactFile[];
  findings: Finding[];
}): PlacementPlan {
  const entries: PlacementEntry[] = [];
  const findings = [...input.findings];
  for (const artifact of input.artifacts) {
    const entry = buildEntry(input.hostId, input.form, input.skillId, artifact);
    if (entry === undefined) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: SOURCE,
          target: `${input.hostId}:${input.form}`,
          message: `该宿主没有可用于形态 ${input.form} 的落位根`,
          remedy: '在宿主注册表中登记对应类别的落位根（规范 3.5）',
        }),
      );
      continue;
    }
    entries.push(entry);
  }

  // 重叠消费声明：同一落位根被多个宿主读取时如实登记（特性而非缺陷）
  const overlaps: OverlapDeclaration[] = entries
    .filter((entry) => entry.consumed_by.length > 1)
    .map((entry) => ({ root_path: entry.root_path, consumed_by: [...entry.consumed_by] }));

  return {
    host_id: input.hostId,
    target_id: input.targetId,
    skill_id: input.skillId,
    form: input.form,
    degraded: input.degraded,
    capability_gaps: [...input.capabilityGaps],
    entries,
    overlaps,
    findings,
  };
}

/**
 * 把落位计划重定基到解析后的宿主真实根。
 *
 * 注册表里的 `path_template` 是模板（工作区可推导布局或宿主相对形态），
 * 真正的落点由外部根解析器给出（默认路径 + 配置覆盖）。重定基规则：
 *   目录类落位根（技能根 / 工作区外技能根）：目标目录 = 宿主根 + Skill 标识；
 *   文件类落位根（规则路径）：目标文件 = 宿主根 + 原计划的文件名。
 */
export function rebasePlan(
  plan: PlacementPlan,
  hostRootPath: string,
  external: boolean,
): PlacementPlan {
  const entries = plan.entries.map((entry) => {
    const fileType = entry.file_name === '';
    const fileName = fileType ? basename(entry.target_path) : entry.file_name;
    const rootPath = fileType ? hostRootPath : join(hostRootPath, plan.skill_id);
    return {
      ...entry,
      root_path: rootPath,
      target_path: join(rootPath, fileName),
      // 重定基后工作区外标记由解析结果决定：注册表模板是相对形态，真实根可能在工作区之外
      external,
    };
  });
  const overlaps: OverlapDeclaration[] = entries
    .filter((entry) => entry.consumed_by.length > 1)
    .map((entry) => ({ root_path: entry.root_path, consumed_by: [...entry.consumed_by] }));
  return { ...plan, entries, overlaps };
}
