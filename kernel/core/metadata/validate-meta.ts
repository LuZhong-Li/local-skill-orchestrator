/**
 * K-01 元数据模型：校验。
 *
 * 覆盖元数据规范第 5.8 节校验规则总表中与本批次实现相关的条目：
 *   V-01 标识命名、V-03 与目录名一致、V-04 时间格式、V-05 时间先后、
 *   V-06 校验值格式、V-09 YAML 基础约束（由解析阶段负责）、
 *   V-10 必填字段、V-11 取值域与长度、V-12 依赖存在与版本、V-13 依赖成环、
 *   V-15 启用状态枚举、V-18 索引版本。
 *
 * 未覆盖：V-07 内容一致性、V-08 内容缺失、V-14 派生区篡改、V-16 跨文件投影一致性、
 *   V-17 引用路径可达。前四条的比对基准需要跨次扫描的既有取值，V-17 需要目标位置存在性，
 *   均留待后续批次。
 */
import {
  ID_PATTERN,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TRIGGER_KEYWORD_LENGTH,
  RECOMMENDED_TRIGGER_KEYWORDS,
  SOURCE_TYPE_VALUES,
  STATUS_VALUES,
  TARGET_MODE_VALUES,
  TARGET_SCOPE_VALUES,
  TIMESTAMP_PATTERN,
  VALIDATION_STATUS_VALUES,
} from './constants.ts';
import type { SkillMeta } from './types.ts';
import { copyPathOf, matchesConvention } from './targets.ts';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { isChecksumFormat } from '../integrity/index.ts';

