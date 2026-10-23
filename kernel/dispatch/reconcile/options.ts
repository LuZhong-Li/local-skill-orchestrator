/** `reconcile` 的参数与选择器校验；只解析，不读盘、不写盘。 */
import { CODES, RECONCILE_ACTIONS } from '@skill-manager/contract';
import type {
  HostRootRole,
  InventoryClassificationKey,
  ReconcileAction,
  ReconcileSelection,
} from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { flag, option, optionList, type ParsedArgs } from '../parsers/index.ts';
import { buildResult, type Result } from '../result/index.ts';
import { validateBulkAdoptFlags } from './adopt-bulk.ts';

const ACTIONS = new Set<string>(RECONCILE_ACTIONS);
const ROLES = new Set<HostRootRole>(['user', 'system', 'platform', 'project']);
const CLASSIFICATIONS = new Set<InventoryClassificationKey>([
  'managed_consistent',
  'drift',
  'inferred_consistent',
  'inferred_drift',
  'untracked',
  'missing',
  'undetermined',
  'unreadable',
  'not_distributed',
  'orphaned',
  'orphaned_with_workspace',
  'orphaned_without_workspace',
]);
const ALLOWED_OPTIONS = new Set([
  'action',
  'path',
  'id',
  'host',
  'classification',
  'role',
  'root',
  'target',
  'apply',
  'yes',
  'dry-run',
  'bulk',
  'limit',
  'rename',
  'force',
  'workspace',
  'json',
  'machine',
  'no-color',
  'verbose',
  'help',
  'version',
]);

function invalid(target: string, message: string, remedy: string): Result<unknown> {
  return buildResult('reconcile', [
    finding(CODES.INPUT_INVALID_ARG, {
      source: 'input',
      target,
      message,
      remedy,
    }),
  ]);
}

function missing(target: string, message: string, remedy: string): Result<unknown> {
  return buildResult('reconcile', [
    finding(CODES.INPUT_MISSING_ARG, {
      source: 'input',
      target,
      message,
      remedy,
    }),
  ]);
}

function actionOf(args: ParsedArgs): { action?: ReconcileAction; error?: Result<unknown> } {
  const value = option(args, 'action');
  if (value === undefined || value === '') {
    return {
      error: missing(
        '--action',
        'reconcile 缺少 --action',
        '请给出 --action adopt、track、repair、accept、clean 或 forget',
      ),
    };
  }
  if (!ACTIONS.has(value)) {
    return {
      error: invalid(
        '--action',
        `未知的 reconcile 动作：${value}`,
        '仅允许 adopt、track、repair、accept、clean、forget',
      ),
    };
  }
  return { action: value as ReconcileAction };
}

function forbiddenFlagsError(args: ParsedArgs): Result<unknown> | undefined {
  if (flag(args, 'all')) {
    return invalid(
      '--all',
      'reconcile 不接受裸 --all',
      '请用 --path、--id + --host，或 --classification 配合 --host / --root 限定范围',
    );
  }
  if (option(args, 'kind') !== undefined) {
    return invalid('--kind', 'reconcile 不接受 --kind', 'reconcile 只处理 Skill 副本');
  }
  if (flag(args, 'apply') && flag(args, 'dry-run')) {
    return invalid(
      '--apply',
      '--apply 与 --dry-run 不能同时给出',
      '默认即为预览；执行时只给 --apply',
    );
  }
  const conflictFlagError = validateBulkAdoptFlags({
    rename: flag(args, 'rename'),
    force: flag(args, 'force'),
  });
  if (conflictFlagError !== undefined) {
    return invalid(
      '--rename',
      '--rename 与 --force 不能同时给出',
      '两者互斥；默认冲突项跳过，重命名或覆盖只能二选一',
    );
  }
  return undefined;
}

function pathSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const path = option(args, 'path');
  const ids = optionList(args, 'id');
  const roles = optionList(args, 'role') as HostRootRole[];
  const host = option(args, 'host');
  const classification = option(args, 'classification');
  const roots = optionList(args, 'root');
  if (
    path !== undefined &&
    (ids.length > 0 ||
      roles.length > 0 ||
      host !== undefined ||
      classification !== undefined ||
      roots.length > 0)
  ) {
    return invalid(
      '--path',
      '--path 不能与 --id / --role / --host / --classification / --root 混用',
      '精确路径选择单独使用，或用 batch 选择器选择多个副本',
    );
  }
  return undefined;
}

function idHostSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const ids = optionList(args, 'id');
  const host = option(args, 'host');
  const classification = option(args, 'classification');
  const roles = optionList(args, 'role');
  const roots = optionList(args, 'root');
  if (ids.length > 0 && host === undefined) {
    return invalid('--id', '使用 --id 时必须同时给出 --host', '请补充 --host <宿主|all>');
  }
  if (
    host !== undefined &&
    ids.length === 0 &&
    roles.length === 0 &&
    roots.length === 0 &&
    classification === undefined
  ) {
    return invalid(
      '--host',
      '单独给出 --host 不足以选择动作对象',
      '请同时给出 --id、--role、--root，或给出 --classification',
    );
  }
  return undefined;
}

function roleSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const roles = optionList(args, 'role');
  const unknown = roles.find((role) => !ROLES.has(role as HostRootRole));
  if (unknown === undefined) return undefined;
  return invalid(
    '--role',
    `未知的宿主根角色：${unknown}`,
    '仅允许 user、system、platform、project',
  );
}

function classificationSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const host = option(args, 'host');
  const classification = option(args, 'classification');
  const roots = optionList(args, 'root');
  if (classification === undefined) return undefined;
  if (classification !== undefined && host === undefined && roots.length === 0) {
    return invalid(
      '--classification',
      '分类批量必须限定 --host 或 --root',
      '请补充 --host <宿主|all> 或 --root <根路径>',
    );
  }
  if (
    classification !== undefined &&
    !CLASSIFICATIONS.has(classification as InventoryClassificationKey)
  ) {
    return invalid(
      '--classification',
      `未知的盘点分类：${classification}`,
      '请使用盘点结果中的分类键',
    );
  }
  return undefined;
}

function selectorShapeError(args: ParsedArgs): Result<unknown> | undefined {
  for (const error of [
    pathSelectorError(args),
    idHostSelectorError(args),
    roleSelectorError(args),
    classificationSelectorError(args),
  ]) {
    if (error !== undefined) return error;
  }
  return undefined;
}

function actionSelectorError(
  args: ParsedArgs,
  action: ReconcileAction,
): Result<unknown> | undefined {
  const classification = option(args, 'classification');
  const target = option(args, 'target');
  if ((action === 'clean' || action === 'forget') && classification !== undefined) {
    return invalid(
      '--classification',
      `${action} 不接受仅按分类批量`,
      `请用 --path 或 --id + --host 精确选择 ${action} 的对象`,
    );
  }
  if (target !== undefined && action !== 'adopt') {
    return invalid(
      '--target',
      '--target 只在 adopt 动作中用于选择工作区目标',
      '请移除 --target 或改用 adopt',
    );
  }
  return undefined;
}

function bulkActionOptionsError(
  args: ParsedArgs,
  action: ReconcileAction,
): Result<unknown> | undefined {
  const bulk = flag(args, 'bulk');
  const limit = option(args, 'limit');
  const rename = flag(args, 'rename');
  const force = flag(args, 'force');
  if ((bulk || limit !== undefined || rename || force) && action !== 'adopt') {
    return invalid(
      '--bulk',
      `${action} 不接受批量 adopt 选项`,
      '--bulk、--limit、--rename 与 --force 只用于 reconcile --action adopt',
    );
  }
  if ((rename || force || limit !== undefined) && !bulk) {
    return invalid(
      '--bulk',
      '冲突策略与 limit 需要配合 --bulk',
      '请补充 --bulk，或移除 --limit / --rename / --force',
    );
  }
  return undefined;
}

function bulkSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  if (!flag(args, 'bulk')) return undefined;
  if (
    option(args, 'path') !== undefined ||
    optionList(args, 'id').length > 0 ||
    option(args, 'classification') !== undefined
  ) {
    return invalid(
      '--bulk',
      '--bulk 不能与 --path / --id / --classification 混用',
      '批量 adopt 从盘点候选展开；仅可再用 --role 与 --limit 收窄',
    );
  }
  return undefined;
}

function limitError(args: ParsedArgs): Result<unknown> | undefined {
  const value = option(args, 'limit');
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return invalid('--limit', `--limit 必须是正整数：${value}`, '请给出大于 0 的整数');
  }
  return undefined;
}

function missingSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const path = option(args, 'path');
  const ids = optionList(args, 'id');
  const roles = optionList(args, 'role');
  const roots = optionList(args, 'root');
  const host = option(args, 'host');
  const classification = option(args, 'classification');
  const bulk = flag(args, 'bulk');
  if (
    !bulk &&
    path === undefined &&
    !(ids.length > 0 && host !== undefined) &&
    roles.length === 0 &&
    roots.length === 0 &&
    classification === undefined
  ) {
    return missing(
      'selection',
      'reconcile 没有选择对象',
      '请给出 --path、--id 与 --host、--role、--root，或 --classification（配合 --host / --root）',
    );
  }
  return undefined;
}

function selectionError(args: ParsedArgs, action: ReconcileAction): Result<unknown> | undefined {
  for (const error of [
    forbiddenFlagsError(args),
    selectorShapeError(args),
    bulkSelectorError(args),
    limitError(args),
    actionSelectorError(args, action),
    bulkActionOptionsError(args, action),
    missingSelectorError(args),
  ]) {
    if (error !== undefined) return error;
  }
  return undefined;
}

function applyBulkOptions(selection: ReconcileSelection, args: ParsedArgs): void {
  if (!flag(args, 'bulk')) return;
  selection.bulk = true;
  if (flag(args, 'rename')) selection.conflict = 'rename';
  if (flag(args, 'force')) selection.conflict = 'force';
}

function commonOptionsError(args: ParsedArgs): Result<unknown> | undefined {
  if (args.positionals.length > 0) {
    return invalid(
      'positionals',
      'reconcile 不接受位置参数',
      '请使用 --path、--id、--host 或 --classification',
    );
  }
  for (const name of Object.keys(args.options)) {
    if (!ALLOWED_OPTIONS.has(name)) {
      return invalid(
        `--${name}`,
        `reconcile 不接受 --${name}`,
        '可用选项见 reconcile --help；动作选择不与其他指令的专用选项混用',
      );
    }
  }
  return undefined;
}

function isBatchSelection(
  ids: readonly string[],
  roles: readonly HostRootRole[],
  roots: readonly string[],
  classification: InventoryClassificationKey | undefined,
  bulk: boolean,
): boolean {
  return (
    bulk ||
    ids.length > 1 ||
    roles.length > 0 ||
    (roots.length > 0 && ids.length === 0 && classification === undefined) ||
    (ids.length > 0 && (roots.length > 0 || classification !== undefined))
  );
}

function selectionModeOf(
  path: string | undefined,
  ids: readonly string[],
  roles: readonly HostRootRole[],
  roots: readonly string[],
  classification: InventoryClassificationKey | undefined,
  bulk: boolean,
): ReconcileSelection['mode'] {
  if (path !== undefined) return 'path';
  if (isBatchSelection(ids, roles, roots, classification, bulk)) return 'batch';
  return ids.length > 0 ? 'id-host' : 'classification';
}

function selectionOf(args: ParsedArgs, action: ReconcileAction): ReconcileSelection {
  const path = option(args, 'path');
  const ids = optionList(args, 'id');
  const roles = optionList(args, 'role') as HostRootRole[];
  const host = option(args, 'host');
  const classification = option(args, 'classification') as InventoryClassificationKey | undefined;
  const roots = optionList(args, 'root');
  const target = option(args, 'target');
  const bulk = flag(args, 'bulk');
  const selection: ReconcileSelection = {
    mode: selectionModeOf(path, ids, roles, roots, classification, bulk),
    action,
    roots,
    apply: flag(args, 'apply'),
  };
  if (path !== undefined) selection.path = path;
  if (ids.length > 0) {
    if (selection.mode === 'id-host') selection.id = ids[0]!;
    else selection.ids = ids;
  }
  if (host !== undefined) selection.host = host;
  if (classification !== undefined) selection.classification = classification;
  if (roles.length > 0) selection.roles = roles;
  if (target !== undefined) selection.target = target;
  applyBulkOptions(selection, args);
  const limit = option(args, 'limit');
  if (limit !== undefined) selection.limit = Number(limit);
  return selection;
}

/** 返回动作选择器；错误以完整结果封装返回，避免路由层重复拼 finding。 */
export function parseReconcileOptions(args: ParsedArgs): {
  selection?: ReconcileSelection;
  error?: Result<unknown>;
} {
  const commonError = commonOptionsError(args);
  if (commonError !== undefined) return { error: commonError };
  const parsedAction = actionOf(args);
  if (parsedAction.error !== undefined) return { error: parsedAction.error };
  const action = parsedAction.action as ReconcileAction;
  const error = selectionError(args, action);
  if (error !== undefined) return { error };
  return { selection: selectionOf(args, action) };
}
