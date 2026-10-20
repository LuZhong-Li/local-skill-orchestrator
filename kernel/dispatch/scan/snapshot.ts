/** 盘点快照的跨模块类型；避免 inventory 与审计 source 互相引用。 */
import type {
  Finding,
  InventoryDiscoveryResult,
  InventoryHostNode,
  InventoryRootView,
  InventorySummary,
} from '@skill-manager/contract';
import type { SkillIndex } from '../../core/metadata/types.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { ReconciledInventory } from './reconcile.ts';

export interface WorkspaceReadState {
  state: 'ok' | 'uninitialized' | 'unreadable';
  index: SkillIndex | null;
  config: Record<string, unknown>;
  findings: Finding[];
}

export interface InventorySnapshot {
  layout: WorkspaceLayout;
  workspace: WorkspaceReadState;
  roots: InventoryRootView[];
  discovered: InventoryDiscoveryResult;
  reconciled: ReconciledInventory;
  aggregated: {
    summary: InventorySummary;
    hosts: InventoryHostNode[];
  };
  findings: Finding[];
}
