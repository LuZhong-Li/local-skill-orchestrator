/**
 * 跨层契约词汇表：问题码与结果形状。
 *
 * 权威定义在 docs/specification/result-and-exit-codes.md（第 2 章结果封装、第 4 章问题码）。
 * 此处只登记本实现实际会产出的码，并由 tests/contract 断言它们全部存在于契约登记表中。
 *
 * 为什么放在存储层：这些常量与类型被存储层、内核层与指令调度层共同引用，
 * 而依赖方向只允许自上而下。把共享契约放在依赖方向的最底层，
 * 各层都能引用而不必反向依赖上层。本文件不含任何存储逻辑。
 *
 * 问题码编码规则：级别字母 E 或 W、类别、三位序号，以短横线连接。
 */

export const CODES = {
  // 输入类
  INPUT_MISSING_ARG: 'E-INPUT-001',
  INPUT_INVALID_ARG: 'E-INPUT-002',
  INPUT_UNKNOWN_COMMAND: 'E-INPUT-003',

  // 工作区与环境类
  ENV_NOT_INITIALIZED: 'E-ENV-001',
  ENV_INCOMPLETE: 'E-ENV-002',

  // 标识类
  ID_INVALID: 'E-ID-001',
  ID_DUPLICATED: 'E-ID-002',
  ID_DIR_MISMATCH: 'E-ID-003',

  // 字段类
  FIELD_REQUIRED: 'E-FIELD-001',
  FIELD_INVALID_VALUE: 'E-FIELD-002',
  FIELD_LENGTH: 'E-FIELD-003',
  FIELD_WHITELIST: 'W-FIELD-004',
  FIELD_TYPE: 'E-FIELD-005',

  // 状态类
  STATUS_INVALID: 'E-STATUS-001',

  // 时间类
  TIME_FORMAT: 'E-TIME-001',
  TIME_ORDER: 'E-TIME-002',

  // 校验值类
  HASH_FORMAT: 'E-HASH-001',
  HASH_MISSING: 'E-HASH-002',
  DRIFT: 'W-DRIFT-001',

  // 语法类
  YAML_INVALID: 'E-YAML-001',

  // 依赖类
  DEP_MISSING: 'E-DEP-001',
  DEP_VERSION: 'E-DEP-002',
  DEP_CYCLE: 'E-DEP-003',
  DEP_VERSION_UNKNOWN: 'W-DEP-004',

  // 校验类
  VALIDATION_REJECTED: 'E-VALIDATION-001',
  VALIDATION_DEPENDENCY: 'E-VALIDATION-002',

  // 冲突类
  CONFLICT_NAMING: 'E-CONFLICT-001',
  CONFLICT_MAPPING: 'E-CONFLICT-002',
  CONFLICT_OCCUPIED: 'E-CONFLICT-003',

  // 路径类
  PATH_INVALID: 'E-PATH-001',

  // 索引类
  INDEX_PROJECTION: 'W-INDEX-001',
  INDEX_STALE: 'W-INDEX-002',
  INDEX_RECORD_INVALID: 'E-INDEX-002',

  // 版本类
  VERSION_UNSUPPORTED: 'E-VER-001',

  // 并发与文件系统类
  LOCK_FAILED: 'E-LOCK-001',
  IO_FAILED: 'E-IO-001',
  IO_ATOMIC_FAILED: 'E-IO-002',
} as const;

export type ProblemCode = (typeof CODES)[keyof typeof CODES];

/** 严重级别：错误或警告 */
export type Severity = 'error' | 'warning';

/** 单条问题 */
export interface Finding {
  code: string;
  severity: Severity;
  source: string;
  target: string;
  message: string;
  remedy: string;
}

/** 单条变更 */
export interface Change {
  action: 'add' | 'modify' | 'remove';
  kind: string;
  path: string;
  detail?: string;
}

/** 结果封装 */
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
