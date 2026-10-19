/** reconcile 执行器的稳定返回类型；动作模块共享，避免实现模块互相依赖。 */
import type { Change, Finding, ReconcileResultItem } from '@skill-manager/contract';

export interface ReconcileExecutionItem {
  result: ReconcileResultItem;
  findings: Finding[];
  changes: Change[];
}
