/**
 * 预加载脚本：向渲染层暴露最小白名单接口。
 *
 * 只暴露白名单方法；不暴露任何 Node 模块、文件系统或任意进程能力。
 * 「哪些指令需要确认」由内核判定，渲染层只负责把预览结果展示给用户。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { InventoryExportResult, InventoryScanData } from '@skill-manager/contract';

const api = {
  /** 直发一条指令：只读查询与已确认的写操作都走这里 */
  invoke: (argv: string[]): Promise<unknown> => ipcRenderer.invoke('kernel:invoke', argv),
  /** 预览一条写指令的影响范围（内核以预演方式运行，不产生变更） */
  preview: (argv: string[]): Promise<unknown> => ipcRenderer.invoke('kernel:preview', argv),
  /** 执行一条已确认的写指令 */
  execute: (argv: string[]): Promise<unknown> => ipcRenderer.invoke('kernel:execute', argv),
  /** 读取当前工作区与运行模式，供界面展示 */
  describe: (): Promise<unknown> => ipcRenderer.invoke('kernel:describe'),
  appSettings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('app-settings:get'),
    setLanguage: (patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke('app-settings:set-language', patch),
  },
  plugins: {
    /** 插件/内置宿主分区，由主进程消费同一份 list --kind plugin 结果 */
    hosts: (): Promise<unknown> => ipcRenderer.invoke('plugins:hosts'),
    list: (): Promise<unknown> => ipcRenderer.invoke('kernel:invoke', ['list', '--kind', 'plugin']),
    scan: (): Promise<unknown> =>
      ipcRenderer.invoke('kernel:invoke', ['scan', '--kind', 'plugin', '--dry-run']),
    inspect: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('kernel:invoke', ['inspect', id, '--kind', 'plugin']),
    install: (source: string): Promise<unknown> =>
      ipcRenderer.invoke('kernel:invoke', ['install', source, '--kind', 'plugin']),
    enable: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('kernel:invoke', ['enable', id, '--kind', 'plugin']),
    disable: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('kernel:invoke', ['disable', id, '--kind', 'plugin']),
    uninstall: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('kernel:invoke', ['uninstall', id, '--kind', 'plugin']),
  },
  inventory: {
    /** 仅把当前盘点结果交给主进程保存到用户显式选择的文件 */
    export: (data: InventoryScanData): Promise<InventoryExportResult> =>
      ipcRenderer.invoke('inventory:export', data),
  },
  updates: {
    /** 手动触发一次只读检查 */
    check: (): Promise<unknown> => ipcRenderer.invoke('updates:check'),
    /** 读取更新检查开关 */
    getSettings: (): Promise<unknown> => ipcRenderer.invoke('updates:settings:get'),
    /** 仅由用户切换开关时调用 */
    setSettings: (patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke('updates:settings:set', patch),
    /** 用户已确认后的单项 update 执行通道（主进程仍调用既有 KernelBridge.execute） */
    update: (id: string, ref?: string): Promise<unknown> =>
      ipcRenderer.invoke('updates:update', id, ref),
    /** 最近一次检查结果，供窗口重建后恢复角标 */
    latest: (): Promise<unknown> => ipcRenderer.invoke('updates:latest'),
    /** 定期/即时检查只发提示事件，不带任何执行能力 */
    onReport: (callback: (report: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, report: unknown): void => {
        callback(report);
      };
      ipcRenderer.on('updates:report', listener);
      return () => ipcRenderer.removeListener('updates:report', listener);
    },
  },
};

contextBridge.exposeInMainWorld('skillManager', api);

export type SkillManagerApi = typeof api;
