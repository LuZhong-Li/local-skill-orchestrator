/** 导入索引清单。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError, toKernelError } from '../../store/errors.ts';
import { isDirectory } from '../../store/library-fs/index.ts';
import { resolveWithin } from '../../store/paths/index.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { computeChecksum, computeDigests, isChecksumFormat } from '../integrity/index.ts';
import type { IndexRecord, SkillIndex } from '../metadata/types.ts';
import { BACKUP_FORMAT_VERSION, EXPORT_RECORD_FIELDS } from './export.ts';

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
