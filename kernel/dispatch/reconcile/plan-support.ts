/** reconcile 计划的纯结构辅助：事务组与过期指纹。 */
import type {
  ReconcilePlanItem,
  ReconcilePreviewData,
  ReconcileTransactionGroup,
} from '@skill-manager/contract';
import { unique } from './candidate-model.ts';

export function transactionGroups(items: ReconcilePlanItem[]): ReconcileTransactionGroup[] {
  const groups = new Map<string, ReconcileTransactionGroup>();
  for (const item of items) {
    const current = groups.get(item.transaction_group) ?? {
      group_id: item.transaction_group,
      physical_path: item.target_path,
      item_ids: [],
      host_ids: [],
      ledger_sources: [],
      shared: false,
    };
    current.item_ids.push(item.item_id);
    current.host_ids = unique([...current.host_ids, ...item.host_ids]);
    for (const change of item.ledger_changes) {
      if (!current.ledger_sources.includes(change.source)) {
        current.ledger_sources.push(change.source);
      }
    }
    current.shared = current.host_ids.length > 1 || item.consumed_by.length > 1;
    groups.set(item.transaction_group, current);
  }
  return [...groups.values()];
}

/** 预览与执行间的计划指纹；任一选中副本事实变化都会改变结果。 */
export function reconcilePlanSignature(plan: ReconcilePreviewData): string {
  return JSON.stringify({
    selection: plan.selection,
    items: plan.items.map((item) => ({
      item_id: item.item_id,
      action: item.action,
      target_path: item.target_path,
      root_roles: item.root_roles,
      ...(item.skill_id === undefined ? {} : { skill_id: item.skill_id }),
      status: item.status,
      before: item.before,
      after: item.after,
      writes: item.writes,
      ledger_changes: item.ledger_changes,
    })),
  });
}
