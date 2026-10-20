/** 盘点导出序列化与单目标文件写入；不读取工作区，也不触碰任何账本。 */
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InventoryScanData } from '@skill-manager/contract';

export function serializeInventoryExport(data: InventoryScanData): string {
  if (data?.mode !== 'inventory' || !Array.isArray(data.copies) || !Array.isArray(data.hosts)) {
    throw new Error('盘点导出数据不完整：缺少 mode=inventory / copies / hosts');
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * 只写用户选择的目标文件。同目录临时文件名仅用于原子替换，立即清理。
 * 调用方负责提供保存对话框返回的路径。
 */
export function writeInventoryExport(target: string, data: InventoryScanData): void {
  const content = serializeInventoryExport(data);
  const temp = join(dirname(target), `.${randomUUID()}.inventory-export.tmp`);
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
