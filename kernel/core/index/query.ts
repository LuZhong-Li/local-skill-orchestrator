/**
 * K-03 索引服务的查询侧：列表筛选、单个查看、配置读取。
 *
 * 三条路径的共同约束是**只读**：不写索引、不写任何文件、不刷新运行期结论。
 * 列表与配置只读索引即可；单个查看为了给出索引未保留的完整信息，另行读取该 Skill 的元文件。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeChecksum } from '../integrity/index.ts';
import { META_FILE_NAME } from '../metadata/constants.ts';
import { readMetaFile } from '../metadata/read.ts';
import type { IndexConfig, IndexRecord, SkillIndex } from '../metadata/types.ts';
import { validateMetaRecord, type MetaContext } from '../metadata/validate.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { isDirectory } from '../../store/library-fs/index.ts';
import { SKILLS_DIR_NAME, type WorkspaceLayout } from '../../store/workspace/index.ts';

/** 列表过滤条件，取值来自 `list` 的选项 */
export interface ListFilter {
  state?: string;
  source?: string;
  target?: string;
}

export interface ListSummary {
  /** 过滤前的总数 */
  total: number;
  /** 过滤后的数量 */
  filtered: number;
  /** 过滤前的状态计数 */
  by_state: { enabled: number; disabled: number };
  /** 过滤前的校验结论计数 */
  by_validation: { ok: number; invalid: number };
  records: IndexRecord[];
}

export interface ListOutcome {
  findings: Finding[];
  summary: ListSummary | null;
}

const STATE_VALUES = ['enabled', 'disabled'] as const;
const SOURCE_VALUES = ['local', 'git', 'archive', 'unknown'] as const;

/**
 * 列出索引内的记录。索引不存在时按契约返回引导性结果：不是错误，摘要为 null，
 * 由调用方在载荷中给出引导语。
 */
export function listSkills(input: { index: SkillIndex | null; filter: ListFilter }): ListOutcome {
  const { index, filter } = input;
  const findings: Finding[] = [];

  if (filter.state !== undefined && !STATE_VALUES.includes(filter.state as 'enabled')) {
    findings.push(
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--state',
        message: `状态过滤取值非法：${filter.state}`,
        remedy: `仅允许 ${STATE_VALUES.join(' 或 ')}`,
      }),
    );
  }
  if (filter.source !== undefined && !SOURCE_VALUES.includes(filter.source as 'local')) {
    findings.push(
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--source',
        message: `来源过滤取值非法：${filter.source}`,
        remedy: `仅允许 ${SOURCE_VALUES.join('、')}`,
      }),
    );
  }
  if (findings.length > 0) return { findings, summary: null };
  if (index === null) return { findings: [], summary: null };

  const records = index.skills;
  const summary: ListSummary = {
    total: records.length,
    filtered: 0,
    by_state: {
      enabled: records.filter((item) => item.status === 'enabled').length,
      disabled: records.filter((item) => item.status === 'disabled').length,
    },
    by_validation: {
      ok: records.filter((item) => item.validation.status === 'ok').length,
      invalid: records.filter((item) => item.validation.status === 'invalid').length,
    },
    records: [],
  };

  summary.records = records
    .filter((item) => filter.state === undefined || item.status === filter.state)
    .filter((item) => filter.source === undefined || item.source_type === filter.source)
    .filter(
      (item) =>
        filter.target === undefined || item.targets.some((entry) => entry.target === filter.target),
    )
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  summary.filtered = summary.records.length;

  return { findings, summary };
}

/** 列表载荷中的单条记录：只保留契约列明的字段 */
export function toListEntry(record: IndexRecord): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: record.id,
    name: record.name,
    status: record.status,
    source_type: record.source_type,
    targets: record.targets,
    updated_at: record.updated_at,
    validation: record.validation,
  };
  if (record.version !== undefined) entry['version'] = record.version;
  return entry;
}

/** 读取配置区；不做任何推导，也不补默认值 */
export function readConfig(index: SkillIndex): Record<string, unknown> {
  const config: IndexConfig = index.config;
  const payload: Record<string, unknown> = { skill_roots: config.skill_roots };
  // 未定义的项按缺失处理，不补默认值（契约 4.2：原样返回，不做推导）
  if (config.default_target !== undefined) payload['default_target'] = config.default_target;
  if (config.default_mode !== undefined) payload['default_mode'] = config.default_mode;
  payload['config'] = config;
  return payload;
}

export interface InspectOutcome {
  findings: Finding[];
  data: Record<string, unknown>;
}

/**
 * 查看单个 Skill：索引记录给出检索与状态，元文件补全索引未保留的完整信息，
 * 内容指纹按契约重算并给出与记录值的比对结论。
 */
export function inspectSkill(input: {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
}): InspectOutcome {
  const { layout, index, id } = input;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) {
    return {
      findings: [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: id,
          message: `标识 ${id} 不在索引中`,
          remedy: '请先用列表指令确认该 Skill 是否已登记，或执行 scan 重新登记',
        }),
      ],
      data: { id },
    };
  }

  const findings: Finding[] = [];
  const dir = join(layout.skillsDir, id);
  const context: MetaContext = { dirName: id, dirPath: dir };
  const read = readMetaFile(dir, id);
  findings.push(...read.findings);
  if (read.raw !== null) findings.push(...validateMetaRecord(read.raw, context));

  // 内容指纹比对：重算值与记录值比对，给出结论而不是改写记录
  let recomputed: string | null = null;
  if (isDirectory(dir)) {
    try {
      recomputed = computeChecksum(dir);
    } catch {
      recomputed = null;
    }
  }
  const match = recomputed === null ? null : recomputed === record.checksum;
  if (match === false) {
    findings.push(
      finding(CODES.DRIFT, {
        source: 'meta',
        target: id,
        message: `内容漂移：记录指纹 ${record.checksum}，重算指纹 ${String(recomputed)}`,
        remedy: '如为有意修改，请重新扫描以刷新指纹；否则请检查内容是否被意外改动',
      }),
    );
  }

  const raw = read.raw ?? {};
  const data: Record<string, unknown> = {
    record,
    meta_path: `${SKILLS_DIR_NAME}/${id}/${META_FILE_NAME}`,
    meta_exists: existsSync(join(dir, META_FILE_NAME)),
    meta: read.raw,
    source: raw['source'] ?? null,
    dependencies: raw['dependencies'] ?? null,
    targets: Array.isArray(raw['targets']) ? raw['targets'] : [],
    checksum: {
      recorded: record.checksum,
      recomputed,
      match,
    },
    validation: record.validation,
    last_updated_at: record.updated_at,
    index_generated_at: index.generated_at,
  };

  return { findings, data };
}
