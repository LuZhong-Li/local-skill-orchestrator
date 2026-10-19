/**
 * 声明式插件数据模型的 kernel 侧公共 barrel。
 *
 * 纯结构定义已迁至 `@skill-manager/contract`；本文件只做兼容 re-export，
 * 不含 IO、校验、渲染或指令逻辑。
 */
export type {
  HostCatalogView,
  PluginCapability,
  PluginCatalogEntry,
  PluginCompatibility,
  PluginForm,
  PluginHostProfile,
  PluginHostRecord,
  PluginIndex,
  PluginLanding,
  PluginManifest,
  PluginPlatform,
  PluginRecord,
  PluginRenderPolicy,
  PluginRoot,
  PluginRootKind,
  PluginRootScope,
  PluginSource,
  PluginState,
  PluginValidation,
} from '@skill-manager/contract';
