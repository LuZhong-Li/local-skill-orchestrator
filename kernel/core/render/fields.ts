/**
 * K-14 渲染层：内部字段 → 宿主标准字段的映射与规整。
 *
 * 依据：设计文档 5.1 节的字段映射表与 5.2 节的保守渲染优先；
 * Agent Skills 开放标准的字段约束（name 必填且与目录名一致、description 必填 ≤1024、
 * license / compatibility 可选、metadata 为字符串映射、allowed-tools 实验性）。
 *
 * 映射要点：
 *   名称   ← 内部标识（两者都要求小写、短横线，且与目录名一致）
 *   描述   ← 内部描述（标准必填；内部可选，缺失即报错误级问题，不虚构内容）
 *   许可证 ← 内部许可证
 *   兼容性 ← 内部兼容性 + 运行时依赖文本（运行时依赖的可读性更适合作说明文本）
 *   允许工具 ← 内部 SKILL.md 元数据块的允许工具
 *   扩展元数据 ← 版本 / 作者 / 主页 / 标签 / Skill 依赖（标准要求字符串映射，列表转字符串）
 *   触发关键词 → 无标准字段，按降级规则并入描述
 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { MAX_COMPATIBILITY_LENGTH, MAX_DESCRIPTION_LENGTH } from '../metadata/constants.ts';
import type { RenderPolicyInput, RenderSource } from './types.ts';

const SOURCE = 'render';

/** 标准字段的渲染顺序：固定顺序保证同一输入产出稳定文本 */
export const STANDARD_FIELD_ORDER = [
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
  'metadata',
] as const;

/** 渲染结果：字段映射（有序）+ 问题条目 */
export interface FieldMapping {
  fields: Record<string, unknown>;
  findings: Finding[];
}

function push(out: Finding[], code: string, target: string, message: string, remedy: string): void {
  out.push(finding(code, { source: SOURCE, target, message, remedy }));
}

/** 兼容性文本：内部兼容性 + 运行时依赖说明 */
export function compatibilityText(source: RenderSource): string | undefined {
  const parts: string[] = [];
  if (source.compatibility !== undefined && source.compatibility.trim() !== '') {
    parts.push(source.compatibility.trim());
  }
  const runtime = source.runtime_dependencies ?? {};
  const entries = Object.entries(runtime).filter(([name]) => name.trim() !== '');
  if (entries.length > 0) {
    parts.push(
      `依赖运行时：${entries
        .map(([name, constraint]) => `${name} ${constraint}`.trim())
        .sort()
        .join('、')}`,
    );
  }
  return parts.length === 0 ? undefined : parts.join('；');
}

/** 扩展元数据映射：只保留非空字符串值（标准要求字符串映射） */
export function metadataMap(source: RenderSource): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined && value.trim() !== '') map[key] = value.trim();
  };
  put('version', source.version);
  put('author', source.author);
  put('homepage', source.homepage);
  if (source.tags !== undefined && source.tags.length > 0) {
    map['tags'] = [...source.tags].sort().join(',');
  }
  if (source.skill_dependencies !== undefined && source.skill_dependencies.length > 0) {
    map['dependencies'] = [...source.skill_dependencies].sort().join(',');
  }
  return Object.keys(map).length === 0 ? undefined : map;
}

/**
 * 描述文本：内部描述缺失时并入触发关键词作为降级提示，仍无内容则报错误级问题。
 * 触发关键词并入后仍受标准长度上限约束。
 */
export function descriptionText(
  source: RenderSource,
  policy: RenderPolicyInput,
  out: Finding[],
): string | undefined {
  const limit = policy.max_description_chars ?? MAX_DESCRIPTION_LENGTH;
  const base = source.description?.trim() ?? '';
  if (base === '') {
    push(
      out,
      CODES.FIELD_REQUIRED,
      `${source.id}:description`,
      '缺少描述：Agent Skills 标准要求 description 必填',
      '补齐内部描述后重新渲染；渲染层不虚构描述内容',
    );
    return undefined;
  }
  const keywords = (source.trigger_keywords ?? []).filter((item) => item.trim() !== '');
  const text = keywords.length === 0 ? base : `${base}（触发关键词：${keywords.join('、')}）`;
  if (text.length > limit) {
    push(
      out,
      CODES.FIELD_LENGTH,
      `${source.id}:description`,
      `描述长度为 ${String(text.length)}，超过上限 ${String(limit)}`,
      '精简描述或触发关键词；渲染层不做静默截断',
    );
  }
  return text;
}

/** 名称：内部标识须满足标准命名规则（小写、数字与短横线） */
export function nameField(source: RenderSource, out: Finding[]): string {
  const id = source.id;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) {
    push(
      out,
      CODES.ID_INVALID,
      `${id}:name`,
      '内部标识不符合标准命名规则（小写字母、数字与短横线，不超过 64 字符）',
      '修正 Skill 标识；标准要求 name 与所在目录名一致',
    );
  }
  return id;
}

/**
 * 逐字段规整：产出有序的字段映射与全部问题条目。
 * 只处理标准字段；扩展字段由调用方按白名单追加。
 */
export function mapStandardFields(source: RenderSource, policy: RenderPolicyInput): FieldMapping {
  const findings: Finding[] = [];
  const fields: Record<string, unknown> = {};

  fields['name'] = nameField(source, findings);

  const description = descriptionText(source, policy, findings);
  if (description !== undefined) fields['description'] = description;

  if (source.license !== undefined && source.license.trim() !== '') {
    fields['license'] = source.license.trim();
  }

  const compatibility = compatibilityText(source);
  if (compatibility !== undefined) {
    if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
      push(
        findings,
        CODES.FIELD_LENGTH,
        `${source.id}:compatibility`,
        `兼容性文本长度为 ${String(compatibility.length)}，超过上限 ${String(MAX_COMPATIBILITY_LENGTH)}`,
        '缩短兼容性说明或运行时依赖列表',
      );
    }
    fields['compatibility'] = compatibility;
  }

  if (source.allowed_tools !== undefined && source.allowed_tools.trim() !== '') {
    fields['allowed-tools'] = source.allowed_tools.trim();
  }

  const metadata = metadataMap(source);
  if (metadata !== undefined) fields['metadata'] = metadata;

  return { fields, findings };
}
