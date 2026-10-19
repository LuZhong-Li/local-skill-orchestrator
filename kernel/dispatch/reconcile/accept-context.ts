/** accept 的只读前置与上下文；与内容暂存/提交分离，控制单文件规模。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODES,
  type Finding,
  type HostLanding,
  type HostLandingIndex,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { readMetaFile } from '../../core/metadata/read.ts';
import type { SkillIndex, SkillMeta } from '../../core/metadata/types.ts';
import { resolveTargets, type ResolvedTarget } from '../../core/targets/resolver/index.ts';
import { findHostLanding, loadHostLandingsForWrite } from '../../store/host-landings/index.ts';
import { TOOL_VERSION } from '../../core/index/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { ledgerHostIds } from './group.ts';

export const SOURCE_DRIFT = new Set(['source_changed', 'version_mismatch', 'source_ref_mismatch']);
export const CONTENT_DRIFT = 'content_drift';
export const VISIBILITY_DRIFT = 'visibility_mismatch';

export interface AcceptInput {
  item: ReconcilePlanItem;
  layout: WorkspaceLayout;
  index: SkillIndex;
  now: string;
}

export interface AcceptContext {
  skillId: string;
  record: SkillIndex['skills'][number];
  libraryDir: string;
  metaRaw: Record<string, unknown>;
  targets: ResolvedTarget[];
  ledger: HostLandingIndex;
  existing?: HostLanding;
  hostIds: string[];
  content: boolean;
  visibility: boolean;
  observedVisibility: 'visible' | 'disabled';
}

interface AcceptBase {
  skillId: string;
  record: SkillIndex['skills'][number];
  libraryDir: string;
  metaRaw: Record<string, unknown>;
  targets: ResolvedTarget[];
}

export class AcceptError extends Error {
  readonly findings: Finding[];

  constructor(findings: Finding[]) {
    super(findings[0]?.message ?? 'accept failed');
    this.findings = findings;
  }
}

export function errorFinding(cause: unknown, target: string): Finding {
  const error = toKernelError(cause, CODES.IO_FAILED);
  return finding(error.code, {
    source: error.source,
    target: error.target || target,
    message: error.message,
    remedy: error.remedy,
  });
}

export function invalid(target: string, message: string, remedy: string): Finding {
  return finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
    source: 'reconcile',
    target,
    message,
    remedy,
  });
}

export function sourceDriftOf(item: ReconcilePlanItem): string | undefined {
  return item.before.drift_reasons.find((reason) => SOURCE_DRIFT.has(reason));
}

export function driftModes(item: ReconcilePlanItem): { content: boolean; visibility: boolean } {
  return {
    content: item.before.drift_reasons.includes(CONTENT_DRIFT),
    visibility: item.before.drift_reasons.includes(VISIBILITY_DRIFT),
  };
}

function assertAcceptShape(item: ReconcilePlanItem): void {
  if (item.format !== 'skill') {
    throw new AcceptError([
      invalid(
        item.target_path,
        'accept 只支持技能目录副本，规则文件不能反向重建中心库',
        '规则漂移请由对应宿主重新渲染或使用 repair',
      ),
    ]);
  }
  const drift = sourceDriftOf(item);
  if (drift !== undefined) {
    throw new AcceptError([
      invalid(
        item.skill_id ?? item.target_path,
        `accept 不接受来源/版本漂移：${drift}`,
        '请使用 reconcile --action repair，以工作区记录为来源基线',
      ),
    ]);
  }
  const firstHost = item.host_ids[0] ?? '';
  if (firstHost.startsWith('x-')) {
    throw new AcceptError([
      invalid(
        firstHost,
        '插件 x- 宿主不支持 accept',
        '插件技能内容归插件包；请使用 repair 或 clean 处理插件副本',
      ),
    ]);
  }
}

function workspaceBase(input: AcceptInput): AcceptBase {
  const { item, layout, index } = input;
  const skillId = item.skill_id;
  if (skillId === undefined) {
    throw new AcceptError([invalid(item.target_path, 'accept 缺少技能标识', '重新盘点后再执行')]);
  }
  const record = index.skills.find((entry) => entry.id === skillId);
  if (record === undefined) {
    throw new AcceptError([
      invalid(skillId, 'accept 需要工作区已有该 Skill', '请先使用 adopt 或 install'),
    ]);
  }
  const libraryDir = join(layout.skillsDir, skillId);
  if (!existsSync(libraryDir)) {
    throw new AcceptError([
      finding(CODES.PATH_INVALID, {
        source: 'reconcile',
        target: libraryDir,
        message: 'accept 需要中心库原件存在',
        remedy: '先修复中心库或重新扫描',
      }),
    ]);
  }
  const metaRead = readMetaFile(libraryDir, skillId);
  if (metaRead.raw === null) throw new AcceptError(metaRead.findings);
  let targets: ResolvedTarget[];
  try {
    targets = resolveTargets(layout.root, metaRead.raw as unknown as SkillMeta);
  } catch (error) {
    throw new AcceptError([errorFinding(error, skillId)]);
  }
  return { skillId, record, libraryDir, metaRaw: metaRead.raw, targets };
}

function acceptModes(item: ReconcilePlanItem): {
  content: boolean;
  visibility: boolean;
  observedVisibility: 'visible' | 'disabled';
} {
  const modes = driftModes(item);
  if (!modes.content && !modes.visibility) {
    throw new AcceptError([
      invalid(
        item.skill_id ?? item.target_path,
        'accept 只处理内容或可见性漂移',
        'source/version 漂移请使用 repair',
      ),
    ]);
  }
  const observedVisibility =
    item.visibility === 'disabled'
      ? 'disabled'
      : item.visibility === 'visible'
        ? 'visible'
        : undefined;
  if (modes.visibility && observedVisibility === undefined) {
    throw new AcceptError([
      invalid(item.target_path, 'accept 无法读取宿主副本可见性', '重新盘点后再执行'),
    ]);
  }
  return {
    content: modes.content,
    visibility: modes.visibility,
    observedVisibility: observedVisibility ?? 'visible',
  };
}

function acceptLedger(
  input: AcceptInput,
  skillId: string,
): { ledger: HostLandingIndex; existing?: HostLanding; hostIds: string[] } {
  const loaded = loadHostLandingsForWrite(input.layout.hostLandingsFile, input.now, TOOL_VERSION);
  if (loaded.index === null) throw new AcceptError(loaded.findings);
  const hostId = input.item.host_ids[0] ?? '';
  const existing = findHostLanding(loaded.index, {
    skill_id: skillId,
    host_id: hostId,
    target_path: input.item.target_path,
  });
  return {
    ledger: loaded.index,
    ...(existing === undefined ? {} : { existing }),
    hostIds: ledgerHostIds({
      is_plugin: false,
      host_ids: input.item.host_ids,
      consumed_by: input.item.consumed_by,
    }),
  };
}

export function acceptContextOf(input: AcceptInput): AcceptContext {
  assertAcceptShape(input.item);
  const base = workspaceBase(input);
  const modes = acceptModes(input.item);
  const ledger = acceptLedger(input, base.skillId);
  return { ...base, ...modes, ...ledger };
}
