/**
 * K-01 元数据模型服务：元文件的读取与解析。
 *
 * 抽出来的理由：登记与校验、单个查看与校验都要求「读一个 Skill 目录里的元文件，
 * 失败时产出问题条目而不是抛异常」，本函数是这条路径的唯一定义处。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import { META_FILE_NAME } from './constants.ts';

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
