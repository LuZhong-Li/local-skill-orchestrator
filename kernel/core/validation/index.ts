/**
 * K-05 校验引擎。
 *
 * 职责：对元数据、配置与索引三类对象做只读校验，产出分级报告。
 * 依据：元数据规范第 5 章校验规则总表（V-01 至 V-18）、索引格式规范第 4 章与第 5 章、
 *      指令契约第 4.12 节。
 *
 * 只读边界（本模块最重要的约束）：
 *   不写入任何文件，也不刷新索引中的运行期结论。契约 4.12 行为 4 与 5、索引格式规范
 *   5.2 都要求校验动作全程只读，运行期结论只由登记与刷新动作写入。因此本模块在
 *   「实时计算的结论」与「索引内已有结论」不一致时，只报告结论已过期并建议重新扫描，
 *   把刷新动作留给 scan。
 *
 * 规则落位：
 *   V-01、V-03 至 V-06、V-10、V-11、V-15 由 K-01 的形态校验承担；
 *   V-02 在索引层面判定；V-08 判内容是否全部缺失；V-09 由元文件解析阶段承担；
 *   V-12、V-13 由 K-01 的依赖判定承担；V-18 判索引版本；
 *   本模块新增 V-07 内容一致性、V-14 派生区篡改、V-16 跨文件投影一致性、V-17 引用路径可达。
 *
 * V-14 与 V-16 的分工：V-14 比对派生区（created_at、updated_at、checksum），
 * V-16 比对声明区投影，两者合起来覆盖元数据规范 5.7 列举的全部字段，且同一字段只报一次。
 */
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { META_ALLOWED_FIELDS } from '../metadata/constants.ts';
import type { IndexRecord, SkillIndex, SkillMeta, ValidationStatus } from '../metadata/types.ts';
import {
  validateDependencies,
  validateIndexVersion,
  validateMetaRecord,
  type AvailabilityMap,
  type MetaContext,
} from '../metadata/validate.ts';
import { computeChecksum, computeDigests, hasHashableContent } from '../integrity/index.ts';
import { isDirectory, pathExists } from '../../store/library-fs/index.ts';
import { resolveWithin } from '../../store/paths/index.ts';
import { declaredSkillsOf, readMetaFile, type MetaRead } from '../metadata/read.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { TARGET_MODE_VALUES } from '../metadata/constants.ts';
import { SKILLS_DIR_NAME, type WorkspaceLayout } from '../../store/workspace/index.ts';

/**
 * V-16 比对的声明区投影字段；source_type 由 source.type 派生，单独处理。
 *
 * 不含 status：索引中的 status 是启用状态的唯一事实源（元数据规范 5.6），
 * 安装动作按 4.7 行为 7 与 D-08 决定登记取值，元文件取值不参与判定。
 */
const PROJECTION_FIELDS = [
  'name',
  'version',
  'description',
  'author',
  'license',
  'path',
  'trigger_keywords',
] as const;

/** V-16 比对 targets 摘要的子字段；enabled 属运行期可见性，不参与判定 */
const PROJECTION_TARGET_FIELDS = ['target', 'scope'] as const;

/** V-14 比对的派生区字段 */
const DERIVED_FIELDS_COMPARED = ['created_at', 'updated_at', 'checksum'] as const;

export interface RecordVerdict {
  id: string;
  /** 实时计算的校验结论 */
  status: ValidationStatus;
  /** 实时计算得到的错误级问题码 */
  errors: string[];
  /** 实时计算得到的警告级问题码 */
  warnings: string[];
  /** 索引中已有的运行期结论 */
  stored: ValidationStatus;
  /** 索引内结论与实时结论是否不一致 */
  stale: boolean;
}

export interface ValidationReport {
  scope: 'environment' | 'record';
  subject?: string;
  total: number;
  passed: number;
  invalid: number;
  warnings: number;
  errors: number;
  /** 结论已过期的记录数 */
  stale: number;
  code_counts: Record<string, number>;
  records: RecordVerdict[];
}

export interface ValidateOutcome {
  findings: Finding[];
  report: ValidationReport;
}

export interface ValidateInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 指定对象：Skill 标识，或工作区内的相对路径；省略时校验整个环境 */
  subject?: string;
}