export interface MetaContext {
  /** 该 Skill 所在目录名 */
  dirName: string;
  /** 该 Skill 目录路径，用于问题定位 */
  dirPath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function typeFinding(field: string, expected: string, ctx: MetaContext): Finding {
  return finding(CODES.FIELD_TYPE, {
    source: 'meta',
    target: `${ctx.dirName}.${field}`,
    message: `字段 ${field} 的类型不符合契约，应为 ${expected}`,
    remedy: `请把 ${field} 改写为 ${expected}`,
  });
}

function requiredFinding(field: string, ctx: MetaContext): Finding {
  return finding(CODES.FIELD_REQUIRED, {
    source: 'meta',
    target: `${ctx.dirName}.${field}`,
    message: `缺少必填字段 ${field}`,
    remedy: `请在元文件中补充 ${field}`,
  });
}

/** 校验标识命名与目录名一致性 */
export function validateIdentity(id: unknown, ctx: MetaContext): Finding[] {
  const findings: Finding[] = [];
  if (!isNonEmptyString(id)) {
    findings.push(requiredFinding('id', ctx));
    return findings;
  }
  if (!ID_PATTERN.test(id) || id.length > MAX_NAME_LENGTH) {
    findings.push(
      finding(CODES.ID_INVALID, {
        source: 'meta',
        target: ctx.dirName,
        message: `标识 ${id} 不符合命名规范：需为全小写、短横线分隔、不超过 ${MAX_NAME_LENGTH} 个字符`,
        remedy: '请把标识改写为小写短横线形式，且不以短横线开头或结尾',
      }),
    );
  }
  if (id !== ctx.dirName) {
    findings.push(
      finding(CODES.ID_DIR_MISMATCH, {
        source: 'meta',
        target: ctx.dirName,
        message: `标识 ${id} 与目录名 ${ctx.dirName} 不一致`,
        remedy: '请把目录名或元文件中的 id 改为一致',
      }),
    );
  }
  return findings;
}

/**
 * 校验时间字段的格式与先后关系。
 *
 * 派生区字段由内核在首次登记或扫描时写入，因此缺失本身不算不合格：
 * 手工编写的元文件通常不带这些字段，内核会在扫描时回填。
 * 只有「存在但格式不合规」才报告问题。
 */
export function validateTimestamps(
  createdAt: unknown,
  updatedAt: unknown,
  ctx: MetaContext,
): Finding[] {
  const findings: Finding[] = [];
  const pairs: Array<[string, unknown]> = [
    ['created_at', createdAt],
    ['updated_at', updatedAt],
  ];
  for (const [field, value] of pairs) {
    if (value === undefined) continue;
    if (!isNonEmptyString(value)) {
      findings.push(typeFinding(field, '字符串', ctx));
      continue;
    }
    if (!TIMESTAMP_PATTERN.test(value)) {
      findings.push(
        finding(CODES.TIME_FORMAT, {
          source: 'meta',
          target: `${ctx.dirName}.${field}`,
          message: `${field} 的时间格式不合规：${value}`,
          remedy: '请使用协调世界时秒级格式，形如 2026-10-12T04:03:58Z',
        }),
      );
    }
  }
  if (isNonEmptyString(createdAt) && isNonEmptyString(updatedAt) && updatedAt < createdAt) {
    findings.push(
      finding(CODES.TIME_ORDER, {
        source: 'meta',
        target: `${ctx.dirName}.updated_at`,
        message: '更新时间早于首次登记时间',
        remedy: '请修正两个时间字段的取值',
      }),
    );
  }
  return findings;
}

/** 校验内容指纹的格式；缺失时由内核回填，不算不合格 */
export function validateChecksum(checksum: unknown, ctx: MetaContext): Finding[] {
  if (checksum === undefined) return [];
  if (!isChecksumFormat(checksum)) {
    return [
      finding(CODES.HASH_FORMAT, {
        source: 'meta',
        target: `${ctx.dirName}.checksum`,
        message: `内容指纹格式不合规：${String(checksum)}`,
        remedy: '请使用 sha256: 加 64 位小写十六进制的形式',
      }),
    ];
  }
  return [];
}

/** 校验索引格式版本是否受当前工具支持 */
export function validateIndexVersion(schemaVersion: unknown): Finding[] {
  if (!isNonEmptyString(schemaVersion)) {
    return [
      finding(CODES.VERSION_UNSUPPORTED, {
        source: 'registry',
        target: 'schema_version',
        message: '索引缺少格式版本号',
        remedy: '请指明索引格式版本，或重新生成索引',
      }),
    ];
  }
  if (schemaVersion !== '1') {
    return [
      finding(CODES.VERSION_UNSUPPORTED, {
        source: 'registry',
        target: 'schema_version',
        message: `索引格式版本 ${schemaVersion} 高于当前工具支持的版本 1`,
        remedy: '请升级工具后再读取该索引',
      }),
    ];
  }
  return [];
}

/** 校验运行期结论区块的取值域 */
export function validateValidationBlock(value: unknown, id: string): Finding[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [
      finding(CODES.FIELD_TYPE, {
        source: 'registry',
        target: `${id}.validation`,
        message: '运行期结论区块缺失或类型不正确',
        remedy: '请重新扫描以重建该区块',
      }),
    ];
  }
  const block = value as Record<string, unknown>;
  if (
    !VALIDATION_STATUS_VALUES.includes(block['status'] as (typeof VALIDATION_STATUS_VALUES)[number])
  ) {
    return [
      finding(CODES.FIELD_INVALID_VALUE, {
        source: 'registry',
        target: `${id}.validation.status`,
        message: `校验结论取值非法：${String(block['status'])}`,
        remedy: `仅允许 ${VALIDATION_STATUS_VALUES.join(' 或 ')}`,
      }),
    ];
  }
  if (!Array.isArray(block['errors'])) {
    return [
      finding(CODES.FIELD_TYPE, {
        source: 'registry',
        target: `${id}.validation.errors`,
        message: '校验结论的问题明细必须为数组',
        remedy: '请重新扫描以重建该区块',
      }),
    ];
  }
  return [];
}

export { isNonEmptyString };

/** 依赖可用性映射：标识到是否校验通过 */
export type AvailabilityMap = Map<string, boolean>;

/** 单个被依赖对象的判定结论：可用、已登记但校验不通过、不在索引中 */
export type DependencyVerdict = 'ok' | 'invalid' | 'missing';

/**
 * 依赖判定的唯一实现。
 * 其它服务（登记与刷新、校验、依赖分析）一律引用本函数，不得各自重写判定逻辑。
 */
export function judgeDependency(name: string, availability: AvailabilityMap): DependencyVerdict {
  if (!availability.has(name)) return 'missing';
  return availability.get(name) === true ? 'ok' : 'invalid';
}

export type { SkillMeta };

