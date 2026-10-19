/** reconcile 指令入口：默认只读预览；T1 的 repair / forget 支持 --apply。 */
import { CODES, type ReconcileApplyData } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import { withLock } from '../../store/locking/index.ts';
import { layoutOf, type WorkspaceLayout } from '../../store/workspace/index.ts';
import type { CommandHandler } from '../registry/types.ts';
import { buildResult, type Result } from '../result/index.ts';
import { flag } from '../parsers/index.ts';
import { decideConfirmation, isAffirmative, type ConfirmPlan } from '../policy/index.ts';
import { workspaceRootOf } from '../shared/options.ts';
import { inventorySnapshotOf } from '../scan/inventory.ts';
import { parseReconcileOptions } from './options.ts';
import { buildReconcilePreview, reconcilePlanSignature } from './plan.ts';
import { executeReconcilePlan } from './execute.ts';

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

function applyDataOf(plan: ReturnType<typeof buildReconcilePreview>): ReconcileApplyData {
  return {
    mode: plan.mode,
    action: plan.action,
    selection: plan.selection,
    apply_requested: plan.apply_requested,
    applied: false,
    items: plan.items,
    transaction_groups: plan.transaction_groups,
    summary: plan.summary,
    notes: plan.notes,
    results: [],
  };
}

function confirmationPlan(plan: ReturnType<typeof buildReconcilePreview>): ConfirmPlan {
  const items = plan.items.filter((item) => item.status === 'planned');
  return {
    action: 'reconcile',
    subject: `${plan.action} ${String(items.length)} 项`,
    writes: items.flatMap((item) => item.writes),
    notes: [
      'T3 执行内置宿主的 adopt / track / repair / forget / accept / clean',
      '共享根与 x- 宿主项保持 skipped，不会写入',
      '预览后若副本、分类或账本发生变化，计划将被拒绝',
    ],
  };
}

async function confirmApply(
  args: Parameters<CommandHandler>[0]['args'],
  interaction: Parameters<CommandHandler>[0]['interaction'],
  plan: ReturnType<typeof buildReconcilePreview>,
): Promise<Result<unknown> | null> {
  const decision = decideConfirmation({
    level: 'standard',
    yes: flag(args, 'yes'),
    dryRun: false,
    interaction,
    plan: confirmationPlan(plan),
  });
  if (decision.kind === 'skip') return null;
  if (decision.kind === 'reject') return buildResult('reconcile', [decision.finding]);
  interaction.write(`${decision.text}\n`);
  const answer = await interaction.read();
  if (isAffirmative(answer)) return null;
  return buildResult('reconcile', [], [], {
    data: { aborted: 'user_declined', action: plan.action },
  });
}

async function applyReconcile(input: {
  args: Parameters<CommandHandler>[0]['args'];
  selection: NonNullable<ReturnType<typeof parseReconcileOptions>['selection']>;
  layout: WorkspaceLayout;
  plan: ReturnType<typeof buildReconcilePreview>;
  findings: readonly import('@skill-manager/contract').Finding[];
  now: string;
  interaction: Parameters<CommandHandler>[0]['interaction'];
}): Promise<Result<unknown>> {
  if (
    input.selection.action !== 'repair' &&
    input.selection.action !== 'forget' &&
    input.selection.action !== 'adopt' &&
    input.selection.action !== 'track' &&
    input.selection.action !== 'accept' &&
    input.selection.action !== 'clean'
  ) {
    return buildResult(
      'reconcile',
      [
        ...input.findings,
        finding(CODES.RECONCILE_ACTION_UNSUPPORTED, {
          source: 'reconcile',
          target: input.selection.action,
          message: `当前批次无法执行 ${input.selection.action}`,
          remedy: '请确认动作、工作区基线与选择器后重试',
        }),
      ],
      [],
      { data: applyDataOf(input.plan) },
    );
  }
  const planned = input.plan.items.filter((item) => item.status === 'planned');
  if (planned.length === 0) {
    return buildResult('reconcile', [...input.findings], [], {
      data: applyDataOf(input.plan),
      preview: true,
    });
  }
  const blocked = await confirmApply(input.args, input.interaction, input.plan);
  if (blocked !== null) return blocked;
  return withLock(input.layout.indexFile, async () => {
    const fresh = inventorySnapshotOf(input.layout.root);
    const freshPlan = buildReconcilePreview(fresh, input.selection);
    if (reconcilePlanSignature(input.plan) !== reconcilePlanSignature(freshPlan)) {
      return buildResult('reconcile', [
        finding(CODES.RECONCILE_PLAN_STALE, {
          source: 'reconcile',
          target:
            input.selection.path ?? input.selection.id ?? input.selection.classification ?? '',
          message: '预览后目标事实已变化，拒绝执行旧计划',
          remedy: '重新运行 reconcile 预览并确认新计划',
        }),
      ]);
    }
    const execution = executeReconcilePlan({
      plan: applyDataOf(freshPlan),
      layout: input.layout,
      index: fresh.workspace.index,
      now: input.now,
    });
    return buildResult('reconcile', [...input.findings, ...execution.findings], execution.changes, {
      data: execution.data,
    });
  });
}

export const reconcileHandler: CommandHandler = async ({ args, now, interaction }) => {
  const parsed = parseReconcileOptions(args);
  if (parsed.error !== undefined || parsed.selection === undefined) {
    return parsed.error ?? buildResult('reconcile', []);
  }
  const selection = parsed.selection;
  const layout = layoutOf(workspaceRootOf(args));
  const snapshot = inventorySnapshotOf(layout.root);
  const plan = buildReconcilePreview(snapshot, selection);
  if (plan.items.length === 0 && selection.mode !== 'classification') {
    return selectionMissingResult(
      selection.mode === 'path' ? (selection.path ?? '--path') : (selection.id ?? '--id'),
    );
  }
  const findings = [...snapshot.findings];
  if (selection.apply) {
    return applyReconcile({
      args,
      selection,
      layout,
      plan,
      findings,
      now,
      interaction,
    });
  }
  return buildResult('reconcile', findings, [], { data: plan, preview: true });
};
