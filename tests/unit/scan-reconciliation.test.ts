import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type {
  HostLanding,
  InventoryCopyObservation,
  InventoryDiscoveryResult,
} from '@skill-manager/contract';
import { reconcileInventory } from '../../kernel/dispatch/scan/reconcile.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { saveHostLandings } from '../../kernel/store/host-landings/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makeTempDir } from '../helpers/temp.ts';

const NOW = '2026-10-19T00:00:00Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function ledgerRecord(state: 'active' | 'orphaned', targetPath: string): HostLanding {
  return {
    skill_id: 'alpha',
    host_id: 'claude',
    target_path: targetPath,
    format: 'skill',
    visibility: 'visible',
    state,
    origin: 'distributed',
    source_checksum: DIGEST,
    content_digest: DIGEST,
    adapter_ref: 'claude',
    registry_version: '1',
    created_at: NOW,
    updated_at: NOW,
  };
}

function discoveryWith(
  copy: InventoryCopyObservation | undefined,
  root: string,
): InventoryDiscoveryResult {
  return {
    roots: [
      {
        root_id: 'claude/user',
        host_id: 'claude',
        host_group: 'builtin',
        root_role: 'user',
        kind: 'skill',
        path: root,
        recursive: false,
        origin: 'default',
        is_x_host: false,
        consumed_by: ['claude'],
        configured: true,
        state: copy === undefined ? 'empty' : 'ok',
        readable: true,
        copy_count: copy === undefined ? 0 : 1,
        corrupt_count: 0,
      },
    ],
    copies: copy === undefined ? [] : [copy],
    corrupt: [],
    summary: {
      roots_total: 1,
      roots_ok: copy === undefined ? 0 : 1,
      roots_empty: copy === undefined ? 1 : 0,
      roots_missing: 0,
      roots_unconfigured: 0,
      roots_unreadable: 0,
      roots_not_applicable: 0,
      copies_before_dedup: copy === undefined ? 0 : 1,
      copies_after_dedup: copy === undefined ? 0 : 1,
      corrupt_before_dedup: 0,
      corrupt_after_dedup: 0,
      duplicates_removed: 0,
      dedup_key: 'realpath+casefold',
    },
  };
}

function copyOf(targetPath: string): InventoryCopyObservation {
  return {
    physical_key: targetPath.toLowerCase(),
    path: targetPath,
    host_id: 'claude',
    host_group: 'builtin',
    root_id: 'claude/user',
    root_role: 'user',
    format: 'skill',
    visibility: 'visible',
    recursive: false,
    skill_id: 'alpha',
    content_digest: DIGEST,
    readable: true,
    exists: true,
    consumed_by: ['claude'],
    root_ids: ['claude/user'],
    sources: [
      {
        host_id: 'claude',
        host_group: 'builtin',
        root_id: 'claude/user',
        root_role: 'user',
        recursive: false,
      },
    ],
  };
}

function saveLedger(root: string, record: HostLanding): void {
  const layout = layoutOf(root);
  saveHostLandings(layout.hostLandingsFile, {
    schema_version: '1',
    tool_version: '0.3.0',
    generated_at: NOW,
    landings: [record],
  });
}

test('M4c-3 反向枚举：active 账本副本不在观察集合时生成 missing', () => {
  const root = makeTempDir('sm-reconcile-unit-');
  const hostRoot = makeHostRoot('sm-reconcile-unit-host-');
  const target = join(hostRoot, 'alpha');
  saveLedger(root, ledgerRecord('active', target));
  const result = reconcileInventory({
    discovery: discoveryWith(undefined, hostRoot),
    workspace: { state: 'ok', index: createInitialIndex(NOW) },
    layout: layoutOf(root),
  });
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0]?.classification, 'missing');
  assert.equal(result.missing[0]?.ledger_source, 'host_landings');
});

test('M4c-3 反向枚举：orphaned 残留副本仍为 orphaned，不生成 missing', () => {
  const root = makeTempDir('sm-reconcile-unit-');
  const hostRoot = makeHostRoot('sm-reconcile-unit-host-');
  const target = join(hostRoot, 'alpha');
  saveLedger(root, ledgerRecord('orphaned', target));
  const result = reconcileInventory({
    discovery: discoveryWith(copyOf(target), hostRoot),
    workspace: { state: 'ok', index: createInitialIndex(NOW) },
    layout: layoutOf(root),
  });
  assert.equal(result.copies[0]?.reconciliation.classification, 'orphaned');
  assert.equal(result.missing.length, 0);
});
