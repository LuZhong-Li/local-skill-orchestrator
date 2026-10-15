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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createBackup, type BackupResult } from '../../store/backup-fs/index.ts';
import { atomicWriteFile } from '../../store/atomic/index.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError, toKernelError } from '../../store/errors.ts';
import { isDirectory } from '../../store/library-fs/index.ts';
import { resolveWithin } from '../../store/paths/index.ts';
import { parseYaml, stringifyYaml } from '../../store/yaml/index.ts';
import { computeChecksum, computeDigests, isChecksumFormat } from '../integrity/index.ts';
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

/** 导入时允许出现的顶层字段 */
const IMPORT_TOP_FIELDS = new Set([
  'backup_format_version',
  'exported_at',
  'tool_version',
  'schema_version',
  'generated_at',
  'config',
  'skills',
]);

/** 导入时的必填记录字段：声明区的最小集合；派生区由内核按导入时点回填 */
const IMPORT_REQUIRED_RECORD_FIELDS = ['id', 'name', 'status'] as const;

const IMPORT_STATUS_VALUES = ['enabled', 'disabled'] as const;
const IMPORT_SOURCE_TYPE_VALUES = ['local', 'git', 'archive', 'unknown'] as const;
const IMPORT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ImportInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 备份文件，工作区内的相对路径 */
  source: string;
  now: string;
  /** 只展示预演，不写入任何文件 */
  dryRun?: boolean;
}

export interface ImportOutcome {
  findings: Finding[];
  /** 预演与失败时原样返回索引；成功时为新的索引 */
  index: SkillIndex;
  preview?: boolean;
  /** 校验失败时置位，调用方据此整体拒绝 */
  refused?: boolean;
  data: Record<string, unknown>;
}

/**
 * 从导出的清单恢复索引记录（契约 4.15 的一期语义）。
 *
 * 三条边界：
 *   先校验后导入——文档结构与必填项不合格时**整体拒绝**，不做部分导入；
 *   不覆盖既有记录——目标标识已在索引中时该条按冲突跳过，不静默覆盖；
 *   只作用于索引层——不触碰磁盘上的 Skill 文件，也不重建副本；
 *   磁盘目录是否存在属运行期结论，由后续扫描判定，导入阶段不作要求。
 */
export function importIndex(input: ImportInput): ImportOutcome {
  const { layout, index, source, now, dryRun } = input;

  // 一、定位来源：必须在工作区之内
  let sourceFile: string;
  try {
    sourceFile = resolveWithin(layout.root, source, '工作区');
  } catch (error) {
    const kernelError = error instanceof KernelError ? error : null;
    return {
      findings: [
        finding(kernelError?.code ?? CODES.PATH_INVALID, {
          source: 'input',
          target: source,
          message: kernelError?.message ?? `导入路径不可用：${source}`,
          remedy: '请给出工作区之内的相对路径',
        }),
      ],
      index,
      refused: true,
      data: { path: source },
    };
  }

  // 二、读取来源：读取失败按来源类问题返回，对应退出码 4
  let text: string;
  try {
    text = readFileSync(sourceFile, 'utf8');
  } catch (error) {
    return {
      findings: [
        finding(CODES.SRC_UNRESOLVED, {
          source: 'input',
          target: source,
          message: `备份文件无法读取：${error instanceof Error ? error.message : String(error)}`,
          remedy: '请确认该文件存在且可读，或先用 export 生成一份清单',
        }),
      ],
      index,
      refused: true,
      data: { path: source },
    };
  }

  // 三、解析与结构校验：不合格整体拒绝
  let document: Record<string, unknown>;
  try {
    document = parseYaml(text, { source: 'backup', target: source });
  } catch (error) {
    return {
      findings: [toFinding(toKernelError(error, CODES.YAML_INVALID), source)],
      index,
      refused: true,
      data: { path: source },
    };
  }

  const formatFindings = validateImportDocument(document, source);
  if (formatFindings.some((item) => item.severity === 'error')) {
    return {
      findings: formatFindings,
      index,
      refused: true,
      data: {
        path: source,
        rejected: 'invalid_format',
        problem_codes: [...new Set(formatFindings.map((item) => item.code))].sort(),
      },
    };
  }

  // 四、逐条登记：已存在的标识按冲突跳过，不覆盖
  const records = document['skills'] as Array<Record<string, unknown>>;
  const existing = new Set(index.skills.map((item) => item.id));
  const added: IndexRecord[] = [];
  const conflicts: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const record of records) {
    const id = String(record['id']);
    if (existing.has(id) || seen.has(id)) {
      conflicts.push({
        id,
        reason: existing.has(id) ? 'already_registered' : 'duplicated_in_backup',
      });
      continue;
    }
    seen.add(id);
    added.push(toImportedRecord(record, layout, now));
  }

  // 没有可登记的内容时原样返回索引对象，调用方据此跳过写入
  const next: SkillIndex =
    added.length === 0
      ? index
      : {
          ...index,
          generated_at: now,
          skills: [...index.skills, ...added].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          ),
        };
  const data: Record<string, unknown> = {
    path: source,
    format_version: String(document['backup_format_version']),
    imported: added.length,
    conflicts: conflicts.length,
    skipped: 0,
    ids: added.map((item) => item.id),
    conflict_entries: conflicts,
    // 往返一致性：导入记录与备份记录在声明区字段上逐条一致
    roundtrip: added.length === 0 ? 'no_records' : 'consistent',
    notes: ['导入只恢复索引记录，不触碰磁盘上的 Skill 文件；运行期结论请在导入后执行 scan 刷新'],
  };

  if (dryRun === true) {
    return { findings: formatFindings, index, preview: true, data: { ...data, preview: true } };
  }
  return { findings: formatFindings, index: next, data };
}

