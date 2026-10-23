/** 审计矩阵的纯数据投影：不读盘，也不包含界面状态。 */
import type {
  DriftSubtype,
  FrontmatterFieldDiff,
  InventoryAuditData,
  InventoryAuditRow,
  InventoryAuditStatus,
  VersionDiff,
} from '@skill-manager/contract';

export interface AuditSkillRow {
  skill_id: string;
  cells: Record<string, InventoryAuditRow[]>;
}

export interface AuditDriftDetail {
  skill_id: string;
  host: string;
  scope: InventoryAuditRow['scope'];
  subtype: DriftSubtype;
  fields: FrontmatterFieldDiff[];
  version?: VersionDiff;
}

export interface AuditMatrix {
  hosts: string[];
  skills: AuditSkillRow[];
  driftDetails: AuditDriftDetail[];
}

function hostOf(row: InventoryAuditRow): string {
  return row.host_id ?? row.target;
}

export function auditStatusKey(status: InventoryAuditStatus): string {
  return `audit.status.${status}`;
}

export function buildAuditMatrix(audit: InventoryAuditData): AuditMatrix {
  const hosts = [...new Set(audit.rows.map(hostOf))].sort();
  const bySkill = new Map<string, AuditSkillRow>();
  const driftDetails: AuditDriftDetail[] = [];
  for (const row of audit.rows) {
    const skill = bySkill.get(row.skill_id) ?? {
      skill_id: row.skill_id,
      cells: Object.fromEntries(hosts.map((host) => [host, []])),
    };
    skill.cells[hostOf(row)]?.push(row);
    bySkill.set(row.skill_id, skill);
    if (row.status === 'drift' && row.drift_subtype !== undefined) {
      driftDetails.push({
        skill_id: row.skill_id,
        host: hostOf(row),
        scope: row.scope,
        subtype: row.drift_subtype,
        fields: row.frontmatter_diffs ?? [],
        ...(row.version_diff === undefined ? {} : { version: row.version_diff }),
      });
    }
  }
  return {
    hosts,
    skills: [...bySkill.values()].sort((left, right) =>
      left.skill_id.localeCompare(right.skill_id),
    ),
    driftDetails,
  };
}
