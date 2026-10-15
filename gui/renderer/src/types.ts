/** 视图层使用的类型：与内核结果封装的形状一一对应，不引入任何业务推导 */

export interface Finding {
  code: string;
  severity: 'error' | 'warning';
  source: string;
  target: string;
  message: string;
  remedy: string;
}

export interface Change {
  action: 'add' | 'modify' | 'remove';
  kind: string;
  path: string;
  detail?: string;
}

export interface KernelResult {
  ok: boolean;
  command: string;
  id?: string;
  findings: Finding[];
  changes: Change[];
  exit_code: number;
  data?: Record<string, unknown>;
  preview?: boolean;
}

/** 列表条目：内核 list 载荷中的记录投影 */
export interface SkillSummary {
  id: string;
  name: string;
  version?: string;
  status: 'enabled' | 'disabled';
  source_type: string;
  targets: Array<{ target: string; scope: string; enabled: boolean }>;
  updated_at: string;
  validation: { status: 'ok' | 'invalid'; errors: string[]; last_scan_at?: string };
}

/**
 * 卡片状态：优先级 失效 > 禁用 > 启用。
 * 失效来自运行期结论，与用户主动禁用是两回事，界面上必须分开呈现。
 */
export type CardState = 'invalid' | 'disabled' | 'enabled';

export function cardStateOf(record: SkillSummary): CardState {
  if (record.validation.status === 'invalid') return 'invalid';
  return record.status === 'disabled' ? 'disabled' : 'enabled';
}

export interface LogEntry {
  at: string;
  text: string;
  ok: boolean;
}

/** 备份条目：内核 restore --list 载荷中的一行 */
export interface BackupRow {
  id: string;
  timestamp: string;
  type: string;
  file_count: number;
  path: string;
}
