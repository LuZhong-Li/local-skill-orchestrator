/** T2 adopt：把宿主实际内容导入中心库，并建立索引与 adopted 账本记录。 */
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODES,
  type Change,
  type Finding,
  type HostLandingVisibility,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { toIndexRecord } from '../../core/lifecycle/shared.ts';
import { computeChecksum } from '../../core/integrity/index.ts';
import type { IndexRecord, SkillIndex, SkillMeta } from '../../core/metadata/types.ts';
import { buildHostLandingRecord, applyHostLandingRecords } from '../../core/host-landings/index.ts';
import { saveIndex, TOOL_VERSION } from '../../core/index/index.ts';
import { removeTree } from '../../store/library-fs/index.ts';
import { createBackup } from '../../store/backup-fs/index.ts';
import { loadHostLandingsForWrite, saveHostLandings } from '../../store/host-landings/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import { renameWithRetry } from '../../store/atomic/index.ts';
import { AdoptError, prepareAdopt, type AdoptInput, type PreparedAdopt } from './adopt-source.ts';
import type { ReconcileExecutionItem } from './execution-types.ts';
import { ledgerHostIds } from './group.ts';

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

function recordOf(prepared: PreparedAdopt, input: AdoptInput): IndexRecord {
  return toIndexRecord(
    prepared.meta as unknown as SkillMeta,
    [prepared.target],
    prepared.checksum,
    prepared.digests,
    input.now,
    prepared.status === 'disabled',
  );
}

function rollbackAdopt(input: {
  layout: AdoptInput['layout'];
  oldIndex: SkillIndex;
  libraryDir: string;
}): Finding[] {
  const findings: Finding[] = [];
  try {
    saveIndex(input.layout.indexFile, input.oldIndex);
  } catch (error) {
    findings.push(errorFinding(error, input.layout.indexFile));
  }
  try {
    removeTree(input.libraryDir);
  } catch (error) {
    findings.push(errorFinding(error, input.libraryDir));
  }
  return findings;
}

function isForceReplace(input: AdoptInput, prepared: PreparedAdopt): boolean {
  return (
    input.item.adopt_preview?.conflict_policy === 'force' &&
    input.item.adopt_preview.conflict === 'different_content' &&
    existsSync(prepared.libraryDir)
  );
}

