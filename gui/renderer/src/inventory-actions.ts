/** 盘点副本的推荐动作映射；只做展示选择，动作合法性仍由内核计划决定。 */
import type {
  InventoryClassificationKey,
  MissingInventoryCopy,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
  ReconcileAction,
  ReconciliationOutput,
} from '@skill-manager/contract';

export type InventoryCopyLike =
  ReconciledInventoryCopy | ReconciledInventoryCorruptCopy | MissingInventoryCopy;

export interface InventoryActionOption {
  action: ReconcileAction;
  label: string;
  destructive: boolean;
  disabled: boolean;
  reason?: string;
}

const LABELS: Record<ReconcileAction, string> = {
  adopt: '采纳到工作区',
  track: '补记账本',
  repair: '修复宿主副本',
  accept: '接受本地改动',
  clean: '清理副本',
  forget: '不再跟踪',
};

function classificationKey(copy: InventoryCopyLike): InventoryClassificationKey {
  const output: ReconciliationOutput = 'reconciliation' in copy ? copy.reconciliation : copy;
  if (output.classification === 'orphaned') {
    return output.orphaned?.workspace_record_present
      ? 'orphaned_with_workspace'
      : 'orphaned_without_workspace';
  }
  return output.classification;
}

function baseActions(key: InventoryClassificationKey): ReconcileAction[] {
  if (key === 'untracked') return ['adopt'];
  if (key === 'inferred_consistent') return ['track'];
  if (key === 'drift' || key === 'inferred_drift') return ['repair', 'accept'];
  if (key === 'missing') return ['repair', 'forget'];
  if (key === 'orphaned_with_workspace') return ['repair'];
  if (key === 'orphaned_without_workspace') return ['adopt', 'clean'];
  if (key === 'unreadable') return ['repair', 'clean'];
  if (key === 'not_distributed') return ['repair'];
  return [];
}

export function inventoryActionPath(copy: InventoryCopyLike): string {
  return 'path' in copy ? copy.path : copy.target_path;
}

export function isUserWritableCopy(copy: InventoryCopyLike): boolean {
  return copy.root_role === 'user';
}

export function inventoryActionsFor(copy: InventoryCopyLike): InventoryActionOption[] {
  if (!isUserWritableCopy(copy)) return [];
  const plugin = copy.host_group === 'plugin';
  return baseActions(classificationKey(copy)).map((action) => {
    const disabled = plugin && (action === 'adopt' || action === 'accept');
    return {
      action,
      label: LABELS[action],
      destructive: action === 'clean' || action === 'accept',
      disabled,
      ...(disabled ? { reason: '插件副本不进入工作区中心库' } : {}),
    };
  });
}

export function inventoryActionLabel(action: ReconcileAction): string {
  return LABELS[action];
}
