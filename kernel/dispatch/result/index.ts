/**
 * 结果装配与退出码派生。
 *
 * 结构定义与问题码见内核契约词汇表 kernel/store/contract.ts，
 * 权威契约见 docs/specification/result-and-exit-codes.md。
 *
 * 本模块只负责两件事：按规则派生退出码、组装结果封装。
 * 所有失败路径都必须经由 buildResult 产出结果，不得让异常穿透到调用方。
 */
import { categoryOf, type Change, type Finding, type Result } from '../../store/contract.ts';

export type { Change, Finding, Result } from '../../store/contract.ts';

/**
 * 由问题列表派生退出码。
 *
 * 规则见契约 5.2 节，命中即停：
 * 无错误级问题 → 0；输入类 → 2；版本或索引或语法类 → 3；
 * 来源类 → 4；锁或文件系统类 → 5；依赖类 → 6；其余 → 1。
 */
export function exitCodeFor(findings: Finding[]): number {
  const errors = findings.filter((item) => item.severity === 'error');
  if (errors.length === 0) return 0;

  const categories = new Set(errors.map((item) => categoryOf(item.code)));
  if (categories.has('INPUT')) return 2;
  if (categories.has('VER') || categories.has('INDEX') || categories.has('YAML')) return 3;
  if (categories.has('SRC')) return 4;
  if (categories.has('LOCK') || categories.has('IO')) return 5;
  if (categories.has('DEP')) return 6;
  return 1;
}

/** 组装结果封装；退出码由问题列表推导，保证 ok 与退出码始终一致 */
export function buildResult<Data = unknown>(
  command: string,
  findings: Finding[],
  changes: Change[] = [],
  extra: { data?: Data; id?: string; preview?: boolean; request_id?: string } = {},
): Result<Data> {
  const exit_code = exitCodeFor(findings);
  const result: Result<Data> = {
    ok: exit_code === 0,
    command,
    findings,
    changes,
    exit_code,
  };
  if (extra.id !== undefined) result.id = extra.id;
  if (extra.data !== undefined) result.data = extra.data;
  if (extra.preview !== undefined) result.preview = extra.preview;
  if (extra.request_id !== undefined) result.request_id = extra.request_id;
  return result;
}