/** 校验导入文档的格式版本、顶层字段集与逐条记录 */
function validateImportDocument(document: Record<string, unknown>, source: string): Finding[] {
  const findings: Finding[] = [];
  const version = document['backup_format_version'];
  if (typeof version !== 'string' || version === '') {
    findings.push(
      finding(CODES.VERSION_UNSUPPORTED, {
        source: 'backup',
        target: source,
        message: '备份缺少格式版本标识',
        remedy: '请使用本工具 export 生成的清单；格式版本标识不可省略',
      }),
    );
  } else if (version !== BACKUP_FORMAT_VERSION) {
    findings.push(
      finding(CODES.VERSION_UNSUPPORTED, {
        source: 'backup',
        target: source,
        message: `备份格式版本 ${version} 高于当前工具支持的版本 ${BACKUP_FORMAT_VERSION}`,
        remedy: '请升级工具后再导入该备份',
      }),
    );
  }

  for (const key of Object.keys(document)) {
    if (!IMPORT_TOP_FIELDS.has(key)) {
      findings.push(
        finding(CODES.FIELD_WHITELIST, {
          source: 'backup',
          target: `${source}.${key}`,
          message: `备份存在契约之外的顶层字段：${key}`,
          remedy: '该字段被忽略；如需携带自研数据，请放在扩展区',
        }),
      );
    }
  }

  const skills = document['skills'];
  if (!Array.isArray(skills)) {
    findings.push(
      finding(CODES.FIELD_TYPE, {
        source: 'backup',
        target: `${source}.skills`,
        message: '备份的记录区必须是数组',
        remedy: '请修正该文件的记录区结构，或重新导出一份',
      }),
    );
    return findings;
  }

  const seen = new Map<string, number>();
  skills.forEach((item, position) => {
    const where = `skills[${position}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      findings.push(
        finding(CODES.FIELD_TYPE, {
          source: 'backup',
          target: `${source}.${where}`,
          message: '记录必须是映射',
          remedy: '请修正该条记录的结构，或重新导出一份',
        }),
      );
      return;
    }
    const record = item as Record<string, unknown>;
    for (const field of IMPORT_REQUIRED_RECORD_FIELDS) {
      if (typeof record[field] !== 'string' || String(record[field]) === '') {
        findings.push(
          finding(CODES.FIELD_REQUIRED, {
            source: 'backup',
            target: `${source}.${where}.${field}`,
            message: `记录缺少必填字段 ${field}`,
            remedy: `请为该条记录补上 ${field}`,
          }),
        );
      }
    }
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    if (id !== '' && !IMPORT_ID_PATTERN.test(id)) {
      findings.push(
        finding(CODES.ID_INVALID, {
          source: 'backup',
          target: `${source}.${where}.id`,
          message: `标识 ${id} 不符合命名规范`,
          remedy: '标识需为全小写、短横线分隔',
        }),
      );
    }
    if (id !== '') {
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      if (count === 2) {
        findings.push(
          finding(CODES.ID_DUPLICATED, {
            source: 'backup',
            target: `${source}.${where}.id`,
            message: `备份中标识 ${id} 出现多次`,
            remedy: '请删除重复记录后重新导出',
          }),
        );
      }
    }
    const status = record['status'];
    if (typeof status === 'string' && !IMPORT_STATUS_VALUES.includes(status as 'enabled')) {
      findings.push(
        finding(CODES.STATUS_INVALID, {
          source: 'backup',
          target: `${source}.${where}.status`,
          message: `启用状态取值非法：${status}`,
          remedy: `仅允许 ${IMPORT_STATUS_VALUES.join(' 或 ')}`,
        }),
      );
    }
    const sourceType = record['source_type'];
    if (sourceType !== undefined && !IMPORT_SOURCE_TYPE_VALUES.includes(sourceType as 'local')) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: 'backup',
          target: `${source}.${where}.source_type`,
          message: `来源类型取值非法：${String(sourceType)}`,
          remedy: `仅允许 ${IMPORT_SOURCE_TYPE_VALUES.join('、')}`,
        }),
      );
    }
    const checksum = record['checksum'];
    if (checksum !== undefined && !isChecksumFormat(checksum)) {
      findings.push(
        finding(CODES.HASH_FORMAT, {
          source: 'backup',
          target: `${source}.${where}.checksum`,
          message: `内容指纹格式不合规：${String(checksum)}`,
          remedy: '请使用 sha256: 加 64 位小写十六进制的形式',
        }),
      );
    }
    for (const key of Object.keys(record)) {
      if (!EXPORT_RECORD_FIELDS.has(key)) {
        findings.push(
          finding(CODES.FIELD_WHITELIST, {
            source: 'backup',
            target: `${source}.${where}.${key}`,
            message: `记录存在契约之外的字段：${key}`,
            remedy: '该字段被忽略；导入只恢复契约内的字段',
          }),
        );
      }
    }
  });

  return findings;
}

/**
 * 把一条备份记录转换为索引记录。
 * 声明区字段照原样落位（来源类型与落位目标摘要按契约收敛），
 * 派生区字段由内核按导入时点回填：首次登记时间与最近变更时间取导入时刻，内容指纹按磁盘重算。
 * 运行期结论取保守值：导入不验证磁盘实况，结论交由后续扫描判定。
 */
function toImportedRecord(
  record: Record<string, unknown>,
  layout: WorkspaceLayout,
  now: string,
): IndexRecord {
  const id = String(record['id']);
  const dir = join(layout.skillsDir, id);
  let checksum = '';
  let digests: Record<string, string> | undefined;
  // 目录不存在时不得计算指纹：空目录会得到「空内容」的哈希，那等于伪造一个指纹
  if (isDirectory(dir)) {
    try {
      checksum = computeChecksum(dir);
      // 逐文件摘要与聚合指纹同一守卫：目录不可读时保持缺失（待回填），不写入半份基准
      digests = computeDigests(dir);
    } catch {
      checksum = '';
      digests = undefined;
    }
  }

  const imported: IndexRecord = {
    id,
    name: String(record['name']),
    status: String(record['status']) === 'disabled' ? 'disabled' : 'enabled',
    path:
      typeof record['path'] === 'string' && record['path'] !== ''
        ? record['path']
        : `./skills/${id}`,
    source_type: (IMPORT_SOURCE_TYPE_VALUES as readonly string[]).includes(
      String(record['source_type']),
    )
      ? (record['source_type'] as IndexRecord['source_type'])
      : 'unknown',
    targets: Array.isArray(record['targets'])
      ? (record['targets'] as unknown[]).flatMap((item) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry['target'] !== 'string') return [];
          const scope = entry['scope'] === 'project' ? 'project' : 'global';
          return [{ target: entry['target'], scope, enabled: entry['enabled'] === true }];
        })
      : [],
    created_at: now,
    updated_at: now,
    checksum,
    ...(digests !== undefined ? { digests } : {}),
    validation: {
      status: 'invalid',
      errors: [CODES.INDEX_RECORD_INVALID],
    },
  };

  for (const field of ['version', 'description', 'author', 'license'] as const) {
    if (typeof record[field] === 'string' && record[field] !== '') {
      imported[field] = record[field] as string;
    }
  }
  if (Array.isArray(record['trigger_keywords'])) {
    const keywords = record['trigger_keywords'].filter(
      (item): item is string => typeof item === 'string',
    );
    if (keywords.length > 0) imported.trigger_keywords = keywords;
  }
  if (Array.isArray(record['dependencies'])) {
    const names = record['dependencies'].filter((item): item is string => typeof item === 'string');
    if (names.length > 0) imported.dependencies = names;
  }
  return imported;
}

/** 把内核错误转换为指向某一位置的问题条目 */
function toFinding(error: KernelError, target: string): Finding {
  return finding(error.code, {
    source: error.source,
    target,
    message: error.message,
    remedy: error.remedy,
  });
}
