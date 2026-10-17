/**
 * 插件宿主清单分区：只消费内核 list --kind plugin 的数据，不推导插件状态。
 * 内置宿主与第三方 x- 宿主在界面上始终分组；disabled/invalid 插件宿主不可选。
 */
export interface HostOption {
  host_id: string;
  display_name: string;
  group: 'builtin' | 'plugin';
  plugin_id?: string;
  plugin_name?: string;
  plugin_state?: 'enabled' | 'disabled' | 'invalid';
  selectable: boolean;
  reason: string;
  config_hint: string[];
}

export interface HostPartition {
  builtin: HostOption[];
  third_party: HostOption[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function partitionPluginHosts(data: unknown): HostPartition {
  const root = recordOf(data);
  const builtinRows = Array.isArray(root?.['builtin_hosts']) ? root['builtin_hosts'] : [];
  const pluginRows = Array.isArray(root?.['plugin_hosts']) ? root['plugin_hosts'] : [];
  const builtin: HostOption[] = [];
  const thirdParty: HostOption[] = [];

  for (const value of builtinRows) {
    const row = recordOf(value);
    if (row === null || typeof row['host_id'] !== 'string') continue;
    const adapter = row['adapter_state'];
    const support = row['support_state'];
    const selectable = adapter === 'implemented' && support !== 'not_applicable';
    builtin.push({
      host_id: row['host_id'],
      display_name: typeof row['display_name'] === 'string' ? row['display_name'] : row['host_id'],
      group: 'builtin',
      selectable,
      reason: selectable
        ? ''
        : support === 'not_applicable'
          ? '不适用宿主，不提供落位'
          : '适配器尚未实现',
      config_hint: [],
    });
  }

  for (const value of pluginRows) {
    const row = recordOf(value);
    if (row === null || typeof row['host_id'] !== 'string') continue;
    const pluginState =
      row['plugin_state'] === 'enabled' ||
      row['plugin_state'] === 'disabled' ||
      row['plugin_state'] === 'invalid'
        ? row['plugin_state']
        : 'invalid';
    const hints: string[] = [];
    const roots = Array.isArray(row['roots']) ? row['roots'] : [];
    for (const rootValue of roots) {
      const rootRecord = recordOf(rootValue);
      if (rootRecord?.['scope'] !== 'global') continue;
      const key =
        rootRecord['kind'] === 'rules'
          ? `plugin.${String(row['plugin_id'])}.${String(row['host_key'])}.rules_root`
          : `plugin.${String(row['plugin_id'])}.${String(row['host_key'])}.root`;
      const config = Array.isArray(row['root_config']) ? row['root_config'] : [];
      const configured = config.some(
        (item) => recordOf(item)?.['key'] === key && recordOf(item)?.['configured'] !== null,
      );
      if (!configured) hints.push(`config set ${key} <路径>`);
    }
    const selectable = pluginState === 'enabled' && hints.length === 0;
    thirdParty.push({
      host_id: row['host_id'],
      display_name:
        typeof row['display_name'] === 'string'
          ? row['display_name']
          : typeof row['host_key'] === 'string'
            ? row['host_key']
            : row['host_id'],
      group: 'plugin',
      plugin_id: typeof row['plugin_id'] === 'string' ? row['plugin_id'] : '',
      plugin_name: typeof row['plugin_name'] === 'string' ? row['plugin_name'] : '',
      plugin_state: pluginState,
      selectable,
      reason:
        pluginState === 'disabled'
          ? '插件已停用；启用后才可选择'
          : pluginState === 'invalid'
            ? '插件校验未通过；修复并重新启用后才可选择'
            : hints.length > 0
              ? 'global 根未配置'
              : '',
      config_hint: hints,
    });
  }

  return { builtin, third_party: thirdParty };
}

/** 便于主进程单测：检查数据中是否只有合法分区。 */
export function selectableHostIds(partition: HostPartition): string[] {
  return [...partition.builtin, ...partition.third_party]
    .filter((item) => item.selectable)
    .map((item) => item.host_id)
    .sort();
}
