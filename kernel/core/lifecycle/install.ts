/** K-04 安装命令。 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { META_FILE_NAME } from '../metadata/constants.ts';
import type { IndexRecord, SkillIndex, SkillMeta } from '../metadata/types.ts';
import { validateMetaRecord, type MetaContext } from '../metadata/validate.ts';
import { computeChecksum } from '../integrity/index.ts';
import { detectMappingConflicts, detectOccupationConflicts } from '../conflict/index.ts';
import { libraryPathOf, resolveTargets, type ResolvedTarget } from '../targets/resolver/index.ts';
import {
  copyTree,
  deliverFiles,
  removeTree,
  setCopyVisibility,
} from '../../store/library-fs/index.ts';
import { toPortablePath } from '../../store/paths/index.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import { acquireFromPath, releaseSource, type AcquiredSource } from './source.ts';
import { CODES, type Change, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { KernelError, toKernelError } from '../../store/errors.ts';
import type { InstallInput, LifecycleOutcome } from './types.ts';
import {
  describeTargets,
  planOf,
  safeDigests,
  toFinding,
  toIndexRecord,
  uniqueCodes,
} from './shared.ts';
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
