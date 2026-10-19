/** 内置宿主盘点根枚举：只把注册表数据展开为统一视图，不访问文件系统。 */
import { isAbsolute, join, resolve } from 'node:path';
import { hostById, hostIds } from './index.ts';
import type { HostEntry } from './types.ts';
import type {
  InventoryRootDefinition,
  InventoryRootView,
  HostRootKind,
} from '@skill-manager/contract';

export interface InventoryRootContext {
  workspaceRoot: string;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  config?: Record<string, unknown>;
}

function platformMatches(root: InventoryRootDefinition, platform: string): boolean {
  return root.platform === undefined || root.platform === 'any' || root.platform === platform;
}

function expandRoot(
  root: InventoryRootDefinition,
  context: InventoryRootContext,
): { path: string; configured: boolean; reason?: string } {
  if (root.base === 'home') {
    return context.home === ''
      ? { path: '', configured: false, reason: 'missing_home' }
      : { path: join(context.home, ...root.path_template.split('/')), configured: true };
  }
  if (root.base === 'env') {
    const base = context.env[root.env_var ?? ''];
    return base === undefined || base === ''
      ? { path: '', configured: false, reason: 'missing_environment' }
      : { path: join(base, ...root.path_template.split('/')), configured: true };
  }
  if (root.base === 'workspace') {
    return {
      path: join(context.workspaceRoot, ...root.path_template.split('/')),
      configured: true,
    };
  }
  return isAbsolute(root.path_template)
    ? { path: root.path_template, configured: true }
    : { path: '', configured: false, reason: 'not_absolute' };
}

function staticRootView(
  hostId: string,
  root: InventoryRootDefinition,
  context: InventoryRootContext,
): InventoryRootView {
  const expanded = expandRoot(root, context);
  return {
    root_id: root.root_id,
    host_id: hostId,
    host_group: 'builtin',
    role: root.role,
    kind: root.kind,
    path: expanded.path,
    depth: root.depth,
    origin: root.origin,
    consumed_by: [...(root.consumed_by ?? [hostId])],
    configured: expanded.configured,
    ...(expanded.reason === undefined ? {} : { reason: expanded.reason }),
    ...(root.platform_notes === undefined ? {} : { platform_notes: root.platform_notes }),
    ...(root.pending_verification === undefined
      ? {}
      : { pending_verification: root.pending_verification }),
  };
}

function configRootKind(entry: HostEntry, key: string): HostRootKind {
  if (key.endsWith('.rules_root')) return 'rules';
  return entry.landing_roots?.[0]?.kind ?? entry.roots?.[0]?.kind ?? 'skill';
}

function configDepth(entry: HostEntry, kind: HostRootKind): 'direct' | 'recursive' {
  return entry.inventory_roots?.find((item) => item.kind === kind)?.depth ?? 'direct';
}

function configRoots(entry: HostEntry, context: InventoryRootContext): InventoryRootView[] {
  const config = context.config ?? {};
  const views: InventoryRootView[] = [];
  for (const [suffix, key] of [
    ['root', `host.${entry.host_id}.root`],
    ['rules_root', `host.${entry.host_id}.rules_root`],
  ] as const) {
    const value = config[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const kind = configRootKind(entry, key);
    const path = isAbsolute(value) ? value : resolve(context.workspaceRoot, value);
    views.push({
      root_id: `${entry.host_id}/config-${suffix}`,
      host_id: entry.host_id,
      host_group: 'builtin',
      role: 'user',
      kind,
      path,
      depth: configDepth(entry, kind),
      origin: 'config',
      consumed_by: [entry.host_id],
      configured: true,
    });
  }
  return views;
}

/** 一个内置宿主的全部盘点根：静态候选 + config 覆盖。 */
export function inventoryRootsForHost(
  hostId: string,
  context: InventoryRootContext,
): InventoryRootView[] {
  const entry = hostById(hostId);
  if (entry === undefined || entry.support_state === 'not_applicable') return [];
  const staticViews = (entry.inventory_roots ?? [])
    .filter((root) => platformMatches(root, context.platform))
    .map((root) => staticRootView(hostId, root, context));
  return [...staticViews, ...configRoots(entry, context)];
}

/** 全部内置宿主的盘点根；不读取目录、不判断存在性。 */
export function inventoryRootsForAll(context: InventoryRootContext): InventoryRootView[] {
  return hostIds().flatMap((hostId) => inventoryRootsForHost(hostId, context));
}
