/**
 * K-16 声明式插件 manifest 校验。
 *
 * 依据 docs/specification/plugin-format.md 第 3 章。校验器只做数据校验，
 * 不读盘、不执行代码、不接触内置宿主注册表；schema 负责字段集合，
 * 本模块负责 schema 无法表达的跨字段约束（form/kind、占位符、禁用字段）。
 */
import semver from 'semver';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import type { PluginManifest } from './types.ts';

export const PLUGIN_MANIFEST_VERSION = '1' as const;
export const PLUGIN_API_VERSION = '1' as const;

export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const HOST_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const MANIFEST_KEYS = new Set([
  'manifest_version',
  'plugin_id',
  'name',
  'version',
  'description',
  'author',
  'license',
  'compatibility',
  'capabilities',
  'hosts',
  'source',
]);
export const COMPATIBILITY_KEYS = new Set(['skill_manager', 'plugin_api']);
export const HOST_KEYS = new Set([
  'host_key',
  'display_name',
  'form',
  'roots',
  'capability',
  'render_policy',
]);
export const ROOT_KEYS = new Set(['kind', 'path_template', 'scope', 'platform']);
export const CAPABILITY_KEYS = new Set(['auto_discovery', 'strict_filename']);
export const RENDER_KEYS = new Set(['field_mode', 'degrade_form']);
export const SOURCE_KEYS = new Set(['type', 'url', 'ref', 'location']);

/**
 * 安全控制与代码入口字段：任意层级出现即整插件拒绝。
 * schema 的 additionalProperties=false 已拒绝未知字段；这里额外给出明确问题。
 */
export const FORBIDDEN_KEYS = new Set([
  'security_control_evidence',
  'disable-model-invocation',
  'allowed-tools',
  'permissions',
  'requires',
  'main',
  'exports',
  'scripts',
  'dependencies',
]);

export const FORMS = new Set(['skill', 'rules', 'entry']);
export const ROOT_KINDS = new Set(['skill', 'rules']);
export const SCOPES = new Set(['project', 'global']);
export const PLATFORMS = new Set(['any', 'darwin', 'linux', 'win32']);
export const DEGRADE_FORMS = new Set(['none', 'rule_file']);

export interface ManifestValidation {
  manifest: PluginManifest | null;
  findings: Finding[];
}

/** 插件 canonical 宿主标识：内置命名空间永远不以 x- 开头。 */
export function canonicalHostId(pluginId: string, hostKey: string): string {
  return `x-${pluginId}-${hostKey}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function add(
  findings: Finding[],
  code: string,
  target: string,
  message: string,
  remedy: string,
): void {
  findings.push(finding(code, { source: 'plugin-manifest', target, message, remedy }));
}

export function checkKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  findings: Finding[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const target = path === '' ? key : `${path}.${key}`;
      add(
        findings,
        CODES.FIELD_INVALID_VALUE,
        target,
        `插件 manifest 不允许字段：${key}`,
        '删除该字段；插件只接受 plugin-format.md 登记的字段',
      );
    }
  }
}

export function findForbiddenKey(value: unknown, path = ''): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) return childPath;
    const nested = findForbiddenKey(child, childPath);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function formalVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value) && semver.valid(value) !== null;
}

export function validPathTemplate(value: string, form: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  if (segments.includes('..')) return false;
  const placeholders = [...value.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
  if (placeholders.some((name) => name !== 'skill_id')) return false;
  const count = placeholders.filter((name) => name === 'skill_id').length;
  if (form === 'entry') return count <= 1;
  return count === 1;
}
