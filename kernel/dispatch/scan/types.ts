/** scan 指令的稳定计划与结果类型；不包含执行逻辑。 */
import type { ScanSummary } from '../../core/discovery/index.ts';
import type { PluginIndex } from '@skill-manager/contract';
import type { ParsedArgs } from '../parsers/index.ts';

/** M4c-1 将增加 inventory；本批只生成 workspace 计划。 */
export type ScanMode = 'workspace' | 'inventory';

export interface ScanCommandInput {
  args: ParsedArgs;
  now: string;
}

export interface WorkspaceScanPlan {
  mode: 'workspace';
  workspaceRoot: string;
  dryRun: boolean;
  roots: string[];
}

export interface InventoryScanPlan {
  mode: 'inventory';
  workspaceRoot: string;
}

/** workspace 与 inventory 两条互斥路径；插件模式由 scan 入口先行分流。 */
export type ScanPlan = WorkspaceScanPlan | InventoryScanPlan;

export interface WorkspaceScanData {
  root: string;
  summary: ScanSummary;
  total: number;
}

export interface PluginScanData {
  kind: 'plugin';
  registered: number;
  invalid: number;
  unregistered: Array<Record<string, unknown>>;
  orphaned_landings: PluginIndex['landings'];
}