/** 校验来源信息块：类型枚举与条件必填 */
export function validateSource(source: unknown, ctx: MetaContext): Finding[] {
  const findings: Finding[] = [];
  if (source === undefined) {
    findings.push(requiredFinding('source', ctx));
    return findings;
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    findings.push(typeFinding('source', '映射', ctx));
    return findings;
  }
  const block = source as Record<string, unknown>;
  const type = block['type'];
  if (!SOURCE_TYPE_VALUES.includes(type as (typeof SOURCE_TYPE_VALUES)[number])) {
    findings.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: 'meta',
        target: `${ctx.dirName}.source.type`,
        message: `来源类型取值非法：${String(type)}`,
        remedy: `仅允许 ${SOURCE_TYPE_VALUES.join('、')}`,
      }),
    );
    return findings;
  }
  // 来源类型不是本地目录、也不是来源未知时，必须给出本地位置或远端地址；
  // 本地形式由 location 表达（本地仓库路径或归档文件路径），远端形式由 url 与 ref 表达
  if (type !== 'local' && type !== 'unknown') {
    if (isNonEmptyString(block['location'])) return findings;
    for (const field of ['url', 'ref']) {
      if (!isNonEmptyString(block[field])) {
        findings.push(
          finding(CODES.FIELD_REQUIRED, {
            source: 'meta',
            target: `${ctx.dirName}.source.${field}`,
            message: `来源类型为 ${type} 时，source.${field} 为必填`,
            remedy: `请补充 source.${field}，或把来源类型改为 local 或 unknown`,
          }),
        );
      }
    }
  }
  return findings;
}

/** 校验落位目标列表 */
export function validateTargets(targets: unknown, ctx: MetaContext): Finding[] {
  const findings: Finding[] = [];
  if (targets === undefined) {
    findings.push(requiredFinding('targets', ctx));
    return findings;
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    findings.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: 'meta',
        target: `${ctx.dirName}.targets`,
        message: '落位目标必须为至少含一项的数组',
        remedy: '请至少声明一个落位目标',
      }),
    );
    return findings;
  }
  const seen = new Set<string>();
  for (const item of targets) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      findings.push(typeFinding('targets', '映射数组', ctx));
      continue;
    }
    const entry = item as Record<string, unknown>;
    const name = entry['target'];
    if (!isNonEmptyString(name)) {
      findings.push(requiredFinding('targets[].target', ctx));
      continue;
    }
    if (seen.has(name)) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: 'meta',
          target: `${ctx.dirName}.targets`,
          message: `落位目标标识重复：${name}`,
          remedy: '请确保同一 Skill 内目标标识唯一',
        }),
      );
    }
    seen.add(name);
    // 落位路径必须与目标落位根约定一致：副本定位依赖该约定，不能由元文件自由指定
    const declaredPath = entry['path'];
    if (isNonEmptyString(declaredPath) && !matchesConvention(declaredPath, name, ctx.dirName)) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: 'meta',
          target: `${ctx.dirName}.targets.${name}.path`,
          message: `落位路径与目标落位根约定不一致：${declaredPath}`,
          remedy: `目标 ${name} 的落位路径应为 ${copyPathOf(name, ctx.dirName)}；副本定位依赖该约定`,
        }),
      );
    }
    if (!TARGET_SCOPE_VALUES.includes(entry['scope'] as (typeof TARGET_SCOPE_VALUES)[number])) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: 'meta',
          target: `${ctx.dirName}.targets.${name}.scope`,
          message: `作用域取值非法：${String(entry['scope'])}`,
          remedy: `仅允许 ${TARGET_SCOPE_VALUES.join(' 或 ')}`,
        }),
      );
    }
    if (!TARGET_MODE_VALUES.includes(entry['mode'] as (typeof TARGET_MODE_VALUES)[number])) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: 'meta',
          target: `${ctx.dirName}.targets.${name}.mode`,
          message: `落位方式取值非法：${String(entry['mode'])}`,
          remedy: `仅允许 ${TARGET_MODE_VALUES.join(' 或 ')}`,
        }),
      );
    }
    if (typeof entry['enabled'] !== 'boolean') {
      findings.push(typeFinding(`targets.${name}.enabled`, '布尔', ctx));
    }
  }
  return findings;
}