/**
 * 校验工作区。不带 subject 时校验整个环境，带 subject 时只报告该对象的问题。
 * 无论哪种范围都只读，不写入任何文件。
 */
export function validateWorkspace(input: ValidateInput): ValidateOutcome {
  const { layout, index, subject } = input;
  const environment: Finding[] = [];

  // 一、索引文件自身与配置区
  environment.push(...validateIndexVersion(index.schema_version));
  environment.push(...validateConfig(layout, index));

  // 二、索引层面的标识唯一性（V-02）：重复出现时逐条列出冲突的双方
  const seen = new Map<string, number>();
  for (const record of index.skills) {
    const count = (seen.get(record.id) ?? 0) + 1;
    seen.set(record.id, count);
    if (count === 2) {
      environment.push(
        finding(CODES.ID_DUPLICATED, {
          source: 'registry',
          target: record.id,
          message: `索引中标识 ${record.id} 出现多次`,
          remedy: '请删除重复记录，保留其中一条',
        }),
      );
    }
  }

  // 三、确定校验范围；单对象模式下只读取该对象的元文件
  const scope = resolveScope(layout, index, subject);
  const single = subject !== undefined && subject !== '';

  // 单对象模式下，指定的对象既不在索引中、也不是工作区内的可达目录时，立即报参数类问题
  if (single && scope.length === 1 && !scope[0]!.registered) {
    const invalid = unresolvableSubject(layout, scope[0]!.record.path);
    if (invalid !== null) {
      const all = [...environment, invalid];
      return { findings: all, report: summarize(all, [], true, subject) };
    }
  }

  const reads = new Map<string, MetaRead>();
  for (const item of scope) {
    reads.set(item.record.id, readMetaFile(recordDir(layout, item.record), item.record.id));
  }

  // 四、依赖校验：可用性取索引中已有的运行期结论，图的默认来源为索引记录的依赖摘要
  const availability: AvailabilityMap = new Map(
    index.skills.map((record) => [record.id, record.validation.status === 'ok']),
  );
  const dependencyMetas: SkillMeta[] = index.skills.map((record) => {
    const fromLive = declaredSkillsOf(reads.get(record.id)?.raw ?? null);
    return {
      id: record.id,
      dependencies: { skills: fromLive ?? record.dependencies ?? [] },
    } as unknown as SkillMeta;
  });
  const byOwner = new Map<string, Finding[]>();
  for (const item of validateDependencies(dependencyMetas, availability)) {
    const owner = item.target.split('.')[0] ?? '';
    // 单对象模式：只保留该对象自身的依赖问题，以及牵涉该对象的依赖环
    if (single && owner !== subject && !item.message.includes(subject)) continue;
    const bucket = byOwner.get(owner) ?? [];
    bucket.push(item);
    byOwner.set(owner, bucket);
  }

  // 五、逐条校验
  const findings: Finding[] = [];
  const verdicts: RecordVerdict[] = [];
  for (const item of scope) {
    const read = reads.get(item.record.id) ?? { raw: null, findings: [] };
    const own = validateRecord(layout, item, read, byOwner.get(item.record.id) ?? []);
    verdicts.push(own.verdict);
    findings.push(...own.findings);
  }

  const all = [...environment, ...findings];
  return {
    findings: all,
    report: summarize(all, verdicts, single, subject),
  };
}

