/** scan 的 workspace 分支：加锁、发现、索引写入、结果组装。 */
import { existsSync } from 'node:fs';
import { scanWorkspace } from '../../core/discovery/index.ts';
import { loadIndex, saveIndex } from '../../core/index/index.ts';
import { withLock } from '../../store/locking/index.ts';
import { layoutOf } from '../../store/workspace/index.ts';
import {
  scanFailureResult,
  scanUninitializedResult,
  scanUnreadableIndexResult,
  workspaceScanResult,
} from './result.ts';
import type { WorkspaceScanPlan } from './types.ts';

export async function workspaceScanCommand(plan: WorkspaceScanPlan, now: string) {
  const layout = layoutOf(plan.workspaceRoot);
  if (!existsSync(layout.indexFile)) return scanUninitializedResult(layout);

  try {
    return await withLock(layout.indexFile, () => {
      const loaded = loadIndex(layout.indexFile);
      if (loaded.index === null) return scanUnreadableIndexResult(layout, loaded.findings);

      const index =
        plan.roots.length > 0
          ? { ...loaded.index, config: { ...loaded.index.config, skill_roots: plan.roots } }
          : loaded.index;
      const outcome = scanWorkspace({ layout, index, now });
      const findings = [...loaded.findings, ...outcome.findings];
      if (!plan.dryRun) saveIndex(layout.indexFile, outcome.index);

      return workspaceScanResult({
        layout,
        outcome,
        findings,
        dryRun: plan.dryRun,
      });
    });
  } catch (error) {
    return scanFailureResult(error);
  }
}
