import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { InventoryScanData } from '@skill-manager/contract';
import {
  serializeInventoryExport,
  writeInventoryExport,
} from '../../gui/main/inventory-export-format.ts';
import { makeTempDir } from '../helpers/temp.ts';

function largeInventory(): InventoryScanData {
  const copies = Array.from({ length: 4000 }, (_, index) => ({
    physical_key: `c:/host/copy-${String(index)}`,
    path: `C:/host/copy-${String(index)}`,
    host_id: 'codex',
    host_group: 'builtin' as const,
    root_id: 'codex/agents-user',
    root_role: 'user' as const,
    format: 'skill' as const,
    visibility: 'visible' as const,
    recursive: false,
    skill_id: `copy-${String(index)}`,
    content_digest: `sha256:${'a'.repeat(64)}`,
    readable: true,
    exists: true,
    consumed_by: ['codex'],
    root_ids: ['codex/agents-user'],
    sources: [
      {
        host_id: 'codex',
        host_group: 'builtin' as const,
        root_id: 'codex/agents-user',
        root_role: 'user' as const,
        recursive: false,
      },
    ],
    reconciliation: {
      classification: 'untracked' as const,
      ledger_source: 'none' as const,
      authority: 'insufficient' as const,
      evidence: {
        managed: 'insufficient' as const,
        content: 'insufficient' as const,
        source: 'insufficient' as const,
      },
      reasons: ['no_ledger_no_workspace'],
      drift_reasons: [],
      untracked_candidate: true,
    },
  }));
  return {
    mode: 'inventory',
    workspace: { root: 'C:/workspace', state: 'ok' },
    roots: [],
    hosts: [
      {
        host_id: 'codex',
        host_group: 'builtin',
        display_name: 'Codex',
        roots: [],
        counts: {
          total_copies: copies.length,
          unique_skills: copies.length,
          corrupt_count: 0,
          by_classification: {},
        },
      },
    ],
    copies,
    corrupt: [],
    missing: [],
    summary: {
      roots_total: 0,
      roots_ok: 0,
      roots_empty: 0,
      roots_missing: 0,
      roots_unconfigured: 0,
      roots_unreadable: 0,
      roots_not_applicable: 0,
      copies_before_dedup: copies.length,
      copies_after_dedup: copies.length,
      corrupt_before_dedup: 0,
      corrupt_after_dedup: 0,
      duplicates_removed: 0,
      dedup_key: 'realpath+casefold',
      main: { total_copies: copies.length, unique_skills: copies.length },
      roles: {
        user: {
          total_copies: copies.length,
          unique_skills: copies.length,
          by_classification: {},
          corrupt_count: 0,
          groups: {},
        },
        system: {
          total_copies: 0,
          unique_skills: 0,
          by_classification: {},
          corrupt_count: 0,
          groups: {},
        },
        platform: {
          total_copies: 0,
          unique_skills: 0,
          by_classification: {},
          corrupt_count: 0,
          groups: {},
        },
        project: {
          total_copies: 0,
          unique_skills: 0,
          by_classification: {},
          corrupt_count: 0,
          groups: {},
        },
      },
      classification_groups: {},
    },
    degradation: { host_landings: 'missing', plugin_landings: 'missing' },
  } as unknown as InventoryScanData;
}

test('盘点导出：1MB 级 JSON 完整序列化，单目标文件写入无临时残留', () => {
  const data = largeInventory();
  const raw = serializeInventoryExport(data);
  assert.ok(Buffer.byteLength(raw, 'utf8') > 1_000_000, String(Buffer.byteLength(raw, 'utf8')));
  const parsed = JSON.parse(raw) as InventoryScanData;
  assert.equal(parsed.copies.length, 4000);
  assert.equal(parsed.summary.main.total_copies, 4000);

  const dir = makeTempDir('sm-export-');
  const target = join(dir, 'skill-inventory.json');
  writeInventoryExport(target, data);
  assert.deepEqual(readdirSync(dir), ['skill-inventory.json']);
  assert.equal(readFileSync(target, 'utf8'), raw);
});
