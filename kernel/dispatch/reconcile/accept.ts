/** T3 accept：以宿主内容/可见性为准更新工作区，但绝不在宿主副本上猜来源。 */
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Change,
  type Finding,
  type HostLanding,
  type HostLandingIndex,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { computeChecksum, computeLandingChecksum } from '../../core/integrity/index.ts';
import { createBackup } from '../../store/backup-fs/index.ts';
import { projectRecord, safeDigests } from '../../core/lifecycle/shared.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import {
  applyHostLandingRecords,
  buildHostLandingRecord,
  sourceMetaOf,
} from '../../core/host-landings/index.ts';
import { saveIndex } from '../../core/index/index.ts';
import { copyTree, removeTree } from '../../store/library-fs/index.ts';
import { saveHostLandings } from '../../store/host-landings/index.ts';
import type { ReconcileExecutionItem } from './execution-types.ts';
import {
  AcceptError,
  errorFinding,
  invalid,
  acceptContextOf,
  type AcceptContext,
  type AcceptInput,
} from './accept-context.ts';

const SKILL_MARKER = 'SKILL.md';
const DISABLED_MARKER = 'SKILL.md.disabled';

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

function visibilityOf(context: AcceptContext, existing?: HostLanding): 'visible' | 'disabled' {
  if (context.visibility) return context.observedVisibility;
  if (existing !== undefined) return existing.visibility;
  return context.record.status === 'disabled' ? 'disabled' : 'visible';
}

function nextLedgerOf(
  context: AcceptContext,
  input: AcceptInput,
  sourceChecksum: string,
  contentDigest: string,
): HostLandingIndex {
  const records = context.hostIds.map((hostId) => {
    const existing = context.ledger.landings.find(
      (record) =>
        record.skill_id === context.skillId &&
        record.host_id === hostId &&
        record.target_path === input.item.target_path,
    );
    return buildHostLandingRecord({
      skillId: context.skillId,
      hostId,
      targetPath: input.item.target_path,
      format: 'skill',
      visibility: visibilityOf(context, existing),
      origin: existing?.origin ?? 'adopted',
      sourceChecksum,
      contentDigest,
      sourceMeta: sourceMetaOf(context.metaRaw),
      now: input.now,
    });
  });
  return applyHostLandingRecords(context.ledger, records);
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
  const changes = changesOf(input, true);
  return {
    result: {
      item_id: input.item.item_id,
      status: 'succeeded',
      target_path: input.item.target_path,
      after: input.item.after,
      message: '已接受宿主本地内容；下次 update 可能以远端来源覆盖',
      changes,
    },
    findings: [],
    changes,
  };
}

/** 执行单个 accept；内容覆盖前创建标准备份，失败恢复原中心库与索引。 */
export function acceptItem(input: AcceptInput): ReconcileExecutionItem {
  let context: AcceptContext;
  try {
    context = acceptContextOf(input);
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
