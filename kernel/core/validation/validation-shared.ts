/** 校验共享类型、投影字段与结果工具。 */
import { statSync } from 'node:fs';
import type { SkillIndex, ValidationStatus } from '../metadata/types.ts';
import type { Finding } from '@skill-manager/contract';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { computeChecksum } from '../integrity/index.ts';

export const PROJECTION_FIELDS = [
  'name',
  'version',
  'description',
  'author',
  'license',
  'path',
  'trigger_keywords',
] as const;

/** V-16 比对 targets 摘要的子字段；enabled 属运行期可见性，不参与判定 */
export const PROJECTION_TARGET_FIELDS = ['target', 'scope'] as const;

/** V-14 比对的派生区字段 */
export const DERIVED_FIELDS_COMPARED = ['created_at', 'updated_at', 'checksum'] as const;

export interface RecordVerdict {
  id: string;
  /** 实时计算的校验结论 */
  status: ValidationStatus;
  /** 实时计算得到的错误级问题码 */
  errors: string[];
  /** 实时计算得到的警告级问题码 */
  warnings: string[];
  /** 索引中已有的运行期结论 */
  stored: ValidationStatus;
  /** 索引内结论与实时结论是否不一致 */
  stale: boolean;
}

export interface ValidationReport {
  scope: 'environment' | 'record';
  subject?: string;
  total: number;
  passed: number;
  invalid: number;
  warnings: number;
  errors: number;
  /** 结论已过期的记录数 */
  stale: number;
  code_counts: Record<string, number>;
  records: RecordVerdict[];
}

export interface ValidateOutcome {
  findings: Finding[];
  report: ValidationReport;
}

export interface ValidateInput {
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 指定对象：Skill 标识，或工作区内的相对路径；省略时校验整个环境 */
  subject?: string;
}

/**
 * 校验工作区。不带 subject 时校验整个环境，带 subject 时只报告该对象的问题。
 * 无论哪种范围都只读，不写入任何文件。
 */
export function summarize(
  findings: Finding[],
  verdicts: RecordVerdict[],
  single: boolean,
  subject: string | undefined,
): ValidationReport {
  const codeCounts: Record<string, number> = {};
  for (const item of findings) {
    codeCounts[item.code] = (codeCounts[item.code] ?? 0) + 1;
  }
  const report: ValidationReport = {
    scope: single ? 'record' : 'environment',
    total: verdicts.length,
    passed: verdicts.filter((item) => item.status === 'ok').length,
    invalid: verdicts.filter((item) => item.status === 'invalid').length,
    warnings: findings.filter((item) => item.severity === 'warning').length,
    errors: findings.filter((item) => item.severity === 'error').length,
    stale: verdicts.filter((item) => item.stale).length,
    code_counts: codeCounts,
    records: verdicts,
  };
  if (single && subject !== undefined) report.subject = subject;
  return report;
}

export function safeChecksum(dir: string): string | null {
  try {
    if (!statSync(dir).isDirectory()) return null;
    return computeChecksum(dir);
  } catch {
    return null;
  }
}

export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function describe(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function uniqueCodes(findings: Finding[]): string[] {
  return [...new Set(findings.map((item) => item.code))].sort();
}
