/**
 * K-04 生命周期编排服务。
 *
 * 本批次实现安装与卸载两条流程。编排的原则有两条：
 *   一、索引是唯一事实源，任何失败的步骤都要么让环境回到起点，要么让环境仍然自洽；
 *   二、删除类动作先于索引写入执行，因为副本可以从中心库原件重建，而索引一旦写错就没有回退依据。
 *
 * 失败时一律返回问题清单，不向上抛出异常。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { META_FILE_NAME } from '../metadata/constants.ts';
import type { IndexRecord, SkillIndex, SkillMeta } from '../metadata/types.ts';
import { validateMetaRecord, type MetaContext } from '../metadata/validate.ts';
import { computeChecksum } from '../integrity/index.ts';
import { detectMappingConflicts, detectOccupationConflicts } from '../conflict/index.ts';
import { backupBeforeUninstall } from '../backup/index.ts';
import { libraryPathOf, resolveTargets, type ResolvedTarget } from '../targets/resolver/index.ts';
import {
  copyTree,
  isCopyDisabled,
  pathExists,
  removeTree,
  setCopyVisibility,
} from '../../store/library-fs/index.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import { CODES, finding, type Change, type Finding } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { toKernelError } from '../../store/errors.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';

export interface LifecycleOutcome {
  index: SkillIndex;
  findings: Finding[];
  changes: Change[];
  data: Record<string, unknown>;
  /** 预演：调用方不得写入任何文件 */
  preview?: boolean;
}

export interface InstallInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 来源：本地目录，或指向 skill_meta.yaml 的文件路径，均为工作区内或显式给出的路径 */
  sourcePath: string;
  now: string;
  target?: string;
  /** 仅落库：只写中心库与登记记录，不分发到目标位置，状态置为已禁用 */
  libraryOnly?: boolean;
  /** 预演：返回将要发生的变更，不写入任何文件 */
  dryRun?: boolean;
}

export interface UninstallInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 是否连同中心库原件一并删除；默认为否 */
  hard?: boolean;
  /** 预演：返回将要删除与保留的路径，不执行删除 */
  dryRun?: boolean;
}

/**
 * 读取来源中的元文件，返回元文件路径与其所在目录。
 * 来源由用户显式给出，因此不受工作区路径防护约束；防护只作用于写入目标。
 */
function locateMetaFile(sourcePath: string): { metaFile: string; sourceDir: string } {
  try {
    const direct = resolve(sourcePath);
    const asDir = join(direct, META_FILE_NAME);
    if (existsSync(asDir)) return { metaFile: asDir, sourceDir: direct };
    if (existsSync(direct) && direct.endsWith(META_FILE_NAME)) {
      return { metaFile: direct, sourceDir: dirname(direct) };
    }
    throw new KernelError({
      code: CODES.PATH_INVALID,
      message: `来源中未找到 ${META_FILE_NAME}：${sourcePath}`,
      source: 'lifecycle',
      target: sourcePath,
      remedy: '请指向包含元文件的 Skill 目录，或直接指向元文件',
    });
  } catch (error) {
    throw toKernelError(error, CODES.PATH_INVALID);
  }
}

