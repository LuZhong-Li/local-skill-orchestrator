/** SKILL.md frontmatter 的 adopter 归一化；只做字段分层，不写盘。 */
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';

const OFFICIAL_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

const COMPATIBILITY_FIELDS = new Set(['author', 'version', 'trigger_keywords', 'allowed_tools']);

export interface NormalizedAdoptFrontmatter {
  skillId?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  triggerKeywords?: string[];
  findings: Finding[];
}

function textOf(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function assignDefined<T extends object>(target: T, values: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
  return target;
}

function keywordsOf(raw: Record<string, unknown>): string[] | undefined {
  const values = raw['trigger_keywords'];
  if (!Array.isArray(values)) return undefined;
  const unique = [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0 && value.length <= 32,
      ),
    ),
  ];
  return unique.length === 0 ? undefined : unique;
}

function warning(marker: string, field: string, message: string): Finding {
  return finding(CODES.FIELD_WHITELIST, {
    source: 'meta',
    target: `${marker}:${field}`,
    message,
    remedy: '该字段只读保留，不参与业务字段映射；如需使用请通过正式字段声明',
  });
}

function promotedField(
  raw: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  marker: string,
  key: 'author' | 'version',
): { value?: string; findings: Finding[] } {
  const legacy = textOf(raw, key);
  const official = metadata === undefined ? undefined : textOf(metadata, key);
  if (legacy !== undefined && official !== undefined && legacy !== official) {
    return {
      value: official,
      findings: [
        warning(
          marker,
          `metadata.${key}`,
          `metadata.${key} 与顶层 ${key} 冲突，采用 metadata 声明`,
        ),
      ],
    };
  }
  const value = official ?? legacy;
  return { ...(value === undefined ? {} : { value }), findings: [] };
}

function extensionsOf(
  raw: Record<string, unknown>,
  marker: string,
): { extensions?: Record<string, unknown>; findings: Finding[] } {
  const extensions: Record<string, unknown> = {};
  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (OFFICIAL_FIELDS.has(key) || COMPATIBILITY_FIELDS.has(key)) continue;
    extensions[key] = value;
    findings.push(warning(marker, key, `非标准字段 ${key} 已只读保留到 extensions`));
  }
  return {
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
    findings,
  };
}

export function normalizeAdoptFrontmatter(
  raw: Record<string, unknown>,
  marker: string,
): NormalizedAdoptFrontmatter {
  const metadata = recordOf(raw['metadata']);
  const author = promotedField(raw, metadata, marker, 'author');
  const version = promotedField(raw, metadata, marker, 'version');
  const extensions = extensionsOf(raw, marker);
  const allowedTools = textOf(raw, 'allowed-tools') ?? textOf(raw, 'allowed_tools');
  const triggerKeywords = keywordsOf(raw);
  const skillId = textOf(raw, 'name');
  const description = textOf(raw, 'description');
  const license = textOf(raw, 'license');
  const compatibility = textOf(raw, 'compatibility');
  return assignDefined<NormalizedAdoptFrontmatter>(
    {
      findings: [...author.findings, ...version.findings, ...extensions.findings],
    },
    {
      skillId,
      description,
      version: version.value,
      author: author.value,
      license,
      compatibility,
      allowedTools,
      metadata,
      extensions: extensions.extensions,
      triggerKeywords,
    },
  );
}