/** 校验索引的配置区；目标标识目前无登记表，因此只校验非空与取值域 */
function validateConfig(layout: WorkspaceLayout, index: SkillIndex): Finding[] {
  const findings: Finding[] = [];
  const config = index.config;

  if (!Array.isArray(config.skill_roots) || config.skill_roots.length === 0) {
    findings.push(
      finding(CODES.FIELD_REQUIRED, {
        source: 'registry',
        target: 'config.skill_roots',
        message: '配置区的 skill_roots 必须为至少含一项的数组',
        remedy: '请在索引的配置区补上至少一个 Skill 根目录',
      }),
    );
  } else {
    for (const rootSpec of config.skill_roots) {
      if (typeof rootSpec !== 'string' || rootSpec.trim() === '') {
        findings.push(
          finding(CODES.FIELD_INVALID_VALUE, {
            source: 'registry',
            target: 'config.skill_roots',
            message: `skill_roots 中存在空项：${String(rootSpec)}`,
            remedy: '请移除空项或补上具体路径',
          }),
        );
        continue;
      }
      // V-17 的环境部分：配置声明的根目录必须可达
      let resolved: string;
      try {
        resolved = resolveWithin(layout.root, rootSpec, '工作区');
      } catch (error) {
        const kernelError = error instanceof KernelError ? error : null;
        findings.push(
          finding(kernelError?.code ?? CODES.PATH_INVALID, {
            source: 'registry',
            target: rootSpec,
            message: kernelError?.message ?? `Skill 根目录不可用：${rootSpec}`,
            remedy: '请把根目录限定在工作区之内',
          }),
        );
        continue;
      }
      if (!pathExists(resolved)) {
        findings.push(
          finding(CODES.PATH_INVALID, {
            source: 'registry',
            target: rootSpec,
            message: `配置声明的 Skill 根目录不可达：${rootSpec}`,
            remedy: '请创建该目录，或把 skill_roots 改为实际存在的目录',
          }),
        );
      }
    }
  }

  if (config.default_mode !== undefined && !TARGET_MODE_VALUES.includes(config.default_mode)) {
    findings.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: 'registry',
        target: 'config.default_mode',
        message: `默认落位方式取值非法：${String(config.default_mode)}`,
        remedy: `仅允许 ${TARGET_MODE_VALUES.join(' 或 ')}`,
      }),
    );
  }

  if (
    config.default_target !== undefined &&
    (typeof config.default_target !== 'string' || config.default_target.trim() === '')
  ) {
    findings.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: 'registry',
        target: 'config.default_target',
        message: `默认目标取值非法：${String(config.default_target)}`,
        remedy: '请填写非空的默认目标标识',
      }),
    );
  }

  return findings;
}

/** 校验对象：记录本身，以及它是否已在索引中登记 */
interface Subject {
  record: IndexRecord;
  /** 未登记的目录没有索引基准，比对类规则一律跳过 */
  registered: boolean;
}

/** 解析校验范围：省略 subject 时为全环境，否则定位到单条记录 */
function resolveScope(
  layout: WorkspaceLayout,
  index: SkillIndex,
  subject: string | undefined,
): Subject[] {
  if (subject === undefined || subject === '') {
    return index.skills.map((record) => ({ record, registered: true }));
  }
  const byId = index.skills.find((record) => record.id === subject);
  if (byId !== undefined) return [{ record: byId, registered: true }];

  // 按路径定位：解析后与某条记录的目录一致时，视为校验该条记录
  const normalized = normalizePath(layout.root, subject);
  if (normalized !== null) {
    for (const record of index.skills) {
      const declared = resolveDeclaredDir(layout, record);
      const candidates = [join(layout.skillsDir, record.id), declared].filter(
        (item): item is string => item !== null,
      );
      if (candidates.some((item) => item.toLowerCase() === normalized)) {
        return [{ record, registered: true }];
      }
    }
  }

  // 未登记的目录：仍纳入校验，但不做需要索引基准的比对
  const dirName =
    subject
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .pop() ?? subject;
  return [
    {
      registered: false,
      record: {
        id: dirName,
        name: dirName,
        status: 'enabled',
        path: subject,
        source_type: 'unknown',
        targets: [],
        created_at: '',
        updated_at: '',
        checksum: '',
        validation: { status: 'ok', errors: [] },
      },
    },
  ];
}

/** 记录对应的技能目录：优先取记录声明的落位路径，不可用时退回 ./skills/<id> */
function recordDir(layout: WorkspaceLayout, record: IndexRecord): string {
  const declared = resolveDeclaredDir(layout, record);
  return declared ?? join(layout.skillsDir, record.id);
}

/** 未登记的指定对象能否定位；返回 null 表示可以继续校验 */
function unresolvableSubject(layout: WorkspaceLayout, pathSpec: string): Finding | null {
  let resolved: string;
  try {
    resolved = resolveWithin(layout.root, pathSpec, '工作区');
  } catch (error) {
    const kernelError = error instanceof KernelError ? error : null;
    return finding(kernelError?.code ?? CODES.PATH_INVALID, {
      source: 'input',
      target: pathSpec,
      message: kernelError?.message ?? `路径不可用：${pathSpec}`,
      remedy: '请提供工作区之内的相对路径，或改用一个已登记的 Skill 标识',
    });
  }
  if (!isDirectory(resolved)) {
    return finding(CODES.INPUT_INVALID_ARG, {
      source: 'input',
      target: pathSpec,
      message: `找不到该标识，也找不到对应的目录：${pathSpec}`,
      remedy: '请使用已登记的 Skill 标识，或指向工作区内包含元文件的目录',
    });
  }
  return null;
}

