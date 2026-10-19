/**
 * K-02 发现与登记服务。
 *
 * 扫描配置区声明的 Skill 根目录，识别其中的 Skill 目录，组装或更新索引记录。
 * 依据 FR-01 的处理要求：
 *   不合格的 Skill 同样写入索引，以运行期结论承载问题码，不静默丢弃、不中断整次扫描；
 *   磁盘上消失的记录同样以校验不通过写入；
 *   重复扫描更新既有记录，不新增重复条目；问题修复后结论自动转为通过。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DERIVED_FIELDS, META_FILE_NAME, META_ALLOWED_FIELDS } from '../metadata/constants.ts';
import type { IndexRecord, SkillIndex, SkillMeta, ValidationStatus } from '../metadata/types.ts';
import {
  validateDependencies,
  validateMetaRecord,
  type AvailabilityMap,
  type MetaContext,
} from '../metadata/validate.ts';
import { computeChecksum, computeDigests, hasHashableContent } from '../integrity/index.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import { resolveWithin } from '../../store/paths/index.ts';
import { CODES, type Change, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { KernelError } from '../../store/errors.ts';
import { resolveWorkspaceRoot, type WorkspaceLayout } from '../../store/workspace/index.ts';

export interface ScanSummary {
  /** 可用记录数：运行期结论为校验通过 */
  available: number;
  /** 不合格记录数 */
  invalid: number;
  /** 首次登记数 */
  added: number;
  /** 既有记录被更新数 */
  updated: number;
  /** 索引中存在但磁盘上已消失的记录数 */
  missing: number;
}

export interface ScanOutcome {
  index: SkillIndex;
  /** 不属于任何单条记录的全局问题 */
  findings: Finding[];
  changes: Change[];
  summary: ScanSummary;
}

export interface ScanInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 本次扫描的时间戳，格式为协调世界时秒级 */
  now: string;
}

interface Candidate {
  dirName: string;
  dirPath: string;
  recordPath: string;
  raw: Record<string, unknown> | null;
  findings: Finding[];
}

/** 由索引记录的 `path` 推导物理目录名（记录的物理归属键） */
function dirNameOfRecordPath(path: string): string {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  const last = parts.at(-1);
  return last !== undefined && last !== '' ? last : path;
}

/** 候选记录的节点标识：元文件 id（非空字符串）优先，否则回退到目录名 */
function nodeIdOf(candidate: Candidate): string {
  const rawId = candidate.raw?.['id'];
  return typeof rawId === 'string' && rawId !== '' ? rawId : candidate.dirName;
}

