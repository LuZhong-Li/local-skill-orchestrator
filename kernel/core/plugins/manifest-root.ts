/** 插件 root 校验。 */
import { CODES, type Finding } from '@skill-manager/contract';
import type { PluginRoot } from '@skill-manager/contract';
import {
  add,
  checkKeys,
  isRecord,
  validPathTemplate,
  PLATFORMS,
  ROOT_KEYS,
  ROOT_KINDS,
  SCOPES,
} from './manifest-shared.ts';

export function validateRoot(
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