/** 校验元文件记录的整体形态：必填、类型、取值域、长度 */
export function validateMetaRecord(raw: Record<string, unknown>, ctx: MetaContext): Finding[] {
  const findings: Finding[] = [];

  findings.push(...validateIdentity(raw['id'], ctx));
  findings.push(...validateTimestamps(raw['created_at'], raw['updated_at'], ctx));
  findings.push(...validateChecksum(raw['checksum'], ctx));

  const name = raw['name'];
  if (!isNonEmptyString(name)) {
    findings.push(requiredFinding('name', ctx));
  } else if (name.length > MAX_NAME_LENGTH) {
    findings.push(
      finding(CODES.FIELD_LENGTH, {
        source: 'meta',
        target: `${ctx.dirName}.name`,
        message: `名称长度超过上限 ${MAX_NAME_LENGTH}`,
        remedy: '请缩短名称',
      }),
    );
  }

  const status = raw['status'];
  if (status === undefined) {
    findings.push(requiredFinding('status', ctx));
  } else if (!STATUS_VALUES.includes(status as (typeof STATUS_VALUES)[number])) {
    findings.push(
      finding(CODES.STATUS_INVALID, {
        source: 'meta',
        target: `${ctx.dirName}.status`,
        message: `启用状态取值非法：${String(status)}`,
        remedy: `仅允许 ${STATUS_VALUES.join(' 或 ')}；校验结论不由本字段承载`,
      }),
    );
  }

  if (!isNonEmptyString(raw['path'])) {
    findings.push(requiredFinding('path', ctx));
  }

  const description = raw['description'];
  if (description !== undefined) {
    if (typeof description !== 'string') {
      findings.push(typeFinding('description', '字符串', ctx));
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      findings.push(
        finding(CODES.FIELD_LENGTH, {
          source: 'meta',
          target: `${ctx.dirName}.description`,
          message: `描述长度超过上限 ${MAX_DESCRIPTION_LENGTH}`,
          remedy: '请精简描述',
        }),
      );
    }
  }

  findings.push(...validateTriggerKeywords(raw['trigger_keywords'], ctx));
  findings.push(...validateSource(raw['source'], ctx));
  findings.push(...validateTargets(raw['targets'], ctx));

  return findings;
}

/** 校验触发关键词列表 */
export function validateTriggerKeywords(value: unknown, ctx: MetaContext): Finding[] {
  if (value === undefined) return [];
  const findings: Finding[] = [];
  if (!Array.isArray(value)) return [typeFinding('trigger_keywords', '字符串数组', ctx)];

  const seen = new Set<string>();
  for (const keyword of value) {
    if (!isNonEmptyString(keyword)) {
      findings.push(typeFinding('trigger_keywords', '非空字符串数组', ctx));
      break;
    }
    if (keyword.length > MAX_TRIGGER_KEYWORD_LENGTH) {
      findings.push(
        finding(CODES.FIELD_LENGTH, {
          source: 'meta',
          target: `${ctx.dirName}.trigger_keywords`,
          message: `触发关键词 ${keyword} 超过长度上限 ${MAX_TRIGGER_KEYWORD_LENGTH}`,
          remedy: '请缩短该关键词',
        }),
      );
    }
    if (seen.has(keyword)) {
      findings.push(
        finding(CODES.FIELD_INVALID_VALUE, {
          source: 'meta',
          target: `${ctx.dirName}.trigger_keywords`,
          message: `触发关键词重复：${keyword}`,
          remedy: '请移除重复项',
        }),
      );
    }
    seen.add(keyword);
  }
  if (value.length > RECOMMENDED_TRIGGER_KEYWORDS) {
    findings.push(
      finding(CODES.FIELD_INVALID_VALUE, {
        source: 'meta',
        target: `${ctx.dirName}.trigger_keywords`,
        message: `触发关键词数量为 ${value.length}，超过建议上限 ${RECOMMENDED_TRIGGER_KEYWORDS}`,
        remedy: '建议收敛关键词，只保留区分度最高的若干项',
      }),
    );
  }
  return findings;
}

/** 取一条依赖声明里的 Skill 标识（忽略版本约束） */
/** 每个节点所属的环（同一节点的多个环都保留，供消息与 deps 对照） */
