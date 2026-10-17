import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(read(`schemas/${name}`)) as Record<string, unknown>;
}

type Validator = ((data: unknown) => boolean) & { errors?: unknown };

function compile(name: string): Validator {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(loadSchema(name)) as unknown as Validator;
}

function assertValid(name: string, data: unknown, hint: string): void {
  const validate = compile(name);
  assert.equal(validate(data), true, `${hint} 应通过 ${name}：${JSON.stringify(validate.errors)}`);
}

function assertInvalid(name: string, data: unknown, hint: string): void {
  const validate = compile(name);
  assert.equal(validate(data), false, `${hint} 应被 ${name} 拒绝`);
}

function propertyNames(
  schema: unknown,
  collected = new Set<string>(),
  prefix = '',
  rootSchema: unknown = schema,
  visited = new Set<string>(),
): Set<string> {
  if (schema === null || typeof schema !== 'object') return collected;
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, collected, prefix, rootSchema, visited);
    return collected;
  }
  const node = schema as Record<string, unknown>;
  const reference = node['$ref'];
  if (typeof reference === 'string' && reference.startsWith('#/')) {
    const key = `${prefix}|${reference}`;
    if (visited.has(key) || prefix.split('.').length > 5) return collected;
    visited.add(key);
    const target = reference
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (current, segment) =>
          current === null || typeof current !== 'object'
            ? undefined
            : (current as Record<string, unknown>)[segment.replace(/~1/g, '/')],
        rootSchema,
      );
    propertyNames(target, collected, prefix, rootSchema, visited);
    return collected;
  }
  const properties = node['properties'];
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      collected.add(key);
      collected.add(`${prefix}${key}`);
      propertyNames(value, collected, `${prefix}${key}.`, rootSchema, visited);
    }
  }
  for (const key of ['items', 'allOf', 'oneOf', 'anyOf', 'if', 'then']) {
    if (key in node) propertyNames(node[key], collected, prefix, rootSchema, visited);
  }
  const definitions = node['$defs'];
  if (definitions !== null && typeof definitions === 'object' && !Array.isArray(definitions)) {
    for (const value of Object.values(definitions as Record<string, unknown>)) {
      propertyNames(value, collected, prefix, rootSchema, visited);
    }
  }
  return collected;
}

