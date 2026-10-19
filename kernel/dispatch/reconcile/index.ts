/** reconcile 指令入口：T0 只注册、校验并生成只读动作预览。 */
import { CODES } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { CommandHandler } from '../registry/types.ts';
import { buildResult } from '../result/index.ts';
import { workspaceRootOf } from '../shared/options.ts';
import { inventorySnapshotOf } from '../scan/inventory.ts';
import { parseReconcileOptions } from './options.ts';
import { buildReconcilePreview } from './plan.ts';

function selectionMissingResult(selectionMode: string): ReturnType<typeof buildResult> {
  return buildResult('reconcile', [
    finding(CODES.INPUT_INVALID_ARG, {
      source: 'input',
      target: selectionMode,
      message: '没有匹配到盘点中的物理副本或账本记录',
      remedy: '先执行 scan --inventory --json 获取 path / id / host，再重试 reconcile',
    }),
  ]);
}

export const reconcileHandler: CommandHandler = async ({ args }) => {
  const parsed = parseReconcileOptions(args);
  if (parsed.error !== undefined || parsed.selection === undefined) {
    return parsed.error ?? buildResult('reconcile', []);
  }
  const selection = parsed.selection;
  const snapshot = inventorySnapshotOf(workspaceRootOf(args));
  const data = buildReconcilePreview(snapshot, selection);
  if (data.items.length === 0 && selection.mode !== 'classification') {
    return selectionMissingResult(
      selection.mode === 'path' ? (selection.path ?? '--path') : (selection.id ?? '--id'),
    );
  }
  const findings = [...snapshot.findings];
  if (selection.apply) {
    findings.push(
      finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
        source: 'reconcile',
        target: selection.action,
        message: `reconcile ${selection.action} 的写入执行尚未实现`,
        remedy: '本批只提供只读预览；请在后续动作批次启用 --apply',
      }),
    );
  }
  return buildResult('reconcile', findings, [], { data, preview: true });
};
