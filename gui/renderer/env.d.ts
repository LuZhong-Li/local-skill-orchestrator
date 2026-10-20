/// <reference types="vite/client" />
import type { InventoryExportResult, InventoryScanData } from '@skill-manager/contract';

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/** 预加载脚本暴露的白名单接口；渲染层只能通过它接触内核 */
interface SkillManagerApi {
  invoke(argv: string[]): Promise<unknown>;
  preview(argv: string[]): Promise<unknown>;
  execute(argv: string[]): Promise<unknown>;
  describe(): Promise<unknown>;
  plugins: {
    hosts(): Promise<unknown>;
    list(): Promise<unknown>;
    scan(): Promise<unknown>;
    inspect(id: string): Promise<unknown>;
    install(source: string): Promise<unknown>;
    enable(id: string): Promise<unknown>;
    disable(id: string): Promise<unknown>;
    uninstall(id: string): Promise<unknown>;
  };
  inventory: {
    export(data: InventoryScanData): Promise<InventoryExportResult>;
  };
  updates: {
    check(): Promise<unknown>;
    getSettings(): Promise<unknown>;
    setSettings(patch: unknown): Promise<unknown>;
    update(id: string, ref?: string): Promise<unknown>;
    latest(): Promise<unknown>;
    onReport(callback: (report: unknown) => void): () => void;
  };
}

declare global {
  interface Window {
    skillManager: SkillManagerApi;
  }
}

export {};
