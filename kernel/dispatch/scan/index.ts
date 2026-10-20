/** scan 指令入口：插件分支与 workspace / M4c-1 inventory 分流点。 */
import { pluginKind } from '../shared/options.ts';
import { inventoryOptionsError, inventoryScanCommand } from './inventory.ts';
import { scanPlanOf } from './options.ts';
import { pluginScanCommand } from './plugin.ts';
import { workspaceScanCommand } from './workspace.ts';
import type { ScanCommandInput } from './types.ts';

export type {
  PluginScanData,
  ScanCommandInput,
  ScanMode,
  ScanPlan,
  WorkspaceScanPlan,
} from './types.ts';

export async function scanHandler({ args, now }: ScanCommandInput) {
  const inventoryRejected = inventoryOptionsError(args);
  if (inventoryRejected !== null) return inventoryRejected;

  // 插件对象继续走既有分支；该分支不持有 Skill 索引锁。
  if (pluginKind(args)) return pluginScanCommand({ args, now });

  const plan = scanPlanOf(args);

  // 必须在任何工作区索引存在性检查之前分流：
  //   inventory → 只展开根，不加锁、不写 last_scan_at，允许未初始化；
  //   workspace → 保持既有加锁、发现与索引写入。
  if (plan.mode === 'inventory') return inventoryScanCommand(plan, now);
  return workspaceScanCommand(plan, now);
}
