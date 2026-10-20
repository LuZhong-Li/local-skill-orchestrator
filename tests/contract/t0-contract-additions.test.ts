import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import type {
  ReconcileSelection,
  ReconcileSelectionSummary,
} from '../../contract/src/reconcile.ts';
import type { InventoryAuditData, InventoryAuditRow } from '../../contract/src/host-inventory.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

type Validator = ((data: unknown) => boolean) & { errors?: unknown };

function validator(name: string): Validator {
  const schema = JSON.parse(read(`schemas/${name}`)) as object;
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema) as unknown as Validator;
}

function minimalSkillMeta(): Record<string, unknown> {
  return {
    id: 'alpha',
    name: 'alpha',
    status: 'enabled',
    path: './skills/alpha',
    source: { type: 'unknown' },
    targets: [
      {
        target: 'claude',
        scope: 'global',
        path: '.claude/skills/alpha',
        mode: 'copy',
        enabled: true,
      },
    ],
  };
}

test('T0 contract：reconcile batch 选择器与结果字段为可选加法', () => {
  const selection: ReconcileSelection = {
    mode: 'batch',
    action: 'repair',
    ids: ['alpha', 'beta'],
    roles: ['user'],
    roots: [],
    apply: false,
  };
  const summary: ReconcileSelectionSummary = {
    total: 2,
    by_skill: { alpha: 1, beta: 1 },
    by_root: {},
    by_role: { user: 2 },
    by_host: { claude: 2 },
    by_classification: { missing: 2 },
  };
  assert.equal(selection.mode, 'batch');
  assert.equal(summary.total, 2);

  const source = read('contract/src/reconcile.ts');
  assert.match(source, /'path' \| 'id-host' \| 'classification' \| 'batch'/);
  assert.match(source, /ids\?: string\[\]/);
  assert.match(source, /roles\?: HostRootRole\[\]/);
  assert.match(source, /ReconcileSelectionSummary/);
  assert.match(source, /succeeded\?: number/);
  assert.match(source, /failed\?: number/);
  assert.match(source, /cancelled\?: number/);
  assert.match(source, /duration_ms\?: number/);
  assert.match(source, /stage\?: string/);
  assert.match(source, /reason\?: string/);
});

test('T0 contract：host-inventory 审计类型与可选 audit 字段', () => {
  const row: InventoryAuditRow = {
    skill_id: 'alpha',
    target: 'claude',
    scope: 'global',
    host_id: 'claude',
    expected_enabled: true,
    ledger_state: 'active',
    status: 'distributed',
    evidence: { managed: 'authoritative', content: 'authoritative', source: 'authoritative' },
    reasons: [],
    observed_at: '2026-10-20T00:00:00Z',
  };
  const audit: InventoryAuditData = {
    observed_at: row.observed_at,
    summary: {
      declared: 1,
      distributed: 1,
      missing: 0,
      drift: 0,
      visibility_mismatch: 0,
      undeclared: 0,
      unmapped: 0,
      workspace_only: 0,
      insufficient: 0,
    },
    rows: [row],
  };
  assert.equal(audit.rows[0]?.status, 'distributed');

  const source = read('contract/src/host-inventory.ts');
  assert.match(source, /export type InventoryAuditStatus/);
  assert.match(source, /export interface InventoryAuditRow/);
  assert.match(source, /export interface InventoryAuditSummary/);
  assert.match(source, /export interface InventoryAuditData/);
  assert.match(source, /audit\?: InventoryAuditData/);
});

test('T0 schema：skill_meta 新字段可选，旧夹具仍通过', () => {
  const validate = validator('skill_meta.schema.json');
  assert.equal(validate(minimalSkillMeta()), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...minimalSkillMeta(),
      compatibility: 'Designed for Claude Code',
      allowed_tools: 'Read Grep',
      metadata: { author: 'example', version: '1.0.0', custom: { nested: true } },
      extensions: { 'mcp-server': { command: 'example' } },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(validate({ ...minimalSkillMeta(), compatibility: 42 }), false);
  assert.equal(validate({ ...minimalSkillMeta(), allowed_tools: ['Read'] }), false);
  assert.equal(validate({ ...minimalSkillMeta(), metadata: 'not-a-map' }), false);
  assert.equal(validate({ ...minimalSkillMeta(), extensions: [] }), false);
});

test('T0 schema：backup 新字段可选，旧导出夹具仍通过', () => {
  const validate = validator('backup.schema.json');
  const base = {
    backup_format_version: '1',
    exported_at: '2026-10-20T00:00:00Z',
    tool_version: '0.5.2',
    skills: [{ id: 'alpha', name: 'alpha', status: 'enabled' }],
  };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.equal(
    validate({
      ...base,
      skills: [
        {
          ...base.skills[0],
          compatibility: 'Claude Code',
          allowed_tools: 'Read',
          metadata: { custom: { nested: true } },
          extensions: { 'mcp-server': { command: 'example' } },
        },
      ],
    }),
    true,
    JSON.stringify(validate.errors),
  );
});

test('T0 文档：CLI 契约登记 batch 选择器与 audit 只读入口', () => {
  const contract = read('docs/specification/cli-contract.md');
  assert.match(contract, /--id <Skill 标识>\.\.\./);
  assert.match(contract, /--role <user\|system\|platform\|project>\.\.\./);
  assert.match(contract, /batch 选择器/);
  assert.match(contract, /--audit/);
  assert.match(contract, /clean.*整角色.*全选|整角色.*全选/is);
});

test('T0 文档：字段、审计与索引边界已登记', () => {
  const metaSpec = read('docs/specification/skill-meta-spec.md');
  assert.match(metaSpec, /\| `compatibility` \|/);
  assert.match(metaSpec, /\| `allowed_tools` \|/);
  assert.match(metaSpec, /\| `metadata` \|/);
  assert.match(metaSpec, /\| `extensions` \|/);
  assert.match(metaSpec, /metadata 与 extensions/);

  const landingSpec = read('docs/specification/host-landings.spec.md');
  assert.match(landingSpec, /审计期望集合.*skill_meta\.targets\[\]/s);

  const indexSpec = read('docs/specification/index-format.md');
  assert.match(indexSpec, /compatibility.*allowed_tools.*metadata.*extensions/s);

  const resultSpec = read('docs/specification/result-and-exit-codes.md');
  assert.match(resultSpec, /批量操作的结果载荷/);
  assert.match(resultSpec, /W-DRIFT-001.*当前内容基线/s);
});
