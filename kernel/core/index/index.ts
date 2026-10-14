/**
 * K-03 索引服务。
 *
 * 负责全局索引的装配与读写：
 *   初始索引的构造（配置区声明默认根目录与默认目标）；
 *   从原始映射载入为带类型的索引，同时保留未识别字段（契约要求不得丢弃）；
 *   写回时按区块顺序输出，保证文本稳定、便于版本控制逐行比对。
 */
import { INDEX_SCHEMA_VERSION } from '../metadata/constants.ts';
import type { IndexConfig, IndexRecord, SkillIndex } from '../metadata/types.ts';
import { readRawIndex, writeRawIndex } from '../../store/registry-store/index.ts';
import type { Finding } from '../../store/contract.ts';
import { validateIndexVersion, validateValidationBlock } from '../metadata/validate.ts';

/** 一期默认的 Skill 根目录，相对于工作区根目录 */
export const DEFAULT_SKILL_ROOT = './skills';

export const TOOL_VERSION = '0.1.0';

export interface LoadedIndex {
  exists: boolean;
  index: SkillIndex | null;
  findings: Finding[];
}

/** 构造初始索引：配置区已声明根目录与默认目标，记录区为空 */
export function createInitialIndex(generatedAt: string, config?: Partial<IndexConfig>): SkillIndex {
  const resolved: IndexConfig = {
    skill_roots: config?.skill_roots ?? [DEFAULT_SKILL_ROOT],
    default_target: config?.default_target ?? 'claude',
    default_mode: config?.default_mode ?? 'copy',
  };
  return {
    schema_version: INDEX_SCHEMA_VERSION,
    tool_version: TOOL_VERSION,
    generated_at: generatedAt,
    config: resolved,
    skills: [],
  };
}

/** 载入索引；文件不存在返回 exists=false，版本不受支持时返回问题而不抛错 */
export function loadIndex(indexFile: string): LoadedIndex {
  const { exists, raw } = readRawIndex(indexFile);
  if (!exists || raw === null) return { exists: false, index: null, findings: [] };

  const findings = validateIndexVersion(raw['schema_version']);
  if (findings.some((item) => item.severity === 'error')) {
    return { exists: true, index: null, findings };
  }

  const records = Array.isArray(raw['skills']) ? (raw['skills'] as unknown[]) : [];
  for (const item of records) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const id = String((item as Record<string, unknown>)['id'] ?? '');
      findings.push(
        ...validateValidationBlock((item as Record<string, unknown>)['validation'], id),
      );
    }
  }

  const index: SkillIndex = {
    ...raw,
    schema_version: String(raw['schema_version']),
    tool_version: String(raw['tool_version'] ?? TOOL_VERSION),
    generated_at: String(raw['generated_at'] ?? ''),
    config: normalizeConfig(raw['config']),
    skills: records.filter(isRecordLike) as unknown as IndexRecord[],
  };
  return { exists: true, index, findings };
}

/** 写回索引：固定区块顺序，未识别字段排在已知区块之后 */
export function saveIndex(indexFile: string, index: SkillIndex): void {
  const { config, skills, ...rest } = index;
  const ordered: Record<string, unknown> = {
    schema_version: index.schema_version,
    tool_version: index.tool_version,
    generated_at: index.generated_at,
    config,
    skills,
  };
  for (const [key, value] of Object.entries(rest)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  writeRawIndex(indexFile, ordered);
}

function normalizeConfig(value: unknown): IndexConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { skill_roots: [DEFAULT_SKILL_ROOT] };
  }
  const config = value as Record<string, unknown>;
  const roots = Array.isArray(config['skill_roots'])
    ? config['skill_roots'].filter((item): item is string => typeof item === 'string')
    : [];
  return {
    ...config,
    skill_roots: roots.length > 0 ? roots : [DEFAULT_SKILL_ROOT],
  };
}

function isRecordLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const id = (value as Record<string, unknown>)['id'];
  return typeof id === 'string' && id !== '';
}
