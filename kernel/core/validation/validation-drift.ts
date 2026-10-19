/** 内容漂移、派生区与跨文件投影校验。 */
import { statSync } from 'node:fs';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { IndexRecord } from '../metadata/types.ts';
import { META_ALLOWED_FIELDS } from '../metadata/constants.ts';
import type { MetaContext } from '../metadata/validate.ts';
import { computeDigests } from '../integrity/index.ts';
import {
  DERIVED_FIELDS_COMPARED,
  PROJECTION_FIELDS,
  PROJECTION_TARGET_FIELDS,
  describe,
  sameValue,
} from './validation-shared.ts';

export function locateDrift(dir: string, record: IndexRecord, id: string): Finding[] {
  const baseline = record.digests;
  if (baseline === undefined || Object.keys(baseline).length === 0) return [];

  let current: Record<string, string>;
  try {
    if (!statSync(dir).isDirectory()) return [];
    current = computeDigests(dir);
  } catch {
    return [];
  }

  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );

  const findings: Finding[] = [];
  for (const rel of paths) {
    const before = baseline[rel];
    const after = current[rel];
    if (before === after) continue;
    findings.push(
      finding(CODES.DRIFT, {
        source: 'meta',
        target: `${id}/${rel}`,
        message: describeFileDrift(rel, before, after),
        remedy:
          before === undefined
            ? '如为有意新增，请重新扫描以刷新内容摘要；否则请确认该文件为何出现在这里'
            : after === undefined
              ? '如为有意删除，请重新扫描以刷新内容摘要；否则请从备份或来源恢复该文件'
              : '如为有意修改，请重新扫描以刷新内容摘要；否则请检查该文件是否被意外改动',
      }),
    );
  }
  return findings;
}

/** 单个文件的漂移描述：区分内容变化、新增与删除，均给出相对路径与两侧摘要 */
function describeFileDrift(
  rel: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (before === undefined) return `新增文件 ${rel}：现有摘要 ${String(after)}`;
  if (after === undefined) return `文件已删除 ${rel}：原摘要 ${before}`;
  return `文件内容已变化 ${rel}：原摘要 ${before}，现有摘要 ${after}`;
}

/** V-14：元文件派生区字段与索引内取值不一致时判定为被用户改写 */
export function detectDerivedTamper(
  raw: Record<string, unknown>,
  record: IndexRecord,
  id: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const field of DERIVED_FIELDS_COMPARED) {
    const inMeta = raw[field];
    const inIndex = (record as unknown as Record<string, unknown>)[field];
    // 缺失表示待内核回填，不构成问题
    if (inMeta === undefined || inMeta === null || inMeta === '') continue;
    if (typeof inMeta !== 'string' || typeof inIndex !== 'string' || inIndex === '') continue;
    if (inMeta === inIndex) continue;
    findings.push(
      finding(CODES.DERIVED_TAMPER, {
        source: 'meta',
        target: `${id}.${field}`,
        message: `派生区字段 ${field} 与内核记录值不一致：元文件为 ${inMeta}，索引为 ${inIndex}`,
        remedy: '派生区字段只允许内核写入；内核会在下次安装或扫描时按自身取值覆盖',
      }),
    );
  }
  return findings;
}

/** V-16：索引记录的声明区投影与元文件不一致时报告差异字段 */
export function detectProjectionDrift(
  raw: Record<string, unknown>,
  record: IndexRecord,
  id: string,
): Finding[] {
  const findings: Finding[] = [];
  const inIndex = record as unknown as Record<string, unknown>;
  for (const field of PROJECTION_FIELDS) {
    const left = inIndex[field];
    const right = raw[field];
    if (sameValue(left, right)) continue;
    findings.push(projectionFinding(id, field, left, right));
  }

  // source_type 是元文件 source.type 的摘要
  const source = raw['source'];
  const metaType =
    source !== null && typeof source === 'object' && !Array.isArray(source)
      ? (source as Record<string, unknown>)['type']
      : undefined;
  if (!sameValue(record.source_type, metaType)) {
    findings.push(projectionFinding(id, 'source_type', record.source_type, metaType));
  }

  // targets 摘要与元文件对应项在 target 与 scope 两个子字段上比对；enabled 不参与
  const projecting = (value: unknown): unknown[] =>
    Array.isArray(value)
      ? value.flatMap((item) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry['target'] !== 'string') return [];
          const picked: Record<string, unknown> = {};
          for (const field of PROJECTION_TARGET_FIELDS) picked[field] = entry[field];
          return [picked];
        })
      : [];
  const indexTargets = projecting(record.targets);
  const metaTargets = projecting(raw['targets']);
  if (!sameValue(indexTargets, metaTargets)) {
    findings.push(projectionFinding(id, 'targets', indexTargets, metaTargets));
  }

  return findings;
}

function projectionFinding(id: string, field: string, inIndex: unknown, inMeta: unknown): Finding {
  return finding(CODES.INDEX_PROJECTION, {
    source: 'registry',
    target: `${id}.${field}`,
    message: `投影不一致：索引为 ${describe(inIndex)}，元文件为 ${describe(inMeta)}`,
    remedy: '以元文件为准；请重新扫描或重新安装，由内核重新生成索引投影',
  });
}

/** 白名单外字段只给警告，与 V-11 同属字段类别 */
export function whitelistFindings(raw: Record<string, unknown>, ctx: MetaContext): Finding[] {
  const extra = Object.keys(raw).filter((key) => !META_ALLOWED_FIELDS.has(key));
  if (extra.length === 0) return [];
  return [
    finding(CODES.FIELD_WHITELIST, {
      source: 'meta',
      target: ctx.dirName,
      message: `元文件存在白名单外字段：${extra.join('、')}`,
      remedy: '请把自研字段移入扩展元数据，或移除这些字段',
    }),
  ];
}
