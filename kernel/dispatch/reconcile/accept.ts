/** T3 accept：以宿主内容/可见性为准更新工作区，但绝不在宿主副本上猜来源。 */
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODES,
  type Change,
  type Finding,
  type HostLandingIndex,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { computeChecksum, computeLandingChecksum } from '../../core/integrity/index.ts';
import { createBackup } from '../../store/backup-fs/index.ts';
import { readMetaFile } from '../../core/metadata/read.ts';
import type { SkillIndex, SkillMeta } from '../../core/metadata/types.ts';
import { projectRecord, safeDigests } from '../../core/lifecycle/shared.ts';
import { resolveTargets, type ResolvedTarget } from '../../core/targets/resolver/index.ts';
import {
  applyHostLandingRecords,
  buildHostLandingRecord,
  sourceMetaOf,
} from '../../core/host-landings/index.ts';
import { saveIndex, TOOL_VERSION } from '../../core/index/index.ts';
import { copyTree, removeTree } from '../../store/library-fs/index.ts';
import {
  findHostLanding,
  loadHostLandingsForWrite,
  saveHostLandings,
} from '../../store/host-landings/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { ReconcileExecutionItem } from './execution-types.ts';

const SOURCE_DRIFT = new Set(['source_changed', 'version_mismatch', 'source_ref_mismatch']);
const CONTENT_DRIFT = 'content_drift';
const VISIBILITY_DRIFT = 'visibility_mismatch';
const SKILL_MARKER = 'SKILL.md';
const DISABLED_MARKER = 'SKILL.md.disabled';

interface AcceptInput {
  item: ReconcilePlanItem;
  layout: WorkspaceLayout;
  index: SkillIndex;
  now: string;
}

interface AcceptContext {
  skillId: string;
  record: SkillIndex['skills'][number];
  libraryDir: string;
  metaRaw: Record<string, unknown>;
  targets: ResolvedTarget[];
  ledger: HostLandingIndex;
  existing?: import('@skill-manager/contract').HostLanding;
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

class AcceptError extends Error {
  readonly findings: Finding[];

