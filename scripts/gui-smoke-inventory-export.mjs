/** 盘点导出冒烟：保存对话框（测试控制文件）→ 写入临时路径 → 读回校验 → 取消零写入。 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSnapshot, treeHash } from './gui-smoke-fixtures.mjs';

function writeControl(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function openInventory(context) {
  const { evaluate, waitFor } = context;
  await evaluate('document.querySelector(\'[data-nav="inventory"]\')?.click()');
  await waitFor('document.querySelector(\'[data-testid="host-inventory"]\') !== null', 60);
  await waitFor(
    'document.querySelector(\'[data-testid="inventory-export"]\')?.disabled === false',
    80,
  );
  return Number(
    await evaluate(
      'document.querySelector(\'[data-testid="inventory-main-count"] strong\')?.textContent',
    ),
  );
}

function snapshotOf(context) {
  const { workspace, hostHome, hostLocal, userData } = context;
  return {
    workspace: treeHash(workspace),
    home: treeHash(hostHome),
    local: treeHash(hostLocal),
    settings: fileSnapshot(join(userData, 'settings.json')),
  };
}

function documentChecks(check, document, bytes, mainCount) {
  const roles = ['user', 'system', 'platform', 'project'].every(
    (role) => document.summary?.roles?.[role] !== undefined,
  );
  const arrays = ['hosts', 'copies', 'missing', 'corrupt'].every((key) =>
    Array.isArray(document[key]),
  );
  check(
    '导出 JSON 与 scan --inventory --json 结构一致',
    document.mode === 'inventory' &&
      document.summary?.main?.total_copies === mainCount &&
      roles &&
      arrays &&
      document.degradation !== undefined &&
      document.workspace !== undefined,
    `main=${String(mainCount)} bytes=${String(bytes)}`,
  );
  check(
    '大清单导出完整可解析',
    bytes > 50_000 && document.copies.length > 0,
    `bytes=${String(bytes)} copies=${String(document.copies.length)}`,
  );
}

async function saveAndRead(context, controlPath, exportPath) {
  const { evaluate, waitFor } = context;
  writeControl(controlPath, { action: 'save', path: exportPath });
  await evaluate('document.querySelector(\'[data-testid="inventory-export"]\')?.click()');
  const saved = await waitFor(
    "document.querySelector('[data-testid=\"inventory-export-message\"]')?.textContent.includes('已导出') === true",
    80,
  );
  if (!saved) {
    const message = await evaluate(
      "document.querySelector('[data-testid=\"inventory-export-error\"]')?.textContent ?? '无错误提示'",
    );
    throw new Error(`导出未完成：${String(message)}`);
  }
  const message = String(
    await evaluate(
      "document.querySelector('[data-testid=\"inventory-export-message\"]')?.textContent ?? ''",
    ),
  ).trim();
  const actualPath = message.replace(/^已导出：/, '').trim();
  return readFileSync(actualPath === '' ? exportPath : actualPath, 'utf8');
}

function checkUnchanged(context, check, before, label = '导出不修改工作区、宿主与 settings') {
  const after = snapshotOf(context);
  check(
    label,
    after.workspace === before.workspace &&
      after.home === before.home &&
      after.local === before.local &&
      after.settings === before.settings,
  );
}

async function cancelExport(context, controlPath, exportPath, before) {
  const { evaluate, waitFor, check } = context;
  rmSync(exportPath, { force: true });
  writeControl(controlPath, { action: 'cancel' });
  await evaluate('document.querySelector(\'[data-testid="inventory-export"]\')?.click()');
  await waitFor(
    "document.querySelector('[data-testid=\"inventory-export-message\"]')?.textContent.includes('取消') === true",
    80,
  );
  check(
    '取消导出不写文件且不改工作区',
    !existsSync(exportPath) && treeHash(context.workspace) === before.workspace,
  );
  checkUnchanged(context, check, before, '取消导出不修改工作区、宿主与 settings');
}

export async function runInventoryExportChecks(context) {
  const { check, userData } = context;
  const controlPath = join(userData, 'export-control.json');
  const mainCount = await openInventory(context);
  const before = snapshotOf(context);
  const exportDir = mkdtempSync(join(tmpdir(), 'sm-gui-export-'));
  const exportPath = join(exportDir, 'skill-inventory.json');
  try {
    const raw = await saveAndRead(context, controlPath, exportPath);
    documentChecks(check, JSON.parse(raw), Buffer.byteLength(raw, 'utf8'), mainCount);
    checkUnchanged(context, check, before);
    await cancelExport(context, controlPath, exportPath, before);
  } finally {
    rmSync(exportDir, { recursive: true, force: true });
  }
}
