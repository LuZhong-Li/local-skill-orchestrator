/**
 * K-16 声明式插件 manifest 校验。
 *
 * 依据 docs/specification/plugin-format.md 第 3 章。校验器只做数据校验，
 * 不读盘、不执行代码、不接触内置宿主注册表；schema 负责字段集合，
 * 本模块负责 schema 无法表达的跨字段约束（form/kind、占位符、禁用字段）。
 */
import semver from 'semver';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import type { PluginHostProfile, PluginManifest, PluginRoot, PluginSource } from './types.ts';

export const PLUGIN_MANIFEST_VERSION = '1' as const;
export const PLUGIN_API_VERSION = '1' as const;

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const MANIFEST_KEYS = new Set([
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
const COMPATIBILITY_KEYS = new Set(['skill_manager', 'plugin_api']);
const HOST_KEYS = new Set([
  'host_key',
  'display_name',
  'form',
  'roots',
  'capability',
  'render_policy',
]);
const ROOT_KEYS = new Set(['kind', 'path_template', 'scope', 'platform']);
const CAPABILITY_KEYS = new Set(['auto_discovery', 'strict_filename']);
const RENDER_KEYS = new Set(['field_mode', 'degrade_form']);
const SOURCE_KEYS = new Set(['type', 'url', 'ref', 'location']);

/**
 * 安全控制与代码入口字段：任意层级出现即整插件拒绝。
 * schema 的 additionalProperties=false 已拒绝未知字段；这里额外给出明确问题。
 */
const FORBIDDEN_KEYS = new Set([
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

const FORMS = new Set(['skill', 'rules', 'entry']);
const ROOT_KINDS = new Set(['skill', 'rules']);
const SCOPES = new Set(['project', 'global']);
const PLATFORMS = new Set(['any', 'darwin', 'linux', 'win32']);
const DEGRADE_FORMS = new Set(['none', 'rule_file']);

export interface ManifestValidation {
  manifest: PluginManifest | null;
  findings: Finding[];
}

/** 插件 canonical 宿主标识：内置命名空间永远不以 x- 开头。 */
export function canonicalHostId(pluginId: string, hostKey: string): string {
  return `x-${pluginId}-${hostKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function add(
  findings: Finding[],
  code: string,
  target: string,
  message: string,
  remedy: string,
): void {
  findings.push(finding(code, { source: 'plugin-manifest', target, message, remedy }));
}

function checkKeys(
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

function findForbiddenKey(value: unknown, path = ''): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) return childPath;
    const nested = findForbiddenKey(child, childPath);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function formalVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value) && semver.valid(value) !== null;
}

function validPathTemplate(value: string, form: string): boolean {
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

function validateRoot(
  value: unknown,
  form: string,
  path: string,
  findings: Finding[],
): PluginRoot | null {
  if (!isRecord(value)) {
    add(findings, CODES.FIELD_TYPE, path, 'roots 条目必须是对象', '按规范提供 roots 对象');
    return null;
  }
  checkKeys(value, ROOT_KEYS, path, findings);
  for (const key of ['kind', 'path_template', 'scope']) {
    if (!(key in value)) {
      add(
        findings,
        CODES.FIELD_REQUIRED,
        `${path}.${key}`,
        `roots 缺少必填字段：${key}`,
        '按 plugin-format.md 3.3 节补齐字段',
      );
    }
  }
  const kind = value['kind'];
  const scope = value['scope'];
  const template = value['path_template'];
  const platform = value['platform'];

  if (typeof kind !== 'string' || !ROOT_KINDS.has(kind)) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${path}.kind`,
      'roots.kind 取值非法',
      '仅允许 skill 或 rules',
    );
  }
  if (typeof scope !== 'string' || !SCOPES.has(scope)) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${path}.scope`,
      'roots.scope 取值非法',
      '仅允许 project 或 global',
    );
  }
  if (platform !== undefined && (typeof platform !== 'string' || !PLATFORMS.has(platform))) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${path}.platform`,
      'roots.platform 取值非法',
      '仅允许 any、darwin、linux 或 win32',
    );
  }
  if (typeof template !== 'string' || !validPathTemplate(template, form)) {
    const pathProblem =
      typeof template === 'string' &&
      (template.startsWith('/') ||
        /^[A-Za-z]:/.test(template) ||
        template.includes('\\') ||
        template.split('/').includes('..'));
    add(
      findings,
      pathProblem ? CODES.PATH_INVALID : CODES.FIELD_INVALID_VALUE,
      `${path}.path_template`,
      'path_template 非法：必须是相对路径、只允许 <skill_id> 占位符且不得越界',
      '按 plugin-format.md 3.3 节修正模板',
    );
  }
  const expectedKind = form === 'rules' || form === 'entry' ? 'rules' : 'skill';
  if (typeof kind === 'string' && ROOT_KINDS.has(kind) && kind !== expectedKind) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${path}.kind`,
      `form ${form} 只能使用 ${expectedKind} 类型的 root`,
      '让 form 与 root.kind 匹配',
    );
  }
  if (
    typeof kind !== 'string' ||
    !ROOT_KINDS.has(kind) ||
    typeof scope !== 'string' ||
    !SCOPES.has(scope) ||
    typeof template !== 'string' ||
    !validPathTemplate(template, form)
  ) {
    return null;
  }
  const result: PluginRoot = {
    kind: kind as PluginRoot['kind'],
    path_template: template,
    scope: scope as PluginRoot['scope'],
  };
  if (typeof platform === 'string')
    result.platform = platform as NonNullable<PluginRoot['platform']>;
  return result;
}

function validateHost(
  value: unknown,
  index: number,
  findings: Finding[],
): PluginHostProfile | null {
  const path = `hosts[${index}]`;
  if (!isRecord(value)) {
    add(findings, CODES.FIELD_TYPE, path, 'host profile 必须是对象', '按规范提供 host profile');
    return null;
  }
  checkKeys(value, HOST_KEYS, path, findings);
  for (const key of ['host_key', 'display_name', 'form', 'roots', 'render_policy']) {
    if (!(key in value)) {
      add(
        findings,
        CODES.FIELD_REQUIRED,
        `${path}.${key}`,
        `host profile 缺少必填字段：${key}`,
        '按 plugin-format.md 3.2 节补齐字段',
      );
    }
  }
  const hostKey = value['host_key'];
  const displayName = value['display_name'];
  const form = value['form'];
  if (typeof hostKey !== 'string' || !HOST_KEY_PATTERN.test(hostKey) || hostKey.length > 32) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${path}.host_key`,
      'host_key 不符合命名规范',
      '使用 1~32 位小写短横线标识',
    );
  }
  if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 128) {
    add(
      findings,
      CODES.FIELD_LENGTH,
      `${path}.display_name`,
      'display_name 长度不合规',
      '使用 1~128 字符的展示名称',
    );
  }
  if (typeof form !== 'string' || !FORMS.has(form)) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${path}.form`,
      'form 取值非法',
      '仅允许 skill、rules 或 entry',
    );
  }

  const roots = value['roots'];
  const validatedRoots: PluginRoot[] = [];
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 4) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${path}.roots`,
      'roots 必须是 1~4 项的数组',
      '按 plugin-format.md 3.3 节提供 roots',
    );
  } else {
    roots.forEach((root, rootIndex) => {
      const validated = validateRoot(
        root,
        typeof form === 'string' ? form : '',
        `${path}.roots[${rootIndex}]`,
        findings,
      );
      if (validated !== null) validatedRoots.push(validated);
    });
  }

  const capability = value['capability'];
  if (capability !== undefined) {
    if (!isRecord(capability)) {
      add(
        findings,
        CODES.FIELD_TYPE,
        `${path}.capability`,
        'capability 必须是对象',
        '提供布尔能力字段',
      );
    } else {
      checkKeys(capability, CAPABILITY_KEYS, `${path}.capability`, findings);
      for (const [key, item] of Object.entries(capability)) {
        if (typeof item !== 'boolean') {
          add(
            findings,
            CODES.FIELD_TYPE,
            `${path}.capability.${key}`,
            'capability 字段必须是布尔值',
            '只使用 true 或 false',
          );
        }
      }
    }
  }

  const render = value['render_policy'];
  if (!isRecord(render)) {
    add(
      findings,
      CODES.FIELD_TYPE,
      `${path}.render_policy`,
      'render_policy 必须是对象',
      '提供 field_mode',
    );
  } else {
    checkKeys(render, RENDER_KEYS, `${path}.render_policy`, findings);
    if (render['field_mode'] !== 'standard6') {
      add(
        findings,
        CODES.FIELD_INVALID_VALUE,
        `${path}.render_policy.field_mode`,
        '第三方只允许 standard6 渲染模式',
        '使用 field_mode: standard6',
      );
    }
    if (
      render['degrade_form'] !== undefined &&
      (typeof render['degrade_form'] !== 'string' || !DEGRADE_FORMS.has(render['degrade_form']))
    ) {
      add(
        findings,
        CODES.FIELD_INVALID_VALUE,
        `${path}.render_policy.degrade_form`,
        'degrade_form 取值非法',
        '仅允许 none 或 rule_file',
      );
    }
  }

  if (
    typeof hostKey !== 'string' ||
    !HOST_KEY_PATTERN.test(hostKey) ||
    hostKey.length > 32 ||
    typeof displayName !== 'string' ||
    displayName.length === 0 ||
    displayName.length > 128 ||
    typeof form !== 'string' ||
    !FORMS.has(form) ||
    validatedRoots.length === 0 ||
    !isRecord(render) ||
    render['field_mode'] !== 'standard6'
  ) {
    return null;
  }

  const result: PluginHostProfile = {
    host_key: hostKey,
    display_name: displayName,
    form: form as PluginHostProfile['form'],
    roots: validatedRoots,
    render_policy: {
      field_mode: 'standard6',
      ...(typeof render['degrade_form'] === 'string'
        ? { degrade_form: render['degrade_form'] as 'none' | 'rule_file' }
        : {}),
    },
  };
  if (isRecord(capability)) {
    result.capability = {};
    for (const [key, item] of Object.entries(capability)) {
      if (typeof item === 'boolean') {
        (result.capability as Record<string, boolean>)[key] = item;
      }
    }
  }
  return result;
}

/** 校验 manifest；任何错误级问题都会使 manifest 为 null（整插件拒绝）。 */
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