function indexForAdopt(input: AdoptInput, prepared: PreparedAdopt, replace: boolean): SkillIndex {
  const record = recordOf(prepared, input);
  const existing = input.index.skills.filter((item) => item.id !== prepared.skillId);
  const records = replace ? existing : input.index.skills;
  return {
    ...input.index,
    generated_at: input.now,
    skills: [...records, record].sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
}

function backupExisting(input: AdoptInput, prepared: PreparedAdopt): void {
  const record = input.index.skills.find((item) => item.id === prepared.skillId);
  createBackup({
    workspaceRoot: input.layout.root,
    backupsDir: input.layout.backupsDir,
    id: prepared.skillId,
    sourceDir: prepared.libraryDir,
    now: input.now,
    checksum: record?.checksum ?? computeChecksum(prepared.libraryDir),
  });
}

function moveExistingAside(prepared: PreparedAdopt): { root: string; library: string } {
  const root = mkdtempSync(join(prepared.libraryDir, '..', '.adopt-old-'));
  const library = join(root, 'library');
  renameWithRetry(prepared.libraryDir, library);
  return { root, library };
}

function restoreExisting(input: {
  libraryDir: string;
  previous?: { root: string; library: string };
}): void {
  if (existsSync(input.libraryDir)) removeTree(input.libraryDir);
  if (input.previous === undefined) return;
  if (existsSync(input.previous.library)) {
    renameWithRetry(input.previous.library, input.libraryDir);
  }
  removeTree(input.previous.root);
}

function rollbackReplace(input: {
  layout: AdoptInput['layout'];
  oldIndex: SkillIndex;
  libraryDir: string;
  previous: { root: string; library: string };
}): Finding[] {
  const findings: Finding[] = [];
  try {
    saveIndex(input.layout.indexFile, input.oldIndex);
  } catch (error) {
    findings.push(errorFinding(error, input.layout.indexFile));
  }
  try {
    restoreExisting({ libraryDir: input.libraryDir, previous: input.previous });
  } catch (error) {
    findings.push(errorFinding(error, input.libraryDir));
  }
  return findings;
}

function installLibrary(
  input: AdoptInput,
  prepared: PreparedAdopt,
  replace: boolean,
): { root: string; library: string } | undefined {
  let previous: { root: string; library: string } | undefined;
  try {
    if (replace) {
      backupExisting(input, prepared);
      previous = moveExistingAside(prepared);
    }
    renameWithRetry(prepared.staging, prepared.libraryDir);
    return previous;
  } catch (error) {
    if (previous !== undefined) {
      try {
        restoreExisting({ libraryDir: prepared.libraryDir, previous });
      } catch {
        // 恢复失败不掩盖原始落位失败；备份仍可用于人工恢复。
      }
    }
    try {
      removeTree(prepared.staging);
    } catch {
      // 暂存目录清理失败不掩盖原始落位失败；源宿主副本始终未被修改。
    }
    throw new AdoptError([errorFinding(error, prepared.libraryDir)]);
  }
}

function rollbackForPersistence(
  input: AdoptInput,
  previous: { root: string; library: string } | undefined,
  libraryDir: string,
): Finding[] {
  return previous === undefined
    ? rollbackAdopt({
        layout: input.layout,
        oldIndex: input.index,
        libraryDir,
      })
    : rollbackReplace({
        layout: input.layout,
        oldIndex: input.index,
        libraryDir,
        previous,
      });
}

function persistAdopt(
  input: AdoptInput,
  prepared: PreparedAdopt,
  nextIndex: SkillIndex,
  nextLedger: ReturnType<typeof applyHostLandingRecords>,
  previous: { root: string; library: string } | undefined,
): void {
  try {
    saveIndex(input.layout.indexFile, nextIndex);
  } catch (error) {
    throw new AdoptError([
      errorFinding(error, input.layout.indexFile),
      ...rollbackForPersistence(input, previous, prepared.libraryDir),
    ]);
  }
  try {
    saveHostLandings(input.layout.hostLandingsFile, {
      ...nextLedger,
      generated_at: input.now,
    });
  } catch (error) {
    throw new AdoptError([
      errorFinding(error, input.layout.hostLandingsFile),
      ...rollbackForPersistence(input, previous, prepared.libraryDir),
    ]);
  }
  if (previous !== undefined) removeTree(previous.root);
}

function changesForAdopt(input: AdoptInput, prepared: PreparedAdopt, replace: boolean): Change[] {
  const action = replace ? 'modify' : 'add';
  return [
    { action, kind: 'library', path: prepared.libraryDir },
    {
      action,
      kind: 'skill_meta',
      path: join(prepared.libraryDir, 'skill_meta.yaml'),
    },
    { action: 'modify', kind: 'index', path: input.layout.indexFile },
    { action: 'modify', kind: 'host_landings', path: input.layout.hostLandingsFile },
  ];
}

function commit(input: AdoptInput, prepared: PreparedAdopt): ReconcileExecutionItem {
  const loaded = loadHostLandingsForWrite(input.layout.hostLandingsFile, input.now, TOOL_VERSION);
  if (loaded.index === null) throw new AdoptError(loaded.findings);
  const hostIds = ledgerHostIds({
    is_plugin: false,
    host_ids: input.item.host_ids,
    consumed_by: input.item.consumed_by,
  });
  if (hostIds.length === 0) {
    throw new AdoptError([
      finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
        source: 'reconcile',
        target: input.item.target_path,
        message: 'adopt 找不到可记账的消费宿主',
        remedy: '确认宿主配置与注册表后重新盘点',
      }),
    ]);
  }
  const records = hostIds.map((hostId) =>
    buildHostLandingRecord({
      skillId: prepared.skillId,
      hostId,
      targetPath: input.item.target_path,
      format: 'skill',
      visibility: (input.item.visibility ?? 'visible') as HostLandingVisibility,
      origin: 'adopted',
      sourceChecksum: prepared.checksum,
      contentDigest: prepared.hostDigest,
      sourceMeta: {
        ...(prepared.version === undefined ? {} : { sourceVersion: prepared.version }),
      },
      now: input.now,
    }),
  );
  const nextLedger = applyHostLandingRecords(loaded.index, records);
  const replace = isForceReplace(input, prepared);
  const nextIndex = indexForAdopt(input, prepared, replace);
  const previous = installLibrary(input, prepared, replace);
  persistAdopt(input, prepared, nextIndex, nextLedger, previous);
  const changes = changesForAdopt(input, prepared, replace);
  return {
    result: {
      item_id: input.item.item_id,
      status: 'succeeded',
      target_path: input.item.target_path,
      after: input.item.after,
      ...(prepared.findings.length === 0 ? {} : { findings: prepared.findings }),
      changes,
    },
    findings: prepared.findings,
    changes,
  };
}

/** 执行单个 adopt；来源宿主副本只读，所有失败都在中心库/索引/账本上回滚。 */
export function adoptItem(input: AdoptInput): ReconcileExecutionItem {
  try {
    return commit(input, prepareAdopt(input));
  } catch (error) {
    return failure(
      input.item,
      error instanceof AdoptError ? error.findings : [errorFinding(error, input.item.target_path)],
    );
  }
}
