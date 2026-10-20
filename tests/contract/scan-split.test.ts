import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkInventoryReadonly } from '../../scripts/check-layer.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

test('架构：scan 实现只在 dispatch/scan，registry 仅保留路由', () => {
  const registry = read('kernel/dispatch/registry/index.ts');
  assert.match(registry, /import \{ scanHandler \} from '\.\.\/scan\/index\.ts';/);
  assert.match(registry, /register\(\{ name: 'scan', handler: scanHandler \}\);/);
  assert.equal(registry.includes('scanWorkspace('), false, 'registry 不得保留 Skill 扫描执行');
  assert.equal(
    registry.includes('inspectPluginPackagesForScan'),
    false,
    'registry 不得保留插件扫描实现',
  );
  assert.equal(registry.includes('pluginScanCommand'), false, 'registry 不得保留插件扫描分支');

  const workspace = read('kernel/dispatch/scan/workspace.ts');
  assert.match(workspace, /withLock\(layout\.indexFile/);
  assert.match(workspace, /scanWorkspace\(\{ layout, index, now \}\)/);
  assert.match(workspace, /saveIndex\(layout\.indexFile, outcome\.index\)/);

  const plugin = read('kernel/dispatch/scan/plugin.ts');
  assert.match(plugin, /loadPluginsForWrite\(layout, now\)/);
  assert.match(plugin, /savePluginIndex\(layout\.pluginIndexFile, next\)/);
  assert.equal(plugin.includes('withLock'), false, '插件扫描保持无锁');

  const inventory = read('kernel/dispatch/scan/inventory.ts');
  for (const forbidden of ['withLock(', 'saveIndex(', 'scanWorkspace(', 'savePluginIndex(']) {
    assert.equal(inventory.includes(forbidden), false, `inventory 不得调用 ${forbidden}`);
  }
  assert.equal(inventory.includes('last_scan_at'), false, 'inventory 不得写扫描时间戳');
  for (const file of [
    'kernel/core/inventory/discover.ts',
    'kernel/dispatch/scan/reconcile.ts',
    'kernel/dispatch/scan/aggregate.ts',
  ]) {
    const source = read(file);
    for (const forbidden of [
      'writeFileSync',
      'appendFileSync',
      'mkdirSync',
      'rmSync',
      'renameSync',
      'cpSync',
      'withLock(',
      'saveIndex(',
      'savePluginIndex(',
      'saveHostLandings(',
      'landPlan(',
    ]) {
      assert.equal(source.includes(forbidden), false, `${file} 不得包含 ${forbidden}`);
    }
  }
});

test('架构：scan 在索引检查前保留 M4c-1 inventory 分流点，且不注册占位参数', () => {
  const index = read('kernel/dispatch/scan/index.ts');
  const plan = index.indexOf('const plan = scanPlanOf(args);');
  const route = index.indexOf('return workspaceScanCommand(plan, now);');
  assert.ok(plan >= 0 && route > plan, '必须先形成计划，再进入 workspace 执行');
  assert.match(index, /M4c-1 inventory 分流点/);
  assert.match(index, /if \(plan\.mode === 'inventory'\) return inventoryScanCommand\(plan, now\)/);
  assert.match(index, /inventory → 只展开根，不加锁、不写 last_scan_at/);

  const options = read('kernel/dispatch/scan/options.ts');
  assert.match(options, /flag\(args, 'inventory'\)/);
  const types = read('kernel/dispatch/scan/types.ts');
  assert.match(types, /export type ScanMode = 'workspace' \| 'inventory';/);
  assert.match(types, /export type ScanPlan = WorkspaceScanPlan \| InventoryScanPlan;/);
});

test('架构：盘点只读静态守卫能捕获临时写调用与写模块导入', () => {
  assert.deepEqual(
    checkInventoryReadonly({
      'synthetic-readonly.ts': "import { readFileSync, readdirSync } from 'node:fs';",
    }),
    [],
  );
  assert.ok(
    checkInventoryReadonly({
      'synthetic-write.ts': "import { writeFileSync } from 'node:fs'; writeFileSync('x', 'y');",
    }).length > 0,
  );
  assert.ok(
    checkInventoryReadonly({
      'synthetic-save.ts': "import { saveIndex } from '../store/index.ts'; saveIndex('x', {});",
    }).length > 0,
  );
});
