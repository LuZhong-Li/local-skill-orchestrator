/** M4c-4：把去重副本、missing、corrupt 聚合成按 role 的统计与宿主层级。 */
import type {
  HostRootRole,
  InventoryClassificationCounts,
  InventoryClassificationGroups,
  InventoryDiscoveryResult,
  InventoryHostNode,
  InventoryHostRootNode,
  InventoryRoleSummary,
  InventorySummary,
  MissingInventoryCopy,
  ReconciledInventoryCopy,
  ReconciledInventoryCorruptCopy,
} from '@skill-manager/contract';
import { hostById } from '../../core/hosts/index.ts';

const ROLES: readonly HostRootRole[] = ['user', 'system', 'platform', 'project'];
const CLASSIFICATIONS = [
  'managed_consistent',
  'drift',
  'inferred_consistent',
  'inferred_drift',
  'untracked',
  'missing',
  'undetermined',
  'unreadable',
  'not_distributed',
  'orphaned',
  'orphaned_with_workspace',
  'orphaned_without_workspace',
] as const;

type ClassificationKey = (typeof CLASSIFICATIONS)[number];

function emptyCounts(): InventoryClassificationCounts {
  return Object.fromEntries(
    CLASSIFICATIONS.map((key) => [key, 0]),
  ) as InventoryClassificationCounts;
}

function emptyGroups(): InventoryClassificationGroups {
  return {
    managed: { total: 0, authoritative: 0, inferred: 0 },
    drift: { total: 0, authoritative: 0, inferred: 0 },
    missing: 0,
    untracked: 0,
    undetermined: 0,
    unreadable: 0,
    not_distributed: 0,
    orphaned: { total: 0, with_workspace: 0, without_workspace: 0 },
  };
}

function addClassification(
  counts: InventoryClassificationCounts,
  value: ReconciledInventoryCopy | ReconciledInventoryCorruptCopy | MissingInventoryCopy,
): void {
  const key = classificationOf(value) as ClassificationKey;
  if (!(key in counts)) return;
  counts[key] += 1;
  if (key === 'orphaned') {
    const present = orphanedOf(value)?.workspace_record_present === true;
    counts[present ? 'orphaned_with_workspace' : 'orphaned_without_workspace'] += 1;
  }
}

function classificationOf(
  value: ReconciledInventoryCopy | ReconciledInventoryCorruptCopy | MissingInventoryCopy,
): string {
  return 'reconciliation' in value ? value.reconciliation.classification : value.classification;
}

function orphanedOf(
  value: ReconciledInventoryCopy | ReconciledInventoryCorruptCopy | MissingInventoryCopy,
): { workspace_record_present: boolean } | undefined {
  return 'reconciliation' in value ? value.reconciliation.orphaned : value.orphaned;
}

function addGroups(
  groups: InventoryClassificationGroups,
  counts: InventoryClassificationCounts,
): void {
  groups.managed = {
    total: counts.managed_consistent + counts.inferred_consistent,
    authoritative: counts.managed_consistent,
    inferred: counts.inferred_consistent,
  };
  groups.drift = {
    total: counts.drift + counts.inferred_drift,
    authoritative: counts.drift,
    inferred: counts.inferred_drift,
  };
  groups.missing = counts.missing;
  groups.untracked = counts.untracked;
  groups.undetermined = counts.undetermined;
  groups.unreadable = counts.unreadable;
  groups.not_distributed = counts.not_distributed;
  groups.orphaned = {
    total: counts.orphaned,
    with_workspace: counts.orphaned_with_workspace,
    without_workspace: counts.orphaned_without_workspace,
  };
}

function roleOf(item: { root_role?: HostRootRole | undefined }): HostRootRole {
  return item.root_role ?? 'user';
}

function uniqueCount(copies: readonly ReconciledInventoryCopy[]): number {
  return new Set(copies.map((copy) => copy.skill_id).filter((id): id is string => id !== undefined))
    .size;
}

function emptyRole(): InventoryRoleSummary {
  return {
    total_copies: 0,
    unique_skills: 0,
    by_classification: emptyCounts(),
    corrupt_count: 0,
    groups: emptyGroups(),
  };
}

function rolesOf(
  copies: readonly ReconciledInventoryCopy[],
  corrupt: readonly ReconciledInventoryCorruptCopy[],
  missing: readonly MissingInventoryCopy[],
): Record<HostRootRole, InventoryRoleSummary> {
  const roles = Object.fromEntries(ROLES.map((role) => [role, emptyRole()])) as Record<
    HostRootRole,
    InventoryRoleSummary
  >;
  const skills = new Map<HostRootRole, Set<string>>(ROLES.map((role) => [role, new Set<string>()]));
  for (const copy of copies) {
    const role = roles[roleOf(copy)];
    role.total_copies += 1;
    if (copy.skill_id !== undefined) skills.get(roleOf(copy))?.add(copy.skill_id);
    addClassification(role.by_classification, copy);
  }
  for (const role of ROLES) roles[role].unique_skills = skills.get(role)?.size ?? 0;
  for (const item of corrupt) roles[roleOf(item)].corrupt_count += 1;
  for (const item of missing) addClassification(roles[roleOf(item)].by_classification, item);
  for (const role of ROLES) addGroups(roles[role].groups, roles[role].by_classification);
  return roles;
}

