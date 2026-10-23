import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { ReconcilePreviewData } from '@skill-manager/contract';
import {
  adoptPreviewRows,
  filterBulkAdoptPlan,
} from '../../gui/renderer/src/host-inventory-action-plan.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/.*$/gm, '');
}

test('M6 GUI contract：未纳管批量采纳复用现有对话框并只执行选中候选', () => {
  const wrapperPath = 'gui/renderer/src/components/unmanaged/UnmanagedBulkAdoptDialog.vue';
  assert.equal(existsSync(join(root, wrapperPath)), true);
  const wrapper = read(wrapperPath);
  assert.match(wrapper, /<InventoryActionDialog/);
  assert.match(wrapper, /:bulk-adopt="true"/);
  assert.match(wrapper, /:targets="targets"/);

  const dialog = read('gui/renderer/src/components/host-inventory/InventoryActionDialog.vue');
  assert.match(dialog, /bulkAdopt/);
  assert.match(dialog, /'reconcile',\s*'--action',\s*'adopt',\s*'--bulk',\s*'--dry-run'/);
  assert.match(dialog, /KernelBridge appends --json/);
  assert.match(dialog, /emit\('done', result\.value\)/);
});

test('M6 GUI contract：批量采纳成功后刷新并切到审计矩阵', () => {
  const host = read('gui/renderer/src/components/HostInventoryView.vue');
  assert.match(host, /import UnmanagedBulkAdoptDialog from/);
  assert.match(host, /<UnmanagedBulkAdoptDialog/);
  assert.match(host, /@done="handleActionDone"/);
  assert.match(host, /tab\.value = 'audit'/);
  assert.match(host, /result\?\.summary\.succeeded/);
});

test('M6 GUI contract：新增文案中英资源独立且组件无硬编码中文', () => {
  const en = read('gui/renderer/src/i18n/locales/en.ts');
  const zh = read('gui/renderer/src/i18n/locales/zh-CN.ts');
  assert.match(en, /unmanagedAdopt/);
  assert.match(zh, /unmanagedAdopt/);
  for (const path of [
    'gui/renderer/src/components/unmanaged/UnmanagedBulkAdoptDialog.vue',
    'gui/renderer/src/components/host-inventory/InventoryActionDialog.vue',
  ]) {
    assert.equal(/[\p{Script=Han}]/u.test(withoutComments(read(path))), false, path);
  }
});

test('M6 GUI contract：bulk 计划只保留选中项及对应事务组', () => {
  const plan = {
    mode: 'reconcile',
    action: 'adopt',
    selection: { mode: 'batch', action: 'adopt', roots: [], apply: false, bulk: true },
    apply_requested: false,
    applied: false,
    items: [
      {
        item_id: 'item-a',
        physical_key: 'a',
        target_path: '/host/a',
        skill_id: 'a',
        host_ids: ['claude'],
        transaction_group: 'group-a',
        status: 'planned',
        action: 'adopt',
        writes: [{ action: 'add', kind: 'library', path: '/workspace/skills/a' }],
        adopt_preview: {
          source_path: '/host/a',
          requested_skill_id: 'a',
          target_skill_id: 'a',
          description: 'A',
          version: null,
          conflict: 'none',
          conflict_policy: 'skip',
        },
      },
      {
        item_id: 'item-b',
        physical_key: 'b',
        target_path: '/host/b',
        skill_id: 'b',
        host_ids: ['codex'],
        transaction_group: 'group-b',
        status: 'planned',
        action: 'adopt',
        writes: [{ action: 'add', kind: 'library', path: '/workspace/skills/b' }],
        adopt_preview: {
          source_path: '/host/b',
          requested_skill_id: 'b',
          target_skill_id: 'b',
          description: 'B',
          version: '1.0.0',
          conflict: 'none',
          conflict_policy: 'skip',
        },
      },
    ],
    transaction_groups: [
      {
        group_id: 'group-a',
        physical_path: '/host/a',
        item_ids: ['item-a'],
        host_ids: ['claude'],
        ledger_sources: ['host_landings'],
        shared: false,
      },
      {
        group_id: 'group-b',
        physical_path: '/host/b',
        item_ids: ['item-b'],
        host_ids: ['codex'],
        ledger_sources: ['host_landings'],
        shared: false,
      },
    ],
    summary: {
      selected: 2,
      planned: 2,
      skipped: 0,
      destructive: 0,
      shared_groups: 0,
      bulk: {
        candidates: 2,
        limited: 2,
        conflict_skipped: 0,
        renamed: 0,
        forced: 0,
      },
    },
    notes: [],
  } as unknown as ReconcilePreviewData;

  const filtered = filterBulkAdoptPlan(plan, [{ path: '/host/a' }]);
  assert.deepEqual(
    filtered.items.map((item) => item.skill_id),
    ['a'],
  );
  assert.deepEqual(
    filtered.transaction_groups.map((group) => group.group_id),
    ['group-a'],
  );
  assert.deepEqual(adoptPreviewRows(filtered), [
    {
      item_id: 'item-a',
      source_path: '/host/a',
      requested_id: 'a',
      target_id: 'a',
      target_path: '/workspace/skills/a',
      description: 'A',
      version: null,
      conflict: 'none',
    },
  ]);
});
