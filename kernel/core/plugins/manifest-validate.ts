/** 插件 manifest 顶层校验。 */
import semver from 'semver';
import { CODES, type Finding } from '@skill-manager/contract';
import type { PluginHostProfile, PluginManifest, PluginSource } from '@skill-manager/contract';
import {
  add,
  checkKeys,
  findForbiddenKey,
  formalVersion,
  isRecord,
  COMPATIBILITY_KEYS,
  MANIFEST_KEYS,
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  PLUGIN_MANIFEST_VERSION,
  SOURCE_KEYS,
  type ManifestValidation,
} from './manifest-shared.ts';
import { validateHost } from './manifest-host.ts';

export function validatePluginManifest(
  input: unknown,
  options: { toolVersion?: string } = {},
): ManifestValidation {
  const findings: Finding[] = [];
  if (!isRecord(input)) {
    add(
      findings,
      CODES.FIELD_TYPE,
      'plugin.json',
      'plugin manifest 顶层必须是对象',
      '提供合法 JSON 对象',
    );
    return { manifest: null, findings };
  }

  const forbidden = findForbiddenKey(input);
  if (forbidden !== undefined) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      forbidden,
      `插件 manifest 出现禁止字段：${forbidden.split('.').pop()}`,
      '删除代码入口与安全控制字段；第三方只能使用声明式 host profile',
    );
  }
  checkKeys(input, MANIFEST_KEYS, '', findings);

  for (const key of [
    'manifest_version',
    'plugin_id',
    'name',
    'version',
    'compatibility',
    'capabilities',
    'hosts',
  ]) {
    if (!(key in input)) {
      add(
        findings,
        CODES.FIELD_REQUIRED,
        key,
        `manifest 缺少必填字段：${key}`,
        '按 plugin-format.md 3.1 节补齐',
      );
    }
  }

  const manifestVersion = input['manifest_version'];
  if (manifestVersion !== undefined && manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    add(
      findings,
      CODES.VERSION_PLUGIN_API,
      'manifest_version',
      `不支持的 manifest 版本：${String(manifestVersion)}`,
      '仅接受 manifest_version: "1"',
    );
  }
  const pluginId = input['plugin_id'];
  if (
    typeof pluginId !== 'string' ||
    pluginId.length === 0 ||
    pluginId.length > 64 ||
    !PLUGIN_ID_PATTERN.test(pluginId)
  ) {
    add(
      findings,
      CODES.ID_PLUGIN_INVALID,
      'plugin_id',
      'plugin_id 不符合命名规范',
      '使用 1~64 位小写短横线标识',
    );
  }
  const name = input['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    add(findings, CODES.FIELD_LENGTH, 'name', 'name 长度不合规', '使用 1~128 字符的展示名称');
  }
  const textLimits: Array<[string, number]> = [
    ['description', 2048],
    ['author', 256],
    ['license', 128],
  ];
  for (const [key, limit] of textLimits) {
    const value = input[key];
    if (value !== undefined && typeof value !== 'string') {
      add(
        findings,
        CODES.FIELD_TYPE,
        key,
        `${key} 必须是字符串`,
        '按 plugin-format.md 3.1 节提供字符串',
      );
    } else if (typeof value === 'string' && value.length > limit) {
      add(findings, CODES.FIELD_LENGTH, key, `${key} 超过 ${limit} 字符上限`, '缩短展示字段');
    }
  }
  const version = input['version'];
  if (!formalVersion(version)) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      'version',
      'version 必须是 semver 正式版',
      '使用形如 1.0.0 的正式版本，不接受 prerelease',
    );
  }

  const compatibility = input['compatibility'];
  let validCompatibility = false;
  if (!isRecord(compatibility)) {
    add(
      findings,
      CODES.FIELD_TYPE,
      'compatibility',
      'compatibility 必须是对象',
      '提供 skill_manager 与 plugin_api',
    );
  } else {
    checkKeys(compatibility, COMPATIBILITY_KEYS, 'compatibility', findings);
    const range = compatibility['skill_manager'];
    const api = compatibility['plugin_api'];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      add(
        findings,
        CODES.VERSION_PLUGIN_API,
        'compatibility.skill_manager',
        'skill_manager 不是合法的 semver 范围',
        '提供合法 semver 范围，例如 >=0.2.0 <1.0.0',
      );
    } else if (options.toolVersion !== undefined && !semver.satisfies(options.toolVersion, range)) {
      add(
        findings,
        CODES.VERSION_PLUGIN_API,
        'compatibility.skill_manager',
        `当前工具版本 ${options.toolVersion} 不满足插件要求 ${range}`,
        '升级工具或安装兼容的插件版本',
      );
    }
    if (api !== PLUGIN_API_VERSION) {
      add(
        findings,
        CODES.VERSION_PLUGIN_API,
        'compatibility.plugin_api',
        `不支持的插件 API 版本：${String(api)}`,
        '仅接受 plugin_api: "1"',
      );
    }
    validCompatibility =
      typeof range === 'string' &&
      semver.validRange(range) !== null &&
      (options.toolVersion === undefined || semver.satisfies(options.toolVersion, range)) &&
      api === PLUGIN_API_VERSION;
  }

  const capabilities = input['capabilities'];
  if (
    !Array.isArray(capabilities) ||
    capabilities.length !== 1 ||
    capabilities[0] !== 'host_profile'
  ) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      'capabilities',
      '本期只允许 capabilities: ["host_profile"]',
      '删除其他能力声明',
    );
  }

  const hostsInput = input['hosts'];
  const hosts: PluginHostProfile[] = [];
  if (!Array.isArray(hostsInput) || hostsInput.length < 1 || hostsInput.length > 8) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      'hosts',
      'hosts 必须是 1~8 项的数组',
      '按 plugin-format.md 3.2 节提供 host profile',
    );
  } else {
    const seenHostKeys = new Set<string>();
    hostsInput.forEach((host, index) => {
      const validated = validateHost(host, index, findings);
      if (validated !== null) {
        if (seenHostKeys.has(validated.host_key)) {
          add(
            findings,
            CODES.FIELD_INVALID_VALUE,
            `hosts[${index}].host_key`,
            `host_key 重复：${validated.host_key}`,
            '同一插件内 host_key 必须唯一',
          );
        } else {
          seenHostKeys.add(validated.host_key);
          hosts.push(validated);
        }
      }
    });
  }

  const source = input['source'];
  if (source !== undefined) {
    if (!isRecord(source)) {
      add(findings, CODES.FIELD_TYPE, 'source', 'source 必须是对象', '提供来源审计对象');
    } else {
      checkKeys(source, SOURCE_KEYS, 'source', findings);
      if (source['type'] !== 'local' && source['type'] !== 'git' && source['type'] !== 'archive') {
        add(
          findings,
          CODES.FIELD_INVALID_VALUE,
          'source.type',
          'source.type 取值非法',
          '仅允许 local、git 或 archive',
        );
      }
      for (const key of ['url', 'ref', 'location']) {
        const value = source[key];
        if (value !== undefined && typeof value !== 'string') {
          add(
            findings,
            CODES.FIELD_TYPE,
            `source.${key}`,
            `source.${key} 必须是字符串`,
            '提供字符串形式的来源审计信息',
          );
        }
      }
    }
  }

  const hasErrors = findings.some((item) => item.severity === 'error');
  if (hasErrors) return { manifest: null, findings };

  const parsedSource = isRecord(source) ? (source as unknown as PluginSource) : undefined;
  const manifest: PluginManifest = {
    manifest_version: PLUGIN_MANIFEST_VERSION,
    plugin_id: pluginId as string,
    name: name as string,
    version: version as string,
    compatibility: {
      skill_manager: (compatibility as Record<string, string>)['skill_manager'] as string,
      plugin_api: PLUGIN_API_VERSION,
    },
    capabilities: ['host_profile'],
    hosts,
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    ...(typeof input['author'] === 'string' ? { author: input['author'] } : {}),
    ...(typeof input['license'] === 'string' ? { license: input['license'] } : {}),
    ...(parsedSource !== undefined ? { source: parsedSource } : {}),
  };
  // validCompatibility 保留为显式判定结果，避免只依赖 findings 的间接状态。
  return { manifest: validCompatibility ? manifest : null, findings };
}
