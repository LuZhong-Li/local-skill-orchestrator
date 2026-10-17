import { UPDATE_CHECK_BACKUP_NOTICE } from './constants.ts';
import {
  looksRemoteLocation,
  selectLatestFormalTag,
  type ProbeOutcome,
  type RemoteTag,
} from './ls-remote.ts';
import { isNewerFormalVersion, normalizeFormalVersion, type FormalVersion } from './semver.ts';

export type UpdateCheckState = 'update-available' | 'up-to-date' | 'not-checkable' | 'failed';

export type NotCheckableReason =
  | 'local-source'
  | 'archive-source'
  | 'unknown-source'
  | 'ref-not-formal-tag'
  | 'baseline-tag-missing';

export interface CheckProvenance {
  url: string | null;
  ref: string | null;
  checked_at: string;
}

export interface UpdateCheckItem {
  id: string;
  state: UpdateCheckState;
  summary: string;
  provenance: CheckProvenance;
  backup_notice: string;
  checksum?: string;
  baseline_version?: string;
  available?: { ref: string; commit: string };
  latest?: { ref: string; commit: string };
  reason?: NotCheckableReason;
  code?: string;
  remedy?: string;
}

export interface ProbeTarget {
  url: string;
  ref: string;
  baseline: FormalVersion;
}

