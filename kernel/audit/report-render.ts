/** M6 审计报告纯渲染器：Markdown、自包含 HTML 与 SARIF 2.1.0。 */
import { basename, isAbsolute, relative, sep } from 'node:path';
import type {
  AuditReportDocument,
  AuditReportFormat,
  AuditReportMeta,
  InventoryAuditData,
  InventoryAuditRow,
  InventoryAuditStatus,
} from '@skill-manager/contract';

type Severity = 'error' | 'warning' | 'note';
type RuleId =
  | 'W-MISSING-001'
  | 'W-MISSING-002'
  | 'W-MISSING-003'
  | 'W-MISSING-004'
  | 'W-DRIFT-001'
  | 'W-DRIFT-002'
  | 'W-DRIFT-003';

interface RuleDefinition {
  id: RuleId;
  level: Severity;
  shortDescription: string;
}

interface ReportFinding {
  row: InventoryAuditRow;
  rule: RuleDefinition;
  message: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, note: 2 };
const SIMPLE_MESSAGES: Partial<
  Record<InventoryAuditStatus, (skill: string, location: string) => string>
> = {
  missing: (skill, location) => `Skill ${skill} is missing from declared target ${location}.`,
  undeclared: (skill, location) =>
    `Skill ${skill} exists on ${location} but is not declared in targets.`,
  visibility_mismatch: (skill, location) =>
    `Skill ${skill} visibility does not match expectations on ${location}.`,
  insufficient: (skill, location) =>
    `Skill ${skill} on ${location} has insufficient audit evidence.`,
  unmapped: (skill, location) => `Skill ${skill} on ${location} has insufficient audit evidence.`,
};

export const SARIF_RULES: readonly RuleDefinition[] = [
  {
    id: 'W-MISSING-001',
    level: 'error',
    shortDescription: 'Declared host target is missing',
  },
  {
    id: 'W-MISSING-002',
    level: 'note',
    shortDescription: 'Host copy is not declared as a target',
  },
  {
    id: 'W-MISSING-003',
    level: 'warning',
    shortDescription: 'Host copy visibility does not match declaration',
  },
  {
    id: 'W-MISSING-004',
    level: 'note',
    shortDescription: 'Audit evidence is insufficient or unmapped',
  },
  {
    id: 'W-DRIFT-001',
    level: 'warning',
    shortDescription: 'Skill content checksum drift',
  },
  {
    id: 'W-DRIFT-002',
    level: 'warning',
    shortDescription: 'Skill frontmatter drift',
  },
  {
    id: 'W-DRIFT-003',
    level: 'warning',
    shortDescription: 'Skill version drift',
  },
];

