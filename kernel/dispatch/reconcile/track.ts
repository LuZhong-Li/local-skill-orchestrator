/** T2 track：工作区已有且内容一致时，仅补内置宿主账本。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODES,
  type Change,
  type Finding,
  type HostLandingVisibility,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { computeChecksum, computeLandingChecksum } from '../../core/integrity/index.ts';
import { buildHostLandingRecord, applyHostLandingRecords } from '../../core/host-landings/index.ts';
import { TOOL_VERSION } from '../../core/index/index.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import {
  findHostLanding,
  loadHostLandingsForWrite,
  saveHostLandings,
} from '../../store/host-landings/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import type { ReconcileExecutionItem } from './adopt.ts';

interface TrackInput {
  item: ReconcilePlanItem;
  layout: WorkspaceLayout;
  index: SkillIndex;
  now: string;
}

interface TrackTarget {
  skillId: string;
  hostId: string;
}

interface TrackBaseline {
  record: SkillIndex['skills'][number];
  sourceChecksum: string;
}

function errorFinding(cause: unknown, target: string): Finding {
  const error = toKernelError(cause, CODES.IO_FAILED);
  return finding(error.code, {
    source: error.source,
    target: error.target || target,
    message: error.message,
    remedy: error.remedy,
  });
}

function failure(item: ReconcilePlanItem, findings: Finding[]): ReconcileExecutionItem {
  return {
    result: {
      item_id: item.item_id,
      status: 'failed',
      target_path: item.target_path,
      findings,
      ...(item.after === undefined ? {} : { after: item.after }),
    },
    findings,
    changes: [],
  };
}

function invalid(target: string, message: string, remedy: string): Finding {
  return finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
    source: 'reconcile',
    target,
    message,
    remedy,
  });
}

function trackTargetOf(item: ReconcilePlanItem): { target?: TrackTarget; finding?: Finding } {
  const skillId = item.skill_id;
  if (skillId === undefined) {
    return {
      finding: invalid(item.target_path, 'track 缺少技能标识', '重新盘点后再执行'),
    };
  }
  if (item.host_ids.length !== 1 || item.consumed_by.length > 1) {
    return {
      finding: finding(CODES.RECONCILE_SHARED_GROUP, {
        source: 'reconcile',
        target: item.target_path,
        message: '共享根整组 track 留到 T4',
        remedy: '请等待共享根事务组支持后再执行',
      }),
    };
  }
  const hostId = item.host_ids[0] ?? '';
  if (hostId.startsWith('x-')) {
    return {
      finding: invalid(hostId, '插件 x- 宿主的 track 留到 T4', '插件账本由插件包维护'),
    };
  }
  return { target: { skillId, hostId } };
}

function baselineOf(
  input: TrackInput,
  skillId: string,
): { baseline?: TrackBaseline; finding?: Finding } {
  const { layout, index } = input;
  const workspaceRecord = index.skills.find((record) => record.id === skillId);
  if (workspaceRecord === undefined) {
    return {
      finding: invalid(skillId, 'track 需要工作区已有该 Skill', '请先执行 adopt 或 install'),
    };
  }
  const libraryDir = join(layout.skillsDir, skillId);
  if (!existsSync(libraryDir)) {
    return {
      finding: finding(CODES.PATH_INVALID, {
        source: 'reconcile',
        target: libraryDir,
        message: 'track 需要中心库原件存在',
        remedy: '请先修复中心库或重新扫描',
      }),
    };
  }
  const sourceChecksum = computeChecksum(libraryDir);
  if (workspaceRecord.checksum !== sourceChecksum) {
    return {
      finding: finding(CODES.RECONCILE_PLAN_STALE, {
        source: 'reconcile',
        target: libraryDir,
        message: '工作区索引摘要与中心库实际内容不一致',
        remedy: '重新扫描并确认工作区基线后再执行 track',
      }),
    };
  }
  return { baseline: { record: workspaceRecord, sourceChecksum } };
}

function duplicateFinding(
  index: import('@skill-manager/contract').HostLandingIndex,
  input: { skillId: string; hostId: string; targetPath: string },
): Finding | undefined {
  const existing = findHostLanding(index, {
    skill_id: input.skillId,
    host_id: input.hostId,
    target_path: input.targetPath,
  });
  if (existing === undefined) return undefined;
  return finding(CODES.RECONCILE_PLAN_STALE, {
    source: 'reconcile',
    target: input.targetPath,
    message: '该宿主副本已有账本记录，track 不需要重复写入',
    remedy: '重新盘点确认分类后再执行',
  });
}

function commitTrack(
  input: TrackInput & {
    skillId: string;
    hostId: string;
    baseline: TrackBaseline;
    ledgerIndex: import('@skill-manager/contract').HostLandingIndex;
  },
): ReconcileExecutionItem {
  const { item, layout, now, skillId, hostId, baseline } = input;
  const contentDigest =
    item.before.content_digest ??
    computeLandingChecksum({
      targetPath: item.target_path,
      format: item.format === 'rules' ? 'rules' : 'skill',
    });
  const landing = buildHostLandingRecord({
    skillId,
    hostId,
    targetPath: item.target_path,
    format: item.format === 'rules' ? 'rules' : 'skill',
    visibility: (item.visibility ?? 'visible') as HostLandingVisibility,
    origin: 'adopted',
    sourceChecksum: baseline.sourceChecksum,
    contentDigest,
    sourceMeta: {
      ...(baseline.record.version === undefined ? {} : { sourceVersion: baseline.record.version }),
    },
    now,
  });
  try {
    saveHostLandings(layout.hostLandingsFile, {
      ...applyHostLandingRecords(input.ledgerIndex, [landing]),
      generated_at: now,
    });
  } catch (error) {
    return failure(item, [errorFinding(error, layout.hostLandingsFile)]);
  }
  const change: Change = {
    action: 'modify',
    kind: 'host_landings',
    path: layout.hostLandingsFile,
    detail: `补记 adopted 宿主副本：${skillId} / ${hostId}`,
  };
  return {
    result: {
      item_id: item.item_id,
      status: 'succeeded',
      target_path: item.target_path,
      after: item.after,
      changes: [change],
    },
    findings: [],
    changes: [change],
  };
}

function recordOf(input: TrackInput): ReconcileExecutionItem {
  const { item, now } = input;
  const target = trackTargetOf(item);
  if (target.finding !== undefined) return failure(item, [target.finding]);
  const identified = target.target;
  if (identified === undefined) {
    return failure(item, [invalid(item.target_path, 'track 缺少技能标识', '重新盘点后再执行')]);
  }
  const baseline = baselineOf(input, identified.skillId);
  if (baseline.finding !== undefined) return failure(item, [baseline.finding]);
  if (baseline.baseline === undefined) {
    return failure(item, [invalid(identified.skillId, 'track 缺少工作区基线', '重新扫描后再执行')]);
  }
  const loaded = loadHostLandingsForWrite(input.layout.hostLandingsFile, now, TOOL_VERSION);
  if (loaded.index === null) return failure(item, loaded.findings);
  const duplicate = duplicateFinding(loaded.index, {
    skillId: identified.skillId,
    hostId: identified.hostId,
    targetPath: item.target_path,
  });
  if (duplicate !== undefined) return failure(item, [duplicate]);
  return commitTrack({
    ...input,
    ...identified,
    baseline: baseline.baseline,
    ledgerIndex: loaded.index,
  });
}

/** 执行单个 track；只写账本，不碰中心库、索引或宿主文件。 */
export function trackItem(input: TrackInput): ReconcileExecutionItem {
  try {
    return recordOf(input);
  } catch (error) {
    return failure(input.item, [errorFinding(error, input.item.target_path)]);
  }
}
