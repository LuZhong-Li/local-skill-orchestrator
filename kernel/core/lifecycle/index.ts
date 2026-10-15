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
import { judgeDependency } from '../metadata/validate.ts';
import { readMetaFile } from '../metadata/read.ts';
import { computeChecksum, computeDigests } from '../integrity/index.ts';
import { detectMappingConflicts, detectOccupationConflicts } from '../conflict/index.ts';
import { backupBeforeUninstall } from '../backup/index.ts';
import {
  libraryPathOf,
  resolveTargetById,
  resolveTargets,
  type ResolvedTarget,
} from '../targets/resolver/index.ts';
import {
  countTreeFiles,
  copyTree,
  deliverFiles,
  isDirectory,
  isCopyDisabled,
  listTreeFiles,
  pathExists,
  replaceTree,
  removeTree,
  setCopyVisibility,
} from '../../store/library-fs/index.ts';
import {
  BACKUP_CONTENT_DIR_NAME,
  BACKUP_TYPE_VALUES,
  listBackups,
  verifyBackup,
} from '../../store/backup-fs/index.ts';
import { ID_PATTERN } from '../metadata/constants.ts';
import type { SkillTarget } from '../metadata/types.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import { toPortablePath } from '../../store/paths/index.ts';
import {
  acquireFromPath,
  acquireSource,
  readDeclaredSource,
  releaseSource,
  type AcquiredSource,
} from './source.ts';
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
  /** 只向指定目标分发；省略时分发到全部声明的目标 */
  target?: string;
  /** 仅落库：只写中心库与登记记录，不分发到目标位置，状态置为已禁用 */
  libraryOnly?: boolean;
  /** 预演：返回将要发生的变更，不写入任何文件 */
  dryRun?: boolean;
  /** 只向指定作用域的目标分发 */
  scope?: string;
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

/**
 * 安装：先取出来源，再交给同步主体完成校验与落位。
 * 临时目录一律在本函数内释放，主体不需要关心来源是目录、仓库还是归档。
 */
export async function installSkill(input: InstallInput): Promise<LifecycleOutcome> {
  let acquired: AcquiredSource;
  try {
    acquired = await acquireFromPath(input.sourcePath);
  } catch (error) {
    const kernelError = toKernelError(error, CODES.SRC_UNRESOLVED);
    return {
      index: input.index,
      findings: [toFinding(kernelError)],
      changes: [],
      data: { rejected: 'source_unavailable' },
    };
  }
  try {
    return installFromSource(input, acquired.dir);
  } finally {
    releaseSource(acquired);
  }
}

