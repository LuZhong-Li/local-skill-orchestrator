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
  assert.match(host, /盘点本身只读/);
  assert.match(host, /不会一键全修或全删/);
  assert.match(host, /@done="load"/);

  const dialog = read('gui/renderer/src/components/host-inventory/InventoryActionDialog.vue');
  assert.match(dialog, /\['reconcile', '--action', props\.action, '--path', props\.path\]/);
  assert.match(dialog, /'--apply'/);
  assert.match(dialog, /'--yes'/);
  assert.equal(dialog.includes('window.skillManager'), false);
  assert.match(dialog, /onMounted\(loadPreview\)/);
});

test('契约：未初始化工作区有盘点入口，逐条动作与角色折叠可见', () => {
  const dashboard = read('gui/renderer/src/components/DashboardView.vue');
  assert.match(dashboard, /data-testid="open-inventory"/);
  assert.match(dashboard, /盘点这台电脑上已安装的 Skill/);
  assert.match(dashboard, /盘点不需要初始化工作区/);

  const summary = read('gui/renderer/src/components/host-inventory/InventorySummary.vue');
  assert.match(summary, /data-testid="inventory-main-count"/);
  assert.match(summary, /data-testid="inventory-role-fold"/);
  assert.match(summary, /系统 \/ 平台 \/ 项目级副本不计入主计数/);

  const host = read('gui/renderer/src/components/HostInventoryView.vue');
  assert.match(host, /data-testid="inventory-untracked"/);
  assert.match(host, /动作按副本逐条提供/);
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
