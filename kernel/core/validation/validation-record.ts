/** 单条记录与配置区校验。 */
import { basename, join } from 'node:path';
import { TARGET_MODE_VALUES } from '../metadata/constants.ts';
import type { IndexRecord, SkillIndex, ValidationStatus } from '../metadata/types.ts';
import { validateMetaRecord, type MetaContext } from '../metadata/validate.ts';
import { hasHashableContent } from '../integrity/index.ts';
import { isDirectory, pathExists } from '../../store/library-fs/index.ts';
import { resolveWithin } from '../../store/paths/index.ts';
import type { MetaRead } from '../metadata/read.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { SKILLS_DIR_NAME, type WorkspaceLayout } from '../../store/workspace/index.ts';
import { safeChecksum, uniqueCodes, type RecordVerdict } from './validation-shared.ts';
import {
  detectDerivedTamper,
  detectProjectionDrift,
  locateDrift,
  whitelistFindings,
} from './validation-drift.ts';
export function validateConfig(layout: WorkspaceLayout, index: SkillIndex): Finding[] {
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
export function resolveScope(
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
export function recordDir(layout: WorkspaceLayout, record: IndexRecord): string {
  const declared = resolveDeclaredDir(layout, record);
  return declared ?? join(layout.skillsDir, record.id);
}

/** 未登记的指定对象能否定位；返回 null 表示可以继续校验 */
export function unresolvableSubject(layout: WorkspaceLayout, pathSpec: string): Finding | null {
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
export function validateRecord(
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
