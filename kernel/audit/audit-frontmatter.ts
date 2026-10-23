/** 多副本 frontmatter 与 version 的只读比较；不访问文件系统。 */
import type {
  DriftSubtype,
  FrontmatterFieldDiff,
  FrontmatterFieldValue,
  HostRootRole,
  VersionDiff,
} from '@skill-manager/contract';

const COMPARED_FIELDS = ['description', 'license', 'compatibility', 'allowed-tools'] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

export interface AuditFrontmatterCopy {
  skill_id: string;
  host_id: string;
  root_role: HostRootRole;
  copy_path: string;
  frontmatter: Record<string, unknown> | null;
  checksum_matches?: boolean;
  unreadable_reason?: string;
}

export interface AuditFrontmatterComparison {
  comparable: boolean;
  drift_subtype?: DriftSubtype;
  frontmatter_diffs: FrontmatterFieldDiff[];
  version_diff?: VersionDiff;
  metadata_incomplete: boolean;
}

function readable(copy: AuditFrontmatterCopy): boolean {
  return copy.frontmatter !== null && copy.unreadable_reason === undefined;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function metadataOf(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = raw['metadata'];
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : undefined;
}

function versionOf(copy: AuditFrontmatterCopy): string | null {
  const raw = copy.frontmatter;
  if (raw === null) return null;
  const topLevel = textOf(raw['version']);
  if (topLevel !== null) return topLevel;
  const metadata = metadataOf(raw);
  return metadata === undefined ? null : textOf(metadata['version']);
}

function valueOf(copy: AuditFrontmatterCopy, field: ComparedField | 'name'): string | null {
  return copy.frontmatter === null ? null : textOf(copy.frontmatter[field]);
}

function sortCopies(copies: readonly AuditFrontmatterCopy[]): AuditFrontmatterCopy[] {
  return [...copies].sort((left, right) => {
    const byHost = left.host_id.localeCompare(right.host_id);
    if (byHost !== 0) return byHost;
    const byRole = left.root_role.localeCompare(right.root_role);
    if (byRole !== 0) return byRole;
    return left.copy_path.localeCompare(right.copy_path);
  });
}

function valuesOf(
  copies: readonly AuditFrontmatterCopy[],
  field: ComparedField | 'name',
): FrontmatterFieldValue[] {
  return copies.map((copy) => ({
    host: copy.host_id,
    role: copy.root_role,
    value: valueOf(copy, field),
  }));
}

function nameDiff(copies: readonly AuditFrontmatterCopy[]): FrontmatterFieldDiff | undefined {
  const values = valuesOf(copies, 'name');
  const workspaceSkillId = copies[0]?.skill_id;
  if (workspaceSkillId === undefined) return undefined;
  return values.every((item) => item.value === workspaceSkillId)
    ? undefined
    : { field: 'name', values };
}

function fieldDiff(
  copies: readonly AuditFrontmatterCopy[],
  field: ComparedField,
): FrontmatterFieldDiff | undefined {
  const values = valuesOf(copies, field);
  return new Set(values.map((item) => item.value)).size > 1 ? { field, values } : undefined;
}

function frontmatterDiffs(copies: readonly AuditFrontmatterCopy[]): FrontmatterFieldDiff[] {
  return [nameDiff(copies), ...COMPARED_FIELDS.map((field) => fieldDiff(copies, field))].filter(
    (diff): diff is FrontmatterFieldDiff => diff !== undefined,
  );
}

function versionValues(copies: readonly AuditFrontmatterCopy[]) {
  return copies.map((copy) => ({
    host: copy.host_id,
    role: copy.root_role,
    version: versionOf(copy),
  }));
}

function versionResult(copies: readonly AuditFrontmatterCopy[]): {
  version_diff?: VersionDiff;
  metadata_incomplete: boolean;
} {
  const values = versionValues(copies);
  if (values.every((item) => item.version === null)) {
    return { metadata_incomplete: true };
  }
  return new Set(values.map((item) => item.version)).size > 1
    ? { version_diff: { values }, metadata_incomplete: false }
    : { metadata_incomplete: false };
}

function withoutDrift(comparable: boolean): AuditFrontmatterComparison {
  return {
    comparable,
    frontmatter_diffs: [],
    metadata_incomplete: false,
  };
}

/**
 * 比较同一 audit skill group 的可读副本。
 * checksum 已知不一致时优先返回 checksum，不继续制造字段级噪音。
 */
export function compareFrontmatterGroup(
  copies: readonly AuditFrontmatterCopy[],
): AuditFrontmatterComparison {
  const readableCopies = sortCopies(copies.filter(readable));
  if (readableCopies.length < 2) return withoutDrift(false);
  const versions = versionResult(readableCopies);
  if (readableCopies.some((copy) => copy.checksum_matches === false)) {
    return {
      comparable: true,
      drift_subtype: 'checksum',
      frontmatter_diffs: [],
      metadata_incomplete: versions.metadata_incomplete,
    };
  }
  const diffs = frontmatterDiffs(readableCopies);
  if (diffs.length > 0) {
    return {
      comparable: true,
      drift_subtype: 'frontmatter',
      frontmatter_diffs: diffs,
      metadata_incomplete: versions.metadata_incomplete,
    };
  }
  if (versions.version_diff !== undefined) {
    return {
      comparable: true,
      drift_subtype: 'version',
      frontmatter_diffs: [],
      version_diff: versions.version_diff,
      metadata_incomplete: false,
    };
  }
  return {
    comparable: true,
    frontmatter_diffs: [],
    metadata_incomplete: versions.metadata_incomplete,
  };
}
