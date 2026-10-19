/** K-04 恢复命令。 */
import { join } from 'node:path';
import { ID_PATTERN } from '../metadata/constants.ts';
import type { IndexRecord, SkillIndex, SkillMeta, SkillTarget } from '../metadata/types.ts';
import { validateMetaRecord } from '../metadata/validate.ts';
import { readMetaFile } from '../metadata/read.ts';
import { computeChecksum } from '../integrity/index.ts';
import {
  libraryPathOf,
  resolveTargetById,
  resolveTargets,
  type ResolvedTarget,
} from '../targets/resolver/index.ts';
import {
  deliverFiles,
  isCopyDisabled,
  isDirectory,
  listTreeFiles,
  pathExists,
  replaceTree,
  setCopyVisibility,
} from '../../store/library-fs/index.ts';
import { toPortablePath } from '../../store/paths/index.ts';
import {
  BACKUP_CONTENT_DIR_NAME,
  BACKUP_TYPE_VALUES,
  listBackups,
  verifyBackup,
} from '../../store/backup-fs/index.ts';
import { CODES, finding, type Change } from '../../store/contract.ts';
import { toKernelError } from '../../store/errors.ts';
import type { LifecycleOutcome, RestoreInput } from './types.ts';
import { planOf, projectRecord, rebuildRecord, safeDigests, toFinding } from './shared.ts';
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