/** 解析记录声明的落位路径；越界或非法时返回 null */
function resolveDeclaredDir(layout: WorkspaceLayout, record: IndexRecord): string | null {
  if (typeof record.path !== 'string' || record.path.trim() === '') return null;
  try {
    return resolveWithin(layout.root, record.path, '工作区');
  } catch {
    return null;
  }
}

/** 把工作区内的相对路径规范化为可比较的小写绝对路径；不可解析时返回 null */
function normalizePath(root: string, target: string): string | null {
  try {
    return resolveWithin(root, target, '工作区').toLowerCase();
  } catch {
    return null;
  }
}

interface RecordOutcome {
  findings: Finding[];
  verdict: RecordVerdict;
}

/** 校验单条记录：形态、内容一致、派生区篡改、投影一致、引用路径可达、结论时效 */
function validateRecord(
  layout: WorkspaceLayout,
  subject: Subject,
  read: MetaRead,
  dependencyFindings: Finding[],
): RecordOutcome {
  const { record, registered } = subject;
  const findings: Finding[] = [];
  const id = record.id;
  const declaredDir = resolveDeclaredDir(layout, record);
  const dir = declaredDir ?? join(layout.skillsDir, id);
  // dirName 取**物理目录名**：id 与目录名不一致由 V-03 报告，而不是按 id 反推目录后假装一致
  const physicalDirName = declaredDir === null ? id : basename(declaredDir);
  const context: MetaContext = { dirName: physicalDirName, dirPath: dir };

  findings.push(...read.findings);
  findings.push(...dependencyFindings);

  if (registered) {
    // V-17 引用路径可达性：以记录**声明的物理位置**为准（悬空记录才报）。
    // 「id 与目录名不一致」由 V-03（E-ID-003）单独报告，避免同一根因双报、也保证与扫描结论一致。
    if (!isDirectory(dir)) {
      findings.push(
        finding(CODES.PATH_INVALID, {
          source: 'registry',
          target: id,
          message: `索引记录指向的目录不存在：${record.path}`,
          remedy: '请确认该 Skill 是否被移除；如已移除，可执行卸载以清理记录',
        }),
      );
    }
    if (declaredDir === null) {
      findings.push(
        finding(CODES.PATH_INVALID, {
          source: 'registry',
          target: `${id}.path`,
          message: `记录的落位路径不可用或越出工作区：${record.path}`,
          remedy: `请把 path 改为工作区内 ${SKILLS_DIR_NAME}/ 之下的相对路径`,
        }),
      );
    } else if (!pathExists(declaredDir)) {
      findings.push(
        finding(CODES.PATH_INVALID, {
          source: 'registry',
          target: `${id}.path`,
          message: `记录的落位路径不可达：${record.path}`,
          remedy: '请确认该目录是否存在，或重新扫描以刷新记录',
        }),
      );
    }
  } else if (declaredDir === null) {
    findings.push(
      finding(CODES.PATH_INVALID, {
        source: 'registry',
        target: String(record.path),
        message: `指定的路径越出工作区或不可用：${record.path}`,
        remedy: '请提供工作区之内的相对路径',
      }),
    );
  }

  // V-08 内容缺失判定与 V-07 内容一致性：依据磁盘内容与索引记录的指纹，与元文件能否解析无关
  if (!hasHashableContent(dir)) {
    findings.push(
      finding(CODES.HASH_MISSING, {
        source: 'meta',
        target: id,
        message: '技能目录内不存在参与指纹计算的内容文件',
        remedy: '请确认该目录是否缺少技能内容，例如 SKILL.md',
      }),
    );
  } else if (registered && record.checksum !== '') {
    const recomputed = safeChecksum(dir);
    if (recomputed !== null && recomputed !== record.checksum) {
      findings.push(
        finding(CODES.DRIFT, {
          source: 'meta',
          target: id,
          message: `内容漂移：记录指纹 ${record.checksum}，重算指纹 ${recomputed}`,
          remedy: '如为有意修改，请重新扫描以刷新指纹；否则请检查内容是否被意外改动',
        }),
      );
      findings.push(...locateDrift(dir, record, id));
    }
  }

  const raw = read.raw;
  if (raw !== null) {
    // V-01、V-03 至 V-06、V-10、V-11、V-15
    findings.push(...validateMetaRecord(raw, context));
    findings.push(...whitelistFindings(raw, context));

    if (registered) {
      // V-14 派生区篡改检测：基准取索引中内核上次写入的取值
      findings.push(...detectDerivedTamper(raw, record, id));
      // V-16 跨文件投影一致性
      findings.push(...detectProjectionDrift(raw, record, id));
    } else {
      findings.push(
        finding(CODES.INDEX_PROJECTION, {
          source: 'registry',
          target: id,
          message: `该目录存在元文件，但未登记在索引中：${record.path}`,
          remedy: '请执行 scan 把该 Skill 登记进索引',
        }),
      );
    }
  }

  // 结论时效：实时结论与索引内结论不一致时，只报告并建议重新扫描
  const errors = uniqueCodes(findings.filter((item) => item.severity === 'error'));
  const warnings = uniqueCodes(findings.filter((item) => item.severity === 'warning'));
  const status: ValidationStatus = errors.length > 0 ? 'invalid' : 'ok';
  const stored: ValidationStatus = record.validation.status;
  const stale =
    registered &&
    (status !== stored || errors.join(',') !== [...record.validation.errors].sort().join(','));
  if (stale) {
    findings.push(
      finding(CODES.INDEX_STALE, {
        source: 'registry',
        target: id,
        message: `索引中的运行期结论已过期：索引记为 ${stored}，实时判定为 ${status}`,
        remedy: '本指令只读，不改写结论；请执行 scan 刷新运行期结论',
      }),
    );
  }

  return {
    findings,
    verdict: { id, status, errors, warnings, stored, stale },
  };
}

