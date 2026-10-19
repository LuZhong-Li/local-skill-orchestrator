/**
 * L2 输出渲染。
 *
 * 三种通道承载同一份信息：人类可读文本、机器可读结构、机器表格。
 * 结构化输出是权威形态，其余两种由它派生，不得增删语义。
 */
import type { Result } from '@skill-manager/contract';
import type { InventoryHostNode, InventorySummary } from '@skill-manager/contract';

export interface RenderOptions {
  json: boolean;
  machine: boolean;
  color: boolean;
  verbose?: boolean;
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
  return renderHuman(result, options.color, options.verbose === true);
}

function paint(text: string, color: keyof typeof ANSI, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function renderHuman(result: Result<unknown>, color: boolean, verbose: boolean): string {
  const lines: string[] = [];
  appendHeader(result, lines, color);
  appendFindings(result, lines, color);
  appendChanges(result, lines, color);
  appendOutcome(result, lines, color, verbose);
  return lines.join('\n');
}

function appendHeader(result: Result<unknown>, lines: string[], color: boolean): void {
  const status = result.ok
    ? paint('成功', 'green', color)
    : paint(`失败（退出码 ${result.exit_code}）`, 'red', color);
  lines.push(`指令 ${result.command}：${status}`);
  if (result.preview === true) {
    lines.push(paint('  预演模式：未写入任何文件，下列变更均未发生', 'dim', color));
  }
  if (abortedReason(result) !== null) {
    lines.push(paint('  已取消：未做任何变更', 'dim', color));
  }
}

function appendFindings(result: Result<unknown>, lines: string[], color: boolean): void {
  for (const item of result.findings) {
    const level =
      item.severity === 'error' ? paint('错误', 'red', color) : paint('警告', 'yellow', color);
    lines.push(`  [${level}] ${item.code} ${item.target}`);
    lines.push(`        ${item.message}`);
    if (item.remedy !== '') lines.push(`        建议：${item.remedy}`);
  }
}

function appendChanges(result: Result<unknown>, lines: string[], color: boolean): void {
  if (result.changes.length > 0) {
    lines.push(paint(`变更 ${result.changes.length} 项：`, 'dim', color));
    for (const change of result.changes) {
      lines.push(`  ${change.action} ${change.path}`);
    }
  }
}

function appendOutcome(
  result: Result<unknown>,
  lines: string[],
  color: boolean,
  verbose: boolean,
): void {
  const inventory = inventoryDataOf(result);
  if (inventory !== null) {
    lines.push(...renderInventoryHuman(inventory, color, verbose));
  } else if (result.ok && result.findings.length === 0 && result.changes.length === 0) {
    lines.push('  无变更');
  }
}

interface InventoryData {
  mode: 'inventory';
  summary: InventorySummary;
  hosts: InventoryHostNode[];
  copies: Array<{
    path: string;
    host_id: string;
    reconciliation: { classification: string };
  }>;
}

function inventoryDataOf(result: Result<unknown>): InventoryData | null {
  const data = result.data;
  if (data === null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  return record['mode'] === 'inventory' ? (data as InventoryData) : null;
}

function renderInventoryHuman(data: InventoryData, color: boolean, verbose: boolean): string[] {
  const lines: string[] = [];
  const main = data.summary.main;
  lines.push(
    `  全机盘点：${String(main.total_copies)} 个安装副本 / ${String(main.unique_skills)} 个不同技能`,
  );
  lines.push(
    `  用户 user：${String(data.summary.roles.user.total_copies)} 个副本 / ${String(data.summary.roles.user.unique_skills)} 个不同技能`,
  );
  for (const role of ['system', 'platform', 'project'] as const) {
    const item = data.summary.roles[role];
    lines.push(
      `  ${roleLabel(role)}：${String(item.total_copies)} 个副本 / ${String(item.unique_skills)} 个不同技能`,
    );
  }
  lines.push(
    `  分类：managed ${String(data.summary.classification_groups.managed.total)} · drift ${String(
      data.summary.classification_groups.drift.total,
    )} · missing ${String(data.summary.classification_groups.missing)} · untracked ${String(
      data.summary.classification_groups.untracked,
    )}`,
  );
  lines.push(
    `  其他：undetermined ${String(data.summary.classification_groups.undetermined)} · unreadable ${String(
      data.summary.classification_groups.unreadable,
    )} · orphaned ${String(data.summary.classification_groups.orphaned.total)}`,
  );
  lines.push(
    paint(
      '  提示：system/platform 为平台或系统内置；明细可用 --json 或 --verbose 查看',
      'dim',
      color,
    ),
  );
  if (data.hosts.length > 0) {
    lines.push(paint('  宿主：', 'dim', color));
    for (const host of data.hosts) {
      lines.push(
        `    ${host.display_name}（${host.host_id}）：${String(host.counts.total_copies)} 个副本 / ${String(
          host.counts.unique_skills,
        )} 个技能`,
      );
    }
  }
  if (verbose) {
    lines.push(paint('  副本明细：', 'dim', color));
    for (const copy of data.copies) {
      lines.push(`    ${copy.reconciliation.classification} ${copy.host_id} ${copy.path}`);
    }
  }
  return lines;
}

function roleLabel(role: 'system' | 'platform' | 'project'): string {
  if (role === 'system') return '系统 system';
  if (role === 'platform') return '平台 platform';
  return '项目 project';
}

/** 读取结果载荷中的取消标记；非取消结果返回 null */
function abortedReason(result: Result<unknown>): string | null {
  const data = result.data;
  if (data === undefined || data === null || typeof data !== 'object') return null;
  const aborted = (data as Record<string, unknown>)['aborted'];
  return typeof aborted === 'string' && aborted !== '' ? aborted : null;
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
