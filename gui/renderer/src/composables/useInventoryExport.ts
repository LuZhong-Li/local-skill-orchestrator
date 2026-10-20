/** 盘点导出：渲染层把已有结果交给主进程保存，自身不接触文件系统。 */
import type { InventoryExportResult, InventoryScanData } from '@skill-manager/contract';

export async function exportInventory(data: InventoryScanData): Promise<InventoryExportResult> {
  // Vue ref 是 reactive proxy，不能直接经 Electron structured clone 传输；
  // 盘点结果本身来自 JSON，做一次纯化可保证 IPC 与文件内容同构。
  const plain = JSON.parse(JSON.stringify(data)) as InventoryScanData;
  return (await globalThis.window.skillManager.inventory.export(plain)) as InventoryExportResult;
}
