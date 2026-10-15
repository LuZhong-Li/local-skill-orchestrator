/**
 * K-14 渲染层核心（共用渲染核心）。
 *
 * 职责：把规范化的内部技能表示渲染为目标宿主可识别的产物文本。
 * 依据：设计文档 5.2 节（保守渲染优先 + DP-04 透传白名单）、5.3 节（共用渲染核心：
 * 通用 Agent Skills 目标与逐宿主适配器同核，差异只在策略）、5.4 节（降级渲染与能力差异）。
 *
 * 三条硬性行为：
 * 一、保守渲染优先——默认只渲染标准六字段；扩展字段仅在宿主策略为 host_declared
 * 且命中白名单时渲染，未命中一律忽略并回报 W-FIELD-004 警告（不静默丢弃）；
 * 二、禁用字段双重拦截——注册表加载期拒绝白名单登记该字段（T2），渲染期再次拦截，
 * 任何宿主的产物中都不会出现它；
 * 三、渲染与落位解耦——只产出内存中的文本与结构，一律不写盘，落位由 T5 承担。
 *
 * 形态边界：本层实现「技能形态」（SKILL.md）与「指令文件降级形态」（AGENTS.md 片段）；
 * 规则路径形态（如 .mdc）属适配器层的逐宿主格式，由 T4 实现。
 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { stringifyYaml } from '../../store/yaml/index.ts';
import { hostById, resolveDeclaredExtensions } from '../hosts/index.ts';
import type { FieldMode } from '../hosts/types.ts';
import { STANDARD_FIELD_ORDER, mapStandardFields } from './fields.ts';
import type { ArtifactFile, RenderOutcome, RenderPolicyInput, RenderSource } from './types.ts';

const SOURCE = 'render';

/** 降级形态缺少的能力：固定三项，随降级产物一并声明（设计 5.4 节） */
export const DEGRADED_CAPABILITY_GAPS = [
  'auto_discovery',
  'progressive_loading',
  'tool_preapproval',
] as const;

/** 渲染形态：技能形态与指令文件降级形态 */
export type RenderForm = 'skill' | 'entry';

/** 规整正文：统一为 LF，去掉首尾多余空行，末尾保留单个换行 */
function normalizeBody(body: string | undefined): string {
  const text = (body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return text === '' ? '' : `${text}\n`;
}

/**
 * 技能形态产物：YAML 元数据块 + 指令正文。
 * 元数据块的序列化复用存储层的 YAML 原语（保持字段顺序、不使用锚点与别名）。
 */
function skillArtifact(fields: Record<string, unknown>, body: string | undefined): ArtifactFile {
  const frontmatter = stringifyYaml(fields);
  return {
    kind: 'skill_md',
    path: 'SKILL.md',
    content: `---\n${frontmatter}---\n\n${normalizeBody(body)}`,
  };
}

/**
 * 指令文件降级产物：条目化片段（无字段映射），供合并进 AGENTS.md。
 * 只产出片段、不落盘——合并策略未定稿前不得写入宿主既有文件（设计 5.4 节）。
 */
function entryArtifact(source: RenderSource, description: string | undefined): ArtifactFile {
  const lines = [`### ${source.id}`, ''];
  lines.push(description === undefined ? '（内部未提供描述）' : description, '');
  const body = normalizeBody(source.body);
  if (body !== '') lines.push(body);
  return {
    kind: 'agents_md_fragment',
    path: 'AGENTS.md',
    content: lines.join('\n'),
  };
}

/**
 * 共用渲染核心：按显式策略渲染。
 *
 * 测试与适配器层都走这一条路径；宿主差异只体现在 policy 上，
 * 因此「通用 Agent Skills 目标」与「逐宿主适配器」不存在两套实现。
 */
export function renderWithPolicy(
  form: RenderForm,
  policy: RenderPolicyInput,
  source: RenderSource,
): RenderOutcome {
  const findings: Finding[] = [];
  const mapped = mapStandardFields(source, policy);
  const fields = mapped.fields;
  findings.push(...mapped.findings);

  // 扩展字段：只按声明渲染，命中白名单才透传（DP-04）
  const declared = Object.keys(source.extensions ?? {}).sort();
  const extensions: string[] = [];
  const dropped: string[] = [];
  if (declared.length > 0) {
    const resolution = resolveDeclaredExtensions(policy, declared);
    for (const item of resolution.findings) {
      findings.push({ ...item, target: `${source.id}:${item.target}` });
      dropped.push(item.target);
    }
    for (const key of resolution.transmitted) {
      const value = (source.extensions ?? {})[key];
      if (typeof value !== 'string' || value.trim() === '') {
        findings.push(
          finding(CODES.FIELD_TYPE, {
            source: SOURCE,
            target: `${source.id}:${key}`,
            message: `透传字段的取值必须是非空字符串：${key}`,
            remedy: '透传字段沿用标准的字符串映射约定',
          }),
        );
        dropped.push(key);
        continue;
      }
      fields[key] = value.trim();
      extensions.push(key);
    }
  }

  const degraded = form === 'entry';
  const description = typeof fields['description'] === 'string' ? fields['description'] : undefined;
  const files: ArtifactFile[] =
    form === 'entry' ? [entryArtifact(source, description)] : [skillArtifact(fields, source.body)];

  return {
    host_id: policy.host_id,
    field_mode: degraded ? 'degrade_entry' : (policy.field_mode as FieldMode),
    degraded,
    capability_gaps: degraded ? [...DEGRADED_CAPABILITY_GAPS] : [],
    files,
    ledger: {
      standard: STANDARD_FIELD_ORDER.filter((field) => field in fields),
      extensions: [...extensions].sort(),
      dropped: [...dropped].sort(),
    },
    findings,
  };
}

/** 按宿主注册项取渲染策略 */
function policyOf(hostId: string): RenderPolicyInput {
  const entry = hostById(hostId);
  if (entry === undefined) {
    throw new KernelError({
      code: CODES.ID_INVALID,
      source: SOURCE,
      target: hostId,
      message: `未登记的宿主标识：${hostId}`,
      remedy: '取值必须来自宿主注册表；未登记取值不渲染也不落位',
    });
  }
  const policy = entry.render_policy;
  const result: RenderPolicyInput = {
    host_id: entry.host_id,
    field_mode: policy.field_mode,
  };
  if (policy.allowed_extensions !== undefined) {
    result.allowed_extensions = policy.allowed_extensions;
  }
  if (policy.degrade_form !== undefined) {
    result.degrade_form = policy.degrade_form;
  }
  if (entry.capability.max_description_chars !== undefined) {
    result.max_description_chars = entry.capability.max_description_chars;
  }
  return result;
}

/** 按宿主注册项的策略渲染技能形态产物 */
export function renderSkill(hostId: string, source: RenderSource): RenderOutcome {
  return renderWithPolicy('skill', policyOf(hostId), source);
}

/** 按宿主注册项的策略渲染指令文件降级片段（不落盘） */
export function renderEntry(hostId: string, source: RenderSource): RenderOutcome {
  return renderWithPolicy('entry', policyOf(hostId), source);
}

/**
 * 通用 Agent Skills 标准目标：与逐宿主适配器共用同一渲染核心，
 * 差异只是策略（standard6）。
 */
export function renderStandardSkill(source: RenderSource): RenderOutcome {
  return renderSkill('agentskills', source);
}