/**
 * V-07 的定位部分：把漂移落到具体文件（元数据规范 5.4 输出要求）。
 *
 * 判据是索引派生区的 `digests` 与磁盘重算的逐文件摘要：
 *   索引里没有该基准（旧索引尚未回填）→ 返回空，上层只给聚合级报告，不猜测文件；
 *   基准存在 → 逐条列出内容变化、新增与删除，每条给出文件相对路径与两侧摘要。
 * 键的排序沿用契约的字节序，保证同一份差异每次报告的次序一致。
 */
function locateDrift(dir: string, record: IndexRecord, id: string): Finding[] {
  const baseline = record.digests;
  if (baseline === undefined || Object.keys(baseline).length === 0) return [];

  let current: Record<string, string>;
  try {
    if (!statSync(dir).isDirectory()) return [];
    current = computeDigests(dir);
  } catch {
    return [];
  }

  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );

  const findings: Finding[] = [];
  for (const rel of paths) {
    const before = baseline[rel];
    const after = current[rel];
    if (before === after) continue;
    findings.push(
      finding(CODES.DRIFT, {
        source: 'meta',
        target: `${id}/${rel}`,
        message: describeFileDrift(rel, before, after),
        remedy:
          before === undefined
            ? '如为有意新增，请重新扫描以刷新内容摘要；否则请确认该文件为何出现在这里'
            : after === undefined
              ? '如为有意删除，请重新扫描以刷新内容摘要；否则请从备份或来源恢复该文件'
              : '如为有意修改，请重新扫描以刷新内容摘要；否则请检查该文件是否被意外改动',
      }),
    );
  }
  return findings;
}

/** 单个文件的漂移描述：区分内容变化、新增与删除，均给出相对路径与两侧摘要 */
function describeFileDrift(
  rel: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (before === undefined) return `新增文件 ${rel}：现有摘要 ${String(after)}`;
  if (after === undefined) return `文件已删除 ${rel}：原摘要 ${before}`;
  return `文件内容已变化 ${rel}：原摘要 ${before}，现有摘要 ${after}`;
}

