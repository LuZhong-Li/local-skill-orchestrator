/** 宿主分发根与盘点根的跨层纯类型；不含 IO、路径展开或注册表校验。 */
export type HostRootKind = 'skill' | 'rules' | 'external';
export type HostRootRole = 'user' | 'system' | 'platform' | 'project';
export type HostRootDepth = 'direct' | 'recursive';
export type HostRootOrigin = 'default' | 'legacy' | 'config';
export type HostRootStaticOrigin = Exclude<HostRootOrigin, 'config'>;
export type HostRootBase = 'home' | 'env' | 'workspace' | 'absolute';
export type HostPlatform = 'any' | 'win32' | 'darwin' | 'linux';
export type HostAdapterForm = 'skill' | 'rules' | 'entry';

/** 分发默认根：由 defaultRootFor 读取并展开，行为与旧默认路径表等价。 */
export interface HostLandingRootDefinition {
  kind: HostRootKind;
  base: 'home' | 'env';
  path_template: string;
  env_var?: string;
  platform?: HostPlatform;
}

/** 盘点候选根：静态注册表数据；config 根由 selector 在运行时追加。 */
export interface InventoryRootDefinition {
  root_id: string;
  role: HostRootRole;
  kind: HostRootKind;
  base: HostRootBase;
  path_template: string;
  env_var?: string;
  platform?: HostPlatform;
  depth: HostRootDepth;
  /** 静态注册表只允许 default / legacy；config 由运行时 selector 追加为视图。 */
  origin: HostRootStaticOrigin;
  consumed_by?: string[];
  platform_notes?: string;
  /** macOS / Linux 等尚未真机验证的根；M4c-7 CI 探针负责补证。 */
  pending_verification?: boolean;
}

export interface InventoryRootView {
  root_id: string;
  host_id: string;
  host_group: 'builtin' | 'plugin';
  role: HostRootRole;
  kind: HostRootKind;
  path: string;
  depth: HostRootDepth;
  origin: HostRootOrigin;
  consumed_by: string[];
  configured: boolean;
  reason?: string;
  platform_notes?: string;
  pending_verification?: boolean;
}
