/**
 * K-08 备份与恢复服务。
 *
 * 本批次只实现**备份产出**一侧：在卸载之前把中心库原件完整备份到工作区的备份目录，
 * 供事后人工回溯。恢复一侧（把备份写回环境）不在一期范围，已登记为缺口。
 *
 * 与卸载流程的契约关系（FR-05 关键要求 2、指令契约 4.8 行为 2）：
 *   备份是卸载的前置步骤，**没有备份就不允许删除任何内容**；
 *   备份失败时卸载必须中止，环境保持调用前的状态；
 *   中心库原件本就不存在时没有可备份的内容，此时按「无需备份」继续，
 *   以便用户仍能清理索引中的悬空记录。
 *
 * 备份只读地读取中心库原件，不修改被备份内容，也不改动索引。
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createBackup, type BackupResult } from '../../store/backup-fs/index.ts';
import { atomicWriteFile } from '../../store/atomic/index.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError, toKernelError } from '../../store/errors.ts';
import { isDirectory } from '../../store/library-fs/index.ts';
import { resolveWithin } from '../../store/paths/index.ts';
import { stringifyYaml } from '../../store/yaml/index.ts';
import { computeChecksum } from '../integrity/index.ts';
import { TOOL_VERSION } from '../index/index.ts';
import type { IndexRecord, SkillIndex } from '../metadata/types.ts';
import { libraryPathOf } from '../targets/resolver/index.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';

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
export const BACKUP_FORMAT_VERSION = '1';

/** 导出文档允许出现的顶层字段，其余字段一律剥离并登记 */
const EXPORT_TOP_LEVEL_FIELDS = new Set([
  'schema_version',
  'tool_version',
  'generated_at',
  'config',
  'skills',
]);

/** 导出文档中记录允许出现的字段，其余字段一律剥离并登记 */
const EXPORT_RECORD_FIELDS = new Set([
  'id',
  'name',
  'version',
  'description',
  'author',
  'license',
  'status',
  'path',
  'trigger_keywords',
  'dependencies',
  'source_type',
  'targets',
  'created_at',
  'updated_at',
  'checksum',
  'validation',
]);

export interface ExportInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 目标文件，工作区内的相对路径 */
  target: string;
  now: string;
  /** 不包含配置区；默认包含 */
  noConfig?: boolean;
  /** 显式声明剥离敏感信息；一期无论如何都执行剥离，该选项与默认行为一致 */
  noSecrets?: boolean;
}

export interface ExportOutcome {
  findings: Finding[];
  data: Record<string, unknown>;
}

/**
 * 导出索引状态为一份可迁移的备份。
 *
 * 契约 4.14：收集索引内容、剥离敏感信息并记录清单、写入格式版本与导出时间、
 * 不以绝对路径表达位置。本函数不改动工作区状态，只写目标导出文件。
 */
export function exportIndex(input: ExportInput): ExportOutcome {
  const { layout, index, target, now, noConfig } = input;
  const stripped: string[] = [];

  // 一、解析目标路径：限定在工作区之内
  let targetFile: string;
  try {
    targetFile = resolveWithin(layout.root, target, '工作区');
  } catch (error) {
    const kernelError = error instanceof KernelError ? error : null;
    return {
      findings: [
        finding(kernelError?.code ?? CODES.PATH_INVALID, {
          source: 'input',
          target,
          message: kernelError?.message ?? `导出路径不可用：${target}`,
          remedy: '请给出工作区之内的相对路径',
        }),
      ],
      data: { path: target },
    };
  }
  if (!existsSync(dirname(targetFile))) {
    return {
      findings: [
        finding(CODES.IO_FAILED, {
          source: 'input',
          target,
          message: `导出目标的上级目录不存在：${target}`,
          remedy: '请先创建该目录，或把导出文件放到工作区内已有的目录下',
        }),
      ],
      data: { path: target },
    };
  }

  // 二、组装文档：白名单过滤，未知字段剥离并登记
  const document: Record<string, unknown> = {
    backup_format_version: BACKUP_FORMAT_VERSION,
    exported_at: now,
    tool_version: TOOL_VERSION,
  };
  for (const [key, value] of Object.entries(index)) {
    if (key === 'config') {
      if (noConfig === true) {
        stripped.push('config');
        continue;
      }
      document['config'] = value;
      continue;
    }
    if (!EXPORT_TOP_LEVEL_FIELDS.has(key)) {
      stripped.push(key);
      continue;
    }
    document[key] = value;
  }
  document['skills'] = index.skills.map((record) => stripRecord(record, stripped));

  // 三、原子写入；失败时目标文件保持调用前的状态
  try {
    atomicWriteFile(targetFile, stringifyYaml(document));
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return {
      findings: [
        finding(kernelError.code, {
          source: kernelError.source,
          target,
          message: `导出失败：${kernelError.message}`,
          remedy: '请检查目标目录是否可写，并确认磁盘空间充足',
        }),
      ],
      data: { path: target },
    };
  }

  return {
    findings: [],
    data: {
      path: target,
      entry_count: index.skills.length,
      stripped,
      backup_format_version: BACKUP_FORMAT_VERSION,
      exported_at: now,
      config_included: noConfig !== true,
    },
  };
}

/** 逐字段过滤一条记录；未知字段与绝对路径形式的落位路径一并剥离 */
function stripRecord(record: IndexRecord, stripped: string[]): Record<string, unknown> {
  const source = record as unknown as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!EXPORT_RECORD_FIELDS.has(key)) {
      stripped.push(`${record.id}.${key}`);
      continue;
    }
    if (key === 'path' && typeof value === 'string' && isAbsolutePath(value)) {
      // 契约 4.14 行为 4：备份不以绝对路径表达位置
      stripped.push(`${record.id}.path`);
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(value);
}