/** 安装：校验、依赖检查、冲突检测、写入中心库、创建副本、登记索引 */
export function installSkill(input: InstallInput): LifecycleOutcome {
  const { layout, index, sourcePath, now, libraryOnly, dryRun } = input;
  const workspaceRoot = layout.root;
  const findings: Finding[] = [];
  const changes: Change[] = [];

  let located: { metaFile: string; sourceDir: string };
  try {
    located = locateMetaFile(sourcePath);
  } catch (error) {
    const kernelError = toKernelError(error, CODES.PATH_INVALID);
    return {
      index,
      findings: [
        finding(kernelError.code, {
          source: kernelError.source,
          target: kernelError.target,
          message: kernelError.message,
          remedy: kernelError.remedy,
        }),
      ],
      changes: [],
      data: {},
    };
  }

  // 一、解析元文件
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(readFileSync(located.metaFile, 'utf8'), {
      source: 'meta',
      target: located.metaFile,
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.YAML_INVALID);
    return {
      index,
      findings: [
        finding(kernelError.code, {
          source: 'meta',
          target: sourcePath,
          message: kernelError.message,
          remedy: '请修正元文件的语法后重试',
        }),
      ],
      changes: [],
      data: {},
    };
  }

  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const context: MetaContext = {
    dirName: id !== '' ? id : (sourcePath.split(/[\\/]/).pop() ?? ''),
    dirPath: located.sourceDir,
  };

  // 二、元数据校验：新装没有历史基准，跨次比对类的规则不适用
  findings.push(...validateMetaRecord(raw, context));
  if (findings.some((item) => item.severity === 'error')) {
    return {
      index,
      findings,
      changes: [],
      data: { rejected: 'invalid_metadata', problem_codes: uniqueCodes(findings) },
    };
  }

  // 三、重复安装：同标识已存在则拒绝，不覆盖、不静默更新
  if (index.skills.some((record) => record.id === id)) {
    return {
      index,
      findings: [
        finding(CODES.CONFLICT_NAMING, {
          source: 'lifecycle',
          target: id,
          message: `标识 ${id} 已在索引中，重复安装被拒绝`,
          remedy: '如需升级，请使用更新指令；如需替换，请先卸载后再安装',
        }),
      ],
      changes: [],
      data: { rejected: 'already_registered', id },
    };
  }

  const meta = raw as unknown as SkillMeta;

  // 四、依赖检查：被依赖对象须在索引中且结论为校验通过
  const availability = new Map<string, boolean>(
    index.skills.map((record) => [record.id, record.validation.status === 'ok']),
  );
  const declared = meta.dependencies?.skills ?? [];
  for (const entry of declared) {
    const name = entry.trim().split(' ')[0] ?? '';
    if (name === '') continue;
    if (!availability.has(name)) {
      findings.push(
        finding(CODES.DEP_MISSING, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 不在索引中`,
          remedy: `请先安装 ${name}`,
        }),
      );
      continue;
    }
    if (availability.get(name) !== true) {
      findings.push(
        finding(CODES.VALIDATION_DEPENDENCY, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 校验不通过，依赖方判定为依赖未满足`,
          remedy: `请先修复 ${name} 的问题并重新扫描`,
        }),
      );
    }
  }
  if (findings.some((item) => item.severity === 'error')) {
    return {
      index,
      findings,
      changes: [],
      data: { rejected: 'dependency_unmet', problem_codes: uniqueCodes(findings) },
    };
  }

  // 五、目标解析与冲突检测
  let targets: ResolvedTarget[];
  try {
    targets = resolveTargets(workspaceRoot, meta);
  } catch (error) {
    const kernelError = toKernelError(error, CODES.PATH_INVALID);
    return {
      index,
      findings: [
        finding(kernelError.code, {
          source: 'targets',
          target: id,
          message: kernelError.message,
          remedy: kernelError.remedy,
        }),
      ],
      changes: [],
      data: {},
    };
  }
  findings.push(...detectMappingConflicts(id, targets));
  findings.push(...detectOccupationConflicts(id, targets));
  if (findings.some((item) => item.severity === 'error')) {
    return {
      index,
      findings,
      changes: [],
      data: { rejected: 'conflict', problem_codes: uniqueCodes(findings) },
    };
  }

  // 六、计算内容指纹：按契约在写入中心库之前计算，使预演与实装得到同一取值
  const libraryDir = libraryPathOf(workspaceRoot, id);
  let checksum: string;
  try {
    checksum = computeChecksum(located.sourceDir);
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return {
      index,
      findings: [toFinding(kernelError)],
      changes: [],
      data: { rejected: 'checksum_failed' },
    };
  }

  // 七、预演：返回落位计划与将要发生的变更，不写入任何文件
  if (dryRun === true) {
    const planned: Change[] = [
      { action: 'add', kind: 'library', path: libraryDir },
      ...(libraryOnly === true
        ? []
        : targets.map((item): Change => ({
            action: 'add',
            kind: 'target_copy',
            path: item.absolutePath,
          }))),
    ];
    return {
      index,
      findings,
      changes: planned,
      preview: true,
      data: {
        preview: true,
        id,
        library_path: libraryDir,
        library_only: libraryOnly === true,
        // 契约 4.7 行为 7：安装登记时状态置为已启用；仅落库时置为已禁用
        status: libraryOnly === true ? 'disabled' : 'enabled',
        checksum,
        planned_changes: planned.length,
        targets: describeTargets(targets, libraryOnly === true),
      },
    };
  }

  // 八、写入中心库
  try {
    copyTree(located.sourceDir, libraryDir);
    changes.push({ action: 'add', kind: 'library', path: libraryDir });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return {
      index,
      findings: [toFinding(kernelError)],
      changes: [],
      data: { rejected: 'library_write_failed' },
    };
  }

  const created: string[] = [];
  // 仅落库：不分发到目标位置，副本留待启用指令补齐
  for (const target of libraryOnly === true ? [] : targets) {
    try {
      copyTree(libraryDir, target.absolutePath);
      if (!target.enabled) setCopyVisibility(target.absolutePath, false);
      created.push(target.absolutePath);
      changes.push({ action: 'add', kind: 'target_copy', path: target.absolutePath });
    } catch (error) {
      // 回滚：删掉本次已创建的副本与中心库内容，环境回到起点
      for (const path of created) removeTree(path);
      removeTree(libraryDir);
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      return {
        index,
        findings: [toFinding(kernelError)],
        changes: [],
        data: { rejected: 'target_write_failed', rolled_back: true },
      };
    }
  }

  // 九、登记索引：派生区由内核写入
  const record: IndexRecord = toIndexRecord(meta, targets, checksum, now, libraryOnly === true);
  const next: SkillIndex = {
    ...index,
    generated_at: now,
    skills: [...index.skills, record].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };

  return {
    index: next,
    findings,
    changes,
    data: {
      id,
      library_path: libraryDir,
      library_only: libraryOnly === true,
      targets: describeTargets(targets, libraryOnly === true),
      checksum,
      status: record.validation.status,
      record_status: record.status,
    },
  };
}