/** V-14：元文件派生区字段与索引内取值不一致时判定为被用户改写 */
function detectDerivedTamper(
  raw: Record<string, unknown>,
  record: IndexRecord,
  id: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const field of DERIVED_FIELDS_COMPARED) {
    const inMeta = raw[field];
    const inIndex = (record as unknown as Record<string, unknown>)[field];
    // 缺失表示待内核回填，不构成问题
    if (inMeta === undefined || inMeta === null || inMeta === '') continue;
    if (typeof inMeta !== 'string' || typeof inIndex !== 'string' || inIndex === '') continue;
    if (inMeta === inIndex) continue;
    findings.push(
      finding(CODES.DERIVED_TAMPER, {
        source: 'meta',
        target: `${id}.${field}`,
        message: `派生区字段 ${field} 与内核记录值不一致：元文件为 ${inMeta}，索引为 ${inIndex}`,
        remedy: '派生区字段只允许内核写入；内核会在下次安装或扫描时按自身取值覆盖',
      }),
    );
  }
  return findings;
}

/** V-16：索引记录的声明区投影与元文件不一致时报告差异字段 */
function detectProjectionDrift(
  raw: Record<string, unknown>,
  record: IndexRecord,
  id: string,
): Finding[] {
  const findings: Finding[] = [];
  const inIndex = record as unknown as Record<string, unknown>;
  for (const field of PROJECTION_FIELDS) {
    const left = inIndex[field];
    const right = raw[field];
    if (sameValue(left, right)) continue;
    findings.push(projectionFinding(id, field, left, right));
  }

  // source_type 是元文件 source.type 的摘要
  const source = raw['source'];
  const metaType =
    source !== null && typeof source === 'object' && !Array.isArray(source)
      ? (source as Record<string, unknown>)['type']
      : undefined;
  if (!sameValue(record.source_type, metaType)) {
    findings.push(projectionFinding(id, 'source_type', record.source_type, metaType));
  }

  // targets 摘要与元文件对应项在 target 与 scope 两个子字段上比对；enabled 不参与
  const projecting = (value: unknown): unknown[] =>
    Array.isArray(value)
      ? value.flatMap((item) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry['target'] !== 'string') return [];
          const picked: Record<string, unknown> = {};
          for (const field of PROJECTION_TARGET_FIELDS) picked[field] = entry[field];
          return [picked];
        })
      : [];
  const indexTargets = projecting(record.targets);
  const metaTargets = projecting(raw['targets']);
  if (!sameValue(indexTargets, metaTargets)) {
    findings.push(projectionFinding(id, 'targets', indexTargets, metaTargets));
  }

  return findings;
}

function projectionFinding(id: string, field: string, inIndex: unknown, inMeta: unknown): Finding {
  return finding(CODES.INDEX_PROJECTION, {
    source: 'registry',
    target: `${id}.${field}`,
    message: `投影不一致：索引为 ${describe(inIndex)}，元文件为 ${describe(inMeta)}`,
    remedy: '以元文件为准；请重新扫描或重新安装，由内核重新生成索引投影',
  });
}

/** 白名单外字段只给警告，与 V-11 同属字段类别 */
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

function summarize(
  findings: Finding[],
  verdicts: RecordVerdict[],
  single: boolean,
  subject: string | undefined,
): ValidationReport {
  const codeCounts: Record<string, number> = {};
  for (const item of findings) {
    codeCounts[item.code] = (codeCounts[item.code] ?? 0) + 1;
  }
  const report: ValidationReport = {
    scope: single ? 'record' : 'environment',
    total: verdicts.length,
    passed: verdicts.filter((item) => item.status === 'ok').length,
    invalid: verdicts.filter((item) => item.status === 'invalid').length,
    warnings: findings.filter((item) => item.severity === 'warning').length,
    errors: findings.filter((item) => item.severity === 'error').length,
    stale: verdicts.filter((item) => item.stale).length,
    code_counts: codeCounts,
    records: verdicts,
  };
  if (single && subject !== undefined) report.subject = subject;
  return report;
}

function safeChecksum(dir: string): string | null {
  try {
    if (!statSync(dir).isDirectory()) return null;
    return computeChecksum(dir);
  } catch {
    return null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function describe(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function uniqueCodes(findings: Finding[]): string[] {
  return [...new Set(findings.map((item) => item.code))].sort();
}
