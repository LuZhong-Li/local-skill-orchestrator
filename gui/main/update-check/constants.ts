/**
 * M4a 检查能力的跨层常量。
 *
 * GUI 不引用内核内部模块，因此这里保留一份与内核远端获取口径相同的数值；
 * `tests/contract/update-check-constants.test.ts` 读取内核源码逐项比对，任一侧漂移即红。
 */
export const UPDATE_CHECK_TIMEOUT_MS = 60_000;
export const UPDATE_CHECK_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
export const UPDATE_CHECK_BACKUP_NOTICE = '执行前将先行备份';

/** 检查阶段沿用内核来源类问题码，不新造错误风格 */
export const SOURCE_ERROR_CODES = {
  commandUnavailable: 'E-SRC-005',
  timeout: 'E-SRC-006',
  remoteFailed: 'E-SRC-007',
  tooLarge: 'E-SRC-008',
  protocolRejected: 'E-SRC-009',
  authRequired: 'E-SRC-010',
} as const;
