import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_API_VERSION, PLUGIN_MANIFEST_VERSION } from '../../kernel/core/plugins/manifest.ts';
import type { PluginManifest } from '../../contract/src/index.ts';
import { makeTempDir } from './temp.ts';

export interface PluginManifestOptions {
  /** 写动作测试使用 global 作用域根（映射为 user 角色）；默认仍为 project。 */
  scope?: 'global' | 'project';
}

export function makePluginManifest(
  patch: Partial<PluginManifest> = {},
  options: PluginManifestOptions = {},
): PluginManifest {
  const scope = options.scope ?? 'project';
  return {
    manifest_version: PLUGIN_MANIFEST_VERSION,
    plugin_id: 'acme-tools',
    name: 'Acme Tools',
    version: '1.0.0',
    compatibility: {
      skill_manager: '>=0.2.0 <1.0.0',
      plugin_api: PLUGIN_API_VERSION,
    },
    capabilities: ['host_profile'],
    hosts: [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'rules',
        roots: [
          {
            kind: 'rules',
            path_template: scope === 'global' ? '<skill_id>.md' : '.zed/rules/<skill_id>.md',
            scope,
          },
        ],
        render_policy: { field_mode: 'standard6' },
      },
    ],
    ...patch,
  } as PluginManifest;
}

export function makePluginDir(prefix = 'sm-plugin-'): string {
  return makeTempDir(prefix);
}

export function writePluginManifest(
  dir: string,
  patch: Partial<PluginManifest> = {},
  options: PluginManifestOptions = {},
): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'plugin.json');
  writeFileSync(target, `${JSON.stringify(makePluginManifest(patch, options), null, 2)}\n`);
  return target;
}
