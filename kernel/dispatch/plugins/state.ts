/** 插件索引的指令层读取状态；不承载插件业务逻辑。 */
import { existsSync } from 'node:fs';
import { TOOL_VERSION } from '../../core/index/index.ts';
import type { PluginIndex } from '@skill-manager/contract';
import { createInitialPluginIndex, loadPluginIndex } from '../../store/plugin-registry/index.ts';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { buildResult, type Result } from '../result/index.ts';

export function emptyPluginIndex(now: string) {
  return createInitialPluginIndex(now, TOOL_VERSION);
}

export function loadPluginsForRead(layout: WorkspaceLayout): {
  index: PluginIndex | null;
  findings: Finding[];
  initialized: boolean;
} {
  if (!existsSync(layout.pluginIndexFile)) {
    return { index: null, findings: [], initialized: false };
  }
  const loaded = loadPluginIndex(layout.pluginIndexFile);
  return { index: loaded.index, findings: [...loaded.findings], initialized: true };
}

export function loadPluginsForWrite(
  layout: WorkspaceLayout,
  now: string,
): {
  index: PluginIndex | null;
  findings: Finding[];
  missing: boolean;
} {
  if (!existsSync(layout.pluginIndexFile)) {
    return { index: null, findings: [], missing: true };
  }
  const loaded = loadPluginIndex(layout.pluginIndexFile);
  return {
    index:
      loaded.index ??
      (loaded.findings.some((item) => item.severity === 'error') ? null : emptyPluginIndex(now)),
    findings: [...loaded.findings],
    missing: false,
  };
}

export function pluginUnreadable(
  command: string,
  layout: WorkspaceLayout,
  findings: Finding[],
  missing: boolean,
): Result<unknown> {
  return buildResult(command, [
    ...findings,
    missing
      ? finding(CODES.ENV_NOT_INITIALIZED, {
          source: 'workspace',
          target: layout.root,
          message: '工作区尚未初始化',
          remedy: '请先执行 init',
        })
      : finding(CODES.ENV_INCOMPLETE, {
          source: 'workspace',
          target: layout.pluginIndexFile,
          message: '插件索引无法读取，不能执行该操作',
          remedy: '修复 plugin_index.yaml 或重新初始化工作区',
        }),
  ]);
}