/** 扫描技能根目录，返回新的索引与本次扫描的问题清单 */
export function scanWorkspace(input: ScanInput): ScanOutcome {
  const { layout, index, now } = input;
  const findings: Finding[] = [];
  const changes: Change[] = [];
  // 物理归属键 = 实际目录名：一个目录一条记录（2026-10-17 内核核查批次裁决）。
  // 逻辑错误（id 与目录名不一致、跨记录 id 重复、path 不符）照常显式报告，但不改变物理归属。
  const existing = new Map<string, IndexRecord>();
  for (const record of index.skills) existing.set(dirNameOfRecordPath(record.path), record);

  const candidates = collectCandidates(layout, index, findings);

  // 每条候选的节点 id 与自身错误；跨记录 id 重复在这里显式判定
  const nodes = candidates.map((candidate) => ({
    candidate,
    id: nodeIdOf(candidate),
    ownError: candidate.findings.some((item) => item.severity === 'error'),
    duplicate: false,
  }));
  const idCounts = new Map<string, number>();
  for (const node of nodes) idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  for (const node of nodes) node.duplicate = (idCounts.get(node.id) ?? 0) > 1;

  // 可用性以节点 id 为键：异常记录（自身错误或重复 id）一律按不可用进入依赖传播
  const ownAvailability: AvailabilityMap = new Map();
  const metas: SkillMeta[] = [];
  for (const node of nodes) {
    ownAvailability.set(node.id, !node.ownError && !node.duplicate);
    if (node.candidate.raw !== null) metas.push({ ...toMeta(node.candidate), id: node.id });
  }

  // 依赖校验会产生新问题，而这些问题又会改变依赖方的可用性，因此迭代到可用性不再变化。
  // 环在**全量图**上一次性定死（见 validateDependencies），因此每轮只会把可用翻成不可用，
  // 最多经过「候选数 + 1」轮必然收敛，且结果与依赖顺序、技能数量无关。
  let availability: AvailabilityMap = ownAvailability;
  let dependencyFindings: Finding[] = [];
  for (let round = 0; round <= candidates.length; round += 1) {
    dependencyFindings = validateDependencies(metas, availability);
    const recomputed: AvailabilityMap = new Map();
    for (const node of nodes) {
      const fromDependencies = dependencyFindings.some(
        (item) => item.severity === 'error' && (item.target.split('.')[0] ?? '') === node.id,
      );
      recomputed.set(node.id, !node.ownError && !node.duplicate && !fromDependencies);
    }
    if (sameAvailability(recomputed, availability)) break;
    availability = recomputed;
  }

  const byOwner = new Map<string, Finding[]>();
  for (const item of dependencyFindings) {
    const owner = item.target.split('.')[0] ?? '';
    const bucket = byOwner.get(owner) ?? [];
    bucket.push(item);
    byOwner.set(owner, bucket);
  }

  const records: IndexRecord[] = [];
  const summary: ScanSummary = { available: 0, invalid: 0, added: 0, updated: 0, missing: 0 };

  for (const node of nodes) {
    const { candidate, id } = node;
    const own = [...candidate.findings, ...(byOwner.get(id) ?? [])];
    if (node.duplicate) {
      own.push(
        finding(CODES.ID_DUPLICATED, {
          source: 'registry',
          target: id,
          message: `标识 ${id} 在工作区内出现多次`,
          remedy: '请确保同一工作区内 Skill 标识唯一，必要时重命名其中一个目录',
        }),
      );
    }

    const hasError = own.some((item) => item.severity === 'error');
    const status: ValidationStatus = hasError ? 'invalid' : 'ok';
    if (status === 'ok') summary.available += 1;
    else summary.invalid += 1;

    const previous = existing.get(candidate.dirName);
    const record = buildRecord(candidate, own, status, previous, now);
    records.push(record);
    existing.delete(candidate.dirName);

    if (previous === undefined) {
      summary.added += 1;
      changes.push({ action: 'add', kind: 'index_record', path: candidate.recordPath });
    } else if (!sameRecord(previous, record)) {
      summary.updated += 1;
      changes.push({ action: 'modify', kind: 'index_record', path: candidate.recordPath });
    }
    findings.push(...own);
  }

  // 索引中存在但磁盘上已消失的记录：保留记录并以校验不通过标记
  for (const [id, previous] of existing) {
    summary.missing += 1;
    summary.invalid += 1;
    records.push({
      ...previous,
      validation: {
        status: 'invalid',
        errors: [CODES.INDEX_RECORD_INVALID],
        last_scan_at: now,
      },
      updated_at: now,
    });
    findings.push(
      finding(CODES.INDEX_RECORD_INVALID, {
        source: 'registry',
        target: id,
        message: `索引记录 ${id} 在磁盘上已不存在`,
        remedy: '请确认该 Skill 是否被移除；如已移除，可执行卸载以清理记录',
      }),
    );
  }

  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    index: { ...index, generated_at: now, skills: records },
    findings,
    changes,
    summary,
  };
}

