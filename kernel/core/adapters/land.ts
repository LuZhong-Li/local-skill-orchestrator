/**
 * K-15 适配器层：落位执行器（**本层唯一的写盘路径**）。
 *
 * 依据：T5 前置裁决——落位目标为宿主真实根；工作区外写安全沿用既有防线
 * （原子写 + 备份先行 + 确认机制由指令层承担）；启用/禁用按 Q-06 在宿主根内改名。
 *
 * 写盘纪律：
 * 一、只经本模块执行写盘，且只调用存储层的原子写与备份原语，不新增旁路；
 * 二、目录类落位（技能形态）写前先备份既有宿主副本目录，备份失败即中止，不改动环境；
 * 三、同一目标路径只写一次（重叠消费不重复产出，M5-R8）；
 * 四、`landable = false` 的落位项（指令文件载体）只登记不落盘；
 * 五、`dryRun` 只产出将执行的变更清单，不触碰磁盘。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CODES, finding, type Change, type Finding } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { atomicWriteFile } from '../../store/atomic/index.ts';
import { createBackup } from '../../store/backup-fs/index.ts';
import {
  deliverFiles,
  isCopyDisabled,
  isDirectory,
  pathExists,
  setCopyVisibility,
  type DeliveryPlanEntry,
} from '../../store/library-fs/index.ts';
import { computeChecksum } from '../integrity/index.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { PlacementPlan } from './types.ts';

const SOURCE = 'land';

/** 落位请求：计划 + 工作区 + 时间戳；可选给出中心库原件目录用于资产落位 */
export interface LandRequest {
  plan: PlacementPlan;
  workspace: WorkspaceLayout;
  /** 协调世界时秒级时间戳，用于备份命名（同秒重复备份自动扩展毫秒） */
  now: string;
  /** 中心库原件目录：给出时按逐文件映射把资产落到宿主副本目录 */
  sourceDir?: string;
  /** 逐文件落位计划（元文件 file_map）；空数组或缺省表示整目录复制 */
  fileMap?: DeliveryPlanEntry[];
  /** 预演：只产出变更清单，不写盘 */
  dryRun?: boolean;
}

/** 落位结果 */
export interface LandResult {
  host_id: string;
  target_id: string;
  skill_id: string;
  dry_run: boolean;
  changes: Change[];
  skipped: Array<{ target_path: string; reason: string }>;
  /** 本次产生的备份目录（可移植路径） */
  backups: string[];
  findings: Finding[];
}

/**
 * 写前备份（备份先行）。
 *
 * 目录类落位备份既有宿主副本目录；文件类落位（规则路径）以父目录为单位备份——
 * 备份存储以目录为载体，规则目录通常只含少量规则文件。
 */
function backupBeforeWrite(input: {
  workspace: WorkspaceLayout;
  skillId: string;
  /** 被备份的既有内容：技能形态为宿主副本目录，规则形态为规则文件所在目录 */
  backupSource: string;
  now: string;
}): string | undefined {
  const existingSource = input.backupSource;
  if (!pathExists(existingSource)) return undefined;
  if (!isDirectory(existingSource)) {
    throw new KernelError({
      code: CODES.BACKUP_FAILED,
      source: SOURCE,
      target: existingSource,
      message: '既有落位内容不是目录，无法按备份载体处理；已中止写盘',
      remedy: '先处理该路径上的文件，或在配置中改指到其他宿主根',
    });
  }
  const result = createBackup({
    workspaceRoot: input.workspace.root,
    backupsDir: input.workspace.backupsDir,
    id: input.skillId,
    sourceDir: existingSource,
    now: input.now,
    checksum: computeChecksum(existingSource),
  });
  return result.portableDir;
}

/**
 * 执行落位计划。
 *
 * 失败时抛出 KernelError（写盘失败为 E-IO-002，备份失败为 E-BAK-*）；
 * 备份先于写入，因此备份失败不会留下任何改动。
 */
export function landPlan(request: LandRequest): LandResult {
  const { plan, workspace, now } = request;
  const dryRun = request.dryRun === true;
  const changes: Change[] = [];
  const skipped: Array<{ target_path: string; reason: string }> = [];
  const backups: string[] = [];
  const findings: Finding[] = [];
  const written = new Set<string>();

  for (const entry of plan.entries) {
    if (!entry.landable) {
      skipped.push({
        target_path: entry.target_path,
        reason: entry.hold_reason ?? '该落位项标记为不可落盘',
      });
      continue;
    }
    if (written.has(entry.target_path)) {
      findings.push(
        finding(CODES.CONFLICT_OCCUPIED, {
          source: SOURCE,
          target: entry.target_path,
          message: '同一目标路径在同一计划中出现多次，已按一次落位处理',
          remedy: '重叠消费按「单次写盘、多宿主读取」处理，不重复产出副本（M5-R8）',
        }),
      );
      continue;
    }
    written.add(entry.target_path);

    const directoryTarget = entry.artifact_kind === 'skill_md';
    const existedBefore = pathExists(entry.target_path);
    if (!dryRun) {
      const backup = backupBeforeWrite({
        workspace,
        skillId: plan.skill_id,
        backupSource: directoryTarget ? entry.root_path : dirname(entry.target_path),
        now,
      });
      if (backup !== undefined) backups.push(backup);

      if (directoryTarget) {
        const targetDir = entry.root_path;
        mkdirSync(targetDir, { recursive: true });
        if (request.sourceDir !== undefined) {
          // 资产按逐文件映射（缺省整目录复制）；随后以渲染产物覆盖技能元数据文件
          deliverFiles(request.sourceDir, targetDir, request.fileMap ?? []);
        }
      } else {
        mkdirSync(dirname(entry.target_path), { recursive: true });
      }
      atomicWriteFile(entry.target_path, entry.content);
    }

    changes.push({
      action: existedBefore ? 'modify' : 'add',
      kind: entry.artifact_kind,
      path: entry.target_path,
      detail: dryRun
        ? '预演：将写入该目标'
        : directoryTarget
          ? `技能形态落位（消费宿主：${entry.consumed_by.join('、') || '自身'}）`
          : '规则文件落位',
    });
  }

  return {
    host_id: plan.host_id,
    target_id: plan.target_id,
    skill_id: plan.skill_id,
    dry_run: dryRun,
    changes,
    skipped,
    backups,
    findings,
  };
}

/**
 * 在宿主真实根内切换技能副本的可见性（启用 / 禁用）。
 *
 * 沿用受控副本原语：只把副本内的技能元数据文件改名为带禁用后缀的名称，
 * 不移动、不重命名、不删除任何目录（Q-06 的三端结论）。
 */
export function setHostSkillVisibility(input: {
  rootPath: string;
  skillId: string;
  enabled: boolean;
}): 'changed' | 'unchanged' {
  const copyDir = join(input.rootPath, input.skillId);
  return setCopyVisibility(copyDir, input.enabled);
}

/** 宿主副本当前是否处于禁用态 */
export function isHostSkillDisabled(input: { rootPath: string; skillId: string }): boolean {
  return isCopyDisabled(join(input.rootPath, input.skillId));
}
