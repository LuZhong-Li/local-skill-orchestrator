/** scan --inventory：只读展开根清单并发现物理副本；不做对账。 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { InventoryRootView, InventoryScanData } from '@skill-manager/contract';
import { loadIndex, TOOL_VERSION } from '../../core/index/index.ts';
import { inventoryRootsForAll } from '../../core/hosts/inventory.ts';
import { loadHostRegistry } from '../../core/hosts/index.ts';
import { discoverInventoryCopies } from '../../core/inventory/discover.ts';
import { aggregateInventory } from './aggregate.ts';
import { inventoryAuditOf } from './audit.ts';
import { reconcileInventory } from './reconcile.ts';
import type { InventorySnapshot, WorkspaceReadState } from './snapshot.ts';
import { loadPluginCatalog } from '../../core/plugins/host.ts';
import { inventoryRootsForPluginCatalog } from '../../core/plugins/inventory.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { toKernelError } from '../../store/errors.ts';
import { layoutOf, type WorkspaceLayout } from '../../store/workspace/index.ts';
import { flag, type ParsedArgs } from '../parsers/index.ts';
import { buildResult, type Result } from '../result/index.ts';
import type { InventoryScanPlan } from './types.ts';
export type { InventorySnapshot, WorkspaceReadState } from './snapshot.ts';

const INVENTORY_ALLOWED_OPTIONS = new Set([
  'inventory',
  'audit',
  'workspace',
  'json',
  'machine',
  'no-color',
  'verbose',
  'help',
  'version',
]);

const INVENTORY_CONFLICTS = new Set(['kind', 'root', 'dry-run']);

/** `--inventory` 与现有 scan 选项的互斥/白名单（参数类错误）。 */
export function inventoryOptionsError(args: ParsedArgs): Result<unknown> | null {
  if (flag(args, 'audit') && args.options['inventory'] !== true) {
    return buildResult('scan', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--audit',
        message: '--audit 只能与 --inventory 同用',
        remedy: '请补充 --inventory；审计是盘点结果的只读投影',
      }),
    ]);
  }
  if (args.options['inventory'] !== true) return null;
  if (args.positionals.length > 0) {
    return buildResult('scan', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--inventory',
        message: '--inventory 不接受位置参数',
        remedy: '盘点模式只接受 --workspace 与通用输出选项',
      }),
    ]);
  }
  for (const name of Object.keys(args.options)) {
    if (INVENTORY_ALLOWED_OPTIONS.has(name)) continue;
    const conflict = INVENTORY_CONFLICTS.has(name);
    return buildResult('scan', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: `--${name}`,
        message: conflict ? `--inventory 与 --${name} 互斥` : `--inventory 不接受 --${name}`,
        remedy: conflict
          ? '盘点模式不与对象类型、根覆盖或预演组合；请移除冲突选项'
          : '盘点模式只接受 --workspace 与通用输出选项',
      }),
    ]);
  }
  return null;
}

function readWorkspaceState(layout: WorkspaceLayout): WorkspaceReadState {
  if (!existsSync(layout.indexFile)) {
    return { state: 'uninitialized', index: null, config: {}, findings: [] };
  }
  try {
    const loaded = loadIndex(layout.indexFile);
    if (loaded.index === null) {
      return { state: 'unreadable', index: null, config: {}, findings: [...loaded.findings] };
    }
    return {
      state: 'ok',
      index: loaded.index,
      config: loaded.index.config,
      findings: [...loaded.findings],
    };
  } catch (error) {
    const kernelError = toKernelError(error, CODES.ENV_INCOMPLETE);
    return {
      state: 'unreadable',
      index: null,
      config: {},
      findings: [
        finding(kernelError.code, {
          source: kernelError.source,
          target: kernelError.target,
          message: kernelError.message,
          remedy: kernelError.remedy,
        }),
      ],
    };
  }
}

function homeOf(): string {
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir();
}

function pluginRootsOf(layout: WorkspaceLayout): {
  roots: InventoryRootView[];
  findings: Finding[];
} {
  try {
    const catalog = loadPluginCatalog({
      layout,
      builtins: loadHostRegistry().hosts,
      toolVersion: TOOL_VERSION,
    });
    return {
      roots: inventoryRootsForPluginCatalog(catalog, {
        workspaceRoot: layout.root,
        platform: process.platform,
      }),
      findings: [...catalog.findings],
    };
  } catch (error) {
    const kernelError = toKernelError(error, CODES.ENV_INCOMPLETE);
    return {
      roots: [],
      findings: [
        finding(kernelError.code, {
          source: kernelError.source,
          target: kernelError.target,
          message: kernelError.message,
          remedy: kernelError.remedy,
        }),
      ],
    };
  }
}

/** 只读生成盘点快照；供 scan --inventory 与 reconcile 预览共用。 */
export function inventorySnapshotOf(workspaceRoot: string): InventorySnapshot {
  const layout = layoutOf(workspaceRoot);
  const workspace = readWorkspaceState(layout);
  const builtinRoots = inventoryRootsForAll({
    workspaceRoot: layout.root,
    home: homeOf(),
    platform: process.platform,
    env: process.env,
    config: workspace.config,
  });
  const plugins = pluginRootsOf(layout);
  const roots = [...builtinRoots, ...plugins.roots];
  const discovered = discoverInventoryCopies(roots);
  const reconciled = reconcileInventory({
    discovery: discovered,
    workspace: { state: workspace.state, index: workspace.index },
    layout,
  });
  const aggregated = aggregateInventory({
    discovery: discovered,
    copies: reconciled.copies,
    corrupt: reconciled.corrupt,
    missing: reconciled.missing,
  });
  return {
    layout,
    workspace,
    roots,
    discovered,
    reconciled,
    aggregated,
    findings: [...workspace.findings, ...plugins.findings],
  };
}

/** 展开内置与已启用插件的候选根；本函数不判断路径是否存在。 */
export function inventoryScanCommand(plan: InventoryScanPlan, observedAt: string): Result<unknown> {
  const snapshot = inventorySnapshotOf(plan.workspaceRoot);
  const data: InventoryScanData = {
    mode: 'inventory',
    workspace: { root: snapshot.layout.root, state: snapshot.workspace.state },
    roots: snapshot.discovered.roots,
    hosts: snapshot.aggregated.hosts,
    copies: snapshot.reconciled.copies,
    corrupt: snapshot.reconciled.corrupt,
    missing: snapshot.reconciled.missing,
    summary: snapshot.aggregated.summary,
    degradation: snapshot.reconciled.degradation,
    ...(plan.audit ? { audit: inventoryAuditOf(snapshot, observedAt) } : {}),
  };
  return buildResult('scan', snapshot.findings, [], { data });
}
