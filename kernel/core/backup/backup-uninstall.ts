/** 卸载前备份。 */
import { createBackup, type BackupResult } from '../../store/backup-fs/index.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { toKernelError } from '../../store/errors.ts';
import { isDirectory } from '../../store/library-fs/index.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { computeChecksum } from '../integrity/index.ts';
import { libraryPathOf } from '../targets/resolver/index.ts';

export interface BackupInput {
  layout: WorkspaceLayout;
  /** Skill 标识 */
  id: string;
  /** 时间戳，协调世界时秒级 */
  now: string;
}

export interface BackupOutcome {
  /** 备份是否完成；未备份时 reason 说明原因 */
  created: boolean;
  /** 未产出备份时的原因码，取值为 no_source 或 skipped */
  reason?: 'no_source';
  findings: Finding[];
  data: {
    backup_path?: string;
    backup_timestamp?: string;
    backup_file_count?: number;
    backup_digest?: string;
    backup_reason?: string;
  };
}

/** 卸载前的备份：备份中心库原件，返回可直接并入结果封装的载荷片段 */
export function backupBeforeUninstall(input: BackupInput): BackupOutcome {
  const { layout, id, now } = input;
  const libraryDir = libraryPathOf(layout.root, id);

  // 中心库原件不存在时没有可备份的内容：继续卸载，但明确记录原因
  if (!isDirectory(libraryDir)) {
    return {
      created: false,
      reason: 'no_source',
      findings: [],
      data: { backup_reason: '中心库原件不存在，没有可备份的内容' },
    };
  }

  let checksum: string;
  try {
    checksum = computeChecksum(libraryDir);
  } catch {
    // 指纹只用于清单回溯，计算失败不阻断备份本身
    checksum = '';
  }

  try {
    const result: BackupResult = createBackup({
      workspaceRoot: layout.root,
      backupsDir: layout.backupsDir,
      id,
      sourceDir: libraryDir,
      now,
      checksum,
    });
    return {
      created: true,
      findings: [],
      data: {
        backup_path: result.portableDir,
        backup_timestamp: result.timestamp,
        backup_file_count: result.fileCount,
        backup_digest: result.digest,
      },
    };
  } catch (error) {
    const kernelError = toKernelError(error, CODES.BACKUP_FAILED);
    return {
      created: false,
      findings: [
        finding(kernelError.code, {
          source: kernelError.source,
          target: id,
          message: `备份失败，卸载已中止：${kernelError.message}`,
          remedy: '请先排除备份目录的问题，然后重试；未生成备份时不会删除任何内容',
        }),
      ],
      data: { backup_reason: '备份失败，卸载未执行' },
    };
  }
}

/** 备份载体的格式版本；导入侧据此判断能否解析 */
