/**
 * K-18 内置宿主账本编排。
 *
 * 只负责把一次已完成的宿主副本操作转换为账本记录，并在账本写入失败时
 * 调用调用方提供的物理回滚。物理副本的写盘与摘要计算仍由 adapters /
 * integrity 承担，本模块不直接写宿主目录。
 */
import { CODES } from '@skill-manager/contract';
import { KernelError, toKernelError } from '../../store/errors.ts';
import {
  findHostLanding,
  saveHostLandings,
  syncActiveHostLandings,
  upsertHostLanding,
  type HostLandingPatch,
} from '../../store/host-landings/index.ts';
import type {
  HostLanding,
  HostLandingIndex,
  HostLandingOrigin,
  HostLandingVisibility,
} from '@skill-manager/contract';
import { REGISTRY_VERSION } from '../hosts/types.ts';
import { hostById } from '../hosts/index.ts';
import type { AdapterForm, PlacementPlan } from '../adapters/types.ts';

export interface LandingSourceMeta {
  sourceVersion?: string;
  sourceRef?: string;
}

export interface HostLandingCommitInput {
  file: string;
  index: HostLandingIndex;
  rollback: () => void;
  /** 测试注入点：替换原子写，用于验证账本失败后的物理回滚。 */
  save?: (file: string, index: HostLandingIndex) => void;
}

export interface HostLandingCommitResult {
  ok: boolean;
  error?: KernelError;
  rollbackError?: KernelError;
}

/** 账本写入失败时回滚物理副本；回滚失败单独报告为 E-LANDING-001。 */
export function commitHostLandings(input: HostLandingCommitInput): HostLandingCommitResult {
  try {
    (input.save ?? saveHostLandings)(input.file, input.index);
    return { ok: true };
  } catch (cause) {
    const error = toKernelError(cause, CODES.IO_ATOMIC_FAILED);
    try {
      input.rollback();
      return { ok: false, error };
    } catch (rollbackCause) {
      return {
        ok: false,
        error,
        rollbackError: new KernelError({
          code: CODES.LANDING_LEDGER_INVALID,
          message: `宿主账本写入失败且物理副本回滚失败：${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`,
          source: 'host-landings',
          target: input.file,
          remedy: '停止继续分发，检查宿主副本与 host_landings.yaml 的实际状态后手工修复',
          cause: rollbackCause,
        }),
      };
    }
  }
}

/** 适配器形态 → 账本形态；entry 没有物理副本，返回 undefined。 */
export function landingFormatOf(form: AdapterForm): 'skill' | 'rules' | undefined {
  if (form === 'skill') return 'skill';
  if (form === 'rules') return 'rules';
  return undefined;
}

/** 账本 target_path：技能形态是副本目录，规则形态是规则文件。 */
export function landingTargetPathOf(plan: PlacementPlan, form: AdapterForm): string | undefined {
  const placement = plan.entries.find((entry) => entry.landable);
  if (placement === undefined) return undefined;
  return form === 'rules' ? placement.target_path : placement.root_path;
}

export function sourceMetaOf(raw: Record<string, unknown>): LandingSourceMeta {
  const result: LandingSourceMeta = {};
  const version = raw['version'];
  if (typeof version === 'string' && version.trim() !== '') result.sourceVersion = version;
  const source = raw['source'];
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const ref = (source as Record<string, unknown>)['ref'];
    if (typeof ref === 'string' && ref.trim() !== '') result.sourceRef = ref;
  }
  return result;
}

export function buildHostLandingRecord(input: {
  skillId: string;
  hostId: string;
  targetPath: string;
  format: 'skill' | 'rules';
  visibility: HostLandingVisibility;
  origin: HostLandingOrigin;
  sourceChecksum: string;
  contentDigest: string;
  sourceMeta?: LandingSourceMeta;
  now: string;
}): HostLanding {
  const record: HostLanding = {
    skill_id: input.skillId,
    host_id: input.hostId,
    target_path: input.targetPath,
    format: input.format,
    visibility: input.visibility,
    state: 'active',
    origin: input.origin,
    source_checksum: input.sourceChecksum,
    content_digest: input.contentDigest,
    adapter_ref: hostById(input.hostId)?.adapter_ref ?? input.hostId,
    registry_version: REGISTRY_VERSION,
    created_at: input.now,
    updated_at: input.now,
  };
  if (input.sourceMeta?.sourceVersion !== undefined) {
    record.source_version = input.sourceMeta.sourceVersion;
  }
  if (input.sourceMeta?.sourceRef !== undefined) record.source_ref = input.sourceMeta.sourceRef;
  return record;
}

function patchOf(record: HostLanding): HostLandingPatch {
  const patch: HostLandingPatch = {
    content_digest: record.content_digest,
    source_checksum: record.source_checksum,
    visibility: record.visibility,
    updated_at: record.updated_at,
  };
  if (record.source_version !== undefined) patch.source_version = record.source_version;
  if (record.source_ref !== undefined) patch.source_ref = record.source_ref;
  return patch;
}

/** 写入一条或多条记录，并同步同一物理路径上的全部活跃记录。 */
export function applyHostLandingRecords(
  index: HostLandingIndex,
  records: readonly HostLanding[],
): HostLandingIndex {
  let next = index;
  for (const record of records) next = upsertHostLanding(next, record);
  for (const path of new Set(records.map((record) => record.target_path))) {
    const representative = records.find((record) => record.target_path === path);
    if (representative !== undefined) {
      next = syncActiveHostLandings(next, path, patchOf(representative));
    }
  }
  return next;
}

/**
 * enable/disable 的 adopted 路径：已有记录保持 origin，缺失记录以 adopted 入账。
 * 返回值同时告诉调用方本次是否新建了记录。
 */
export function recordAdoptedVisibility(input: {
  index: HostLandingIndex;
  skillId: string;
  hostId: string;
  targetPath: string;
  visibility: HostLandingVisibility;
  sourceChecksum: string;
  contentDigest: string;
  sourceMeta?: LandingSourceMeta;
  now: string;
}): { index: HostLandingIndex; adopted: boolean; origin: HostLandingOrigin } {
  const existing = findHostLanding(input.index, {
    skill_id: input.skillId,
    host_id: input.hostId,
    target_path: input.targetPath,
  });
  const record = buildHostLandingRecord({
    skillId: input.skillId,
    hostId: input.hostId,
    targetPath: input.targetPath,
    format: 'skill',
    visibility: input.visibility,
    origin: existing?.origin ?? 'adopted',
    sourceChecksum: input.sourceChecksum,
    contentDigest: input.contentDigest,
    ...(input.sourceMeta === undefined ? {} : { sourceMeta: input.sourceMeta }),
    now: input.now,
  });
  const merged: HostLanding = {
    ...(existing ?? {}),
    ...record,
    created_at: existing?.created_at ?? record.created_at,
  };
  return {
    index: applyHostLandingRecords(input.index, [merged]),
    adopted: existing === undefined,
    origin: record.origin,
  };
}
