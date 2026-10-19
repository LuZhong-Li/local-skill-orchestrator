/** lifecycle 命令间共享的索引投影、目标解析与结果工具。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { META_FILE_NAME } from '../metadata/constants.ts';
import type { IndexRecord, SkillIndex, SkillMeta } from '../metadata/types.ts';
import { readMetaFile } from '../metadata/read.ts';
import { computeDigests } from '../integrity/index.ts';
import {
  libraryPathOf,
  resolveTargetById,
  type ResolvedTarget,
} from '../targets/resolver/index.ts';
import { parseYaml, stringifyYaml } from '../../store/yaml/index.ts';
import { atomicWriteFile } from '../../store/atomic/index.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError, toKernelError } from '../../store/errors.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { LifecycleOutcome } from './types.ts';

/** 目标标签更新成功后，把中心库受控副本的 source.ref 持久化为新基线。 */

export function toIndexRecord(
  meta: SkillMeta,
  targets: ResolvedTarget[],
  checksum: string,
  digests: Record<string, string> | undefined,
  now: string,
  libraryOnly: boolean,
): IndexRecord {
  const record: IndexRecord = {
    id: meta.id,
    name: meta.name,
    // 契约 4.7 行为 7 与 D-08：登记时的启用状态由安装动作决定，不沿用元文件的声明值
    status: libraryOnly ? 'disabled' : 'enabled',
    path: meta.path,
    source_type: meta.source?.type ?? 'unknown',
    targets: targets.map((item) => ({
      target: item.target,
      scope: item.scope,
      enabled: libraryOnly ? false : item.enabled,
    })),
    created_at: normalizeTimestamp(meta.created_at, now),
    updated_at: now,
    checksum,
    ...(digests !== undefined ? { digests } : {}),
    validation: { status: 'ok', errors: [] },
  };
  if (meta.version !== undefined) record.version = meta.version;
  if (meta.description !== undefined) record.description = meta.description;
  if (meta.author !== undefined) record.author = meta.author;
  if (meta.license !== undefined) record.license = meta.license;
  if (meta.trigger_keywords !== undefined) record.trigger_keywords = meta.trigger_keywords;
  const dependencies = meta.dependencies?.skills;
  if (Array.isArray(dependencies)) {
    record.dependencies = dependencies
      .map((item) => item.trim().split(' ')[0] ?? '')
      .filter((item) => item !== '');
  }
  return record;
}

/** 落位目标的对外摘要；仅落库时全部标记为未生效 */
export function describeTargets(targets: ResolvedTarget[], libraryOnly: boolean): unknown[] {
  return targets.map((item) => ({
    target: item.target,
    scope: item.scope,
    path: item.declaredPath,
    enabled: libraryOnly ? false : item.enabled,
  }));
}

export function normalizeTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** 逐文件摘要：与聚合指纹同源同范围；重算失败时返回 undefined，表示待回填而非伪造取值 */
export function safeDigests(dir: string): Record<string, string> | undefined {
  try {
    return computeDigests(dir);
  } catch {
    return undefined;
  }
}

export function uniqueCodes(findings: Finding[]): string[] {
  return [...new Set(findings.map((item) => item.code))].sort();
}

export function toFinding(error: KernelError): Finding {
  return finding(error.code, {
    source: error.source,
    target: error.target,
    message: error.message,
    remedy: error.remedy,
  });
}

/**
 * 由索引记录推导落位目标（副本位置按约定算出，不依赖中心库原件是否存在），
 * 并尽力读取原件元文件补上逐文件映射；元文件缺失不构成失败，此时按整目录复制处理。
 */
export function targetsOfRecord(input: {
  layout: WorkspaceLayout;
  record: IndexRecord;
  target?: string | undefined;
  scope?: string | undefined;
}): { targets: ResolvedTarget[]; findings: Finding[] } {
  const { layout, record, target, scope } = input;
  const read = readMetaFile(libraryPathOf(layout.root, record.id), record.id);
  const maps = new Map<string, Record<string, string>>();
  if (read.raw !== null) {
    const declared = read.raw['targets'];
    if (Array.isArray(declared)) {
      for (const entry of declared) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const item = entry as Record<string, unknown>;
        const name = item['target'];
        const map = item['file_map'];
        if (typeof name !== 'string') continue;
        if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
          maps.set(name, map as Record<string, string>);
        }
      }
    }
  }

  const findings: Finding[] = [];
  let targets: ResolvedTarget[];
  try {
    targets = record.targets
      .filter(
        (item) =>
          (target === undefined || item.target === target) &&
          (scope === undefined || item.scope === scope),
      )
      .map((item) => ({
        ...resolveTargetById(layout.root, item.target, record.id, item.scope, item.enabled),
        fileMap: maps.get(item.target) ?? {},
      }));
  } catch (error) {
    return { targets: [], findings: [toFinding(toKernelError(error, CODES.PATH_INVALID))] };
  }
  return { targets, findings };
}

/** 把逐文件映射表转换为投递计划；空表表示整目录复制 */
export function planOf(
  fileMap: Record<string, string>,
): Array<{ source: string; destination: string }> {
  return Object.entries(fileMap).map(([source, destination]) => ({
    source,
    destination,
  }));
}

