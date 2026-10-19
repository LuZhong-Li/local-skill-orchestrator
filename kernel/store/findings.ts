/** 问题条目的纯构造与类别推导；契约词汇来自 `@skill-manager/contract`。 */
import type { Finding, ProblemCode, Severity } from '@skill-manager/contract';

/** 级别字母与严重级别的对应：E 为错误，W 为警告 */
export function severityOf(code: string): Severity {
  return code.startsWith('W-') ? 'warning' : 'error';
}

/** 取问题码的类别段，用于退出码派生 */
export function categoryOf(code: string): string {
  const parts = code.split('-');
  return parts.length >= 2 ? (parts[1] ?? '') : '';
}

/** 构造问题条目；严重级别由问题码的级别字母推导，避免二者不一致 */
export function finding(
  code: ProblemCode | string,
  fields: Omit<Finding, 'code' | 'severity'>,
): Finding {
  return { code, severity: severityOf(code), ...fields };
}
