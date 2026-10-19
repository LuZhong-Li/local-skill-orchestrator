/** 插件 host profile 校验。 */
import { CODES, type Finding } from '../../store/contract.ts';
import type { PluginHostProfile, PluginRoot } from './types.ts';
import {
  add,
  checkKeys,
  isRecord,
  CAPABILITY_KEYS,
  DEGRADE_FORMS,
  FORMS,
  HOST_KEYS,
  HOST_KEY_PATTERN,
  RENDER_KEYS,
} from './manifest-shared.ts';
import { validateRoot } from './manifest-root.ts';

export function validateHost(
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
