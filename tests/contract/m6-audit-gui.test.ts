import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

test('M6 GUI contract：盘点视图提供审计 tab 并复用通用 scan 入口', () => {
  const host = read('gui/renderer/src/components/HostInventoryView.vue');
  assert.match(host, /import AuditMatrixView from/);
  assert.match(host, /data-testid="inventory-tab-audit"/);
  assert.match(host, /<AuditMatrixView[\s\S]*?:run="run"/);

  const matrix = read('gui/renderer/src/components/audit/AuditMatrixView.vue');
  assert.match(matrix, /\['scan', '--inventory', '--audit'\]/);
  assert.match(matrix, /drift_by_subtype/);
  assert.match(matrix, /data-testid="audit-matrix"/);
  assert.match(matrix, /<AuditExportMenu/);
});

test('M6 GUI contract：导出菜单三格式完整，主进程负责 dialog 与 kernel 调用', () => {
  const menu = read('gui/renderer/src/components/audit/AuditExportMenu.vue');
  for (const format of ['markdown', 'html', 'sarif']) {
    assert.match(menu, new RegExp(`data-testid="audit-export-${format}"`));
  }
  assert.match(menu, /skillManager\.audit\.export/);

  const main = read('gui/main/audit-export.ts');
  const dialogSource = `${main}\n${read('gui/main/inventory-export.ts')}`;
  assert.match(dialogSource, /dialog\.showSaveDialog/);
  assert.match(main, /'--format'/);
  assert.match(main, /'--output'/);
  assert.match(main, /'--json'/);

  const preload = read('gui/preload/index.ts');
  assert.match(preload, /audit:\s*\{/);
  assert.match(preload, /audit:export/);
});

test('M6 GUI contract：AuditMatrixView 低于 600 行且没有硬编码中文', () => {
  const matrix = read('gui/renderer/src/components/audit/AuditMatrixView.vue');
  const lines = matrix.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  assert.ok(lines < 600, `AuditMatrixView 行数 ${String(lines)}`);
  const source = matrix
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(/[\p{Script=Han}]/u.test(source), false);
});