function rule(id: RuleId): RuleDefinition {
  const found = SARIF_RULES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing SARIF rule: ${id}`);
  return found;
}

function sortedRows(audit: InventoryAuditData): InventoryAuditRow[] {
  return [...audit.rows].sort((left, right) =>
    `${left.skill_id}\0${left.target}\0${left.scope}`.localeCompare(
      `${right.skill_id}\0${right.target}\0${right.scope}`,
    ),
  );
}

function ruleFor(row: InventoryAuditRow): RuleDefinition | undefined {
  if (row.status === 'missing') return rule('W-MISSING-001');
  if (row.status === 'undeclared') return rule('W-MISSING-002');
  if (row.status === 'visibility_mismatch') return rule('W-MISSING-003');
  if (row.status === 'insufficient' || row.status === 'unmapped') {
    return rule('W-MISSING-004');
  }
  if (row.status !== 'drift') return undefined;
  if (row.drift_subtype === 'frontmatter') return rule('W-DRIFT-002');
  if (row.drift_subtype === 'version') return rule('W-DRIFT-003');
  return rule('W-DRIFT-001');
}

function statusDescription(row: InventoryAuditRow): string {
  if (row.status !== 'drift') return row.status;
  return `${row.status} (${row.drift_subtype ?? 'checksum'})`;
}

function driftMessage(row: InventoryAuditRow, location: string): string {
  if (row.drift_subtype === 'frontmatter') {
    const fields = (row.frontmatter_diffs ?? []).map((item) => item.field).join(', ');
    return `Skill ${row.skill_id} has frontmatter drift on ${location}: ${fields || 'unknown field'}.`;
  }
  if (row.drift_subtype === 'version') {
    return `Skill ${row.skill_id} has version drift on ${location}.`;
  }
  return `Skill ${row.skill_id} has content checksum drift on ${location}.`;
}

function findingMessage(row: InventoryAuditRow): string {
  const location = row.host_id ?? row.target;
  const simple = SIMPLE_MESSAGES[row.status];
  if (simple !== undefined) return simple(row.skill_id, location);
  if (row.status === 'drift') {
    return driftMessage(row, location);
  }
  return `Skill ${row.skill_id} is healthy on ${location}.`;
}

function findingsOf(audit: InventoryAuditData): ReportFinding[] {
  return sortedRows(audit)
    .flatMap((row) => {
      const ruleDefinition = ruleFor(row);
      return ruleDefinition === undefined
        ? []
        : [{ row, rule: ruleDefinition, message: findingMessage(row) }];
    })
    .sort((left, right) => {
      const severity = SEVERITY_ORDER[left.rule.level] - SEVERITY_ORDER[right.rule.level];
      if (severity !== 0) return severity;
      return `${left.row.skill_id}\0${left.row.target}`.localeCompare(
        `${right.row.skill_id}\0${right.row.target}`,
      );
    });
}

function publicWorkspace(): string {
  return '<workspace>';
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cell(value: string | number | undefined): string {
  if (value === undefined || value === '') return '—';
  return escapeMarkdown(String(value));
}

function details(row: InventoryAuditRow): string {
  if (row.status === 'drift' && row.drift_subtype === 'frontmatter') {
    return (row.frontmatter_diffs ?? [])
      .map(
        (diff) =>
          `${diff.field}: ${diff.values.map((item) => item.value ?? 'missing').join(' / ')}`,
      )
      .join('; ');
  }
  if (row.status === 'drift' && row.drift_subtype === 'version') {
    return (row.version_diff?.values ?? [])
      .map((item) => `${item.host}: ${item.version ?? 'missing'}`)
      .join('; ');
  }
  return row.reasons.join(', ');
}

function overviewRows(audit: InventoryAuditData): Array<[string, number]> {
  const summary = audit.summary;
  return [
    ['Declared', summary.declared],
    ['Distributed', summary.distributed],
    ['Missing', summary.missing],
    ['Checksum drift', summary.drift_by_subtype?.checksum ?? 0],
    ['Frontmatter drift', summary.drift_by_subtype?.frontmatter ?? 0],
    ['Version drift', summary.drift_by_subtype?.version ?? 0],
    ['Visibility mismatch', summary.visibility_mismatch],
    ['Undeclared', summary.undeclared],
    ['Unmapped', summary.unmapped],
    ['Workspace only', summary.workspace_only],
    ['Insufficient', summary.insufficient],
  ];
}

function markdownHeader(meta: AuditReportMeta): string[] {
  return [
    '# Skill audit report',
    '',
    `- Generated: ${meta.generated_at}`,
    `- Tool version: ${meta.tool_version}`,
    `- Workspace: ${publicWorkspace()}`,
    `- Observed at: ${meta.observed_at}`,
    `- Hosts: ${[...new Set(meta.hosts)].sort().join(', ') || '—'}`,
    '',
  ];
}

function markdownTable(
  headings: readonly string[],
  rows: readonly (readonly (string | number | undefined)[])[],
): string[] {
  return [
    `| ${headings.join(' | ')} |`,
    `| ${headings.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    '',
  ];
}

