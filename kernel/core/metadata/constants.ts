/**
 * K-01 元数据模型常量。
 * 取值与上限全部来自 docs/specification/skill-meta-spec.md。
 */

export const META_FILE_NAME = 'skill_meta.yaml';
export { DISABLED_SUFFIX, SKILL_MD_NAME } from '@skill-manager/contract';

/** 名称长度上限 */
export const MAX_NAME_LENGTH = 64;
/** 描述长度上限 */
export const MAX_DESCRIPTION_LENGTH = 1024;
/** 兼容性字段长度上限 */
export const MAX_COMPATIBILITY_LENGTH = 500;
/** 单个触发关键词长度上限 */
export const MAX_TRIGGER_KEYWORD_LENGTH = 32;
/** 触发关键词数量建议上限 */
export const RECOMMENDED_TRIGGER_KEYWORDS = 10;

/** 当前支持的索引格式版本 */
export const INDEX_SCHEMA_VERSION = '1';

export const STATUS_VALUES = ['enabled', 'disabled'] as const;
export const SOURCE_TYPE_VALUES = ['local', 'git', 'archive', 'unknown'] as const;
export const TARGET_SCOPE_VALUES = ['global', 'project'] as const;
export const TARGET_MODE_VALUES = ['copy', 'link'] as const;
export const VALIDATION_STATUS_VALUES = ['ok', 'invalid'] as const;

/** 元文件允许出现的顶层字段白名单 */
export const META_ALLOWED_FIELDS = new Set([
  'id',
  'name',
  'version',
  'description',
  'author',
  'license',
  'status',
  'path',
  'trigger_keywords',
  'dependencies',
  'source',
  'targets',
  'created_at',
  'updated_at',
  'checksum',
]);

/** 派生区字段：只允许内核在安装、更新、扫描时写入，用户侧不得修改 */
export const DERIVED_FIELDS = ['created_at', 'updated_at', 'checksum'] as const;

/** 时间格式：协调世界时秒级，形如 2026-10-12T04:03:58Z */
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** 标识格式：全小写，仅字母数字与短横线，不得首尾为短横线或出现连续短横线 */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
