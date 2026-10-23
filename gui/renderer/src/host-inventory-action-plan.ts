import type {
  Finding,
  ReconcileAction,
  ReconcilePlanItem,
  ReconcilePreviewData,
  ReconcileResultItem,
} from '@skill-manager/contract';
import type { BatchTarget } from './inventory-batch.ts';

function targetMatchesItem(target: BatchTarget, item: ReconcilePlanItem): boolean {
  if (target.path !== undefined && target.path === item.target_path) return true;
  return (
    target.id !== undefined &&
    target.id === item.skill_id &&
    (target.host === undefined || item.host_ids.includes(target.host))
  );
}

export interface AdoptPreviewRow {
  item_id: string;
  source_path: string;
  requested_id: string;
  target_id: string;
  target_path: string;
  description: string;
  version: string | null;
  conflict: NonNullable<ReconcilePlanItem['adopt_preview']>['conflict'];
}

export function adoptPreviewRows(preview: ReconcilePreviewData | null): AdoptPreviewRow[] {
  return (preview?.items ?? []).flatMap((item) => {
    const adopt = item.adopt_preview;
    if (adopt === undefined) return [];
    const targetPath =
      item.writes.find((write) => write.kind === 'library')?.path ?? adopt.target_skill_id;
    return [
      {
        item_id: item.item_id,
        source_path: adopt.source_path,
        requested_id: adopt.requested_skill_id,
        target_id: adopt.target_skill_id,
        target_path: targetPath,
        description: adopt.description,
        version: adopt.version,
        conflict: adopt.conflict,
      },
    ];
  });
}

export function filterBulkAdoptPlan(
  plan: ReconcilePreviewData,
  targets: BatchTarget[],
): ReconcilePreviewData {
  const items = plan.items.filter((item) =>
    targets.some((target) => targetMatchesItem(target, item)),
  );
  const itemIds = new Set(items.map((item) => item.item_id));
  const transactionGroups = plan.transaction_groups.filter((group) =>
    group.item_ids.some((itemId) => itemIds.has(itemId)),
  );
  const planned = items.filter((item) => item.status === 'planned');
  const bulk = plan.summary.bulk;
  return {
    ...plan,
    selection: {
      ...plan.selection,
      mode: 'batch',
      action: 'adopt',
      roots: [],
      apply: false,
    },
    items,
    transaction_groups: transactionGroups,
    summary: {
      selected: items.length,
      planned: planned.length,
      skipped: items.length - planned.length,
      destructive: planned.filter((item) => item.action === 'accept' || item.action === 'clean')
        .length,
      shared_groups: transactionGroups.filter((group) => group.shared).length,
      ...(bulk === undefined
        ? {}
        : {
            bulk: {
              candidates: items.length,
              limited: items.length,
              conflict_skipped: items.filter((item) =>
                [
                  'duplicate_skill_id',
                  'same_content_existing_skill',
                  'different_content_existing_skill',
                ].includes(item.reason ?? ''),
              ).length,
              renamed: items.filter(
                (item) =>
                  item.adopt_preview !== undefined &&
                  item.adopt_preview.requested_skill_id !== item.adopt_preview.target_skill_id,
              ).length,
              forced: items.filter(
                (item) =>
                  item.status === 'planned' &&
                  item.adopt_preview?.conflict_policy === 'force' &&
                  item.adopt_preview.conflict === 'different_content',
              ).length,
            },
          }),
    },
  };
}

export function mergeBatchPlans(
  plans: ReconcilePreviewData[],
  action: ReconcileAction,
): ReconcilePreviewData | null {
  const first = plans[0];
  if (first === undefined) return null;
  const items = [
    ...new Map(
      plans.flatMap((plan) => plan.items).map((item) => [item.physical_key, item]),
    ).values(),
  ];
  const transactionGroups = [
    ...new Map(
      plans.flatMap((plan) => plan.transaction_groups).map((group) => [group.group_id, group]),
    ).values(),
  ];
  const planned = items.filter((item) => item.status === 'planned');
  return {
    ...first,
    selection: {
      mode: 'batch',
      action,
      roots: [],
      apply: false,
    },
    items,
    transaction_groups: transactionGroups,
    summary: {
      selected: items.length,
      planned: planned.length,
      skipped: items.length - planned.length,
      destructive: planned.filter((item) => item.action === 'accept' || item.action === 'clean')
        .length,
      shared_groups: transactionGroups.filter((group) => group.shared).length,
    },
    notes: [...new Set(plans.flatMap((plan) => plan.notes))],
  };
}

export function planItemSignature(item: ReconcilePlanItem): string {
  return JSON.stringify({
    physical_key: item.physical_key,
    target_path: item.target_path,
    skill_id: item.skill_id,
    host_ids: item.host_ids,
    format: item.format,
    visibility: item.visibility,
    root_roles: item.root_roles,
    status: item.status,
    reason: item.reason,
    before: item.before,
    action: item.action,
    after: item.after,
    writes: item.writes,
    ledger_changes: item.ledger_changes,
    warnings: item.warnings,
  });
}

export function failedReconcileResult(
  item: ReconcilePlanItem,
  stage: string,
  reason: string,
  message: string,
  findings: Finding[] = [],
): ReconcileResultItem {
  return {
    item_id: item.item_id,
    status: 'failed',
    target_path: item.target_path,
    stage,
    reason,
    message,
    findings,
  };
}

export function skippedReconcileResults(plan: ReconcilePreviewData): ReconcileResultItem[] {
  return plan.items
    .filter((item) => item.status === 'skipped')
    .map((item) => ({
      item_id: item.item_id,
      status: 'skipped',
      target_path: item.target_path,
      stage: 'plan',
      ...(item.reason === undefined ? {} : { reason: item.reason, message: item.reason }),
    }));
}
