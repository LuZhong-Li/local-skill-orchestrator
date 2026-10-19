/** T4 reconcile 执行器：共享根 / 插件 x- 的六动作编排。 */
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
import { loadPluginIndex, savePluginIndex } from '../../store/plugin-registry/index.ts';
import { collectUnifiedLandings } from '../../core/host-landings/uninstall.ts';
import { inventoryPhysicalKey } from '../../core/inventory/discover.ts';
import { toKernelError } from '../../store/errors.ts';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { runHostLanding } from '../host/index.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import { adoptItem } from './adopt.ts';
import { acceptItem } from './accept.ts';
import { cleanItem } from './clean.ts';
import { trackItem } from './track.ts';
import type { ReconcileExecutionItem } from './execution-types.ts';

export interface ReconcileExecution {
  data: ReconcileApplyData;
  findings: Finding[];
  changes: Change[];
}

function unavailable(item: ReconcilePlanItem): ReconcileExecutionItem {
  const findings = [
    finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
      source: 'reconcile',
      target: item.action,
      message: `当前计划动作无法执行：${item.action}`,
      remedy: '请检查工作区基线或重新盘点后再执行',
    }),
  ];
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

function executionOf(
  input: {
    plan: ReconcileApplyData;
    layout: WorkspaceLayout;
    index: SkillIndex | null;
    now: string;
  },
  item: ReconcilePlanItem,
): ReconcileExecutionItem {
  if (item.action === 'repair') {
    return repairItem({ item, layout: input.layout, index: input.index, now: input.now });
  }
  if (item.action === 'forget') return forgetItem({ item, layout: input.layout, now: input.now });
  if (item.action === 'clean') return cleanItem({ item, layout: input.layout, now: input.now });
  if (item.action === 'adopt' && input.index !== null) {
    return adoptItem({
      item,
      layout: input.layout,
      index: input.index,
      selection: input.plan.selection,
      now: input.now,
    });
  }
  if (item.action === 'track' && input.index !== null) {
    return trackItem({ item, layout: input.layout, index: input.index, now: input.now });
  }
  if (item.action === 'accept' && input.index !== null) {
    return acceptItem({ item, layout: input.layout, index: input.index, now: input.now });
  }
  return unavailable(item);
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
  if (hostValue === undefined) {
    const findings = [
      finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
        source: 'reconcile',
        target: input.item.target_path,
        message: 'repair 缺少可重渲染的宿主',
        remedy: '重新盘点后再执行',
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
  if (input.item.host_ids[0]?.startsWith('x-')) return forgetPluginItem(input);
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
  const hostIds = new Set(input.item.host_ids);
  const records = loaded.index.landings.filter(
    (item) =>
      item.skill_id === input.item.skill_id &&
      hostIds.has(item.host_id) &&
      item.target_path === input.item.target_path &&
      item.state === 'active',
  );
  if (records.length === 0) {
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
    const keys = new Set(records);
    const next = {
      ...loaded.index,
      landings: loaded.index.landings.map((record) =>
        keys.has(record)
          ? { ...record, state: 'orphaned' as const, updated_at: input.now }
          : record,
      ),
    };
    saveHostLandings(input.layout.hostLandingsFile, {
      ...next,
      generated_at: input.now,
    });
    const change: Change = {
      action: 'modify',
      kind: 'host_landings',
      path: input.layout.hostLandingsFile,
      detail: `账本记录转为 orphaned：${input.item.skill_id ?? ''} / ${input.item.host_ids.join(',')}`,
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

function forgetPluginItem(input: {
  item: ReconcilePlanItem;
  layout: WorkspaceLayout;
  now: string;
}): { result: ReconcileResultItem; findings: Finding[]; changes: Change[] } {
  const loaded = loadPluginIndex(input.layout.pluginIndexFile);
  if (loaded.index === null) {
    const findings = loaded.findings.length
      ? loaded.findings
      : [
          finding(CODES.LANDING_LEDGER_INVALID, {
            source: 'plugin-registry',
            target: input.layout.pluginIndexFile,
            message: 'forget 无法读取 plugin_index.yaml',
            remedy: '先修复插件账本或重新扫描插件宿主',
          }),
        ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  const hostIds = new Set(input.item.host_ids);
  const targetKey = inventoryPhysicalKey(input.item.target_path);
  const found = collectUnifiedLandings(null, loaded.index, input.item.skill_id ?? '').filter(
    (item) =>
      hostIds.has(item.host_id) &&
      item.state === 'active' &&
      inventoryPhysicalKey(item.physical_path) === targetKey,
  );
  if (found.length === 0) {
    const findings = [
      finding(CODES.RECONCILE_PLAN_STALE, {
        source: 'reconcile',
        target: input.item.target_path,
        message: 'forget 找不到对应的 active 插件账本记录',
        remedy: '重新执行 scan --inventory 后再确认',
      }),
    ];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  try {
    const records = new Set(found.map((item) => item.record));
    savePluginIndex(input.layout.pluginIndexFile, {
      ...loaded.index,
      generated_at: input.now,
      landings: loaded.index.landings.map((record) =>
        records.has(record)
          ? { ...record, state: 'orphaned' as const, updated_at: input.now }
          : record,
      ),
    });
  } catch (error) {
    const findings = [errorFinding(error, input.layout.pluginIndexFile)];
    return { result: failedResult(input.item, findings), findings, changes: [] };
  }
  const change: Change = {
    action: 'modify',
    kind: 'plugin_index',
    path: input.layout.pluginIndexFile,
    detail: `插件账本记录转为 orphaned：${input.item.skill_id ?? ''} / ${input.item.host_ids.join(',')}`,
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
    const execution = executionOf(input, item);
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
