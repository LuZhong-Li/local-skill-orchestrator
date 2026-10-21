/**
 * 盘点批量选择与动作映射：纯逻辑，不接触内核或 preload。
 * 选择以 physical_key / target_path 作为唯一键；只有 user 角色、有动作的副本可选。
 */
import type {
  InventoryHostRootNode,
  MissingInventoryCopy,
  ReconcileAction,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
} from '@skill-manager/contract';
import {
  inventoryActionPath,
  inventoryActionsFor,
  isUserWritableCopy,
  type InventoryActionOption,
  type InventoryCopyLike,
} from './inventory-actions.ts';

export interface BatchSelectionState {
  selected: Set<string>;
}

export interface BatchTarget {
  path?: string;
  id?: string;
  host?: string;
}

export function copyKey(copy: InventoryCopyLike): string {
  return 'physical_key' in copy ? copy.physical_key : `missing:${copy.host_id}:${copy.target_path}`;
}

export function batchTargetOf(copy: InventoryCopyLike): BatchTarget {
  const output = 'reconciliation' in copy ? copy.reconciliation : copy;
  if (
    output.classification === 'not_distributed' &&
    copy.skill_id !== undefined &&
    copy.host_id !== ''
  ) {
    return { id: copy.skill_id, host: copy.host_id };
  }
  return { path: inventoryActionPath(copy) };
}

export function isCopySelectable(copy: InventoryCopyLike): boolean {
  if (!isUserWritableCopy(copy)) return false;
  return inventoryActionsFor(copy).some((option) => !option.disabled);
}

export function toggleSelection(state: BatchSelectionState, key: string): void {
  if (state.selected.has(key)) state.selected.delete(key);
  else state.selected.add(key);
}

export function setSelection(state: BatchSelectionState, keys: string[], selected: boolean): void {
  for (const key of keys) {
    if (selected) state.selected.add(key);
    else state.selected.delete(key);
  }
}

export function selectableKeys(copies: InventoryCopyLike[]): string[] {
  return copies.filter(isCopySelectable).map(copyKey);
}

export function allSelected(state: BatchSelectionState, copies: InventoryCopyLike[]): boolean {
  const selectable = selectableKeys(copies);
  if (selectable.length === 0) return false;
  return selectable.every((key) => state.selected.has(key));
}

export function someSelected(state: BatchSelectionState, copies: InventoryCopyLike[]): boolean {
  return selectableKeys(copies).some((key) => state.selected.has(key));
}

export interface RootSelectionInfo {
  key: string;
  selectableCount: number;
  selectedCount: number;
}

export function rootSelectionInfo(
  state: BatchSelectionState,
  node: InventoryHostRootNode,
): RootSelectionInfo {
  const all = [...node.copies, ...node.corrupt, ...node.missing];
  const selectable = all.filter(isCopySelectable).map(copyKey);
  const selected = selectable.filter((key) => state.selected.has(key)).length;
  return { key: node.root.root_id, selectableCount: selectable.length, selectedCount: selected };
}

export interface BatchActionInfo {
  action: ReconcileAction;
  label: string;
  destructive: boolean;
  count: number;
}

/**
 * 对当前选中的副本集合，计算「可共同执行」的批量动作：
 * 只保留每个副本都有的动作；同一动作对至少一个副本可用。
 */
export function availableBatchActions(
  state: BatchSelectionState,
  copies: InventoryCopyLike[],
): BatchActionInfo[] {
  const selectedCopies = copies.filter(
    (copy) => isCopySelectable(copy) && state.selected.has(copyKey(copy)),
  );
  if (selectedCopies.length === 0) return [];

  const counts = new Map<ReconcileAction, number>();
  const labels = new Map<ReconcileAction, string>();
  const destructiveMap = new Map<ReconcileAction, boolean>();

  for (const copy of selectedCopies) {
    const actions = inventoryActionsFor(copy).filter((option) => !option.disabled);
    for (const opt of actions) {
      counts.set(opt.action, (counts.get(opt.action) ?? 0) + 1);
      labels.set(opt.action, opt.label);
      destructiveMap.set(opt.action, opt.destructive);
    }
  }

  const total = selectedCopies.length;
  return [...counts.entries()]
    .filter(([, count]) => count === total)
    .map(([action, count]) => ({
      action,
      label: labels.get(action) ?? action,
      destructive: destructiveMap.get(action) ?? false,
      count,
    }));
}

export function collectAllCopiesFromData(data: {
  copies: ReconciledInventoryCopy[];
  corrupt: ReconciledInventoryCorruptCopy[];
  missing: MissingInventoryCopy[];
  hosts: { roots: InventoryHostRootNode[] }[];
}): InventoryCopyLike[] {
  const copies: InventoryCopyLike[] = [...data.copies, ...data.corrupt, ...data.missing];
  for (const host of data.hosts) {
    for (const root of host.roots) {
      copies.push(...root.copies, ...root.corrupt, ...root.missing);
    }
  }
  // 去重（同一 physical_key / target_path 可能出现在多个分组里）
  const seen = new Set<string>();
  const result: InventoryCopyLike[] = [];
  for (const copy of copies) {
    const key = copyKey(copy);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(copy);
  }
  return result;
}

/**
 * 从选中集合里挑出用于调用 batch reconcile 的副本：
 * 优先用 skill_id（如有），否则回退到 physical_key。
 */
export function selectedIds(state: BatchSelectionState, copies: InventoryCopyLike[]): string[] {
  const ids = new Set<string>();
  const fallbacks: string[] = [];
  for (const copy of copies) {
    if (!state.selected.has(copyKey(copy))) continue;
    if ('skill_id' in copy && copy.skill_id) ids.add(copy.skill_id);
    else fallbacks.push(copyKey(copy));
  }
  if (ids.size > 0) return [...ids];
  return fallbacks;
}

export function actionFromLabel(
  label: string,
  options: InventoryActionOption[],
): ReconcileAction | null {
  const found = options.find((opt) => opt.label === label);
  return found?.action ?? null;
}
