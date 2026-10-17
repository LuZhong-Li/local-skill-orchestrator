/** 插件管理的主进程通道：只转发 KernelBridge，不复制内核规则。 */
import { ipcMain } from 'electron';
import type { KernelBridge } from '../../bridge/commands.ts';
import { partitionPluginHosts } from './hosts.ts';

export function registerPluginIpc(bridge: KernelBridge): void {
  ipcMain.handle('plugins:hosts', async () => {
    const result = await bridge.run(['list', '--kind', 'plugin']);
    return {
      result,
      ...partitionPluginHosts(result.data),
    };
  });
}