export function renderMarkdown(audit: InventoryAuditData, meta: AuditReportMeta): string {
  const rows = sortedRows(audit);
  const missing = rows.filter((row) => row.status === 'missing');
  const findings = findingsOf(audit);
  return [
    ...markdownHeader(meta),
    '## Overview',
    '',
    ...markdownTable(['Metric', 'Count'], overviewRows(audit)),
    '## Skill matrix',
    '',
    ...markdownTable(
      ['Skill', 'Target', 'Status', 'Evidence', 'Details'],
      rows.map((row) => [
        row.skill_id,
        row.host_id ?? row.target,
        statusDescription(row),
        `${row.evidence.managed}/${row.evidence.content}/${row.evidence.source}`,
        details(row),
      ]),
    ),
    '## Missing by host',
    '',
    ...(missing.length === 0
      ? ['No missing targets.', '']
      : missing.map(
          (row) =>
            `- ${row.host_id ?? row.target}: ${row.skill_id} — ${row.reasons.join(', ') || 'missing'}`,
        )),
    ...(missing.length === 0 ? [] : ['']),
    '## Findings',
    '',
    ...markdownTable(
      ['Severity', 'Rule', 'Skill', 'Target', 'Message'],
      findings.map((finding) => [
        finding.rule.level,
        finding.rule.id,
        finding.row.skill_id,
        finding.row.host_id ?? finding.row.target,
        finding.message,
      ]),
    ),
  ].join('\n');
}

function htmlTable(
  headings: readonly string[],
  rows: readonly (readonly (string | number | undefined)[])[],
): string {
  return [
    '<table>',
    '<thead><tr>',
    ...headings.map((heading) => `<th>${escapeHtml(heading)}</th>`),
    '</tr></thead>',
    '<tbody>',
    ...rows.map(
      (row) =>
        `<tr>${row
          .map(
            (value) =>
              `<td>${escapeHtml(value === undefined || value === '' ? '—' : String(value))}</td>`,
          )
          .join('')}</tr>`,
    ),
    '</tbody>',
    '</table>',
  ].join('\n');
}