  constructor(findings: Finding[]) {
    super(findings[0]?.message ?? 'accept failed');
    this.findings = findings;
  }
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

function sourceDriftOf(item: ReconcilePlanItem): string | undefined {
  return item.before.drift_reasons.find((reason) => SOURCE_DRIFT.has(reason));
}

function driftModes(item: ReconcilePlanItem): { content: boolean; visibility: boolean } {
  return {
    content: item.before.drift_reasons.includes(CONTENT_DRIFT),
    visibility: item.before.drift_reasons.includes(VISIBILITY_DRIFT),
  };
}

function acceptBase(input: AcceptInput): AcceptBase {
  const { item, layout, index } = input;
  if (item.format !== 'skill') {
    throw new AcceptError([
      invalid(
        item.target_path,
        'accept 只支持技能目录副本，规则文件不能反向重建中心库',
        '规则漂移请由对应宿主重新渲染或使用 repair',
      ),
    ]);
  }
  const sourceDrift = sourceDriftOf(item);
  if (sourceDrift !== undefined) {
    throw new AcceptError([
      invalid(
        item.skill_id ?? item.target_path,
        `accept 不接受来源/版本漂移：${sourceDrift}`,
        '请使用 reconcile --action repair，以工作区记录为来源基线',
      ),
    ]);
  }
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
): {
  ledger: HostLandingIndex;
  existing?: import('@skill-manager/contract').HostLanding;
} {
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
  };
}

function contextOf(input: AcceptInput): AcceptContext {
  const base = acceptBase(input);
  const modes = acceptModes(input.item);
  const ledger = acceptLedger(input, base.skillId);
  return {
    ...base,
    ...modes,
    ...ledger,
  };
}

function statusOf(context: AcceptContext): 'enabled' | 'disabled' {
  return context.observedVisibility === 'disabled' ? 'disabled' : 'enabled';
}

function nextRecordOf(
  context: AcceptContext,
  input: AcceptInput,
  checksum: string,
  digests: Record<string, string> | undefined,
): SkillIndex['skills'][number] {
  const projected = context.content
    ? projectRecord(context.record, context.metaRaw, context.targets, checksum, digests, input.now)
    : { ...context.record, updated_at: input.now };
  return context.visibility ? { ...projected, status: statusOf(context) } : projected;
}

function visibilityOf(context: AcceptContext): 'visible' | 'disabled' {
  if (context.visibility) return context.observedVisibility;
  if (context.existing !== undefined) return context.existing.visibility;
  return context.record.status === 'disabled' ? 'disabled' : 'visible';
}

function nextLedgerOf(
  context: AcceptContext,
  input: AcceptInput,
  sourceChecksum: string,
  contentDigest: string,
): HostLandingIndex {
  const hostId = input.item.host_ids[0] ?? '';
  const landing = buildHostLandingRecord({
    skillId: context.skillId,
    hostId,
    targetPath: input.item.target_path,
    format: 'skill',
    visibility: visibilityOf(context),
    origin: context.existing?.origin ?? 'adopted',
    sourceChecksum,
    contentDigest,
    sourceMeta: sourceMetaOf(context.metaRaw),
    now: input.now,
  });
  return applyHostLandingRecords(context.ledger, [landing]);
}

function changesOf(input: AcceptInput, content: boolean): Change[] {
  return [
    ...(content
      ? [
          {
            action: 'modify' as const,
            kind: 'library',
            path: join(input.layout.skillsDir, input.item.skill_id ?? ''),
          },
        ]
      : []),
    { action: 'modify', kind: 'index', path: input.layout.indexFile },
    { action: 'modify', kind: 'host_landings', path: input.layout.hostLandingsFile },
  ];
}

function saveVisibilityOnly(context: AcceptContext, input: AcceptInput): ReconcileExecutionItem {
  const nextIndex: SkillIndex = {
    ...input.index,
    generated_at: input.now,
    skills: input.index.skills.map((record) =>
      record.id === context.skillId
        ? nextRecordOf(context, input, record.checksum, record.digests)
        : record,
    ),
  };
  const contentDigest =
    input.item.before.content_digest ??
    computeLandingChecksum({ targetPath: input.item.target_path, format: 'skill' });
  const nextLedger = nextLedgerOf(
    context,
    input,
    context.existing?.source_checksum ?? context.record.checksum,
    contentDigest,
  );
  try {
    saveIndex(input.layout.indexFile, nextIndex);
  } catch (error) {
    return failure(input.item, [errorFinding(error, input.layout.indexFile)]);
  }
  try {
    saveHostLandings(input.layout.hostLandingsFile, {
      ...nextLedger,
      generated_at: input.now,
    });
  } catch (error) {
    try {
      saveIndex(input.layout.indexFile, input.index);
    } catch {
      // 原始账本失败优先返回；索引回滚失败不掩盖首个错误。
    }
    return failure(input.item, [errorFinding(error, input.layout.hostLandingsFile)]);
  }
  const changes = changesOf(input, false);
  return {
    result: {
      item_id: input.item.item_id,
      status: 'succeeded',
      target_path: input.item.target_path,
      after: input.item.after,
      message: '已按宿主可读可见性同步索引与账本',
      changes,
    },
    findings: [],
    changes,
  };
}

function prepareContent(
  context: AcceptContext,
  input: AcceptInput,
): {
  staging: string;
  checksum: string;
  digests?: Record<string, string>;
  nextRecord: SkillIndex['skills'][number];
} {
  const staging = mkdtempSync(join(input.layout.skillsDir, '.accept-'));
  try {
    copyTree(input.item.target_path, staging);
    for (const path of [
      join(staging, 'skill_meta.yaml'),
      join(staging, '.git'),
      join(staging, 'node_modules'),
    ]) {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    const visible = join(staging, SKILL_MARKER);
    const disabled = join(staging, DISABLED_MARKER);
    if (existsSync(visible) && existsSync(disabled)) {
      throw new AcceptError([
        invalid(staging, '宿主副本同时存在可见与禁用标记', '先修复副本标记冲突'),
      ]);
    }
    if (!existsSync(visible) && existsSync(disabled)) renameSync(disabled, visible);
    copyFileSync(join(context.libraryDir, 'skill_meta.yaml'), join(staging, 'skill_meta.yaml'));
    const checksum = computeChecksum(staging);
    const digests = safeDigests(staging);
    return {
      staging,
      checksum,
      ...(digests === undefined ? {} : { digests }),
      nextRecord: nextRecordOf(context, input, checksum, digests),
    };
  } catch (error) {
    if (existsSync(staging)) removeTree(staging);
    throw error;
  }
}

function commitContent(
  context: AcceptContext,
  input: AcceptInput,
  prepared: {
    staging: string;
    checksum: string;
    digests?: Record<string, string>;
    nextRecord: SkillIndex['skills'][number];
  },
): ReconcileExecutionItem {
  const oldDir = mkdtempSync(join(input.layout.skillsDir, '.accept-old-'));
  const oldLibrary = join(oldDir, 'library');
  const nextIndex: SkillIndex = {
    ...input.index,
    generated_at: input.now,
    skills: input.index.skills.map((record) =>
      record.id === context.skillId ? prepared.nextRecord : record,
    ),
  };
  const contentDigest = computeLandingChecksum({
    targetPath: input.item.target_path,
    format: 'skill',
  });
  const nextLedger = nextLedgerOf(context, input, prepared.checksum, contentDigest);
  try {
    renameSync(context.libraryDir, oldLibrary);
  } catch (error) {
    removeTree(prepared.staging);
    removeTree(oldDir);
    return failure(input.item, [errorFinding(error, context.libraryDir)]);
  }
  try {
    renameSync(prepared.staging, context.libraryDir);
  } catch (error) {
    renameSync(oldLibrary, context.libraryDir);
    removeTree(oldDir);
    return failure(input.item, [errorFinding(error, context.libraryDir)]);
  }
  try {
    saveIndex(input.layout.indexFile, nextIndex);
  } catch (error) {
    removeTree(context.libraryDir);
    renameSync(oldLibrary, context.libraryDir);
    removeTree(oldDir);
    return failure(input.item, [errorFinding(error, input.layout.indexFile)]);
  }
  try {
    saveHostLandings(input.layout.hostLandingsFile, {
      ...nextLedger,
      generated_at: input.now,
    });
  } catch (error) {
    try {
      saveIndex(input.layout.indexFile, input.index);
    } catch {
      // 账本失败是首要诊断；索引回滚失败由随后的账本 finding 保持可见。
    }
    removeTree(context.libraryDir);
    renameSync(oldLibrary, context.libraryDir);
    removeTree(oldDir);
    return failure(input.item, [errorFinding(error, input.layout.hostLandingsFile)]);
  }
  removeTree(oldDir);
  return {
    result: {
      item_id: input.item.item_id,
      status: 'succeeded',
      target_path: input.item.target_path,
      after: input.item.after,
      message: '已接受宿主本地内容；下次 update 可能以远端来源覆盖',
      changes: changesOf(input, true),
    },
    findings: [],
    changes: changesOf(input, true),
  };
}

/** 执行单个 accept；内容覆盖前创建标准备份，失败恢复原中心库与索引。 */
export function acceptItem(input: AcceptInput): ReconcileExecutionItem {
  let context: AcceptContext;
  try {
    context = contextOf(input);
  } catch (error) {
    return failure(
      input.item,
      error instanceof AcceptError ? error.findings : [errorFinding(error, input.item.target_path)],
    );
  }
  if (!context.content) return saveVisibilityOnly(context, input);
  let prepared: ReturnType<typeof prepareContent>;
  try {
    prepared = prepareContent(context, input);
  } catch (error) {
    return failure(
      input.item,
      error instanceof AcceptError ? error.findings : [errorFinding(error, input.item.target_path)],
    );
  }
  try {
    const checksum = computeChecksum(context.libraryDir);
    createBackup({
      workspaceRoot: input.layout.root,
      backupsDir: input.layout.backupsDir,
      id: context.skillId,
      sourceDir: context.libraryDir,
      now: input.now,
      checksum,
    });
  } catch (error) {
    removeTree(prepared.staging);
    return failure(input.item, [errorFinding(error, context.libraryDir)]);
  }
  return commitContent(context, input, prepared);
}
