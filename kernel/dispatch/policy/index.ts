/**
 * C-03 确认与预演策略。
 *
 * 职责边界：本层只裁决「能否继续、需要什么确认」，并渲染确认提示。
 *   不执行任何业务逻辑，不决定变更内容，也不读写文件。
 *   预期变更摘要由调用方按预览结果给出——哪些文件、索引与副本会被写入属于业务知识，
 *   本层只负责分级、渲染与判定。
 *
 * 依据：指令契约 2.4 确认强度、第 3 节指令总表的需确认级别列、4.7 与 4.8 的预演与确认。
 *
 * 确认强度到本层的映射：
 *   无需确认 → none；轻确认 → light（行内二次触发，单行提示）；
 *   强制二次确认 → standard（独立确认，逐条列出影响范围）；
 *   `--hard` 在卸载上再升一档 → strict（在常规之上单独指明永久删除）。
 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';

export type ConfirmLevel = 'none' | 'light' | 'standard' | 'strict';

/**
 * 每指令确认级别登记表，本层是唯一事实源。
 * 指令实现一律通过 confirmLevelOf 查询，不得各自硬编码确认逻辑。
 */
export const CONFIRMATION_TABLE: Readonly<Record<string, ConfirmLevel>> = {
  init: 'none',
  'config get': 'none',
  'config set': 'none',
  scan: 'none',
  list: 'none',
  inspect: 'none',
  install: 'light',
  uninstall: 'standard',
  enable: 'none',
  disable: 'none',
  update: 'light',
  validate: 'none',
  deps: 'none',
  export: 'none',
  import: 'light',
  restore: 'standard',
  reconcile: 'standard',
  'pipeline run': 'none',
  'experience list': 'none',
  'experience search': 'none',
  'experience show': 'none',
};

/** 会把级别升档的选项：卸载带 `--hard` 时高于常规级别 */
export function confirmLevelOf(command: string, options: { hard?: boolean } = {}): ConfirmLevel {
  const base = CONFIRMATION_TABLE[command] ?? 'none';
  if (command === 'uninstall' && options.hard === true) return 'strict';
  return base;
}

/** 预期变更摘要：由调用方按预览结果组装 */
export interface ConfirmPlan {
  /** 动作类型，例如「安装」或「卸载」 */
  action: string;
  /** 目标：Skill 标识或来源 */
  subject: string;
  /** 将发生的写入点，逐条给出 */
  writes: Array<{ action: string; kind: string; path: string }>;
  /** 附加提示，例如中心库原件将被永久删除 */
  notes: string[];
  /** 轻确认的单行摘要；省略时按变更条数呈现 */
  inline?: string;
}

/** 交互通道：由宿主注入，便于在无终端环境下测试拒绝路径 */
export interface Interaction {
  /** 是否存在可用终端；为假时禁止等待输入 */
  interactive: boolean;
  /** 输出提示文本 */
  write(text: string): void;
  /** 读取一行回答 */
  read(): Promise<string>;
}

export interface ConfirmRequest {
  level: ConfirmLevel;
  /** 是否传入跳过确认选项 */
  yes: boolean;
  /** 是否预演 */
  dryRun: boolean;
  interaction: Interaction;
  plan: ConfirmPlan;
}

export type ConfirmDecision =
  | { kind: 'skip'; reason: 'none' | 'yes' | 'dry-run' }
  | { kind: 'prompt'; level: ConfirmLevel; text: string }
  | { kind: 'reject'; finding: Finding };

/**
 * 判定本次调用是否需要确认、能否在无终端环境下继续。
 * 判定次序：无需确认 → 跳过；给出跳过选项 → 跳过；预演 → 跳过；
 * 无可用终端 → 拒绝并要求显式给出跳过选项；否则要求交互确认。
 */
export function decideConfirmation(request: ConfirmRequest): ConfirmDecision {
  const { level, yes, dryRun, interaction, plan } = request;
  if (level === 'none') return { kind: 'skip', reason: 'none' };
  if (yes) return { kind: 'skip', reason: 'yes' };
  if (dryRun) return { kind: 'skip', reason: 'dry-run' };
  if (!interaction.interactive) {
    return {
      kind: 'reject',
      finding: finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: '--yes',
        message: `非交互环境缺少跳过确认选项：${plan.action} ${plan.subject} 需要确认后才能执行`,
        remedy: '请在非交互调用中显式给出 --yes，或改用 --dry-run 先查看将发生的变更',
      }),
    };
  }
  return { kind: 'prompt', level, text: buildPrompt(plan, level) };
}

/** 渲染确认提示：轻确认为单行行内触发，常规与强制为独立的多行影响范围清单 */
export function buildPrompt(plan: ConfirmPlan, level: ConfirmLevel): string {
  if (level === 'light') {
    const summary = plan.inline ?? `将产生 ${plan.writes.length} 处变更`;
    return `${plan.action} ${plan.subject}：${summary}，确认执行？[y/N] `;
  }
  const lines: string[] = [];
  lines.push(`${plan.action} ${plan.subject} 的影响范围：`);
  for (const write of plan.writes) {
    lines.push(`  ${write.action} ${write.path}（${write.kind}）`);
  }
  if (plan.writes.length === 0) lines.push('  无文件与索引变更');
  for (const note of plan.notes) lines.push(`  注意：${note}`);
  if (level === 'strict') {
    lines.push('  本次为强制确认级别：操作不可撤销，请确认你已了解上述影响。');
  }
  lines.push(`共 ${plan.writes.length} 处变更。确认执行？[y/N] `);
  return lines.join('\n');
}

/** 回答是否表示肯定；空回答与无法识别的回答一律按取消处理（契约 2.4：默认聚焦取消） */
export function isAffirmative(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}
