import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_API_VERSION, PLUGIN_MANIFEST_VERSION } from '../../kernel/core/plugins/manifest.ts';
import type { PluginManifest } from '../../contract/src/index.ts';
import { makeTempDir } from './temp.ts';

export function makePluginManifest(patch: Partial<PluginManifest> = {}): PluginManifest {
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
            path_template: '.zed/rules/<skill_id>.md',
            scope: 'project',
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

export function writePluginManifest(dir: string, patch: Partial<PluginManifest> = {}): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'plugin.json');
  writeFileSync(target, `${JSON.stringify(makePluginManifest(patch), null, 2)}\n`);
  return target;
}
