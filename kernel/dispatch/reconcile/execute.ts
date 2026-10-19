/** T1 reconcile 执行器：仅内置宿主的 repair 与 forget。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODES,
  type Change,
  type Finding,
  type ReconcileApplyData,
  type ReconcilePlanItem,
  type ReconcileResultItem,
} from '@skill-manager/contract';
import { loadHostLandings, saveHostLandings } from '../../store/host-landings/index.ts';
import { orphanHostLandingsForPaths } from '../../core/host-landings/uninstall.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { runHostLanding } from '../host/index.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';

export interface ReconcileExecution {
  data: ReconcileApplyData;
  findings: Finding[];
  changes: Change[];
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

function failedResult(item: ReconcilePlanItem, findings: Finding[]): ReconcileResultItem {
  return {
    item_id: item.item_id,
    status: 'failed',
    target_path: item.target_path,
    findings,
    ...(item.after === undefined ? {} : { after: item.after }),
  };
}

function repairItem(input: {
  item: ReconcilePlanItem;
  layout: WorkspaceLayout;
  index: SkillIndex | null;
  now: string;
}): { result: ReconcileResultItem; findings: Finding[]; changes: Change[] } {
  const skillId = input.item.skill_id;
  if (skillId === undefined) {
    const findings = [
      finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
        source: 'reconcile',
        target: input.item.target_path,
        message: 'repair 缺少可重渲染的 Skill 标识',
        remedy: '先执行 scan --inventory 获取带 skill_id 的副本，再重试',
      }),
    ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  const index = input.index;
  const record = index?.skills.find((item) => item.id === skillId);
  if (index === null || record === undefined) {
    const findings = [
      finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
        source: 'reconcile',
        target: skillId,
        message: 'repair 需要工作区基线，但该 Skill 不在索引中',
        remedy: '先用 reconcile --action adopt 纳管，或使用 reconcile --action clean',
      }),
    ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  const visibility = record.status === 'disabled' ? 'disabled' : 'visible';
  const hostValue = input.item.host_ids[0];
  if (hostValue === undefined || hostValue.startsWith('x-')) {
    const findings = [
      finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
        source: 'reconcile',
        target: input.item.target_path,
        message: 'T1 repair 只支持内置宿主',
        remedy: 'x- 宿主的 repair 将在 T4 接入',
      }),
    ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  try {
    const landed = runHostLanding({
      command: 'update',
      hostValue,
      layout: input.layout,
      index,
      skillDir: join(input.layout.skillsDir, skillId),
      now: input.now,
      dryRun: false,
      visibility,
    });
    if (landed.findings.some((item) => item.severity === 'error')) {
      return {
        result: failedResult(input.item, landed.findings),
        findings: landed.findings,
        changes: landed.changes,
      };
    }
    return {
      result: {
        item_id: input.item.item_id,
        status: 'succeeded',
        target_path: input.item.target_path,
        after: input.item.after,
        changes: landed.changes,
      },
      findings: landed.findings,
      changes: landed.changes,
    };
  } catch (error) {
    const findings = [errorFinding(error, input.item.target_path)];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
}

function forgetItem(input: { item: ReconcilePlanItem; layout: WorkspaceLayout; now: string }): {
  result: ReconcileResultItem;
  findings: Finding[];
  changes: Change[];
} {
  if (existsSync(input.item.target_path)) {
    const findings = [
      finding(CODES.RECONCILE_PLAN_STALE, {
        source: 'reconcile',
        target: input.item.target_path,
        message: 'forget 只能清理已不存在的副本，当前路径仍存在',
        remedy: '重新盘点后再选择 repair 或 clean',
      }),
    ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  const loaded = loadHostLandings(input.layout.hostLandingsFile);
  if (loaded.index === null) {
    const findings = loaded.findings.length
      ? loaded.findings
      : [
          finding(CODES.LANDING_LEDGER_INVALID, {
            source: 'host-landings',
            target: input.layout.hostLandingsFile,
            message: 'forget 无法读取 host_landings.yaml',
            remedy: '先修复账本字节或运行 scan --inventory 确认账本状态',
          }),
        ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  const hostId = input.item.host_ids[0];
  const record = loaded.index.landings.find(
    (item) =>
      item.skill_id === input.item.skill_id &&
      item.host_id === hostId &&
      item.target_path === input.item.target_path &&
      item.state === 'active',
  );
  if (record === undefined) {
    const findings = [
      finding(CODES.RECONCILE_PLAN_STALE, {
        source: 'reconcile',
        target: input.item.target_path,
        message: 'forget 找不到对应的 active 账本记录',
        remedy: '重新执行 scan --inventory 后再确认',
      }),
    ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  try {
    const next = orphanHostLandingsForPaths(
      loaded.index,
      record.skill_id,
      [record.target_path],
      input.now,
    );
    saveHostLandings(input.layout.hostLandingsFile, {
      ...next,
      generated_at: input.now,
    });
    const change: Change = {
      action: 'modify',
      kind: 'host_landings',
      path: input.layout.hostLandingsFile,
      detail: `账本记录转为 orphaned：${record.skill_id} / ${record.host_id}`,
    };
    return {
      result: {
        item_id: input.item.item_id,
        status: 'succeeded',
        target_path: input.item.target_path,
        after: input.item.after,
        changes: [change],
      },
      findings: [],
      changes: [change],
    };
  } catch (error) {
    const findings = [errorFinding(error, input.layout.hostLandingsFile)];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
}

/** 执行已通过预览与锁的执行计划；每个 item 独立，返回逐项结果。 */
export function executeReconcilePlan(input: {
  plan: ReconcileApplyData;
  layout: WorkspaceLayout;
  index: SkillIndex | null;
  now: string;
}): ReconcileExecution {
  const results: ReconcileResultItem[] = [];
  const findings: Finding[] = [];
  const changes: Change[] = [];
  for (const item of input.plan.items) {
    if (item.status === 'skipped') {
      results.push({
        item_id: item.item_id,
        status: 'skipped',
        target_path: item.target_path,
        ...(item.reason === undefined ? {} : { message: item.reason }),
      });
      continue;
    }
    const execution =
      item.action === 'repair'
        ? repairItem({ item, layout: input.layout, index: input.index, now: input.now })
        : item.action === 'forget'
          ? forgetItem({ item, layout: input.layout, now: input.now })
          : {
              result: failedResult(item, [
                finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
                  source: 'reconcile',
                  target: item.action,
                  message: `T1 尚未实现 ${item.action}`,
                  remedy: '本批只执行 repair 与 forget',
                }),
              ]),
              findings: [],
              changes: [],
            };
    results.push(execution.result);
    findings.push(...execution.findings);
    changes.push(...execution.changes);
  }
  return {
    data: {
      ...input.plan,
      applied: results.some((item) => item.status === 'succeeded'),
      results,
    },
    findings,
    changes,
  };
}
