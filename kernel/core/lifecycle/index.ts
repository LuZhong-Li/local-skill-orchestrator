/**
 * K-04 生命周期编排入口。
 *
 * 实现按命令拆分到 install / uninstall / toggle / update / restore，
 * 共享的索引投影与目标工具在 shared.ts；本文件只保留公共导出，调用方签名不变。
 */
export type {
  LifecycleOutcome,
  InstallInput,
  UninstallInput,
  ToggleInput,
  UpdateInput,
  RestoreInput,
} from './types.ts';

export { installSkill } from './install.ts';
export { uninstallSkill } from './uninstall.ts';
export { enableSkill, disableSkill } from './toggle.ts';
export { updateSkill } from './update.ts';
export { restoreSkill } from './restore.ts';
