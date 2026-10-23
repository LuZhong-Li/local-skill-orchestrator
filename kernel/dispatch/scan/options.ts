/** scan 参数计划：workspace 与 inventory 的现有允许项。 */
import { flag, option, optionList, type ParsedArgs } from '../parsers/index.ts';
import { workspaceRootOf } from '../shared/options.ts';
import type { InventoryScanPlan, WorkspaceScanPlan } from './types.ts';
import type { AuditReportFormat } from '@skill-manager/contract';

export function scanPlanOf(args: ParsedArgs): WorkspaceScanPlan | InventoryScanPlan {
  if (flag(args, 'inventory')) {
    const format = option(args, 'format') as Exclude<AuditReportFormat, 'json'> | undefined;
    return {
      mode: 'inventory',
      workspaceRoot: workspaceRootOf(args),
      audit: flag(args, 'audit'),
      ...(format === undefined ? {} : { format }),
      ...(option(args, 'output') === undefined ? {} : { output: option(args, 'output') as string }),
    };
  }
  return {
    mode: 'workspace',
    workspaceRoot: workspaceRootOf(args),
    dryRun: flag(args, 'dry-run'),
    roots: optionList(args, 'root'),
  };
}
