/** 第三方 x- 宿主的盘点根枚举：与内置 inventory_roots 输出同一视图形状。 */
import { dirname, isAbsolute, resolve } from 'node:path';
import type { InventoryRootView } from '@skill-manager/contract';
import { canonicalHostId } from './manifest.ts';
import type { LoadedPluginCatalog } from './host.ts';

export interface PluginInventoryContext {
  workspaceRoot: string;
  platform?: NodeJS.Platform;
}

function rootDirectory(template: string): string {
  return dirname(template.split('<skill_id>').join('__skill__'));
}

function platformMatches(platform: string | undefined, current: string | undefined): boolean {
  return (
    platform === undefined || platform === 'any' || current === undefined || platform === current
  );
}

/** 从已加载的插件目录枚举 enabled / valid 的 x- 宿主根。 */
export function inventoryRootsForPluginCatalog(
  catalog: LoadedPluginCatalog,
  context: PluginInventoryContext,
): InventoryRootView[] {
  const views: InventoryRootView[] = [];
  for (const host of catalog.view.pluginHosts) {
    const owner = findPluginOwner(catalog, host.host_id);
    if (owner === undefined) continue;
    host.roots.forEach((root, index) => {
      const view = pluginRootView(
        host,
        root,
        index,
        owner.record.id,
        catalog.index.config,
        context,
      );
      if (view !== undefined) views.push(view);
    });
  }
  return views;
}

function findPluginOwner(
  catalog: LoadedPluginCatalog,
  hostId: string,
): LoadedPluginCatalog['entries'][number] | undefined {
  return catalog.entries.find(
    (entry) =>
      entry.manifest?.hosts.some(
        (profile) => canonicalHostId(entry.record.id, profile.host_key) === hostId,
      ) === true,
  );
}

function pluginRootView(
  host: LoadedPluginCatalog['view']['pluginHosts'][number],
  root: LoadedPluginCatalog['view']['pluginHosts'][number]['roots'][number],
  index: number,
  pluginId: string,
  config: Record<string, string>,
  context: PluginInventoryContext,
): InventoryRootView | undefined {
  if (!platformMatches(root.platform, context.platform)) return undefined;
  const base = pluginBase(root, pluginId, host.host_key, config, context.workspaceRoot);
  const directory = rootDirectory(root.path_template);
  return {
    root_id: `${host.host_id}/${root.kind}-${String(index)}`,
    host_id: host.host_id,
    host_group: 'plugin',
    role: root.scope === 'project' ? 'project' : 'user',
    kind: root.kind,
    path: base === undefined ? '' : resolve(base, directory),
    depth: 'direct',
    origin: root.scope === 'project' ? 'default' : 'config',
    consumed_by: [host.host_id],
    configured: base !== undefined,
    ...(base === undefined ? { reason: 'missing_root_config' } : {}),
  };
}

function pluginBase(
  root: LoadedPluginCatalog['view']['pluginHosts'][number]['roots'][number],
  pluginId: string,
  hostKey: string,
  config: Record<string, string>,
  workspaceRoot: string,
): string | undefined {
  if (root.scope === 'project') return workspaceRoot;
  const key = `plugin.${pluginId}.${hostKey}.${root.kind === 'rules' ? 'rules_root' : 'root'}`;
  const configured = config[key];
  if (typeof configured !== 'string' || configured.trim() === '') return undefined;
  return isAbsolute(configured) ? configured : resolve(workspaceRoot, configured);
}
