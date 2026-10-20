/** 全机盘点导出 IPC：主进程负责保存对话框与文件写入。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { InventoryExportResult, InventoryScanData } from '@skill-manager/contract';
import { writeInventoryExport } from './inventory-export-format.ts';

interface ExportControlSave {
  action: 'save';
  path: string;
}

interface ExportControlCancel {
  action: 'cancel';
}

/**
 * 冒烟测试无法自动操作原生保存对话框；仅当显式设置控制文件时，
 * 主进程按控制文件选择保存或取消。生产形态不设置该环境变量。
 */
function controlOf(): ExportControlSave | ExportControlCancel | undefined {
  const controlPath =
    process.env['SKILL_MANAGER_EXPORT_CONTROL'] ??
    (process.env['SKILL_MANAGER_USER_DATA_DIR'] === undefined
      ? undefined
      : join(process.env['SKILL_MANAGER_USER_DATA_DIR'], 'export-control.json'));
  if (controlPath === undefined || controlPath === '') return undefined;
  try {
    const parsed = JSON.parse(readFileSync(controlPath, 'utf8')) as {
      action?: unknown;
      path?: unknown;
    };
    if (parsed.action === 'cancel') return { action: 'cancel' };
    if (parsed.action === 'save' && typeof parsed.path === 'string' && parsed.path !== '') {
      return { action: 'save', path: parsed.path };
    }
  } catch {
    // 控制文件不可读时回退到真实保存对话框。
  }
  return undefined;
}

async function targetOf(event: Electron.IpcMainInvokeEvent): Promise<string | undefined> {
  const control = controlOf();
  if (control?.action === 'cancel') return undefined;
  if (control?.action === 'save') return control.path;
  const options = {
    defaultPath: 'skill-inventory.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const window = BrowserWindow.fromWebContents(event.sender);
  const result =
    window === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options);
  return result.canceled || result.filePath === undefined ? undefined : result.filePath;
}

export function registerInventoryExportIpc(): void {
  ipcMain.handle(
    'inventory:export',
    async (event, data: InventoryScanData): Promise<InventoryExportResult> => {
      try {
        const target = await targetOf(event);
        if (target === undefined) return { canceled: true };
        writeInventoryExport(target, data);
        return { canceled: false, path: target };
      } catch (error) {
        return {
          canceled: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
