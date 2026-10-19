/** `reconcile` 的参数与选择器校验；只解析，不读盘、不写盘。 */
import { CODES, RECONCILE_ACTIONS } from '@skill-manager/contract';
import type {
  InventoryClassificationKey,
  ReconcileAction,
  ReconcileSelection,
} from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { flag, option, optionList, type ParsedArgs } from '../parsers/index.ts';
import { buildResult, type Result } from '../result/index.ts';

const ACTIONS = new Set<string>(RECONCILE_ACTIONS);
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
  'root',
  'target',
  'apply',
  'yes',
  'dry-run',
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
  return undefined;
}

function pathSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const path = option(args, 'path');
  const id = option(args, 'id');
  const host = option(args, 'host');
  const classification = option(args, 'classification');
  if (
    path !== undefined &&
    (id !== undefined || host !== undefined || classification !== undefined)
  ) {
    return invalid(
      '--path',
      '--path 不能与 --id / --host / --classification 混用',
      '精确路径选择单独使用，或用 --id 与 --host 组合',
    );
  }
  return undefined;
}

function idHostSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const id = option(args, 'id');
  const host = option(args, 'host');
  const classification = option(args, 'classification');
  if (id !== undefined && host === undefined) {
    return invalid('--id', '使用 --id 时必须同时给出 --host', '请补充 --host <宿主|all>');
  }
  if (host !== undefined && id === undefined && classification === undefined) {
    return invalid(
      '--host',
      '单独给出 --host 不足以选择动作对象',
      '请同时给出 --id，或给出 --classification',
    );
  }
  return undefined;
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

function missingSelectorError(args: ParsedArgs): Result<unknown> | undefined {
  const path = option(args, 'path');
  const id = option(args, 'id');
  const host = option(args, 'host');
  const classification = option(args, 'classification');
  if (
    path === undefined &&
    !(id !== undefined && host !== undefined) &&
    classification === undefined
  ) {
    return missing(
      'selection',
      'reconcile 没有选择对象',
      '请给出 --path，或 --id 与 --host，或 --classification（配合 --host / --root）',
    );
  }
  return undefined;
}

function selectionError(args: ParsedArgs, action: ReconcileAction): Result<unknown> | undefined {
  for (const error of [
    forbiddenFlagsError(args),
    selectorShapeError(args),
    actionSelectorError(args, action),
    missingSelectorError(args),
  ]) {
    if (error !== undefined) return error;
  }
  return undefined;
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

function selectionOf(args: ParsedArgs, action: ReconcileAction): ReconcileSelection {
  const path = option(args, 'path');
  const id = option(args, 'id');
  const host = option(args, 'host');
  const classification = option(args, 'classification') as InventoryClassificationKey | undefined;
  const target = option(args, 'target');
  return {
    mode: path !== undefined ? 'path' : id !== undefined ? 'id-host' : 'classification',
    action,
    ...(path === undefined ? {} : { path }),
    ...(id === undefined ? {} : { id }),
    ...(host === undefined ? {} : { host }),
    ...(classification === undefined ? {} : { classification }),
    roots: optionList(args, 'root'),
    ...(target === undefined ? {} : { target }),
    apply: flag(args, 'apply'),
  };
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
