/**
 * K-16 插件登记记录构造。
 *
 * 只把已校验 manifest 转成插件索引记录；默认 disabled，不启用、不落位、不读盘。
 */
import { canonicalHostId } from './manifest.ts';
import type { PluginManifest, PluginRecord, PluginState } from './types.ts';

export function createPluginRecord(input: {
  manifest: PluginManifest;
  manifestPath: string;
  manifestHash: string;
  now: string;
  state?: PluginState;
  sourceUrl?: string;
  sourceRef?: string;
}): PluginRecord {
  return {
    id: input.manifest.plugin_id,
    kind: 'plugin',
    name: input.manifest.name,
    version: input.manifest.version,
    capabilities: ['host_profile'],
    compatibility: { ...input.manifest.compatibility },
    manifest_path: input.manifestPath,
    manifest_hash: input.manifestHash,
    hosts: input.manifest.hosts.map((profile) => ({
      host_id: canonicalHostId(input.manifest.plugin_id, profile.host_key),
      host_key: profile.host_key,
      display_name: profile.display_name,
      form: profile.form,
      roots: profile.roots.map((root) => ({
        kind: root.kind,
        path_template: root.path_template,
        scope: root.scope,
        ...(root.platform !== undefined ? { platform: root.platform } : {}),
      })),
      render_policy: {
        field_mode: profile.render_policy.field_mode,
        ...(profile.render_policy.degrade_form !== undefined
          ? { degrade_form: profile.render_policy.degrade_form }
          : {}),
      },
      ...(profile.capability !== undefined ? { capability: { ...profile.capability } } : {}),
    })),
    state: input.state ?? 'disabled',
    validation: { status: 'ok', errors: [] },
    installed_at: input.now,
    updated_at: input.now,
    ...(input.manifest.description !== undefined
      ? { description: input.manifest.description }
      : {}),
    ...(input.manifest.author !== undefined ? { author: input.manifest.author } : {}),
    ...(input.manifest.license !== undefined ? { license: input.manifest.license } : {}),
    ...(input.sourceUrl !== undefined ? { source_url: input.sourceUrl } : {}),
    ...(input.sourceRef !== undefined ? { source_ref: input.sourceRef } : {}),
  };
}
