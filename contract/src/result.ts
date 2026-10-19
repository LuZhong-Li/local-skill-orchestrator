/** 结果封装的纯类型；字段与 docs/specification/result-and-exit-codes.md 一致。 */
import type { Severity } from './codes.ts';

export interface Finding {
  code: string;
  severity: Severity;
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

export interface Result<Data = unknown> {
  ok: boolean;
  command: string;
  id?: string;
  findings: Finding[];
  changes: Change[];
  exit_code: number;
  data?: Data;
  request_id?: string;
  preview?: boolean;
}
