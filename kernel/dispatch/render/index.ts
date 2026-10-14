/**
 * L2 输出渲染。
 *
 * 三种通道承载同一份信息：人类可读文本、机器可读结构、机器表格。
 * 结构化输出是权威形态，其余两种由它派生，不得增删语义。
 */
import type { Result } from '../../store/contract.ts';

export interface RenderOptions {
  json: boolean;
  machine: boolean;
  color: boolean;
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
};

/** 渲染结果封装为待输出文本 */
export function render(result: Result<unknown>, options: RenderOptions): string {
  if (options.json) return JSON.stringify(result, null, 2);
  if (options.machine) return renderMachine(result);
  return renderHuman(result, options.color);
}

function paint(text: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function renderHuman(result: Result<unknown>, color: boolean): string {
  const lines: string[] = [];
  const status = result.ok
    ? paint('成功', 'green', color)
    : paint(`失败（退出码 ${result.exit_code}）`, 'red', color);
  lines.push(`指令 ${result.command}：${status}`);

  for (const item of result.findings) {
    const level =
      item.severity === 'error' ? paint('错误', 'red', color) : paint('警告', 'yellow', color);
    lines.push(`  [${level}] ${item.code} ${item.target}`);
    lines.push(`        ${item.message}`);
    if (item.remedy !== '') lines.push(`        建议：${item.remedy}`);
  }

  if (result.changes.length > 0) {
    lines.push(paint(`变更 ${result.changes.length} 项：`, 'dim', color));
    for (const change of result.changes) {
      lines.push(`  ${change.action} ${change.path}`);
    }
  }

  if (result.ok && result.findings.length === 0 && result.changes.length === 0) {
    lines.push('  无变更');
  }
  return lines.join('\n');
}

function renderMachine(result: Result<unknown>): string {
  const rows: string[] = [['ok', 'command', 'exit_code', 'findings', 'changes'].join('\t')];
  rows.push(
    [
      String(result.ok),
      result.command,
      String(result.exit_code),
      String(result.findings.length),
      String(result.changes.length),
    ].join('\t'),
  );
  for (const item of result.findings) {
    rows.push(['finding', item.code, item.severity, item.target, item.message].join('\t'));
  }
  return rows.join('\n');
}
