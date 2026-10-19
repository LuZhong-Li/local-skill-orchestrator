/** K-04 卸载命令。 */
import { backupBeforeUninstall } from '../backup/index.ts';
import type { SkillIndex } from '../metadata/types.ts';
import {
  libraryPathOf,
  resolveTargetById,
  type ResolvedTarget,
} from '../targets/resolver/index.ts';
import {
  countTreeFiles,
  isCopyDisabled,
  listTreeFiles,
  pathExists,
  removeTree,
} from '../../store/library-fs/index.ts';
import { toPortablePath } from '../../store/paths/index.ts';
import { CODES, finding, type Change, type Finding } from '../../store/contract.ts';
import { toKernelError } from '../../store/errors.ts';
import type { LifecycleOutcome, UninstallInput } from './types.ts';
import { toFinding } from './shared.ts';
export function uninstallSkill(input: UninstallInput): LifecycleOutcome {
  const { layout, index, id, now, hard, dryRun } = input;
  const workspaceRoot = layout.root;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) {
    return {
      index,
      findings: [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: id,
          message: `标识 ${id} 不在索引中`,
          remedy: '请先用列表指令确认该 Skill 是否已登记',
        }),
      ],
      changes: [],
      data: { rejected: 'not_registered', id },
    };
  }

  const findings: Finding[] = [];
  const changes: Change[] = [];
  const removed: string[] = [];
  let removedFiles = 0;

  // 一、按目标落位根约定定位副本：只依赖索引中的目标摘要与 Skill 标识，
  //     因此中心库原件缺失时仍能回收副本（N-09 的解决点）
  const libraryDir = libraryPathOf(workspaceRoot, id);
  let copies: ResolvedTarget[];
  try {
    copies = record.targets.map((item) =>
      resolveTargetById(workspaceRoot, item.target, id, item.scope, item.enabled),
    );
  } catch (error) {
    return {
      index,
      findings: [toFinding(toKernelError(error, CODES.PATH_INVALID))],
      changes: [],
      data: {},
    };
  }

  // 二、预演：列出将被删除与将被保留的路径，不执行任何删除
  if (dryRun === true) {
    const detail = copies
      .filter((item) => pathExists(item.absolutePath))
      .map((item) => {
        const files = listTreeFiles(item.absolutePath);
        return {
          path: item.declaredPath,
          file_count: files.length,
          // N-06：影响范围落到逐文件粒度
          files: files.map((rel) => `${item.declaredPath}/${rel}`),
        };
      });
    const wouldRemove = detail.map((item) => item.path);
    const planned: Change[] = wouldRemove.map((path): Change => ({
      action: 'remove',
      kind: 'target_copy',
      path,
    }));
    let libraryFiles = 0;
    if (hard === true) {
      libraryFiles = countTreeFiles(libraryDir);
      planned.push({ action: 'remove', kind: 'library', path: libraryDir });
    }
    return {
      index,
      findings,
      changes: planned,
      preview: true,
      data: {
        preview: true,
        id,
        would_remove: wouldRemove,
        // 契约 2.4：强制二次确认须逐条列出影响范围与文件数量
        would_remove_detail: detail,
        would_remove_file_count:
          detail.reduce((sum, item) => sum + item.file_count, 0) + libraryFiles,
        library_kept: hard !== true,
        library_path: toPortablePath(layout.root, libraryDir),
        system_disabled: isCopyDisabled(libraryDir),
        backup_planned: true,
      },
    };
  }

  // 三、卸载前的备份：没有备份就不允许删除任何内容
  const backup = backupBeforeUninstall({ layout, id, now });
  if (!backup.created && backup.findings.length > 0) {
    return {
      index,
      findings: [...findings, ...backup.findings],
      changes: [],
      data: { rejected: 'backup_failed', ...backup.data },
    };
  }

  // 四、清理副本：失败则中止，索引与原件都不动
  const removedFilePaths: string[] = [];
  for (const item of copies) {
    const copyPath = item.absolutePath;
    if (!pathExists(copyPath)) continue;
    try {
      // 逐文件路径必须在删除前统计（N-06）
      const files = listTreeFiles(copyPath).map((rel) => `${item.declaredPath}/${rel}`);
      removeTree(copyPath);
      removedFilePaths.push(...files);
      removedFiles += files.length;
      // 载荷里的位置统一用相对工作区的可移植路径，便于跨机器阅读
      removed.push(item.declaredPath);
      changes.push({ action: 'remove', kind: 'target_copy', path: copyPath });
    } catch (error) {
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      return {
        index,
        findings: [...findings, toFinding(kernelError)],
        changes: [],
        data: { rejected: 'copy_cleanup_failed', rolled_back: false },
      };
    }
  }

  // 五、索引移除：先写索引，再按选项处理中心库原件
  const next: SkillIndex = {
    ...index,
    generated_at: now,
    skills: index.skills.filter((item) => item.id !== id),
  };

  // 六、按选项处理中心库原件
  if (hard === true) {
    try {
      removeTree(libraryDir);
      changes.push({ action: 'remove', kind: 'library', path: libraryDir });
    } catch (error) {
      // 原件删除失败时，索引已决定移除记录、副本已删；残留原件无害（不再被索引引用）
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      findings.push(
        finding(kernelError.code, {
          source: 'lifecycle',
          target: libraryDir,
          message: `中心库原件未能删除：${kernelError.message}`,
          remedy: '记录已从索引移除，残留的目录可手工清理；它不再被索引引用',
        }),
      );
    }
  }

  return {
    index: next,
    findings,
    changes,
    data: {
      id,
      removed_copies: removed,
      // N-06：影响范围落到逐文件粒度
      removed_files: removedFilePaths,
      removed_file_count: removedFiles,
      library_kept: hard !== true,
      library_path: toPortablePath(layout.root, libraryDir),
      system_disabled: isCopyDisabled(libraryDir),
      ...backup.data,
    },
  };
}

/** 把元文件与目标解析结果组装为索引记录 */
