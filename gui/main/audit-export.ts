/** 审计报告导出 IPC：主进程负责保存对话框，内核负责渲染与写文件。 */
import { ipcMain } from 'electron';
import type { AuditReportFormat, InventoryExportResult } from '@skill-manager/contract';
import { KernelBridge } from '../bridge/commands.ts';
import { exportTargetOf, type ExportDialogOptions } from './inventory-export.ts';

type ReportFormat = Exclude<AuditReportFormat, 'json'>;

function dialogOptionsOf(format: ReportFormat): ExportDialogOptions {
  const extension = format === 'markdown' ? 'md' : format === 'html' ? 'html' : 'sarif';
  const label = format === 'markdown' ? 'Markdown' : format === 'html' ? 'HTML' : 'SARIF';
  return {
    defaultPath: `skill-audit.${extension}`,
    filters: [{ name: label, extensions: [extension] }],
  };
}

function formatOf(value: unknown): ReportFormat | undefined {
  return value === 'markdown' || value === 'html' || value === 'sarif' ? value : undefined;
}

export function registerAuditExportIpc(bridge: KernelBridge): void {
  ipcMain.handle(
    'audit:export',
    async (event, rawFormat: unknown): Promise<InventoryExportResult> => {
      const format = formatOf(rawFormat);
      if (format === undefined) {
        return {
          canceled: false,
          error: `unsupported audit report format: ${String(rawFormat)}`,
          code: 'E-INPUT-002',
        };
      }
      try {
        const target = await exportTargetOf(event, dialogOptionsOf(format));
        if (target === undefined) return { canceled: true };
        const result = await bridge.run([
          'scan',
          '--inventory',
          '--audit',
          '--format',
          format,
          '--output',
          target,
          '--json',
        ]);
        if (!result.ok) {
          return {
            canceled: false,
            error:
              result.findings[0]?.message ?? `audit export failed: ${String(result.exit_code)}`,
            ...(result.findings[0]?.code === undefined ? {} : { code: result.findings[0].code }),
          };
        }
        return { canceled: false, path: target };
      } catch (error) {
        return {
          canceled: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'E-IO-002',
        };
      }
    },
  );
}
