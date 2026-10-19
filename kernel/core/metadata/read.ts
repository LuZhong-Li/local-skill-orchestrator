/**
 * K-01 元数据模型服务：元文件的读取与解析。
 *
 * 抽出来的理由：登记与校验、单个查看与校验都要求「读一个 Skill 目录里的元文件，
 * 失败时产出问题条目而不是抛异常」，本函数是这条路径的唯一定义处。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { KernelError } from '../../store/errors.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import { META_FILE_NAME } from './constants.ts';
import type { SkillRuntimeDependency } from './types.ts';

export interface MetaRead {
  /** 解析成功时为顶层映射；失败时为 null */
  raw: Record<string, unknown> | null;
  findings: Finding[];
}

/**
 * 取元文件声明的依赖标识列表。
 * 返回 null 表示元文件不可用或未声明依赖，调用方据此退回索引内的依赖摘要。
 */
export function declaredSkillsOf(raw: Record<string, unknown> | null): string[] | null {
  if (raw === null) return null;
  const dependencies = raw['dependencies'];
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return null;
  }
  const declared = (dependencies as Record<string, unknown>)['skills'];
  if (!Array.isArray(declared)) return null;
  return declared
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 读取并解析一个 Skill 目录中的元文件。
 * label 用于问题定位，通常取 Skill 标识。
 */
/**
 * 取元文件声明的运行时依赖列表（名称 + 约束原文）。
 *
 * 返回空数组表示未声明运行时依赖或元文件不可用：运行时条目只影响依赖检查的呈现，
 * 不参与记录结论，因此缺声明与读不到元文件都不构成问题（读取失败的问题由调用方单独呈现）。
 * 声明的顺序即呈现顺序，名称相同的重复键在 YAML 解析阶段已被合并。
 */
export function declaredRuntimeOf(raw: Record<string, unknown> | null): SkillRuntimeDependency[] {
  if (raw === null) return [];
  const dependencies = raw['dependencies'];
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return [];
  }
  const declared = (dependencies as Record<string, unknown>)['runtime'];
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return [];
  return Object.entries(declared as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, constraint]) => ({ name, constraint }));
}
export function readMetaFile(dir: string, label: string): MetaRead {
  const metaFile = join(dir, META_FILE_NAME);
  try {
    const raw = parseYaml(readFileSync(metaFile, 'utf8'), { source: 'meta', target: metaFile });
    return { raw, findings: [] };
  } catch (error) {
    const kernelError = error instanceof KernelError ? error : null;
    return {
      raw: null,
      findings: [
        finding(kernelError?.code ?? CODES.YAML_INVALID, {
          source: 'meta',
          target: `${label}/${META_FILE_NAME}`,
          message:
            kernelError?.message ?? (error instanceof Error ? error.message : '元文件无法解析'),
          remedy: '请检查该元文件的语法与结构',
        }),
      ],
    };
  }
}