/** 由记录与受影响目标构造下一份索引 */
export function withTargets(
  index: SkillIndex,
  id: string,
  status: 'enabled' | 'disabled',
  affected: ResolvedTarget[],
  now: string,
): SkillIndex {
  const touched = new Set(affected.map((item) => `${item.target}|${item.scope}`));
  return {
    ...index,
    generated_at: now,
    skills: index.skills.map((record) =>
      record.id === id
        ? {
            ...record,
            status,
            targets: record.targets.map((entry) =>
              touched.has(`${entry.target}|${entry.scope}`)
                ? { ...entry, enabled: status === 'enabled' }
                : entry,
            ),
            updated_at: now,
          }
        : record,
    ),
  };
}

/**
 * 启用（契约 4.9）。
 *
 * 次序：前置校验 → 按目标补齐缺失副本 → 副本内元数据文件改回原名 → 索引状态置为已启用。
 * 索引状态是启用状态的唯一事实源；运行期结论不属本指令的写入范围。
 */

export function notRegistered(id: string, index: SkillIndex): LifecycleOutcome {
  return {
    index,
    findings: [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `标识 ${id} 不在索引中`,
        remedy: '请先用列表指令确认该 Skill 是否已登记，或执行 scan 重新登记',
      }),
    ],
    changes: [],
    data: { rejected: 'not_registered', id },
  };
}

export function rebuildRecord(
  meta: SkillMeta,
  targets: ResolvedTarget[],
  checksum: string,
  digests: Record<string, string> | undefined,
  now: string,
): IndexRecord {
  const record: IndexRecord = {
    id: meta.id,
    name: meta.name,
    status: meta.status,
    path: meta.path,
    source_type: meta.source?.type ?? 'unknown',
    targets: targets.map((item) => ({
      target: item.target,
      scope: item.scope,
      enabled: item.enabled,
    })),
    created_at: normalizeTimestamp(meta.created_at, now),
    updated_at: now,
    checksum,
    ...(digests !== undefined ? { digests } : {}),
    // 恢复的内容尚未经过校验，取保守值；结论由后续扫描判定
    validation: { status: 'invalid', errors: [CODES.INDEX_RECORD_INVALID] },
  };
  if (meta.version !== undefined) record.version = meta.version;
  if (meta.description !== undefined) record.description = meta.description;
  if (meta.author !== undefined) record.author = meta.author;
  if (meta.license !== undefined) record.license = meta.license;
  if (meta.trigger_keywords !== undefined) record.trigger_keywords = meta.trigger_keywords;
  const dependencies = meta.dependencies?.skills;
  if (Array.isArray(dependencies)) {
    record.dependencies = dependencies
      .map((item) => item.trim().split(' ')[0] ?? '')
      .filter((item) => item !== '');
  }
  return record;
}

/** 刷新主体：fetched 非空时先用它替换中心库原件，再刷新记录与副本 */

export function persistDeclaredRef(libraryDir: string, ref: string): void {
  const metaFile = join(libraryDir, META_FILE_NAME);
  const raw = parseYaml(readFileSync(metaFile, 'utf8'), { source: 'meta', target: metaFile });
  const source = raw['source'];
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new KernelError({
      code: CODES.FIELD_REQUIRED,
      message: '目标版本元文件缺少 source 声明，无法持久化目标 ref',
      source: 'meta',
      target: 'source',
      remedy: '请修正目标版本的 skill_meta.yaml 后重试',
    });
  }
  (source as Record<string, unknown>)['ref'] = ref;
  atomicWriteFile(metaFile, stringifyYaml(raw));
}

/**
 * 按元文件重新投影一条记录。
 * 声明区字段以元文件为准（索引格式规范 3.2：更新刷新投影字段与派生区字段）；
 * 启用状态与各目标的可见性属于运行期事实，保持记录原值，新声明的目标沿用其声明取值；
 * 首次登记时间不变，运行期结论不属本指令的写入范围。
 */
export function projectRecord(
  record: IndexRecord,
  raw: Record<string, unknown>,
  targets: ResolvedTarget[],
  checksum: string,
  digests: Record<string, string> | undefined,
  now: string,
): IndexRecord {
  const previous = new Map(record.targets.map((item) => [`${item.target}|${item.scope}`, item]));
  const next: IndexRecord = {
    ...record,
    name: typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : record.name,
    path: typeof raw['path'] === 'string' && raw['path'] !== '' ? raw['path'] : record.path,
    targets: targets.map(
      (item) =>
        previous.get(`${item.target}|${item.scope}`) ?? {
          target: item.target,
          scope: item.scope,
          enabled: item.enabled,
        },
    ),
    updated_at: now,
    checksum,
  };

  // 逐文件摘要与聚合指纹同批刷新；重算失败时沿用既有基准（缺失即待回填）
  if (digests !== undefined) next.digests = digests;

  for (const field of ['version', 'description', 'author', 'license'] as const) {
    if (typeof raw[field] === 'string' && raw[field] !== '') next[field] = raw[field];
    else delete next[field];
  }
  if (Array.isArray(raw['trigger_keywords'])) {
    const keywords = raw['trigger_keywords'].filter(
      (item): item is string => typeof item === 'string',
    );
    if (keywords.length > 0) next.trigger_keywords = keywords;
    else delete next.trigger_keywords;
  } else {
    delete next.trigger_keywords;
  }

  const source = raw['source'];
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const type = (source as Record<string, unknown>)['type'];
    if (type === 'local' || type === 'git' || type === 'archive' || type === 'unknown') {
      next.source_type = type;
    }
  }

  const declared = raw['dependencies'];
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    const skills = (declared as Record<string, unknown>)['skills'];
    if (Array.isArray(skills)) {
      const names = skills
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().split(' ')[0] ?? '')
        .filter((item) => item !== '');
      if (names.length > 0) next.dependencies = names;
      else delete next.dependencies;
    }
  }

  return next;
}
