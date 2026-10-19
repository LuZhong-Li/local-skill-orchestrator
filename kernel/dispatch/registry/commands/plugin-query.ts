import { join } from 'node:path';
import { TOOL_VERSION } from '../../../core/index/index.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { loadHostRegistry } from '../../../core/hosts/index.ts';
import { buildResult, type Result } from '../../result/index.ts';
import { option, type ParsedArgs } from '../../parsers/index.ts';
import { inspectPluginPackage } from '../../../core/plugins/discovery.ts';
import { rejectPluginOptions, workspaceRootOf } from '../../shared/options.ts';
import { emptyPluginIndex, loadPluginsForRead } from '../../plugins/state.ts';
export function pluginListCommand(context: { args: ParsedArgs }): Result<unknown> {
  const { args } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const rejected = rejectPluginOptions('list', args, ['target']);
  if (rejected !== null) return rejected;
  const loaded = loadPluginsForRead(layout);
  const index = loaded.index ?? emptyPluginIndex('');
  const state = option(args, 'state');
  if (state !== undefined && !['enabled', 'disabled', 'invalid'].includes(state)) {
    return buildResult('list', [
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: '--state',
        message: `插件状态取值非法：${state}`,
        remedy: '仅允许 enabled、disabled 或 invalid',
      }),
    ]);
  }
  const source = option(args, 'source');
  const records = index.plugins
    .filter((item) => (state === undefined ? true : item.state === state))
    .filter((item) => (source === undefined ? true : (item.source_url ?? 'local') === source))
    .map((item) => ({
      id: item.id,
      version: item.version,
      state: item.state,
      hosts: item.hosts.length,
      validation: item.validation,
    }));
  const orphaned = index.landings.filter(
    (item) =>
      item.state === 'orphaned' || !index.plugins.some((plugin) => plugin.id === item.plugin_id),
  );
  const builtinHosts = loadHostRegistry().hosts.map((host) => ({
    host_id: host.host_id,
    display_name: host.display_name,
    adapter_state: host.adapter_state,
    support_state: host.support_state,
    roots: host.roots ?? [],
  }));
  const pluginHosts = index.plugins.flatMap((plugin) =>
    plugin.hosts.map((host) => ({
      host_id: host.host_id,
      host_key: host.host_key,
      display_name: host.display_name,
      form: host.form,
      plugin_id: plugin.id,
      plugin_name: plugin.name,
      plugin_state: plugin.state,
      roots: host.roots,
      root_config: host.roots.map((root) => ({
        key: `plugin.${plugin.id}.${host.host_key}.${root.kind === 'rules' ? 'rules_root' : 'root'}`,
        scope: root.scope,
        configured:
          index.config[
            `plugin.${plugin.id}.${host.host_key}.${root.kind === 'rules' ? 'rules_root' : 'root'}`
          ] ?? null,
      })),
    })),
  );
  return buildResult('list', loaded.findings, [], {
    data: {
      kind: 'plugin',
      initialized: loaded.initialized,
      total: index.plugins.length,
      filtered: records.length,
      plugins: records,
      builtin_hosts: builtinHosts,
      plugin_hosts: pluginHosts,
      config: index.config,
      orphaned_landings: orphaned,
    },
  });
}
export function pluginInspectCommand(context: { args: ParsedArgs }): Result<unknown> {
  const { args } = context;
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('inspect', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'inspect --kind plugin 需要给出插件标识',
        remedy: '请提供已登记的插件标识',
      }),
    ]);
  }
  const loaded = loadPluginsForRead(layout);
  const record = loaded.index?.plugins.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult('inspect', [
      ...loaded.findings,
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `插件 ${id} 不在插件登记中`,
        remedy: '先用 list --kind plugin 确认插件标识',
      }),
    ]);
  }
  const inspected = inspectPluginPackage(join(layout.pluginsDir, id), TOOL_VERSION);
  return buildResult('inspect', [...loaded.findings, ...inspected.findings], [], {
    data: {
      kind: 'plugin',
      plugin: record,
      manifest: inspected.manifest,
      manifest_hash: inspected.manifest_hash,
      config: loaded.index?.config ?? {},
      root_config: record.hosts.map((host) => ({
        host_id: host.host_id,
        host_key: host.host_key,
        keys: host.roots.map((root) => {
          const key = `plugin.${id}.${host.host_key}.${root.kind === 'rules' ? 'rules_root' : 'root'}`;
          return {
            key,
            scope: root.scope,
            value: loaded.index?.config[key] ?? null,
          };
        }),
      })),
      landings: (loaded.index?.landings ?? []).filter((item) => item.plugin_id === id),
    },
  });
}
