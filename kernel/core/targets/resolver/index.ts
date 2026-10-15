/**
 * K-10 目标适配：目标位置解析。
 *
 * 副本位置由目标落位根约定推导（工作区根 + 目标标识 + Skill 标识），**不读取元文件中声明的路径**：
 * 这样即使中心库原件缺失，卸载与启用禁用仍能定位并回收副本。
 * 元文件声明的路径只用于一致性校验与对外呈现，解析结果与它不一致时由元数据校验负责报告。
 */
import { join } from 'node:path';
import { copyPathOf, targetRootOf } from '../../metadata/targets.ts';
import type { SkillMeta, SkillTarget } from '../../metadata/types.ts';
import { resolveWithin } from '../../../store/paths/index.ts';

export interface ResolvedTarget {
  target: string;
  scope: SkillTarget['scope'];
  enabled: boolean;
  /** 副本的目标绝对路径 */
  absolutePath: string;
  /** 元文件中声明的相对路径，原样保留 */
  declaredPath: string;
  fileMap: Record<string, string>;
}

/** 把元文件声明的落位目标解析为工作区内的绝对路径 */
export function resolveTargets(workspaceRoot: string, meta: SkillMeta): ResolvedTarget[] {
  return meta.targets.map((entry) => ({
    target: entry.target,
    scope: entry.scope,
    enabled: entry.enabled === true,
    // 以约定为准，而不是以元文件声明的路径为准
    absolutePath: resolveWithin(workspaceRoot, copyPathOf(entry.target, meta.id), '工作区'),
    declaredPath: entry.path,
    fileMap: entry.file_map ?? {},
  }));
}

/** 按约定解析某个目标下的副本位置；不依赖元文件，供原件缺失时的回收路径使用 */
export function resolveTargetById(
  workspaceRoot: string,
  target: string,
  id: string,
  scope: SkillTarget['scope'] = 'global',
  enabled = true,
): ResolvedTarget {
  return {
    target,
    scope,
    enabled,
    absolutePath: resolveWithin(workspaceRoot, copyPathOf(target, id), '工作区'),
    declaredPath: copyPathOf(target, id),
    fileMap: {},
  };
}

export { targetRootOf, copyPathOf };

/** 中心库中原件的存放路径 */
export function libraryPathOf(workspaceRoot: string, id: string): string {
  return join(workspaceRoot, 'skills', id);
}
