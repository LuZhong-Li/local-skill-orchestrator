/**
 * K-16 声明式插件 manifest 校验入口。
 *
 * 实现拆分为 shared / root / host / validate 四个模块；
 * 本文件只保留公共导出，调用方签名不变。
 */
export { PLUGIN_MANIFEST_VERSION, PLUGIN_API_VERSION, canonicalHostId } from './manifest-shared.ts';
export type { ManifestValidation } from './manifest-shared.ts';
export { validatePluginManifest } from './manifest-validate.ts';
