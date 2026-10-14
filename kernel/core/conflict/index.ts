/**
 * K-07 冲突检测服务。
 *
 * 本批次实现安装与卸载路径上必需的三类冲突中的两类：
 *   命名冲突：同一标识已存在于索引（由生命周期编排在更早一步拦截并给出专用问题码）；
 *   落位映射冲突：同一 Skill 的多个目标解析到同一路径；
 *   目标占用冲突：目标路径已被既有的非本工具内容占用。
 *
 * 本模块只报告，不处置。
 */
import { isDirectory, pathExists } from '../../store/library-fs/index.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import type { ResolvedTarget } from '../targets/resolver/index.ts';

/** 检测同一 Skill 内部的落位路径是否重复 */
export function detectMappingConflicts(id: string, targets: ResolvedTarget[]): Finding[] {
  const seen = new Map<string, string>();
  const findings: Finding[] = [];
  for (const target of targets) {
    const key = target.absolutePath.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      findings.push(
        finding(CODES.CONFLICT_MAPPING, {
          source: 'conflict',
          target: id,
          message: `落位映射冲突：目标 ${previous} 与 ${target.target} 解析到同一路径`,
          remedy: '请修改其中一个目标的落位路径后再试',
        }),
      );
      continue;
    }
    seen.set(key, target.target);
  }
  return findings;
}

/** 检测目标路径是否已被既有的非本工具内容占用 */
export function detectOccupationConflicts(id: string, targets: ResolvedTarget[]): Finding[] {
  const findings: Finding[] = [];
  for (const target of targets) {
    if (!pathExists(target.absolutePath)) continue;
    if (!isDirectory(target.absolutePath)) {
      findings.push(
        finding(CODES.CONFLICT_OCCUPIED, {
          source: 'conflict',
          target: id,
          message: `目标占用冲突：${target.declaredPath} 已被同名文件占用`,
          remedy: '请移走该文件，或改用其他落位路径',
        }),
      );
      continue;
    }
    findings.push(
      finding(CODES.CONFLICT_OCCUPIED, {
        source: 'conflict',
        target: id,
        message: `目标占用冲突：${target.declaredPath} 已存在同名目录`,
        remedy: '请确认该目录是否属于本工具管理；如属于，请改用更新或其他目标',
      }),
    );
  }
  return findings;
}