function totalGroups(
  roles: Record<HostRootRole, InventoryRoleSummary>,
): InventoryClassificationGroups {
  const groups = emptyGroups();
  for (const role of ROLES) {
    groups.managed.total += roles[role].groups.managed.total;
    groups.managed.authoritative += roles[role].groups.managed.authoritative;
    groups.managed.inferred += roles[role].groups.managed.inferred;
    groups.drift.total += roles[role].groups.drift.total;
    groups.drift.authoritative += roles[role].groups.drift.authoritative;
    groups.drift.inferred += roles[role].groups.drift.inferred;
    groups.missing += roles[role].groups.missing;
    groups.untracked += roles[role].groups.untracked;
    groups.undetermined += roles[role].groups.undetermined;
    groups.unreadable += roles[role].groups.unreadable;
    groups.not_distributed += roles[role].groups.not_distributed;
    groups.orphaned.total += roles[role].groups.orphaned.total;
    groups.orphaned.with_workspace += roles[role].groups.orphaned.with_workspace;
    groups.orphaned.without_workspace += roles[role].groups.orphaned.without_workspace;
  }
  return groups;
}

function hostCopies(
  copies: readonly ReconciledInventoryCopy[],
  hostId: string,
): ReconciledInventoryCopy[] {
  return copies.filter((copy) => copy.sources.some((source) => source.host_id === hostId));
}

function rootNode(input: {
  root: InventoryDiscoveryResult['roots'][number];
  copies: readonly ReconciledInventoryCopy[];
  corrupt: readonly ReconciledInventoryCorruptCopy[];
  missing: readonly MissingInventoryCopy[];
}): InventoryHostRootNode {
  return {
    root: input.root,
    copies: input.copies.filter((copy) => copy.root_ids.includes(input.root.root_id)),
    corrupt: input.corrupt.filter((copy) => copy.root_ids.includes(input.root.root_id)),
    missing: input.missing.filter((item) => item.root_id === input.root.root_id),
  };
}

function hostStats(
  copies: readonly ReconciledInventoryCopy[],
  corrupt: readonly ReconciledInventoryCorruptCopy[],
  missing: readonly MissingInventoryCopy[],
) {
  const counts = emptyCounts();
  for (const copy of copies) addClassification(counts, copy);
  for (const item of missing) addClassification(counts, item);
  return {
    total_copies: copies.length,
    unique_skills: uniqueCount(copies),
    corrupt_count: corrupt.length,
    by_classification: counts,
  };
}

function hostNodes(input: {
  roots: InventoryDiscoveryResult['roots'];
  copies: readonly ReconciledInventoryCopy[];
  corrupt: readonly ReconciledInventoryCorruptCopy[];
  missing: readonly MissingInventoryCopy[];
}): InventoryHostNode[] {
  const grouped = new Map<string, InventoryDiscoveryResult['roots']>();
  for (const root of input.roots) {
    const list = grouped.get(root.host_id) ?? [];
    list.push(root);
    grouped.set(root.host_id, list);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostId, roots]) => {
      const copies = hostCopies(input.copies, hostId);
      const corrupt = input.corrupt.filter((copy) =>
        copy.sources.some((source) => source.host_id === hostId),
      );
      const missing = input.missing.filter((item) => item.host_id === hostId);
      return {
        host_id: hostId,
        host_group: roots[0]?.host_group ?? 'builtin',
        display_name: hostById(hostId)?.display_name ?? hostId,
        roots: roots
          .map((root) =>
            rootNode({
              root,
              copies,
              corrupt,
              missing,
            }),
          )
          .sort((left, right) => left.root.root_id.localeCompare(right.root.root_id)),
        counts: hostStats(copies, corrupt, missing),
      };
    });
}

export function aggregateInventory(input: {
  discovery: InventoryDiscoveryResult;
  copies: readonly ReconciledInventoryCopy[];
  corrupt: readonly ReconciledInventoryCorruptCopy[];
  missing: readonly MissingInventoryCopy[];
}): { summary: InventorySummary; hosts: InventoryHostNode[] } {
  const roles = rolesOf(input.copies, input.corrupt, input.missing);
  const groups = totalGroups(roles);
  return {
    summary: {
      ...input.discovery.summary,
      main: {
        total_copies: roles.user.total_copies,
        unique_skills: roles.user.unique_skills,
      },
      roles,
      classification_groups: groups,
    },
    hosts: hostNodes({
      roots: input.discovery.roots,
      copies: input.copies,
      corrupt: input.corrupt,
      missing: input.missing,
    }),
  };
}
