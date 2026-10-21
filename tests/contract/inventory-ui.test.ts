import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function nonEmptyLines(path: string): number {
  return read(path)
    .split(/\r?\n/)
    .filter((line) => line.length > 0).length;
}

test('契约：M4c-6 盘点视图独立挂载，App.vue 规模只降不增', () => {
  const app = read('gui/renderer/src/App.vue');
  assert.match(app, /import HostInventoryView from/);
  assert.match(app, /<HostInventoryView[\s\S]*?:run="kernel\.run"[\s\S]*?\/>/);
  assert.match(app, /:export-inventory="exportInventory"/);
  assert.match(app, /data-nav="inventory"/);
  assert.ok(
    nonEmptyLines('gui/renderer/src/App.vue') <= 858,
    `App.vue 不得超过 858 行基线，实际 ${String(nonEmptyLines('gui/renderer/src/App.vue'))}`,
  );
  for (const path of [
    'gui/renderer/src/components/HostInventoryView.vue',
    'gui/renderer/src/components/host-inventory/InventorySummary.vue',
    'gui/renderer/src/components/host-inventory/InventoryHostGroups.vue',
    'gui/renderer/src/components/host-inventory/InventoryCopyDetails.vue',
  ]) {
    assert.ok(nonEmptyLines(path) < 800, `${path} 应低于 800 行`);
  }
});

test('契约：盘点视图走通用 scan --inventory，不直接访问 preload 或写通道', () => {
  const host = read('gui/renderer/src/components/HostInventoryView.vue');
  assert.match(host, /\['scan', '--inventory'\]/);
  assert.match(host, /run: \(argv: string\[\]\) => Promise<Result<Record<string, unknown>>>/);
  for (const forbidden of [
    'window.skillManager',
    'runWithConfirm',
    '.preview(',
    '.execute(',
    'plugins.',
    'updates.',
  ]) {
    assert.equal(host.includes(forbidden), false, `盘点视图不得使用 ${forbidden}`);
  }
  assert.equal(host.includes('install'), false, '盘点视图不得包含安装类调用');
  assert.equal(host.includes('uninstall'), false);
  assert.match(host, /inventory\.intro/);
  assert.match(host, /@done="load"/);

  const dialog = read('gui/renderer/src/components/host-inventory/InventoryActionDialog.vue');
  assert.match(dialog, /function buildPreviewArgv\(\): string\[\]/);
  assert.match(dialog, /function executeBatch\(/);
  assert.match(dialog, /function planItemSignature\(/);
  assert.match(dialog, /'--apply'/);
  assert.match(dialog, /'--yes'/);
  assert.equal(dialog.includes('window.skillManager'), false);
  assert.match(dialog, /onMounted\(loadPreview\)/);
});

test('T7 契约：批量选择覆盖复选框、根级全选、三区块与 item 边界取消', () => {
  const host = read('gui/renderer/src/components/HostInventoryView.vue');
  assert.match(host, /data-testid="batch-action-bar"/);
  assert.match(host, /data-testid="batch-clear"/);
  assert.match(host, /:selected-keys="selection\.selected"/);
  assert.match(host, /@toggle-root="toggleRoot"/);

  const copyDetails = read('gui/renderer/src/components/host-inventory/InventoryCopyDetails.vue');
  assert.match(copyDetails, /type="checkbox"/);
  assert.match(copyDetails, /:data-path="copy\.path"/);
  assert.match(copyDetails, /:disabled="!isCopySelectable\(copy\)"/);

  const groups = read('gui/renderer/src/components/host-inventory/InventoryHostGroups.vue');
  assert.match(groups, /select-root-\$\{node\.root\.root_id\}/);
  assert.match(groups, /@change="toggleRoot\(node\.root\.root_id, node\)"/);

  const dialog = read('gui/renderer/src/components/host-inventory/InventoryActionDialog.vue');
  for (const section of ['writes', 'ledger', 'warnings']) {
    assert.match(dialog, new RegExp(`data-testid="action-section-${section}"`));
  }
  assert.match(dialog, /data-testid="batch-progress"/);
  assert.match(dialog, /data-testid="batch-summary"/);
  assert.match(dialog, /function requestCancel\(\): void/);
  assert.match(dialog, /if \(cancelRequested\.value && attempted > 0\) break;/);
});

test('T8 契约：角色、根状态、空状态与长文本呈现由统一映射和样式承接', () => {
  const presentation = read('gui/renderer/src/host-inventory-presentation.ts');
  assert.match(presentation, /export function roleVisualClass/);
  assert.match(presentation, /export function rootStateVisualClass/);
  assert.match(presentation, /export function rootStateHint/);

  const groups = read('gui/renderer/src/components/host-inventory/InventoryHostGroups.vue');
  assert.match(groups, /data-testid="root-role-tag"/);
  assert.match(groups, /data-testid="root-state-tag"/);
  assert.match(groups, /data-testid="root-empty-state"/);
  assert.match(groups, /:class="roleVisualClass\(node\.root\.root_role\)"/);
  assert.match(groups, /:class="rootStateVisualClass\(node\.root\.state\)"/);

  const copies = read('gui/renderer/src/components/host-inventory/InventoryCopyDetails.vue');
  assert.match(copies, /class="skill-id"/);
  assert.match(copies, /class="path-text"/);
  assert.match(copies, /text-overflow: ellipsis/);
  assert.match(copies, /white-space: nowrap/);
});

test('契约：未初始化工作区有盘点入口，逐条动作与角色折叠可见', () => {
  const dashboard = read('gui/renderer/src/components/DashboardView.vue');
  assert.match(dashboard, /data-testid="open-inventory"/);
  assert.match(dashboard, /dashboard\.inventoryInstalled/);
  assert.match(dashboard, /dashboard\.inventoryHint/);

  const summary = read('gui/renderer/src/components/host-inventory/InventorySummary.vue');
  assert.match(summary, /data-testid="inventory-main-count"/);
  assert.match(summary, /data-testid="inventory-role-fold"/);
  assert.match(summary, /inventory\.mainHint/);

  const host = read('gui/renderer/src/components/HostInventoryView.vue');
  assert.match(host, /data-testid="inventory-untracked"/);
  assert.match(host, /inventory\.actionHint/);
  assert.match(host, /data-testid="inventory-third-party-hosts"|InventoryHostGroups/);

  const groups = read('gui/renderer/src/components/host-inventory/InventoryHostGroups.vue');
  assert.match(groups, /data-testid="inventory-builtin-hosts"/);
  assert.match(groups, /data-testid="inventory-third-party-hosts"/);
  assert.match(groups, /data-testid="inventory-consumed-by"/);

  const menu = read('gui/renderer/src/components/host-inventory/InventoryActionMenu.vue');
  assert.match(menu, /data-testid="`inventory-action-\$\{option\.action\}`"/);
  assert.match(menu, /:disabled="option\.disabled"/);
});

test('契约：盘点结果类型只来自 contract', () => {
  const scanTypes = read('kernel/dispatch/scan/types.ts');
  assert.equal(
    /export\s+type\s*\{[\s\S]*\}\s+from\s+['"]@skill-manager\/contract['"]/.test(scanTypes),
    false,
  );
  assert.equal(scanTypes.includes('export interface InventoryScanData'), false);
  const inventory = read('kernel/dispatch/scan/inventory.ts');
  assert.match(
    inventory,
    /InventoryRootView,\s*InventoryScanData\s*\} from '@skill-manager\/contract';/,
  );
  const contract = read('contract/src/host-inventory.ts');
  assert.match(contract, /export interface InventoryScanData/);
});
