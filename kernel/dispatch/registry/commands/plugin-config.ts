import { isAbsolute, resolve } from 'node:path';
import { savePluginIndex } from '../../../store/plugin-registry/index.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES, finding } from '../../../store/contract.ts';
import { buildResult, type Result } from '../../result/index.ts';
import type { PluginIndex } from '../../../core/plugins/types.ts';
import { workspaceRootOf } from '../../shared/options.ts';
import { loadPluginsForWrite, pluginUnreadable } from '../../plugins/state.ts';
import type { CommandContext } from '../types.ts';
const PLUGIN_CONFIG_PATTERN =
  /^plugin\.([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9]+(?:-[a-z0-9]+)*)\.(root|rules_root)$/;
export function configSetPluginCommand(
  context: CommandContext,
  key: string,
  value: string,
): Result<unknown> {
  const layout = layoutOf(workspaceRootOf(context.args));
  const loaded = loadPluginsForWrite(layout, context.now);
  if (loaded.index === null) {
    return pluginUnreadable('config set', layout, loaded.findings, loaded.missing);
  }
  const match = PLUGIN_CONFIG_PATTERN.exec(key);
  if (match === null) {
    return buildResult('config set', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: key,
        message: `插件配置键非法：${key}`,
        remedy:
          '使用 plugin.<plugin_id>.<host_key>.root 或 plugin.<plugin_id>.<host_key>.rules_root',
      }),
    ]);
  }
  const pluginId = match[1] as string;
  const hostKey = match[2] as string;
  const record = loaded.index.plugins.find((item) => item.id === pluginId);
  const host = record?.hosts.find((item) => item.host_key === hostKey);
  if (record === undefined || host === undefined) {
    return buildResult('config set', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: key,
        message: `插件或宿主未登记：${pluginId}/${hostKey}`,
        remedy: '先安装插件，并使用 list --kind plugin 查看可用宿主',
      }),
    ]);
  }
  const trimmed = value.trim();
  const relativeWithTraversal = !isAbsolute(trimmed) && trimmed.split(/[\\/]/).includes('..');
  if (trimmed === '' || trimmed.includes('\0') || relativeWithTraversal) {
    return buildResult('config set', [
      finding(CODES.PATH_INVALID, {
        source: 'input',
        target: key,
        message: '插件宿主根路径不能为空或包含空字节',
        remedy: '提供可写目录路径',
      }),
    ]);
  }
  const resolved = isAbsolute(trimmed) ? trimmed : resolve(layout.root, trimmed);
  if (resolved.includes('\0')) {
    return buildResult('config set', [
      finding(CODES.PATH_INVALID, {
        source: 'input',
        target: key,
        message: '插件宿主根路径非法',
        remedy: '提供合法路径',
      }),
    ]);
  }
  const config = { ...loaded.index.config, [key]: trimmed };
  const next: PluginIndex = { ...loaded.index, generated_at: context.now, config };
  savePluginIndex(layout.pluginIndexFile, next);
  return buildResult('config set', loaded.findings, [], {
    data: {
      key,
      previous_value: loaded.index.config[key] ?? null,
      new_value: trimmed,
      resolved_path: resolved,
    },
  });
}
