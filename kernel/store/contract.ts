/**
 * 跨层契约词汇表的 kernel 侧兼容入口。
 *
 * 权威定义已迁至 `@skill-manager/contract`（纯类型 / 常量）；本文件只保留
 * kernel 内部使用的纯函数（严重级别推导、类别提取、finding 构造），
 * 不重复定义 CODES 或结果类型。
 */
import type { Finding, ProblemCode, Severity } from '@skill-manager/contract';

export { CODES } from '@skill-manager/contract';
export type { Change, Finding, ProblemCode, Result, Severity } from '@skill-manager/contract';

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