/** 遍历配置区声明的根目录，收集候选记录 */
function collectCandidates(
  layout: WorkspaceLayout,
  index: SkillIndex,
  findings: Finding[],
): Candidate[] {
  const candidates: Candidate[] = [];
  const workspaceRoot = resolveWorkspaceRoot(layout.root);

  for (const rootSpec of index.config.skill_roots) {
    let rootPath: string;
    try {
      rootPath = resolveWithin(layout.root, rootSpec, '工作区');
    } catch (error) {
      const kernelError = error instanceof KernelError ? error : null;
      findings.push(
        finding(kernelError?.code ?? CODES.PATH_INVALID, {
          source: 'registry',
          target: rootSpec,
          message: `Skill 根目录不可用：${rootSpec}`,
          remedy: '请把根目录限定在工作区之内',
        }),
      );
      continue;
    }

    let entries;
    try {
      entries = readdirSync(rootPath, { withFileTypes: true });
    } catch {
      // 根目录不存在时视为空，不报错：首次初始化后尚未建立 skills/ 是正常状态
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(rootPath, entry.name);
      const metaFile = join(dirPath, META_FILE_NAME);
      let hasMeta = false;
      try {
        hasMeta = statSync(metaFile).isFile();
      } catch {
        hasMeta = false;
      }
      if (!hasMeta) continue;
      candidates.push(readCandidate(entry.name, dirPath, metaFile, workspaceRoot));
    }
  }
  return candidates;
}

/** 读取单个候选目录的元文件并执行形态校验 */
function readCandidate(
  dirName: string,
  dirPath: string,
  metaFile: string,
  workspaceRoot: string,
): Candidate {
  const recordPath = dirPath
    .slice(workspaceRoot.length + 1)
    .split('\\')
    .join('/');
  const context: MetaContext = { dirName, dirPath };
  try {
    const raw = parseYaml(readFileSync(metaFile, 'utf8'), { source: 'meta', target: metaFile });
    const findings = validateMetaRecord(raw, context);
    findings.push(...whitelistFindings(raw, context));
    // V-08：参与指纹计算的内容全部缺失时判为内容缺失，属于错误级问题
    if (!hasHashableContent(dirPath)) {
      findings.push(
        finding(CODES.HASH_MISSING, {
          source: 'meta',
          target: dirName,
          message: '技能目录内不存在参与指纹计算的内容文件',
          remedy: '请确认该目录是否缺少技能内容，例如 SKILL.md',
        }),
      );
    }
    return { dirName, dirPath, recordPath, raw, findings };
  } catch (error) {
    const kernelError = error instanceof KernelError ? error : null;
    return {
      dirName,
      dirPath,
      recordPath,
      raw: null,
      findings: [
        finding(kernelError?.code ?? CODES.YAML_INVALID, {
          source: 'meta',
          target: dirName,
          message: kernelError?.message ?? '元文件无法解析',
          remedy: '请检查该元文件的语法与结构',
        }),
      ],
    };
  }
}

/** 白名单外字段只给警告，不影响该 Skill 的可用性判定 */
function whitelistFindings(raw: Record<string, unknown>, ctx: MetaContext): Finding[] {
  const extra = Object.keys(raw).filter((key) => !META_ALLOWED_FIELDS.has(key));
  if (extra.length === 0) return [];
  return [
    finding(CODES.FIELD_WHITELIST, {
      source: 'meta',
      target: ctx.dirName,
      message: `元文件存在白名单外字段：${extra.join('、')}`,
      remedy: '请把自研字段移入扩展元数据，或移除这些字段',
    }),
  ];
}

/** 由候选记录组装带类型的元数据对象，缺失的派生字段以扫描时间补齐 */
function toMeta(candidate: Candidate): SkillMeta {
  const raw = candidate.raw ?? {};
  const meta = { ...raw } as unknown as SkillMeta;
  for (const field of DERIVED_FIELDS) {
    if (typeof (raw as Record<string, unknown>)[field] !== 'string') {
      (meta as unknown as Record<string, unknown>)[field] = '';
    }
  }
  if (meta.dependencies === undefined) meta.dependencies = {};
  return meta;
}

