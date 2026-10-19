/** 宿主卸载计划/执行结果类型；独立文件用于断开 plan 与 execute 的循环依赖。 */
import type { Change, Finding } from '../../store/contract.ts';
import type { HostLandingIndex, PluginIndex } from '@skill-manager/contract';
import type { UnifiedFormat, UnifiedLanding } from '../../core/host-landings/uninstall.ts';

export interface HostUninstallGroup {
  physical_path: string;
  exists: boolean;
  format: UnifiedFormat;
  shared: boolean;
  landings: UnifiedLanding[];
}

export interface HostUninstallPlan {
  hostValue: string;
  groups: HostUninstallGroup[];
  findings: Finding[];
}

export interface HostUninstallResultItem {
  host_id: string;
  ledger_source: string;
  target_path: string;
  status: 'removed' | 'missing' | 'unchanged' | 'failed';
  message?: string;
}

export interface HostUninstallExecution {
  results: HostUninstallResultItem[];
  findings: Finding[];
  changes: Change[];
  hostIndex: HostLandingIndex;
  pluginIndex: PluginIndex;
  orphaned_records: number;
}

export interface HostUninstallHooks {
  onBeforeDelete?: (physicalPath: string) => void;
}
