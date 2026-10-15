/**
 * 预加载脚本：向渲染层暴露最小白名单接口。
 *
 * 只暴露四个方法，全部转发为一次内核调用；不暴露任何 Node 模块、文件系统或任意进程能力。
 * 「哪些指令需要确认」由内核判定，渲染层只负责把预览结果展示给用户。
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** 直发一条指令：只读查询与已确认的写操作都走这里 */
  invoke: (argv: string[]): Promise<unknown> => ipcRenderer.invoke('kernel:invoke', argv),
  /** 预览一条写指令的影响范围（内核以预演方式运行，不产生变更） */
  preview: (argv: string[]): Promise<unknown> => ipcRenderer.invoke('kernel:preview', argv),
  /** 执行一条已确认的写指令 */
  execute: (argv: string[]): Promise<unknown> => ipcRenderer.invoke('kernel:execute', argv),
  /** 读取当前工作区与运行模式，供界面展示 */
  describe: (): Promise<unknown> => ipcRenderer.invoke('kernel:describe'),
};

contextBridge.exposeInMainWorld('skillManager', api);

export type SkillManagerApi = typeof api;