interface SourceView {
  type: string;
  location: string | null;
  ref: string | null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function sourceOf(data: unknown): SourceView | null {
  const root = recordOf(data);
  const source = root === null ? null : recordOf(root['source']);
  if (source === null) return null;
  return {
    type: stringOf(source['type']) ?? 'unknown',
    location: stringOf(source['location']) ?? stringOf(source['url']),
    ref: stringOf(source['ref']),
  };
}

function metaVersionOf(data: unknown): FormalVersion | null {
  const root = recordOf(data);
  const meta = root === null ? null : recordOf(root['meta']);
  const version = meta === null ? null : stringOf(meta['version']);
  return version === null ? null : normalizeFormalVersion(version);
}

function checksumOf(data: unknown): string | undefined {
  const root = recordOf(data);
  if (root === null) return undefined;
  const checksumBlock = recordOf(root['checksum']);
  const recorded = checksumBlock === null ? null : stringOf(checksumBlock['recorded']);
  if (recorded !== null) return recorded;
  const record = recordOf(root['record']);
  return record === null ? undefined : (stringOf(record['checksum']) ?? undefined);
}

function provenanceOf(data: unknown, checkedAt: string): CheckProvenance {
  const source = sourceOf(data);
  const version = metaVersionOf(data)?.version ?? null;
  return {
    url: source?.location ?? null,
    ref: source?.ref ?? version,
    checked_at: checkedAt,
  };
}

function notCheckable(
  id: string,
  data: unknown,
  checkedAt: string,
  reason: NotCheckableReason,
  summary: string,
): UpdateCheckItem {
  const checksum = checksumOf(data);
  return {
    id,
    state: 'not-checkable',
    summary,
    provenance: provenanceOf(data, checkedAt),
    backup_notice: UPDATE_CHECK_BACKUP_NOTICE,
    reason,
    ...(checksum === undefined ? {} : { checksum }),
  };
}

function formalRefOf(ref: string): { raw: string; parsed: FormalVersion } | null {
  const raw = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  const parsed = normalizeFormalVersion(raw);
  return parsed === null ? null : { raw, parsed };
}

/** 返回可探测目标；不可检查来源返回 null，不触发任何网络请求。 */
export function probeTargetOf(data: unknown): ProbeTarget | null {
  const source = sourceOf(data);
  if (source === null || source.type !== 'git' || source.location === null) return null;
  if (!looksRemoteLocation(source.location) || source.ref === null) return null;
  const formal = formalRefOf(source.ref);
  if (formal === null) return null;
  return { url: source.location, ref: formal.raw, baseline: formal.parsed };
}

/**
 * 四态判定纯函数。
 *
 * 不可检查来源不读取 probe；可检查来源若探测失败则进入 failed。
 * 基线标签在远端消失判 not-checkable/baseline-tag-missing：远端列表本身成功，
 * 不存在可比较基线，不能伪造 E-SRC-* 网络失败，也不能猜一个「最新版」。
 */
export function classifyInspectItem(
  id: string,
  data: unknown,
  probe: ProbeOutcome,
  checkedAt: string,
): UpdateCheckItem {
  const source = sourceOf(data);
  if (source === null) {
    return notCheckable(
      id,
      data,
      checkedAt,
      'unknown-source',
      '不可检查：来源未知，无法确定登记来源',
    );
  }
  if (source.type === 'local') {
    return notCheckable(
      id,
      data,
      checkedAt,
      'local-source',
      '不可检查：本地来源没有新版本概念，请用 update --check 查看本地漂移',
    );
  }
  if (source.type === 'archive') {
    return notCheckable(
      id,
      data,
      checkedAt,
      'archive-source',
      '不可检查：归档来源没有版本标签，无法判断远端是否有新版本',
    );
  }
  if (source.type !== 'git') {
    return notCheckable(
      id,
      data,
      checkedAt,
      'unknown-source',
      '不可检查：来源未知，无法确定登记来源',
    );
  }
  if (source.location === null || !looksRemoteLocation(source.location)) {
    return notCheckable(
      id,
      data,
      checkedAt,
      'local-source',
      '不可检查：本地来源没有新版本概念，请用 update --check 查看本地漂移',
    );
  }
  if (source.ref === null) {
    return notCheckable(
      id,
      data,
      checkedAt,
      'ref-not-formal-tag',
      '不可检查：来源缺少引用标识，无法形成正式版标签基线',
    );
  }
  const formal = formalRefOf(source.ref);
  if (formal === null) {
    const commitLike = /^[0-9a-f]{7,64}$/i.test(source.ref);
    return notCheckable(
      id,
      data,
      checkedAt,
      'ref-not-formal-tag',
      `不可检查：来源 ref「${source.ref}」是${commitLike ? '提交' : '分支或非 semver 标签'}，缺少可比较的正式版标签`,
    );
  }
  if (!probe.ok) {
    const checksum = checksumOf(data);
    return {
      id,
      state: 'failed',
      summary: `检查失败：${probe.message}`,
      provenance: provenanceOf(data, checkedAt),
      backup_notice: UPDATE_CHECK_BACKUP_NOTICE,
      code: probe.code,
      remedy: probe.remedy,
      ...(checksum === undefined ? {} : { checksum }),
    };
  }

  const baseline = formal.parsed;
  const baselinePresent = probe.tags.some((tag: RemoteTag) => {
    const parsed = normalizeFormalVersion(tag.tag);
    return parsed?.version === baseline.version;
  });
  if (!baselinePresent) {
    return notCheckable(
      id,
      data,
      checkedAt,
      'baseline-tag-missing',
      `不可检查：基线标签 ${formal.raw} 在远端已不存在（可能被删除或 force-push）`,
    );
  }

  const latest = selectLatestFormalTag(probe.tags);
  const checksum = checksumOf(data);
  if (latest === null) {
    return notCheckable(
      id,
      data,
      checkedAt,
      'baseline-tag-missing',
      `不可检查：远端没有正式版标签，基线 ${formal.raw} 不可比较`,
    );
  }
  const state: UpdateCheckState = isNewerFormalVersion(latest.version, baseline)
    ? 'update-available'
    : 'up-to-date';
  const available =
    state === 'update-available' ? { ref: latest.tag.tag, commit: latest.tag.commit } : undefined;
  return {
    id,
    state,
    summary:
      state === 'update-available'
        ? `来源标签 ${latest.tag.tag} 高于当前基线 ${baseline.version}`
        : `远端最高正式版 ${latest.tag.tag} 不高于当前基线 ${baseline.version}`,
    provenance: provenanceOf(data, checkedAt),
    backup_notice: UPDATE_CHECK_BACKUP_NOTICE,
    baseline_version: baseline.version,
    ...(available === undefined ? {} : { available }),
    latest: { ref: latest.tag.tag, commit: latest.tag.commit },
    ...(checksum === undefined ? {} : { checksum }),
  };
}
