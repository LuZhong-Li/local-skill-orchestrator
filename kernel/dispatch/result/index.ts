/**
 * 结果装配与退出码派生。
 *
 * 结构定义与问题码见 `@skill-manager/contract`，
 * 权威契约见 docs/specification/result-and-exit-codes.md。
 *
 * 本模块只负责两件事：按规则派生退出码、组装结果封装。
 * 所有失败路径都必须经由 buildResult 产出结果，不得让异常穿透到调用方。
 */
import { type Change, type Finding, type Result } from '@skill-manager/contract';
import { categoryOf } from '../../store/findings.ts';

export type { Change, Finding, Result } from '@skill-manager/contract';

/**
 * 由问题列表派生退出码。
 *
 * 规则见契约 5.2 节，命中即停：
 * 无错误级问题 → 0；输入类 → 2；版本或索引或语法类 → 3；
 * 来源类 → 4；锁、文件系统与备份类 → 5；依赖类与运行时类 → 6；其余 → 1。
 *
 * 运行时类归入依赖档：运行时不可用或版本不满足在语义上就是依赖未满足，
 * 只是判定依据从索引换成了执行环境（元数据规范 3.3 与 5.3）。
 *
 * 指令另有专属退出码规定时优先于本函数，例如 validate 采用指令契约 4.12 的口径。
 */
export function exitCodeFor(findings: Finding[]): number {
  const errors = findings.filter((item) => item.severity === 'error');
  if (errors.length === 0) return 0;

  const categories = new Set(errors.map((item) => categoryOf(item.code)));
  if (categories.has('INPUT')) return 2;
  // 「索引或配置文件损坏」才落 3 档：技能元文件（source === 'meta'）的 YAML 问题属技能级，
  // 不命中第 3 步（结果规范 5.2 的对象限定），按其余错误归 1（2026-10-17 内核核查批次裁决）。
  const indexOrConfigProblem = errors.some(
    (item) => ['VER', 'INDEX', 'YAML'].includes(categoryOf(item.code)) && item.source !== 'meta',
  );
  if (indexOrConfigProblem) return 3;
  if (categories.has('SRC')) return 4;
  if (categories.has('LOCK') || categories.has('IO') || categories.has('BAK')) return 5;
  if (categories.has('DEP') || categories.has('RUN')) return 6;
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