const HTML_STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; background: #f6f7f9; color: #1f2937; }
main { max-width: 1100px; margin: 32px auto; padding: 24px; background: #fff; border-radius: 12px; }
h1, h2 { color: #111827; }
table { width: 100%; border-collapse: collapse; margin: 12px 0 28px; }
th, td { padding: 8px 10px; border: 1px solid #d7dce2; text-align: left; vertical-align: top; }
th { background: #eef2f6; }
.meta { color: #4b5563; }
@media (prefers-color-scheme: dark) {
  body { background: #111827; color: #e5e7eb; }
  main { background: #1f2937; }
  h1, h2 { color: #f9fafb; }
  th { background: #374151; }
  th, td { border-color: #4b5563; }
  .meta { color: #cbd5e1; }
}
`.trim();

export function renderHtml(audit: InventoryAuditData, meta: AuditReportMeta): string {
  const rows = sortedRows(audit);
  const missing = rows.filter((row) => row.status === 'missing');
  const findings = findingsOf(audit);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Skill audit report</title>',
    `<style>${HTML_STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Skill audit report</h1>',
    '<p class="meta">',
    `Generated: ${escapeHtml(meta.generated_at)}<br>`,
    `Tool version: ${escapeHtml(meta.tool_version)}<br>`,
    `Workspace: ${escapeHtml(publicWorkspace())}<br>`,
    `Observed at: ${escapeHtml(meta.observed_at)}<br>`,
    `Hosts: ${escapeHtml([...new Set(meta.hosts)].sort().join(', ') || '—')}`,
    '</p>',
    '<h2>Overview</h2>',
    htmlTable(['Metric', 'Count'], overviewRows(audit)),
    '<h2>Skill matrix</h2>',
    htmlTable(
      ['Skill', 'Target', 'Status', 'Evidence', 'Details'],
      rows.map((row) => [
        row.skill_id,
        row.host_id ?? row.target,
        statusDescription(row),
        `${row.evidence.managed}/${row.evidence.content}/${row.evidence.source}`,
        details(row),
      ]),
    ),
    '<h2>Missing by host</h2>',
    ...(missing.length === 0
      ? ['<p>No missing targets.</p>']
      : [
          '<ul>',
          ...missing.map(
            (row) =>
              `<li>${escapeHtml(row.host_id ?? row.target)}: ${escapeHtml(row.skill_id)} — ${escapeHtml(row.reasons.join(', ') || 'missing')}</li>`,
          ),
          '</ul>',
        ]),
    '<h2>Findings</h2>',
    htmlTable(
      ['Severity', 'Rule', 'Skill', 'Target', 'Message'],
      findings.map((finding) => [
        finding.rule.level,
        finding.rule.id,
        finding.row.skill_id,
        finding.row.host_id ?? finding.row.target,
        finding.message,
      ]),
    ),
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function relativeArtifact(path: string | undefined, workspace: string): string | undefined {
  if (path === undefined || path === '' || !isAbsolute(path) || !isAbsolute(workspace)) {
    return undefined;
  }
  const value = relative(workspace, path);
  if (value === '' || value.startsWith('..') || isAbsolute(value)) return undefined;
  const normalized = value.split(sep).join('/');
  return basename(normalized) === 'SKILL.md' ? normalized : `${normalized}/SKILL.md`;
}

function artifactLocation(row: InventoryAuditRow, meta: AuditReportMeta) {
  const workspaceRelative = [row.copy_path, row.target_path]
    .map((path) => relativeArtifact(path, meta.workspace))
    .find((path) => path !== undefined);
  if (workspaceRelative !== undefined) {
    return {
      uri: workspaceRelative
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/'),
      uriBaseId: '%SRCROOT%',
    };
  }
  const host = encodeURIComponent(row.host_id ?? row.target);
  const skill = encodeURIComponent(row.skill_id);
  return {
    uri: `hosts/${host}/skills/${skill}/SKILL.md`,
    uriBaseId: 'SKILL_MANAGER_AUDIT',
  };
}

export function renderSarif(audit: InventoryAuditData, meta: AuditReportMeta): string {
  const results = findingsOf(audit).map((finding) => ({
    ruleId: finding.rule.id,
    level: finding.rule.level,
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: artifactLocation(finding.row, meta),
        },
      },
    ],
    partialFingerprints: {
      'skillManagerAudit/v1': [
        finding.row.skill_id,
        finding.row.target,
        finding.row.scope,
        finding.row.status,
        finding.row.drift_subtype ?? 'none',
      ].join('|'),
    },
  }));
  const document = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'skill-manager',
            version: meta.tool_version,
            rules: SARIF_RULES.map((item) => ({
              id: item.id,
              name: item.id,
              shortDescription: { text: item.shortDescription },
              defaultConfiguration: { level: item.level },
            })),
          },
        },
        originalUriBaseIds: {
          '%SRCROOT%': {},
          SKILL_MANAGER_AUDIT: {},
        },
        results,
      },
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function renderAuditReport(
  format: AuditReportFormat,
  audit: InventoryAuditData,
  meta: AuditReportMeta,
): AuditReportDocument {
  if (format === 'markdown') {
    return {
      format,
      media_type: 'text/markdown',
      extension: 'md',
      content: renderMarkdown(audit, meta),
    };
  }
  if (format === 'html') {
    return {
      format,
      media_type: 'text/html',
      extension: 'html',
      content: renderHtml(audit, meta),
    };
  }
  if (format === 'sarif') {
    return {
      format,
      media_type: 'application/sarif+json',
      extension: 'sarif',
      content: renderSarif(audit, meta),
    };
  }
  return {
    format,
    media_type: 'application/json',
    extension: 'json',
    content: `${JSON.stringify(audit, null, 2)}\n`,
  };
}
