/**
 * K-10 目标适配：目标位置解析。
 *
 * 一期只做最小解析：读取元文件中声明的落位目标，把其中的相对落位路径解析为
 * 工作区内的绝对路径，并保持声明顺序。
 *
 * 需要说明的边界：契约规定落位路径必须是相对路径、禁止绝对路径，但**未规定它相对哪个根**。
 * 由于路径防护要求所有路径落在工作区之内，一期把落位路径解析为「相对工作区根目录」，
 * 即受控副本创建在工作区内。真实宿主目录位于工作区之外，其部署方式待落位根的定义明确后再实现。
 */
import { join } from 'node:path';
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
    absolutePath: resolveWithin(workspaceRoot, entry.path, '工作区'),
    declaredPath: entry.path,
    fileMap: entry.file_map ?? {},
  }));
}

/** 中心库中原件的存放路径 */
export function libraryPathOf(workspaceRoot: string, id: string): string {
  return join(workspaceRoot, 'skills', id);
}
