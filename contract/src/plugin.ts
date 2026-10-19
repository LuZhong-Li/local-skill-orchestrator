/** 声明式插件的数据模型；只含纯结构类型，不含 IO / 校验 / 渲染逻辑。 */
import type { Finding } from './result.ts';

export type PluginState = 'disabled' | 'enabled' | 'invalid';
export type PluginForm = 'skill' | 'rules' | 'entry';
export type PluginRootKind = 'skill' | 'rules';
export type PluginRootScope = 'project' | 'global';
export type PluginPlatform = 'any' | 'darwin' | 'linux' | 'win32';

export interface PluginCompatibility {
  skill_manager: string;
  plugin_api: string;
}

export interface PluginRoot {
  kind: PluginRootKind;
  path_template: string;
  scope: PluginRootScope;
  platform?: PluginPlatform;
}

export interface PluginCapability {
  auto_discovery?: boolean;
  strict_filename?: boolean;
}

export interface PluginRenderPolicy {
  field_mode: 'standard6';
  degrade_form?: 'none' | 'rule_file';
}

export interface PluginHostProfile {
  host_key: string;
  display_name: string;
  form: PluginForm;
  roots: PluginRoot[];
  capability?: PluginCapability;
  render_policy: PluginRenderPolicy;
}

export interface PluginSource {
  type: 'local' | 'git' | 'archive';
  url?: string;
  ref?: string;
  location?: string;
}

export interface PluginManifest {
  manifest_version: '1';
  plugin_id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  compatibility: PluginCompatibility;
  capabilities: ['host_profile'];
  hosts: PluginHostProfile[];
  source?: PluginSource;
}

export interface PluginHostRecord extends PluginHostProfile {
  host_id: string;
}

export interface PluginValidation {
  status: 'ok' | 'invalid';
  errors: string[];
  last_scan_at?: string;
}

export interface PluginRecord {
  id: string;
  kind: 'plugin';
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  capabilities: ['host_profile'];
  compatibility: PluginCompatibility;
  source_url?: string;
  source_ref?: string;
  manifest_path: string;
  manifest_hash: string;
  hosts: PluginHostRecord[];
  state: PluginState;
  validation: PluginValidation;
  installed_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/** 插件宿主副本账本：独立于插件记录留存，卸载后仍可追踪孤儿副本。 */
export interface PluginLanding {
  plugin_id: string;
  skill_id: string;
  host_id: string;
  host_key: string;
  /** 实际写入路径；工作区外为绝对路径，工作区内也统一记录为绝对路径。 */
  target_path: string;
  state: 'active' | 'orphaned';
  created_at: string;
  updated_at: string;
}

export interface PluginIndex {
  schema_version: '1';
  tool_version: string;
  generated_at: string;
  config: Record<string, string>;
  plugins: PluginRecord[];
  landings: PluginLanding[];
  [key: string]: unknown;
}

export interface PluginCatalogEntry {
  record: PluginRecord;
  /** 校验通过的 manifest；null 表示该插件不加载 */
  manifest: PluginManifest | null;
  findings?: Finding[];
}

export interface HostCatalogView {
  builtinHostIds: string[];
  pluginHosts: PluginHostRecord[];
  hostIds: string[];
  findings: Finding[];
}
