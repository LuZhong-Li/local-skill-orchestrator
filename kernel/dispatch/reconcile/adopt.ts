/** T2 adopt：把宿主实际内容导入中心库，并建立索引与 adopted 账本记录。 */
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODES,
  type Change,
  type Finding,
  type HostLandingVisibility,
  type ReconcilePlanItem,
} from '@skill-manager/contract';
import { toIndexRecord } from '../../core/lifecycle/shared.ts';
import type { IndexRecord, SkillIndex, SkillMeta } from '../../core/metadata/types.ts';
import { buildHostLandingRecord, applyHostLandingRecords } from '../../core/host-landings/index.ts';
import { saveIndex, TOOL_VERSION } from '../../core/index/index.ts';
import { removeTree } from '../../store/library-fs/index.ts';
import { loadHostLandingsForWrite, saveHostLandings } from '../../store/host-landings/index.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import { AdoptError, prepareAdopt, type AdoptInput, type PreparedAdopt } from './adopt-source.ts';
import type { ReconcileExecutionItem } from './execution-types.ts';

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

function commit(input: AdoptInput, prepared: PreparedAdopt): ReconcileExecutionItem {
  const loaded = loadHostLandingsForWrite(input.layout.hostLandingsFile, input.now, TOOL_VERSION);
  if (loaded.index === null) throw new AdoptError(loaded.findings);
  const hostId = input.item.host_ids[0] ?? '';
  const landing = buildHostLandingRecord({
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
  });
  const nextLedger = applyHostLandingRecords(loaded.index, [landing]);
  const nextIndex: SkillIndex = {
    ...input.index,
    generated_at: input.now,
    skills: [...input.index.skills, recordOf(prepared, input)].sort((left, right) =>
      left.id < right.id ? -1 : 1,
    ),
  };
  const oldIndex = input.index;
  try {
    renameSync(prepared.staging, prepared.libraryDir);
  } catch (error) {
    try {
      removeTree(prepared.staging);
    } catch {
      // 暂存目录清理失败不掩盖原始落位失败；源宿主副本始终未被修改。
    }
    throw new AdoptError([errorFinding(error, prepared.libraryDir)]);
  }
  try {
    saveIndex(input.layout.indexFile, nextIndex);
  } catch (error) {
    throw new AdoptError([
      errorFinding(error, input.layout.indexFile),
      ...rollbackAdopt({
        layout: input.layout,
        oldIndex,
        libraryDir: prepared.libraryDir,
      }),
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
      ...rollbackAdopt({
        layout: input.layout,
        oldIndex,
        libraryDir: prepared.libraryDir,
      }),
    ]);
  }
  const changes: Change[] = [
    { action: 'add', kind: 'library', path: prepared.libraryDir },
    {
      action: 'add',
      kind: 'skill_meta',
      path: join(prepared.libraryDir, 'skill_meta.yaml'),
    },
    { action: 'modify', kind: 'index', path: input.layout.indexFile },
    { action: 'modify', kind: 'host_landings', path: input.layout.hostLandingsFile },
  ];
  return {
    result: {
      item_id: input.item.item_id,
      status: 'succeeded',
      target_path: input.item.target_path,
      after: input.item.after,
      changes,
    },
    findings: [],
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
