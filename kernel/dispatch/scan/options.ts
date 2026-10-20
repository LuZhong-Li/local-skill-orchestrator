/** scan 参数计划：workspace 与 inventory 的现有允许项。 */
import { flag, optionList, type ParsedArgs } from '../parsers/index.ts';
import { workspaceRootOf } from '../shared/options.ts';
import type { InventoryScanPlan, WorkspaceScanPlan } from './types.ts';

export function scanPlanOf(args: ParsedArgs): WorkspaceScanPlan | InventoryScanPlan {
  if (flag(args, 'inventory')) {
    return {
      mode: 'inventory',
      workspaceRoot: workspaceRootOf(args),
      audit: flag(args, 'audit'),
    };
  }
  return {
    mode: 'workspace',
    workspaceRoot: workspaceRootOf(args),
    dryRun: flag(args, 'dry-run'),
    roots: optionList(args, 'root'),
  };
}