/** 卸载：清理副本，按选项决定是否删除中心库原件，最后移除索引记录 */
export function uninstallSkill(input: UninstallInput): LifecycleOutcome {
  const { layout, index, id, now, hard, dryRun } = input;
  const workspaceRoot = layout.root;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) {
    return {
      index,
      findings: [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: id,
          message: `标识 ${id} 不在索引中`,
          remedy: '请先用列表指令确认该 Skill 是否已登记',
        }),
      ],
      changes: [],
      data: { rejected: 'not_registered', id },
    };
  }

  const findings: Finding[] = [];
  const changes: Change[] = [];
  const removed: string[] = [];

  // 一、从中心库原件读回落位路径：索引只保留目标摘要，落位路径只存在于元文件里
  const libraryDir = libraryPathOf(workspaceRoot, id);
  const libraryMetaFile = join(libraryDir, META_FILE_NAME);
  let copies: ResolvedTarget[] = [];
  if (existsSync(libraryMetaFile)) {
    try {
      const raw = parseYaml(readFileSync(libraryMetaFile, 'utf8'), {
        source: 'meta',
        target: libraryMetaFile,
      });
      copies = resolveTargets(workspaceRoot, raw as unknown as SkillMeta);
    } catch (error) {
      findings.push(toFinding(toKernelError(error, CODES.YAML_INVALID)));
    }
  } else {
    findings.push(
      finding(CODES.HASH_MISSING, {
        source: 'lifecycle',
        target: id,
        message: '中心库原件中缺少元文件，无法确定副本位置',
        remedy: '请手工确认并清理该 Skill 在各目标位置的副本',
      }),
    );
  }

  // 二、预演：列出将被删除与将被保留的路径，不执行任何删除
  if (dryRun === true) {
    const wouldRemove = copies.map((item) => item.absolutePath).filter((path) => pathExists(path));
    const planned: Change[] = wouldRemove.map((path): Change => ({
      action: 'remove',
      kind: 'target_copy',
      path,
    }));
    if (hard === true) planned.push({ action: 'remove', kind: 'library', path: libraryDir });
    return {
      index,
      findings,
      changes: planned,
      preview: true,
      data: {
        preview: true,
        id,
        would_remove: wouldRemove,
        library_kept: hard !== true,
        library_path: libraryDir,
        system_disabled: isCopyDisabled(libraryDir),
        backup_planned: true,
      },
    };
  }

  // 三、卸载前的备份：没有备份就不允许删除任何内容
  const backup = backupBeforeUninstall({ layout, id, now });
  if (!backup.created && backup.findings.length > 0) {
    return {
      index,
      findings: [...findings, ...backup.findings],
      changes: [],
      data: { rejected: 'backup_failed', ...backup.data },
    };
  }

  // 四、清理副本：失败则中止，索引与原件都不动
  for (const target of copies) {
    const copyPath = target.absolutePath;
    if (!pathExists(copyPath)) continue;
    try {
      removeTree(copyPath);
      removed.push(copyPath);
      changes.push({ action: 'remove', kind: 'target_copy', path: copyPath });
    } catch (error) {
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      return {
        index,
        findings: [...findings, toFinding(kernelError)],
        changes: [],
        data: { rejected: 'copy_cleanup_failed', rolled_back: false },
      };
    }
  }

  // 五、索引移除：先写索引，再按选项处理中心库原件
  const next: SkillIndex = {
    ...index,
    generated_at: now,
    skills: index.skills.filter((item) => item.id !== id),
  };

  // 六、按选项处理中心库原件
  if (hard === true) {
    try {
      removeTree(libraryDir);
      changes.push({ action: 'remove', kind: 'library', path: libraryDir });
    } catch (error) {
      // 原件删除失败时，索引已决定移除记录、副本已删；残留原件无害（不再被索引引用）
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      findings.push(
        finding(kernelError.code, {
          source: 'lifecycle',
          target: libraryDir,
          message: `中心库原件未能删除：${kernelError.message}`,
          remedy: '记录已从索引移除，残留的目录可手工清理；它不再被索引引用',
        }),
      );
    }
  }

  return {
    index: next,
    findings,
    changes,
    data: {
      id,
      removed_copies: removed,
      library_kept: hard !== true,
      library_path: libraryDir,
      system_disabled: isCopyDisabled(libraryDir),
      ...backup.data,
    },
  };
}

/** 把元文件与目标解析结果组装为索引记录 */
function toIndexRecord(
  meta: SkillMeta,
  targets: ResolvedTarget[],
  checksum: string,
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
function describeTargets(targets: ResolvedTarget[], libraryOnly: boolean): unknown[] {
  return targets.map((item) => ({
    target: item.target,
    scope: item.scope,
    path: item.declaredPath,
    enabled: libraryOnly ? false : item.enabled,
  }));
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function uniqueCodes(findings: Finding[]): string[] {
  return [...new Set(findings.map((item) => item.code))].sort();
}

function toFinding(error: KernelError): Finding {
  return finding(error.code, {
    source: error.source,
    target: error.target,
    message: error.message,
    remedy: error.remedy,
  });
}