/** 由候选记录与问题清单组装索引记录 */
function buildRecord(
  candidate: Candidate,
  findings: Finding[],
  status: ValidationStatus,
  previous: IndexRecord | undefined,
  now: string,
): IndexRecord {
  const raw = candidate.raw ?? {};
  const checksum = safeChecksum(candidate.dirPath) ?? String(raw['checksum'] ?? '');
  const digests = safeDigests(candidate.dirPath);
  const createdAt = pickString(raw['created_at'], previous?.created_at, now);
  const errors = [...new Set(findings.map((item) => item.code))].sort();
  const changed =
    previous === undefined ||
    previous.checksum !== checksum ||
    previous.validation.status !== status ||
    previous.validation.errors.join(',') !== errors.join(',');

  const record: IndexRecord = {
    id: pickString(raw['id'], previous?.id, candidate.dirName),
    name: pickString(raw['name'], previous?.name, candidate.dirName),
    status: previous?.status ?? 'enabled',
    path: pickString(raw['path'], previous?.path, `./skills/${candidate.dirName}`),
    source_type: previous?.source_type ?? 'unknown',
    targets: previous?.targets ?? [],
    created_at: createdAt,
    updated_at: changed ? now : (previous?.updated_at ?? now),
    checksum,
    // 逐文件摘要：本字段引入之前的旧索引没有它，扫描一次即回填；重算失败时保持缺失（待回填）
    ...(digests !== null ? { digests } : {}),
    validation: { status, errors, last_scan_at: now },
  };

  const version = pickOptional(raw['version'], previous?.version);
  if (version !== undefined) record.version = version;
  const description = pickOptional(raw['description'], previous?.description);
  if (description !== undefined) record.description = description;
  const author = pickOptional(raw['author'], previous?.author);
  if (author !== undefined) record.author = author;
  const license = pickOptional(raw['license'], previous?.license);
  if (license !== undefined) record.license = license;

  const keywords = raw['trigger_keywords'];
  if (Array.isArray(keywords) && keywords.every((item) => typeof item === 'string')) {
    record.trigger_keywords = keywords as string[];
  } else if (previous?.trigger_keywords !== undefined) {
    record.trigger_keywords = previous.trigger_keywords;
  }

  const dependencies = raw['dependencies'];
  if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    const declared = (dependencies as Record<string, unknown>)['skills'];
    if (Array.isArray(declared)) {
      record.dependencies = declared
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().split(' ')[0] ?? '')
        .filter((item) => item !== '');
    }
  } else if (previous?.dependencies !== undefined) {
    record.dependencies = previous.dependencies;
  }

  const source = raw['source'];
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const type = (source as Record<string, unknown>)['type'];
    if (type === 'local' || type === 'git' || type === 'archive' || type === 'unknown') {
      record.source_type = type;
    }
  }

  const targets = raw['targets'];
  if (Array.isArray(targets)) {
    record.targets = targets.flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      const name = entry['target'];
      const scope = entry['scope'];
      if (typeof name !== 'string') return [];
      if (scope !== 'global' && scope !== 'project') return [];
      return [{ target: name, scope, enabled: entry['enabled'] === true }];
    });
  }

  return record;
}

function safeChecksum(dirPath: string): string | null {
  try {
    return computeChecksum(dirPath);
  } catch {
    return null;
  }
}

/** 逐文件摘要：与聚合指纹同源同范围，重算失败时返回 null，由调用方保持缺失（待回填） */
function safeDigests(dirPath: string): Record<string, string> | null {
  try {
    return computeDigests(dirPath);
  } catch {
    return null;
  }
}

function pickString(value: unknown, fallback: string | undefined, last: string): string {
  if (typeof value === 'string' && value !== '') return value;
  return fallback ?? last;
}

function pickOptional(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  return fallback;
}

/**
 * 判断两条记录在语义上是否一致，用于避免无谓的更新时间抖动。
 * 忽略最近变更时间与结论时间戳：前者本身就是判定对象，后者每次扫描都会刷新，
 * 二者参与比较会让每次扫描都被记成一次更新。结论取值（status 与问题码）仍参与比较。
 */
function sameRecord(a: IndexRecord, b: IndexRecord): boolean {
  const normalize = (record: IndexRecord): string =>
    JSON.stringify({
      ...record,
      updated_at: '',
      validation: { ...record.validation, last_scan_at: '' },
    });
  return normalize(a) === normalize(b);
}

/** 判断两份可用性映射是否一致 */
function sameAvailability(a: AvailabilityMap, b: AvailabilityMap): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}
