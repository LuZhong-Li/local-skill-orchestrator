/**
 * K-07 冲突检测服务。
 *
 * 三类冲突：
 *   命名冲突：同一标识已存在于索引（由生命周期编排在更早一步拦截并给出专用问题码）；
 *   落位映射冲突：逐文件映射表本身不自洽——同一目标被多个条目占用、或目标越出副本目录；
 *   目标占用冲突：副本目录已被既有的非本工具内容占用。
 *
 * 本模块只报告，不处置。
 */
import { isAbsolute } from 'node:path';
import { isDirectory, pathExists } from '../../store/library-fs/index.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { ResolvedTarget } from '../targets/resolver/index.ts';

/**
 * 检测逐文件映射表是否自洽。
 * 目标落位根约定已经消除了「不同目标解析到同一路径」的可能，因此这里的映射冲突
 * 只可能来自映射表内部：多个条目写入同一目标，或目标路径越出副本目录。
 */
export function detectMappingConflicts(id: string, targets: ResolvedTarget[]): Finding[] {
  const findings: Finding[] = [];
  for (const target of targets) {
    const seen = new Map<string, string>();
    for (const [source, destination] of Object.entries(target.fileMap)) {
      const normalized = String(destination).replace(/\\/g, '/');
      if (normalized === '' || isAbsolute(normalized) || normalized.split('/').includes('..')) {
        findings.push(
          finding(CODES.PATH_INVALID, {
            source: 'conflict',
            target: `${id}.targets.${target.target}.file_map`,
            message: `落位映射的目标路径非法：${source} → ${String(destination)}`,
            remedy: '目标应为副本目录之下的相对路径，禁止绝对路径与上级目录跳转',
          }),
        );
        continue;
      }
      const previous = seen.get(normalized);
      if (previous !== undefined) {
        findings.push(
          finding(CODES.CONFLICT_MAPPING, {
            source: 'conflict',
            target: `${id}.targets.${target.target}.file_map`,
            message: `落位映射冲突：${previous} 与 ${source} 都写入 ${normalized}`,
            remedy: '请让每个目标路径只对应一个源文件',
          }),
        );
        continue;
      }
      seen.set(normalized, source);
    }
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
