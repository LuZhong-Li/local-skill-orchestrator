/** registry 共享确认、计划与索引读取工具。 */
import { existsSync } from 'node:fs';
import { loadIndex } from '../../core/index/index.ts';
import { type LifecycleOutcome } from '../../core/lifecycle/index.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import { layoutOf } from '../../store/workspace/index.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { buildResult, type Result } from '../result/index.ts';
import { flag, type ParsedArgs } from '../parsers/index.ts';
import {
  confirmLevelOf,
  decideConfirmation,
  isAffirmative,
  type ConfirmLevel,
  type ConfirmPlan,
  type Interaction,
} from '../policy/index.ts';
export async function confirmationGate(options: {
  command: string;
  args: ParsedArgs;
  interaction: Interaction;
  preview: LifecycleOutcome;
  plan: ConfirmPlan;
  /** 级别提升：宿主分发写工作区之外时，把「无需确认」的两条指令升到轻确认 */
  escalateTo?: ConfirmLevel;
}): Promise<Result<unknown> | null> {
  const { command, args, interaction, preview, plan, escalateTo } = options;
  if (preview.data['rejected'] !== undefined) {
    return buildResult(command, preview.findings, [], { data: preview.data });
  }
  if (preview.findings.some((item) => item.severity === 'error') && preview.changes.length === 0) {
    return buildResult(command, preview.findings, [], { data: preview.data });
  }
  const decision = decideConfirmation({
    level: escalateTo ?? confirmLevelOf(command, { hard: flag(args, 'hard') }),
    yes: flag(args, 'yes'),
    dryRun: flag(args, 'dry-run'),
    interaction,
    plan,
  });
  if (decision.kind === 'skip') return null;
  if (decision.kind === 'reject') return buildResult(command, [decision.finding]);
  interaction.write(`${decision.text}\n`);
  const answer = await interaction.read();
  if (isAffirmative(answer)) return null;
  // 用户取消：未做任何变更。契约 2.4 规定默认聚焦取消，因此空白与无法识别的回答同样按取消处理。
  return buildResult(command, [], [], {
    data: {
      aborted: 'user_declined',
      impact: plan.writes,
      notes: plan.notes,
    },
  });
}
/** 确认提示中的动作名称：与指令名一一对应，不得互相借用 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  install: '安装',
  uninstall: '卸载',
  enable: '启用',
  disable: '禁用',
  update: '刷新',
  import: '导入',
  restore: '恢复',
};
/** 由预览结果与附加提示组装预期变更摘要 */
export function planOf(
  command: string,
  subject: string,
  preview: LifecycleOutcome,
  notes: string[],
): ConfirmPlan {
  return {
    action: ACTION_LABELS[command] ?? command,
    subject,
    writes: preview.changes.map((item) => ({
      action: item.action,
      kind: item.kind,
      path: item.path,
    })),
    notes,
  };
}
export function loadForRead(layout: ReturnType<typeof layoutOf>): {
  index: SkillIndex | null;
  findings: Finding[];
  initialized: boolean;
} {
  if (!existsSync(layout.indexFile)) {
    return { index: null, findings: [], initialized: false };
  }
  const loaded = loadIndex(layout.indexFile);
  return { index: loaded.index, findings: [...loaded.findings], initialized: true };
}
export function loadForWrite(layout: ReturnType<typeof layoutOf>): {
  index: SkillIndex | null;
  findings: Finding[];
  missing: boolean;
} {
  if (!existsSync(layout.indexFile)) return { index: null, findings: [], missing: true };
  const loaded = loadIndex(layout.indexFile);
  return { index: loaded.index, findings: [...loaded.findings], missing: false };
}
/** 索引缺失或损坏时的统一回应：按写操作处理，索引不可用即不能继续 */
export function unreadableIndex(
  command: string,
  layout: ReturnType<typeof layoutOf>,
  findings: Finding[],
  missing: boolean,
): Result<unknown> {
  return buildResult(command, [
    ...findings,
    missing
      ? finding(CODES.ENV_NOT_INITIALIZED, {
          source: 'workspace',
          target: layout.root,
          message: '工作区尚未初始化',
          remedy: '请先执行 init',
        })
      : finding(CODES.ENV_INCOMPLETE, {
          source: 'workspace',
          target: layout.indexFile,
          message: '索引无法读取，不能执行写操作',
          remedy: '请先修复或重建索引',
        }),
  ]);
}
export function formatRejected(
  command: string,
  findings: Finding[],
  data: Record<string, unknown>,
): Result<unknown> {
  const result = buildResult(command, findings, [], { data });
  if (data['rejected'] === 'invalid_format' && result.exit_code !== 2) {
    result.exit_code = 3;
    result.ok = false;
  }
  return result;
}
