import { ipcMain } from 'electron';
import type { UpdateCheckReport } from '../update-check/index.ts';
import type { UpdateCoordinator } from './coordinator.ts';
import type { UpdateSettings } from './settings.ts';

/**
 * 注册更新检查的 IPC。
 * 预览与其他写操作仍由 kernel:preview/kernel:execute 承接；确认后的 update 走
 * updates:update，但内部仍是同一个 KernelBridge.execute，不存在第二套写入实现。
 */
export function registerUpdateIpc(coordinator: UpdateCoordinator): void {
  ipcMain.handle('updates:check', () => coordinator.checkNow('manual'));
  ipcMain.handle('updates:settings:get', () => coordinator.getSettings());
  ipcMain.handle('updates:settings:set', (_event, patch: Partial<UpdateSettings>) =>
    coordinator.setSettings(patch),
  );
  ipcMain.handle('updates:update', (_event, id: string, ref?: string) =>
    coordinator.executeConfirmed(id, ref),
  );
  ipcMain.handle('updates:latest', () => coordinator.getLatestReport());
}

export function sendUpdateReport(
  targets: Array<{ send: (channel: string, report: UpdateCheckReport) => void }>,
  report: UpdateCheckReport,
): void {
  for (const target of targets) target.send('updates:report', report);
}