/** 安装主体：来源内容已经在 sourceDir 里就位，本函数只做校验与编排 */
function installFromSource(input: InstallInput, sourceDir: string): LifecycleOutcome {
  const { layout, index, sourcePath, now, libraryOnly, dryRun, target, scope } = input;
  const workspaceRoot = layout.root;
  const findings: Finding[] = [];
  const changes: Change[] = [];

  let located: { metaFile: string; sourceDir: string };
  try {
    located = locateMetaFile(sourceDir);
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
  // 五之后：按选项选定本次实际分发的目标
  const selected = targets.filter(
    (item) =>
      (target === undefined || item.target === target) &&
      (scope === undefined || item.scope === scope),
  );
  if ((target !== undefined || scope !== undefined) && selected.length === 0) {
    return {
      index,
      findings: [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: target ?? scope ?? '',
          message: '指定的目标或作用域没有匹配到该 Skill 声明的落位目标',
          remedy: `请从声明的目标中挑选：${targets.map((item) => item.target).join('、') || '（无）'}`,
        }),
      ],
      changes: [],
      data: {},
    };
  }

  findings.push(...detectMappingConflicts(id, selected));
  findings.push(...detectOccupationConflicts(id, selected));
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
        library_path: toPortablePath(layout.root, libraryDir),
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
  const delivered: Array<Record<string, unknown>> = [];
  // 仅落库：不分发到目标位置，副本留待启用指令补齐
  for (const item of libraryOnly === true ? [] : selected) {
    try {
      const files = deliverFiles(libraryDir, item.absolutePath, planOf(item.fileMap));
      if (!item.enabled) setCopyVisibility(item.absolutePath, false);
      created.push(item.absolutePath);
      changes.push({ action: 'add', kind: 'target_copy', path: item.absolutePath });
      delivered.push({
        target: item.target,
        scope: item.scope,
        path: item.declaredPath,
        file_count: files.length,
        // 逐文件落位计划：预演与实装呈现同一份列表
        files: files.map((rel) => `${item.declaredPath}/${rel}`),
      });
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

  // 九、登记索引：派生区由内核写入（聚合指纹与逐文件摘要两级共存）
  const record: IndexRecord = toIndexRecord(
    meta,
    selected,
    checksum,
    safeDigests(libraryDir),
    now,
    libraryOnly === true,
  );
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
      library_path: toPortablePath(layout.root, libraryDir),
      library_only: libraryOnly === true,
      targets: describeTargets(selected, libraryOnly === true),
      delivery: delivered,
      selected_targets: selected.map((item) => item.target),
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
  let removedFiles = 0;

  // 一、按目标落位根约定定位副本：只依赖索引中的目标摘要与 Skill 标识，
  //     因此中心库原件缺失时仍能回收副本（N-09 的解决点）
  const libraryDir = libraryPathOf(workspaceRoot, id);
  let copies: ResolvedTarget[];
  try {
    copies = record.targets.map((item) =>
      resolveTargetById(workspaceRoot, item.target, id, item.scope, item.enabled),
    );
  } catch (error) {
    return {
      index,
      findings: [toFinding(toKernelError(error, CODES.PATH_INVALID))],
      changes: [],
      data: {},
    };
  }

  // 二、预演：列出将被删除与将被保留的路径，不执行任何删除
  if (dryRun === true) {
    const detail = copies
      .filter((item) => pathExists(item.absolutePath))
      .map((item) => {
        const files = listTreeFiles(item.absolutePath);
        return {
          path: item.declaredPath,
          file_count: files.length,
          // N-06：影响范围落到逐文件粒度
          files: files.map((rel) => `${item.declaredPath}/${rel}`),
        };
      });
    const wouldRemove = detail.map((item) => item.path);
    const planned: Change[] = wouldRemove.map((path): Change => ({
      action: 'remove',
      kind: 'target_copy',
      path,
    }));
    let libraryFiles = 0;
    if (hard === true) {
      libraryFiles = countTreeFiles(libraryDir);
      planned.push({ action: 'remove', kind: 'library', path: libraryDir });
    }
    return {
      index,
      findings,
      changes: planned,
      preview: true,
      data: {
        preview: true,
        id,
        would_remove: wouldRemove,
        // 契约 2.4：强制二次确认须逐条列出影响范围与文件数量
        would_remove_detail: detail,
        would_remove_file_count:
          detail.reduce((sum, item) => sum + item.file_count, 0) + libraryFiles,
        library_kept: hard !== true,
        library_path: toPortablePath(layout.root, libraryDir),
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
  const removedFilePaths: string[] = [];
  for (const item of copies) {
    const copyPath = item.absolutePath;
    if (!pathExists(copyPath)) continue;
    try {
      // 逐文件路径必须在删除前统计（N-06）
      const files = listTreeFiles(copyPath).map((rel) => `${item.declaredPath}/${rel}`);
      removeTree(copyPath);
      removedFilePaths.push(...files);
      removedFiles += files.length;
      // 载荷里的位置统一用相对工作区的可移植路径，便于跨机器阅读
      removed.push(item.declaredPath);
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
      // N-06：影响范围落到逐文件粒度
      removed_files: removedFilePaths,
      removed_file_count: removedFiles,
      library_kept: hard !== true,
      library_path: toPortablePath(layout.root, libraryDir),
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

/** 逐文件摘要：与聚合指纹同源同范围；重算失败时返回 undefined，表示待回填而非伪造取值 */
function safeDigests(dir: string): Record<string, string> | undefined {
  try {
    return computeDigests(dir);
  } catch {
    return undefined;
  }
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

export interface ToggleInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 只作用于指定目标；省略时作用于全部已落位目标 */
  target?: string;
  scope?: string;
  dryRun?: boolean;
}

/**
 * 由索引记录推导落位目标（副本位置按约定算出，不依赖中心库原件是否存在），
 * 并尽力读取原件元文件补上逐文件映射；元文件缺失不构成失败，此时按整目录复制处理。
 */
function targetsOfRecord(input: {
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
function planOf(fileMap: Record<string, string>): Array<{ source: string; destination: string }> {
  return Object.entries(fileMap).map(([source, destination]) => ({
    source,
    destination,
  }));
}

/** 由记录与受影响目标构造下一份索引 */
function withTargets(
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
export function enableSkill(input: ToggleInput): LifecycleOutcome {
  const { layout, index, id, now, target, scope, dryRun } = input;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) return notRegistered(id, index);

  // 不可用条件 2：校验不通过一律拒绝，且不得表述为「已被禁用」
  if (record.validation.status === 'invalid') {
    return {
      index,
      findings: [
        finding(CODES.VALIDATION_REJECTED, {
          source: 'lifecycle',
          target: id,
          message: `该 Skill 的校验不通过，拒绝启用。问题码：${record.validation.errors.join('、') || '（无明细）'}`,
          remedy: '请先修复上述问题并重新扫描；该拒绝与「已被禁用」语义不同，二者不得混用',
        }),
      ],
      changes: [],
      data: { rejected: 'validation_failed', problem_codes: record.validation.errors },
    };
  }

  // 不可用条件 3：依赖未满足
  const availability = new Map(
    index.skills.map((item) => [item.id, item.validation.status === 'ok']),
  );
  const dependencyFindings: Finding[] = [];
  for (const raw of record.dependencies ?? []) {
    const name = raw.trim().split(' ')[0] ?? '';
    if (name === '') continue;
    const verdict = judgeDependency(name, availability);
    if (verdict === 'missing') {
      dependencyFindings.push(
        finding(CODES.DEP_MISSING, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 不在索引中，拒绝启用`,
          remedy: `请先安装 ${name}，或从依赖声明中移除该项后重新扫描`,
        }),
      );
    } else if (verdict === 'invalid') {
      dependencyFindings.push(
        finding(CODES.VALIDATION_DEPENDENCY, {
          source: 'dependency',
          target: id,
          message: `依赖的 Skill ${name} 校验不通过，依赖未满足，拒绝启用`,
          remedy: `请先修复 ${name} 的问题并重新扫描`,
        }),
      );
    }
  }
  if (dependencyFindings.length > 0) {
    return {
      index,
      findings: dependencyFindings,
      changes: [],
      data: { rejected: 'dependency_unmet' },
    };
  }

  const resolved = targetsOfRecord({ layout, record, target, scope });
  if (resolved.targets.length === 0 && resolved.findings.length > 0) {
    return {
      index,
      findings: resolved.findings,
      changes: [],
      data: { rejected: 'targets_unreadable' },
    };
  }

  const libraryDir = libraryPathOf(layout.root, id);
  const findings: Finding[] = [];
  const changes: Change[] = [];
  const targetStates: Array<Record<string, unknown>> = [];
  const planned: Change[] = [];

  for (const item of resolved.targets) {
    const copyPath = item.absolutePath;
    const missing = !pathExists(copyPath);
    const before = missing ? null : isCopyDisabled(copyPath) ? 'disabled' : 'enabled';
    if (missing) planned.push({ action: 'add', kind: 'target_copy', path: copyPath });
    if (before === 'disabled') {
      planned.push({ action: 'modify', kind: 'copy_marker', path: copyPath });
    }
    targetStates.push({
      target: item.target,
      scope: item.scope,
      path: item.declaredPath,
      existed: !missing,
      state_before: before,
      state_after: 'enabled',
    });
  }

  if (dryRun === true) {
    return {
      index,
      findings,
      changes: [...planned, { action: 'modify', kind: 'index_record', path: record.path }],
      preview: true,
      data: {
        preview: true,
        id,
        status_before: record.status,
        status_after: 'enabled',
        targets: targetStates,
      },
    };
  }

  // 幂等：状态与副本都已是目标态时不产生任何变更，也不刷新最近变更时间
  const summaryDrifted = resolved.targets.some(
    (item) =>
      record.targets.find((entry) => entry.target === item.target && entry.scope === item.scope)
        ?.enabled !== true,
  );
  if (planned.length === 0 && record.status === 'enabled' && !summaryDrifted) {
    return {
      index,
      findings,
      changes: [],
      data: {
        id,
        status_before: record.status,
        status_after: 'enabled',
        targets: targetStates,
        unchanged: true,
      },
    };
  }

  for (const item of resolved.targets) {
    try {
      if (!pathExists(item.absolutePath)) {
        // 按需补齐：文件不存在时按落位方式把中心库原件补到目标位置，映射表存在时按逐文件落位
        deliverFiles(libraryDir, item.absolutePath, planOf(item.fileMap));
        changes.push({ action: 'add', kind: 'target_copy', path: item.absolutePath });
      }
      if (setCopyVisibility(item.absolutePath, true) === 'changed') {
        changes.push({ action: 'modify', kind: 'copy_marker', path: item.absolutePath });
      }
    } catch (error) {
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      findings.push(toFinding(kernelError));
      return { index, findings, changes: [], data: { rejected: 'copy_toggle_failed' } };
    }
  }

  const next = withTargets(index, id, 'enabled', resolved.targets, now);
  if (next !== index) changes.push({ action: 'modify', kind: 'index_record', path: record.path });
  return {
    index: next,
    findings,
    changes,
    data: {
      id,
      status_before: record.status,
      status_after: 'enabled',
      targets: targetStates,
      unchanged: changes.length === 0,
    },
  };
}

/**
 * 禁用（契约 4.10）。
 *
 * 只切换可见性：把副本内的技能元数据文件改名为带禁用后缀的名称，不删除任何内容文件，
 * 也不触发内容分发。副本不存在的目标只有索引状态变更，实际动作在载荷中说明。
 */
export function disableSkill(input: ToggleInput): LifecycleOutcome {
  const { layout, index, id, now, target, scope, dryRun } = input;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) return notRegistered(id, index);

  const resolved = targetsOfRecord({ layout, record, target, scope });
  if (resolved.targets.length === 0 && resolved.findings.length > 0) {
    return {
      index,
      findings: resolved.findings,
      changes: [],
      data: { rejected: 'targets_unreadable' },
    };
  }

  // 第一遍只做判定，不落盘：得到将发生的变更与各目标的前后状态
  const targetStates: Array<Record<string, unknown>> = [];
  const pending: Array<{ path: string; declared: string; existed: boolean }> = [];
  for (const item of resolved.targets) {
    const copyPath = item.absolutePath;
    const existed = pathExists(copyPath);
    const before = existed ? (isCopyDisabled(copyPath) ? 'disabled' : 'enabled') : null;
    if (!existed) {
      targetStates.push({
        target: item.target,
        scope: item.scope,
        path: item.declaredPath,
        existed: false,
        state_before: null,
        state_after: 'disabled',
      });
      continue;
    }
    if (before === 'enabled')
      pending.push({ path: copyPath, declared: item.declaredPath, existed });
    targetStates.push({
      target: item.target,
      scope: item.scope,
      path: item.declaredPath,
      existed: true,
      state_before: before,
      state_after: 'disabled',
    });
  }
  const summaryDrifted =
    record.status !== 'disabled' ||
    resolved.targets.some(
      (item) =>
        record.targets.find((entry) => entry.target === item.target && entry.scope === item.scope)
          ?.enabled !== false,
    );

  if (dryRun === true) {
    return {
      index,
      findings: [],
      changes: [
        ...pending.map((item): Change => ({
          action: 'modify',
          kind: 'copy_marker',
          path: item.path,
        })),
        ...(summaryDrifted
          ? [{ action: 'modify' as const, kind: 'index_record', path: record.path }]
          : []),
      ],
      preview: true,
      data: {
        preview: true,
        id,
        status_before: record.status,
        status_after: 'disabled',
        targets: targetStates,
        actions: [
          ...pending.map((item) => `副本 ${item.declared} 内的技能元数据文件将改为禁用态`),
          ...targetStates
            .filter((item) => item['existed'] === false)
            .map((item) => `目标 ${String(item['target'])} 尚未落位，将只更新索引状态`),
        ],
      },
    };
  }

  // 幂等：副本与状态都已是目标态时不产生任何变更
  if (pending.length === 0 && !summaryDrifted) {
    return {
      index,
      findings: [],
      changes: [],
      data: {
        id,
        status_before: record.status,
        status_after: 'disabled',
        targets: targetStates,
        actions: ['副本与索引状态均已是禁用态，无需改动'],
      },
    };
  }

  const changes: Change[] = [];
  const actions: string[] = [];
  for (const item of pending) {
    try {
      if (setCopyVisibility(item.path, false) === 'changed') {
        changes.push({ action: 'modify', kind: 'copy_marker', path: item.path });
        actions.push(`副本 ${item.declared} 内的技能元数据文件已改为禁用态`);
      }
    } catch (error) {
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      return {
        index,
        findings: [toFinding(kernelError)],
        changes: [],
        data: { rejected: 'copy_toggle_failed' },
      };
    }
  }
  for (const item of targetStates) {
    if (item['existed'] === false)
      actions.push(`目标 ${String(item['target'])} 尚未落位，仅更新索引状态`);
  }

  const next = withTargets(index, id, 'disabled', resolved.targets, now);
  changes.push({ action: 'modify', kind: 'index_record', path: record.path });
  return {
    index: next,
    findings: [],
    changes,
    data: {
      id,
      status_before: record.status,
      status_after: 'disabled',
      targets: targetStates,
      actions: actions.length > 0 ? actions : ['无需改动副本，仅更新索引状态'],
    },
  };
}

/** 标识不在索引中的统一回应：索引原样返回，调用方据此跳过写入 */
function notRegistered(id: string, index: SkillIndex): LifecycleOutcome {
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

export interface UpdateInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 只检查并报告漂移与版本差异，不写入任何文件 */
  check?: boolean;
  /** 只刷新指定目标的副本；省略时刷新全部已存在的副本 */
  target?: string | undefined;
}

/**
 * 刷新一个已登记 Skill 的记录（契约 4.11）。
 *
 * 按来源声明决定是否重新获取内容：
 *   本地目录与来源未知 → 不重新获取，按磁盘现状刷新记录；
 *   本地仓库与归档文件 → 先按声明重新获取并替换中心库原件，再刷新记录与副本。
 * 获取失败时不刷新记录（E-SRC 系列），因此不会出现「记录已刷新而内容仍旧」的状态。
 * 元文件本身与用户源文件一律不改写（AMB-01）。
 *
 * `--check` 只做检查：报告本地漂移与版本差异，不写盘、不改动索引。
 */
export async function updateSkill(input: UpdateInput): Promise<LifecycleOutcome> {
  const libraryDir = libraryPathOf(input.layout.root, input.id);
  const declared = readDeclaredSource(join(libraryDir, META_FILE_NAME));
  const refetchable =
    declared !== null &&
    (declared.type === 'git' || declared.type === 'archive') &&
    (declared.location ?? '') !== '';
  if (!refetchable) {
    return updateFromSource(input, null);
  }

  let acquired: AcquiredSource;
  try {
    acquired = await acquireSource({
      type: declared.type,
      location: declared.location as string,
      ref: declared.ref,
    });
  } catch (error) {
    return {
      index: input.index,
      findings: [toFinding(toKernelError(error, CODES.SRC_UNRESOLVED))],
      changes: [],
      data: { rejected: 'source_unavailable' },
    };
  }
  try {
    return updateFromSource(input, acquired.dir);
  } finally {
    releaseSource(acquired);
  }
}

export interface RestoreInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  id: string;
  now: string;
  /** 指定备份时间戳；省略时取该 Skill 最新的备份 */
  timestamp?: string | undefined;
  /** 预演：返回将恢复的文件清单，不写入任何文件 */
  dryRun?: boolean;
}

/**
 * 从备份载体恢复一个 Skill（契约 4.16）。
 *
 * 次序：定位并校验载体 → 内容放回中心库 → 重分发副本 → 刷新或重建索引记录。
 * 载体是只读消费，恢复不改动任何备份。
 * 运行期结论不在这里预判：记录已存在时保持原结论不动，记录重建时取保守值，
 * 两种情况都在载荷里提示执行扫描。
 */
export function restoreSkill(input: RestoreInput): LifecycleOutcome {
  const { layout, index, id, now, timestamp, dryRun } = input;
  if (!ID_PATTERN.test(id)) {
    return {
      index,
      findings: [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: id,
          message: `标识不符合命名规范：${id}`,
          remedy: '标识需为全小写、短横线分隔',
        }),
      ],
      changes: [],
      data: { rejected: 'invalid_id' },
    };
  }

  const backups = listBackups(layout.root, layout.backupsDir, id);
  if (backups.length === 0) {
    return {
      index,
      findings: [
        finding(CODES.BACKUP_MISSING, {
          source: 'lifecycle',
          target: id,
          message: `没有可恢复的备份载体：${id}`,
          remedy: '卸载该 Skill 时会自动生成备份；请确认备份目录是否被清理过',
        }),
      ],
      changes: [],
      data: { rejected: 'no_backup', available: [] },
    };
  }

  const selected =
    timestamp === undefined || timestamp === ''
      ? backups[backups.length - 1]
      : backups.find((item) => item.timestamp === timestamp);
  if (selected === undefined) {
    return {
      index,
      findings: [
        finding(CODES.INPUT_INVALID_ARG, {
          source: 'input',
          target: String(timestamp),
          message: `该标识没有指定时间戳的备份：${String(timestamp)}`,
          remedy: `可选时间戳：${backups.map((item) => item.timestamp).join('、')}`,
        }),
      ],
      changes: [],
      data: { rejected: 'timestamp_not_found', available: backups.map((item) => item.timestamp) },
    };
  }

  if (!BACKUP_TYPE_VALUES.includes(selected.type as (typeof BACKUP_TYPE_VALUES)[number])) {
    return {
      index,
      findings: [
        finding(CODES.BACKUP_TYPE_UNSUPPORTED, {
          source: 'lifecycle',
          target: selected.portableDir,
          message: `备份载体类型不受支持：${selected.type}`,
          remedy: `当前支持的类型为 ${BACKUP_TYPE_VALUES.join('、')}`,
        }),
      ],
      changes: [],
      data: { rejected: 'type_unsupported', backup_type: selected.type },
    };
  }

  const verified = verifyBackup(selected);
  if (!verified.ok) {
    return {
      index,
      findings: [
        finding(CODES.BACKUP_CORRUPT, {
          source: 'lifecycle',
          target: selected.portableDir,
          message: `备份载体校验不通过：${verified.problem}`,
          remedy: '请改用其他时间戳的备份；该载体的内容已不可信',
        }),
      ],
      changes: [],
      data: { rejected: 'backup_corrupt' },
    };
  }

  const contentDir = join(selected.dir, BACKUP_CONTENT_DIR_NAME);
  const read = readMetaFile(contentDir, id);
  const metaFindings =
    read.raw === null
      ? read.findings
      : validateMetaRecord(read.raw, { dirName: id, dirPath: contentDir });
  if (read.raw === null || metaFindings.some((item) => item.severity === 'error')) {
    return {
      index,
      findings: [
        finding(CODES.BACKUP_CORRUPT, {
          source: 'lifecycle',
          target: selected.portableDir,
          message: '备份载体内的元文件不可用或不合格',
          remedy: '请改用其他时间戳的备份；该载体的内容已不可信',
        }),
        ...metaFindings,
      ],
      changes: [],
      data: { rejected: 'backup_corrupt' },
    };
  }

  const meta = read.raw as unknown as SkillMeta;
  const record = index.skills.find((item) => item.id === id);
  const libraryDir = libraryPathOf(layout.root, id);

  // 目标：已登记时沿用记录里的启用状态，未登记时按元文件声明的目标
  let targets: ResolvedTarget[];
  try {
    targets =
      record === undefined
        ? resolveTargets(layout.root, meta)
        : record.targets.map((item) =>
            resolveTargetById(layout.root, item.target, id, item.scope, item.enabled),
          );
  } catch (error) {
    return {
      index,
      findings: [toFinding(toKernelError(error, CODES.PATH_INVALID))],
      changes: [],
      data: {},
    };
  }

  const fileMapByTarget = new Map<string, Record<string, string>>();
  if (Array.isArray(meta.targets)) {
    for (const entry of meta.targets) {
      if (entry === null || typeof entry !== 'object') continue;
      const item = entry as unknown as SkillTarget;
      if (typeof item.target === 'string') fileMapByTarget.set(item.target, item.file_map ?? {});
    }
  }
  const contentFiles = listTreeFiles(contentDir);

  if (dryRun === true) {
    const libraryExists = pathExists(libraryDir);
    return {
      index,
      findings: [],
      changes: [{ action: 'modify', kind: 'library', path: libraryDir }],
      preview: true,
      data: {
        preview: true,
        id,
        backup_path: selected.portableDir,
        backup_timestamp: selected.timestamp,
        backup_type: selected.type,
        library_exists: libraryExists,
        action: record === undefined ? 'rebuild_record' : 'refresh_record',
        files: contentFiles.map((rel) => `${toPortablePath(layout.root, libraryDir)}/${rel}`),
        file_count: contentFiles.length,
        targets: targets.map((item) => item.declaredPath),
        // 确认弹窗展示的提示：覆盖风险与「结论由扫描判定」都必须写在预演载荷里，界面不自行编造
        notes: [
          libraryExists
            ? '目标位置已有中心库原件：确认后会被备份内容覆盖'
            : '目标位置当前没有原件：确认后会按备份内容重建',
          record === undefined
            ? '该标识未登记：恢复会重建索引记录，运行期结论交由随后的扫描判定'
            : '该标识已登记：恢复会刷新记录投影与派生区，运行期结论保持不变',
          '恢复只读消费备份载体，不改动任何备份',
        ],
      },
    };
  }

  // 目标被非本工具内容占用时拒绝：覆盖目录与覆盖文件的风险完全不同
  if (pathExists(libraryDir) && !isDirectory(libraryDir)) {
    return {
      index,
      findings: [
        finding(CODES.CONFLICT_OCCUPIED, {
          source: 'lifecycle',
          target: toPortablePath(layout.root, libraryDir),
          message: '中心库位置已被同名文件占用，无法写回原件',
          remedy: '请先移走该文件，再重新执行恢复',
        }),
      ],
      changes: [],
      data: { rejected: 'target_occupied' },
    };
  }

  // 一、内容放回中心库
  try {
    replaceTree(contentDir, libraryDir);
  } catch (error) {
    return {
      index,
      findings: [toFinding(toKernelError(error, CODES.IO_FAILED))],
      changes: [],
      data: { rejected: 'library_restore_failed' },
    };
  }
  const changes: Change[] = [
    { action: record === undefined ? 'add' : 'modify', kind: 'library', path: libraryDir },
  ];

  // 二、重分发副本：已存在的保持原有可见性，不存在的按声明创建
  const restored: Array<Record<string, unknown>> = [];
  for (const item of targets) {
    const existed = pathExists(item.absolutePath);
    const wasEnabled = existed ? !isCopyDisabled(item.absolutePath) : item.enabled;
    try {
      const files = deliverFiles(
        libraryDir,
        item.absolutePath,
        planOf(fileMapByTarget.get(item.target) ?? {}),
      );
      setCopyVisibility(item.absolutePath, wasEnabled);
      restored.push({
        target: item.target,
        scope: item.scope,
        path: item.declaredPath,
        created: !existed,
        enabled: wasEnabled,
        file_count: files.length,
        files: files.map((rel) => `${item.declaredPath}/${rel}`),
      });
      changes.push({
        action: existed ? 'modify' : 'add',
        kind: 'target_copy',
        path: item.absolutePath,
      });
    } catch (error) {
      return {
        index,
        findings: [...metaFindings, toFinding(toKernelError(error, CODES.IO_FAILED))],
        changes: [],
        data: { rejected: 'redistribute_failed' },
      };
    }
  }

  // 三、刷新或重建索引记录
  let checksum = '';
  try {
    checksum = computeChecksum(libraryDir);
  } catch {
    checksum = '';
  }
  const refreshed: IndexRecord =
    record === undefined
      ? rebuildRecord(meta, targets, checksum, safeDigests(libraryDir), now)
      : { ...projectRecord(record, read.raw, targets, checksum, safeDigests(libraryDir), now) };
  const next: SkillIndex = {
    ...index,
    generated_at: now,
    skills:
      record === undefined
        ? [...index.skills, refreshed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        : index.skills.map((item) => (item.id === id ? refreshed : item)),
  };
  changes.push({
    action: record === undefined ? 'add' : 'modify',
    kind: 'index_record',
    path: refreshed.path,
  });

  return {
    index: next,
    findings: metaFindings,
    changes,
    data: {
      id,
      record_action: record === undefined ? 'rebuilt' : 'refreshed',
      backup_path: selected.portableDir,
      backup_timestamp: selected.timestamp,
      backup_type: selected.type,
      library_path: toPortablePath(layout.root, libraryDir),
      files: contentFiles.map((rel) => `${toPortablePath(layout.root, libraryDir)}/${rel}`),
      file_count: contentFiles.length,
      targets: restored,
      notes: ['恢复只写回内容与记录，不判定校验结论；请在恢复后执行扫描刷新运行期结论'],
    },
  };
}

/** 按元文件重建一条索引记录：用于恢复一个已卸载的 Skill */
function rebuildRecord(
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
function updateFromSource(input: UpdateInput, fetchedDir: string | null): LifecycleOutcome {
  const { layout, index, id, now, check, target } = input;
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) return notRegistered(id, index);

  // 一、按声明重新获取内容时，先替换中心库原件；此时尚未改动索引，失败不会刷新记录
  if (fetchedDir !== null) {
    const libraryDir = libraryPathOf(layout.root, id);
    if (!check) {
      try {
        replaceTree(fetchedDir, libraryDir);
      } catch (error) {
        return {
          index,
          findings: [toFinding(toKernelError(error, CODES.IO_FAILED))],
          changes: [],
          data: { rejected: 'library_refresh_failed' },
        };
      }
    }
  }

  const libraryDir = libraryPathOf(layout.root, id);
  const read = readMetaFile(libraryDir, id);
  if (read.raw === null) {
    return {
      index,
      findings: read.findings,
      changes: [],
      data: { rejected: 'meta_unreadable' },
    };
  }
  const context: MetaContext = { dirName: id, dirPath: libraryDir };
  const metaFindings = validateMetaRecord(read.raw, context);
  if (metaFindings.some((item) => item.severity === 'error')) {
    return {
      index,
      findings: metaFindings,
      changes: [],
      data: { rejected: 'invalid_metadata', problem_codes: uniqueCodes(metaFindings) },
    };
  }

  const checksum = computeChecksum(libraryDir);
  const raw = read.raw;
  const meta = raw as unknown as SkillMeta;
  const findings: Finding[] = [...metaFindings];
  if (record.checksum !== '' && record.checksum !== checksum) {
    findings.push(
      finding(CODES.DRIFT, {
        source: 'meta',
        target: id,
        message: `本地内容与记录不一致：记录指纹 ${record.checksum}，重算指纹 ${checksum}`,
        remedy: '本次刷新会按磁盘现状更新记录；如需保留原内容，请先还原磁盘文件',
      }),
    );
  }

  let targets: ResolvedTarget[];
  try {
    targets = resolveTargets(layout.root, meta);
  } catch (error) {
    const kernelError = toKernelError(error, CODES.PATH_INVALID);
    return { index, findings: [toFinding(kernelError)], changes: [], data: {} };
  }

  const versionBefore = record.version ?? null;
  const versionAfter = meta.version ?? null;
  const summary = {
    id,
    version_before: versionBefore,
    version_after: versionAfter,
    version_changed: versionBefore !== versionAfter,
    checksum_before: record.checksum,
    checksum_after: checksum,
    updated_at: now,
    created_at: record.created_at,
    targets: targets.map((item) => ({
      target: item.target,
      scope: item.scope,
      path: item.declaredPath,
    })),
    notes: ['刷新会按落位计划把副本内容一并更新；任一处落位失败则整体不生效'],
  };

  if (check === true) {
    return {
      index,
      findings,
      changes: [],
      preview: true,
      data: { ...summary, checked: true },
    };
  }

  // 先重分发副本，再写索引：顺序反过来会留下「记录已刷新、副本仍是旧内容」的中间态。
  // 只刷新已存在的副本，不新建副本——分发是安装与启用的职责。
  const copied: Array<Record<string, unknown>> = [];
  const refreshable = targets.filter(
    (item) => (target === undefined || item.target === target) && pathExists(item.absolutePath),
  );
  for (const item of refreshable) {
    const wasEnabled = !isCopyDisabled(item.absolutePath);
    try {
      const files = deliverFiles(libraryDir, item.absolutePath, planOf(item.fileMap));
      // 落位会带回技能元数据文件，按该副本原有可见性恢复状态，避免刷新把禁用态改成启用态
      setCopyVisibility(item.absolutePath, wasEnabled);
      copied.push({
        target: item.target,
        scope: item.scope,
        path: item.declaredPath,
        file_count: files.length,
        files: files.map((rel) => `${item.declaredPath}/${rel}`),
      });
    } catch (error) {
      const kernelError = toKernelError(error, CODES.IO_FAILED);
      return {
        index,
        findings: [...findings, toFinding(kernelError)],
        changes: [],
        data: { rejected: 'redistribute_failed', rolled_back: true },
      };
    }
  }

  const next: SkillIndex = {
    ...index,
    generated_at: now,
    skills: index.skills.map((item) =>
      item.id === id
        ? projectRecord(item, raw, targets, checksum, safeDigests(libraryDir), now)
        : item,
    ),
  };
  return {
    index: next,
    findings,
    changes: [
      ...copied.map((item): Change => ({
        action: 'modify',
        kind: 'target_copy',
        path: String(item['path']),
      })),
      { action: 'modify', kind: 'index_record', path: record.path },
    ],
    data: { ...summary, copies: copied },
  };
}

/**
 * 按元文件重新投影一条记录。
 * 声明区字段以元文件为准（索引格式规范 3.2：更新刷新投影字段与派生区字段）；
 * 启用状态与各目标的可见性属于运行期事实，保持记录原值，新声明的目标沿用其声明取值；
 * 首次登记时间不变，运行期结论不属本指令的写入范围。
 */
function projectRecord(
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
