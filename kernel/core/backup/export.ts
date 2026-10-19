/** 导出索引清单。 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../../store/atomic/index.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { KernelError, toKernelError } from '../../store/errors.ts';
import { resolveWithin } from '../../store/paths/index.ts';
import { stringifyYaml } from '../../store/yaml/index.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { TOOL_VERSION } from '../index/index.ts';
import type { IndexRecord, SkillIndex } from '../metadata/types.ts';

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
export const EXPORT_RECORD_FIELDS = new Set([
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

/**
 * 内核内部派生数据：不属于导出物，**不计入被剥离项清单**。
 *
 * 逐文件摘要 `digests` 是纯内部数据（用于把内容漂移定位到具体文件），既不是敏感信息，
 * 也不是用户自研字段：把它列入「被剥离项清单」会让清单被每条记录刷屏，反而掩盖真正的剥离项。
 * 导出物的记录字段集因此固定为上面 16 个字段，与契约 4.14 的输出载荷一致。
 */
const EXPORT_INTERNAL_RECORD_FIELDS = new Set(['digests']);

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
    if (EXPORT_INTERNAL_RECORD_FIELDS.has(key)) continue;
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