function tableFields(
  from: string,
  to: string,
  until = '\n## ',
): { names: string[]; required: string[] } {
  const document = read('docs/specification/' + from);
  const start = document.indexOf(to);
  assert.ok(start >= 0, `未找到章节标记：${to}`);
  const end = document.indexOf(until, start + to.length);
  const section = document.slice(start, end < 0 ? document.length : end);
  const names: string[] = [];
  const required: string[] = [];
  for (const line of section.split('\n')) {
    const match = /^\|\s*`([A-Za-z_][A-Za-z0-9_.]*)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (match === null) continue;
    const name = match[1] as string;
    if (name.endsWith('.yaml') || name.endsWith('.json')) continue;
    names.push(name);
    const requirement = (match[3] ?? '').trim();
    if (requirement === '是') required.push(name);
  }
  return { names, required };
}

function jsonExampleAfter(marker: string): unknown {
  const document = read('docs/specification/plugin-format.md');
  const start = document.indexOf(marker);
  assert.ok(start >= 0, `未找到章节标记：${marker}`);
  const fence = document.indexOf('```json', start);
  assert.ok(fence >= 0, '章节缺少 json 示例');
  const bodyStart = document.indexOf('\n', fence) + 1;
  const bodyEnd = document.indexOf('```', bodyStart);
  return JSON.parse(document.slice(bodyStart, bodyEnd));
}

function yamlExampleAfter(marker: string): unknown {
  const document = read('docs/specification/plugin-format.md');
  const start = document.indexOf(marker);
  assert.ok(start >= 0, `未找到章节标记：${marker}`);
  const fence = document.indexOf('```yaml', start);
  assert.ok(fence >= 0, '章节缺少 yaml 示例');
  const bodyStart = document.indexOf('\n', fence) + 1;
  const bodyEnd = document.indexOf('```', bodyStart);
  return parseYaml(document.slice(bodyStart, bodyEnd));
}

test('契约：plugin manifest schema 接受规范示例并拒绝代码/安全字段', () => {
  const example = jsonExampleAfter('## 9.');
  assertValid('plugin_manifest.schema.json', example, '规范 manifest 示例');

  const document = example as Record<string, unknown>;
  assertInvalid('plugin_manifest.schema.json', { ...document, main: 'index.js' }, '代码入口字段');
  assertInvalid(
    'plugin_manifest.schema.json',
    {
      ...document,
      hosts: [
        {
          ...((document['hosts'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>),
          security_control_evidence: {},
        },
      ],
    },
    '安全控制字段',
  );
  assertInvalid(
    'plugin_manifest.schema.json',
    {
      ...document,
      compatibility: { skill_manager: '>=0.2.0', plugin_api: '2' },
    },
    '不支持的插件 API 版本',
  );
});

test('契约：plugin_index schema 接受规范示例，拒绝状态/哈希异常', () => {
  const example = yamlExampleAfter('### 4.5');
  assertValid('plugin_index.schema.json', example, '规范插件索引示例');

  const document = example as Record<string, unknown>;
  const plugins = document['plugins'] as Array<Record<string, unknown>>;
  assertInvalid(
    'plugin_index.schema.json',
    {
      ...document,
      plugins: [{ ...plugins[0], state: 'active' }],
    },
    '插件状态枚举非法',
  );
  assertInvalid(
    'plugin_index.schema.json',
    {
      ...document,
      plugins: [{ ...plugins[0], manifest_hash: 'md5:abc' }],
    },
    'manifest 哈希格式非法',
  );
  assertValid(
    'plugin_index.schema.json',
    {
      ...document,
      plugins: [{ ...plugins[0], extension_flag: 'kept' }],
    },
    '插件记录未知字段保留',
  );
});

test('契约：插件规范字段表与两份 schema 逐字段一致', () => {
  const manifestSchema = loadSchema('plugin_manifest.schema.json');
  const manifestNames = propertyNames(manifestSchema);
  const manifestTop = tableFields('plugin-format.md', '### 3.1 顶层字段', '#### 3.1.1');
  const manifestMissing = manifestTop.names.filter((name) => !manifestNames.has(name));
  assert.deepEqual(
    manifestMissing,
    [],
    `manifest 规范声明但 schema 未覆盖的字段：${manifestMissing.join('、')}`,
  );
  assert.deepEqual(
    (manifestSchema['required'] as string[]).slice().sort(),
    manifestTop.required.slice().sort(),
    'manifest 顶层必填集合应与规范一致',
  );

  const indexSchema = loadSchema('plugin_index.schema.json');
  const indexNames = propertyNames(indexSchema);
  const indexTop = tableFields('plugin-format.md', '### 4.1 顶层字段', '### 4.2');
  const indexMissing = indexTop.names.filter((name) => !indexNames.has(name));
  assert.deepEqual(
    indexMissing,
    [],
    `插件索引规范声明但 schema 未覆盖的字段：${indexMissing.join('、')}`,
  );
  assert.deepEqual(
    (indexSchema['required'] as string[]).slice().sort(),
    indexTop.required.slice().sort(),
    '插件索引顶层必填集合应与规范一致',
  );

  const defs = indexSchema['$defs'] as Record<string, Record<string, unknown>>;
  const recordDef = defs['pluginRecord'] as Record<string, unknown>;
  const recordDoc = tableFields('plugin-format.md', '### 4.2 插件记录', '### 4.3');
  const recordMissing = recordDoc.names.filter((name) => !indexNames.has(name));
  assert.deepEqual(recordMissing, [], `插件记录字段未覆盖：${recordMissing.join('、')}`);
  assert.deepEqual(
    (recordDef['required'] as string[]).slice().sort(),
    recordDoc.required.slice().sort(),
    '插件记录必填集合应与规范一致',
  );
});
