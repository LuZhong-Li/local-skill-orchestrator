/**
 * S-09 内置宿主分发账本持久化。
 *
 * 只负责 host_landings.yaml 的原始读写、结构校验与按主键的纯数据操作；
 * 宿主副本的写盘与摘要计算由 core 层完成。账本损坏时返回 E-LANDING-001，
 * 不崩溃、不返回半份解析结果，也不覆盖原文件。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../findings.ts';
import { atomicWriteFile } from '../atomic/index.ts';
import { parseYaml, stringifyYaml } from '../yaml/index.ts';
import type { HostLanding, HostLandingIndex, HostLandingVisibility } from '@skill-manager/contract';

export const HOST_LANDINGS_SCHEMA_VERSION = '1';

const SOURCE = 'host-landings';
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_ID_PATTERN = /^(?!x-)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ADAPTER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const FORBIDDEN_FIELDS = ['root_role', 'root_id', 'host_key', 'plugin_id'] as const;

export interface LoadedHostLandings {
  exists: boolean;
  index: HostLandingIndex | null;
  findings: Finding[];
}

export interface HostLandingWriteView {
  index: HostLandingIndex | null;
  findings: Finding[];
  missing: boolean;
}

export interface HostLandingPatch {
  content_digest?: string;
  source_checksum?: string;
  source_version?: string;
  source_ref?: string;
  visibility?: HostLandingVisibility;
  updated_at: string;
}

/** 新建空账本；toolVersion 由调用方传入，存储层不反向依赖内核层。 */
export function createInitialHostLandings(
  generatedAt: string,
  toolVersion: string,
): HostLandingIndex {
  return {
    schema_version: HOST_LANDINGS_SCHEMA_VERSION,
    tool_version: toolVersion,
    generated_at: generatedAt,
    landings: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(target: string, message: string, remedy: string): Finding {
  return finding(CODES.LANDING_LEDGER_INVALID, {
    source: SOURCE,
    target,
    message,
    remedy,
  });
}

function readText(file: string): { exists: boolean; text: string | null } {
  try {
    return { exists: true, text: readFileSync(file, 'utf8') };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { exists: false, text: null };
    throw cause;
  }
}

/** 读取原始 YAML；文件不存在时返回 exists=false。 */
export function readRawHostLandings(file: string): {
  exists: boolean;
  raw: Record<string, unknown> | null;
} {
  const read = readText(file);
  if (!read.exists || read.text === null) return { exists: false, raw: null };
  return { exists: true, raw: parseYaml(read.text, { source: SOURCE, target: file }) };
}

function validateTop(raw: Record<string, unknown>, file: string): Finding[] {
  const findings: Finding[] = [];
  if (raw['schema_version'] !== HOST_LANDINGS_SCHEMA_VERSION) {
    findings.push(
      error(
        file,
        `宿主账本格式版本不受支持：${String(raw['schema_version'])}`,
        '使用支持该账本版本的工具，或备份后重建 host_landings.yaml',
      ),
    );
  }
  for (const key of ['tool_version', 'generated_at'] as const) {
    if (typeof raw[key] !== 'string' || raw[key] === '') {
      findings.push(error(key, `缺少或非法顶层字段：${key}`, '修复 host_landings.yaml 的顶层字段'));
    }
  }
  if (typeof raw['generated_at'] === 'string' && !TIME_PATTERN.test(raw['generated_at'])) {
    findings.push(
      error('generated_at', 'generated_at 不是 UTC 秒级时间', '改为 YYYY-MM-DDTHH:mm:ssZ'),
    );
  }
  if (!Array.isArray(raw['landings'])) {
    findings.push(
      error('landings', 'landings 必须是数组', '把 landings 改写为数组，或重新生成账本'),
    );
  }
  return findings;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  findings: Finding[],
  pattern?: RegExp,
  maxLength = 4096,
): void {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    findings.push(error(key, `缺少或非法字段：${key}`, '补必填字段并重试'));
    return;
  }
  if (value.length > maxLength) {
    findings.push(error(key, `字段超长：${key}`, `将 ${key} 缩短到 ${String(maxLength)} 字符以内`));
  } else if (pattern !== undefined && !pattern.test(value)) {
    findings.push(error(key, `字段格式不合规：${key}`, `按第七份规范修正 ${key} 的取值`));
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  findings: Finding[],
  maxLength: number,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || value === '' || value.length > maxLength) {
    findings.push(error(key, `可选字段 ${key} 必须是非空字符串且不超长`, `修正或省略 ${key}`));
  }
}

function checkForbidden(record: Record<string, unknown>, findings: Finding[]): void {
  for (const key of FORBIDDEN_FIELDS) {
    if (key in record) {
      findings.push(error(key, `账本不得包含字段：${key}`, '根属性由注册表与配置判定；删除该字段'));
    }
  }
}

function checkVisibility(record: Record<string, unknown>, findings: Finding[]): void {
  if (record['format'] === 'rules' && record['visibility'] !== 'visible') {
    findings.push(
      error('visibility', '规则形态只允许 visible', '把 rules 记录的 visibility 改为 visible'),
    );
  }
}

function checkTimes(record: Record<string, unknown>, findings: Finding[]): void {
  const created = record['created_at'];
  const updated = record['updated_at'];
  if (typeof created === 'string' && !TIME_PATTERN.test(created)) {
    findings.push(error('created_at', 'created_at 不是 UTC 秒级时间', '修正时间格式'));
  }
  if (typeof updated === 'string' && !TIME_PATTERN.test(updated)) {
    findings.push(error('updated_at', 'updated_at 不是 UTC 秒级时间', '修正时间格式'));
  }
  if (typeof created === 'string' && typeof updated === 'string' && updated < created) {
    findings.push(error('updated_at', 'updated_at 早于 created_at', '修正时间先后关系'));
  }
}

function validateRecord(record: Record<string, unknown>, at: string): Finding[] {
  const findings: Finding[] = [];
  requireString(record, 'skill_id', findings, ID_PATTERN, 128);
  requireString(record, 'host_id', findings, HOST_ID_PATTERN, 32);
  requireString(record, 'target_path', findings, undefined, 4096);
  if (typeof record['target_path'] === 'string' && !isAbsolute(record['target_path'])) {
    findings.push(error('target_path', 'target_path 必须是绝对路径', '改为宿主副本的绝对路径'));
  }
  for (const key of ['format', 'visibility', 'state', 'origin'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      findings.push(error(key, `缺少或非法字段：${key}`, `补 ${key} 的枚举值`));
    }
  }
  if (!['skill', 'rules'].includes(String(record['format']))) {
    findings.push(error('format', 'format 只能是 skill / rules', 'entry 没有物理副本，不得入账'));
  }
  if (!['visible', 'disabled'].includes(String(record['visibility']))) {
    findings.push(error('visibility', 'visibility 只能是 visible / disabled', '修正可见性枚举'));
  }
  if (!['active', 'orphaned'].includes(String(record['state']))) {
    findings.push(error('state', 'state 只能是 active / orphaned', '修正状态枚举'));
  }
  if (!['distributed', 'adopted'].includes(String(record['origin']))) {
    findings.push(error('origin', 'origin 只能是 distributed / adopted', '修正来源枚举'));
  }
  requireString(record, 'source_checksum', findings, DIGEST_PATTERN, 71);
  requireString(record, 'content_digest', findings, DIGEST_PATTERN, 71);
  requireString(record, 'adapter_ref', findings, ADAPTER_PATTERN, 128);
  requireString(record, 'registry_version', findings, undefined, 64);
  requireString(record, 'created_at', findings, TIME_PATTERN, 20);
  requireString(record, 'updated_at', findings, TIME_PATTERN, 20);
  optionalString(record, 'source_version', findings, 128);
  optionalString(record, 'source_ref', findings, 256);
  checkForbidden(record, findings);
  checkVisibility(record, findings);
  checkTimes(record, findings);
  return findings.map((item) => ({ ...item, target: `${at}.${item.target}` }));
}

function keyOf(record: Pick<HostLanding, 'skill_id' | 'host_id' | 'target_path'>): string {
  return [record.skill_id, record.host_id, record.target_path].join('\u0000');
}

export function landingKey(
  record: Pick<HostLanding, 'skill_id' | 'host_id' | 'target_path'>,
): string {
  return keyOf(record);
}

function validateCollection(records: HostLanding[]): Finding[] {
  const findings: Finding[] = [];
  const keys = new Set<string>();
  const paths = new Map<string, HostLanding[]>();
  for (const record of records) {
    const key = keyOf(record);
    if (keys.has(key)) {
      findings.push(
        error(key, '账本主键重复：skill_id + host_id + target_path', '删除重复记录后重试'),
      );
    }
    keys.add(key);
    const list = paths.get(record.target_path) ?? [];
    list.push(record);
    paths.set(record.target_path, list);
  }
  for (const [path, list] of paths) {
    if (new Set(list.map((item) => item.skill_id)).size > 1) {
      findings.push(
        error(
          path,
          '同一 target_path 对应多个 skill_id',
          '修正账本，确保一个物理目标只归属一个 Skill',
        ),
      );
    }
    const active = list.filter((item) => item.state === 'active');
    if (new Set(active.map((item) => item.content_digest)).size > 1) {
      findings.push(
        error(
          path,
          '同一 target_path 的活跃记录 content_digest 不一致',
          '同步共享根记录或重新分发',
        ),
      );
    }
    if (new Set(active.map((item) => item.visibility)).size > 1) {
      findings.push(error(path, '同一 target_path 的活跃记录 visibility 不一致', '同步共享根记录'));
    }
  }
  return findings;
}

/** 载入账本；文件不存在按空账本处理，损坏返回 E-LANDING-001。 */
export function loadHostLandings(file: string): LoadedHostLandings {
  let rawResult: { exists: boolean; raw: Record<string, unknown> | null };
  try {
    rawResult = readRawHostLandings(file);
  } catch (cause) {
    return {
      exists: true,
      index: null,
      findings: [
        error(
          file,
          `读取宿主账本失败：${cause instanceof Error ? cause.message : String(cause)}`,
          '检查 host_landings.yaml 是否可读；必要时备份后重建账本',
        ),
      ],
    };
  }
  if (!rawResult.exists || rawResult.raw === null) {
    return { exists: false, index: null, findings: [] };
  }
  const findings = validateTop(rawResult.raw, file);
  const records: HostLanding[] = [];
  if (Array.isArray(rawResult.raw['landings'])) {
    rawResult.raw['landings'].forEach((item, index) => {
      if (!isRecord(item)) {
        findings.push(
          error(`landings[${String(index)}]`, '落位记录必须是对象', '删除非法条目或重建账本'),
        );
        return;
      }
      findings.push(...validateRecord(item, `landings[${String(index)}]`));
      records.push({ ...item } as unknown as HostLanding);
    });
  }
  findings.push(...validateCollection(records));
  if (findings.some((item) => item.severity === 'error')) {
    return { exists: true, index: null, findings };
  }
  return {
    exists: true,
    index: {
      ...rawResult.raw,
      schema_version: HOST_LANDINGS_SCHEMA_VERSION,
      tool_version: String(rawResult.raw['tool_version']),
      generated_at: String(rawResult.raw['generated_at']),
      landings: records,
    },
    findings,
  };
}

/** 写入前读取：缺失时给空账本；损坏时 index=null，调用方必须中止写盘。 */
export function loadHostLandingsForWrite(
  file: string,
  now: string,
  toolVersion: string,
): HostLandingWriteView {
  if (!existsSync(file)) {
    return { index: createInitialHostLandings(now, toolVersion), findings: [], missing: true };
  }
  const loaded = loadHostLandings(file);
  return { index: loaded.index, findings: loaded.findings, missing: false };
}

/** 原子写回账本；固定顶层顺序，未知字段原样保留。 */
export function saveHostLandings(file: string, index: HostLandingIndex): void {
  const { landings, ...rest } = index;
  const ordered: Record<string, unknown> = {
    schema_version: index.schema_version,
    tool_version: index.tool_version,
    generated_at: index.generated_at,
    landings,
  };
  for (const [key, value] of Object.entries(rest)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  atomicWriteFile(file, stringifyYaml(ordered));
}

export function findHostLanding(
  index: HostLandingIndex,
  key: Pick<HostLanding, 'skill_id' | 'host_id' | 'target_path'>,
): HostLanding | undefined {
  const wanted = keyOf(key);
  return index.landings.find((item) => keyOf(item) === wanted);
}

/** 按主键 upsert；保留首次入账时间。 */
export function upsertHostLanding(index: HostLandingIndex, landing: HostLanding): HostLandingIndex {
  const existing = findHostLanding(index, landing);
  const value: HostLanding = {
    ...landing,
    created_at: existing?.created_at ?? landing.created_at,
  };
  const landings = index.landings.filter((item) => keyOf(item) !== keyOf(landing));
  landings.push(value);
  return { ...index, landings };
}

/** 同步同一物理路径的全部活跃记录；共享根不得只改一条。 */
export function syncActiveHostLandings(
  index: HostLandingIndex,
  targetPath: string,
  patch: HostLandingPatch,
): HostLandingIndex {
  return {
    ...index,
    landings: index.landings.map((item) =>
      item.state === 'active' && item.target_path === targetPath ? { ...item, ...patch } : item,
    ),
  };
}

export function removeHostLanding(
  index: HostLandingIndex,
  key: Pick<HostLanding, 'skill_id' | 'host_id' | 'target_path'>,
): HostLandingIndex {
  const wanted = keyOf(key);
  return { ...index, landings: index.landings.filter((item) => keyOf(item) !== wanted) };
}
