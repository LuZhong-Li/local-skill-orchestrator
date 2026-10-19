/** 内置宿主分发账本的纯结构类型；不含 IO、校验或生命周期逻辑。 */
export type HostLandingFormat = 'skill' | 'rules';
export type HostLandingVisibility = 'visible' | 'disabled';
export type HostLandingState = 'active' | 'orphaned';
export type HostLandingOrigin = 'distributed' | 'adopted';

export interface HostLanding {
  skill_id: string;
  source_version?: string;
  source_ref?: string;
  host_id: string;
  target_path: string;
  format: HostLandingFormat;
  visibility: HostLandingVisibility;
  state: HostLandingState;
  origin: HostLandingOrigin;
  source_checksum: string;
  content_digest: string;
  adapter_ref: string;
  registry_version: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface HostLandingIndex {
  schema_version: '1';
  tool_version: string;
  generated_at: string;
  landings: HostLanding[];
  [key: string]: unknown;
}
