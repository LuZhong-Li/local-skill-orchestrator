import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 四份 schema 声明的是 2020-12 草案，需用对应的 Ajv 入口
import Ajv from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { run } from '../../kernel/entry/cli.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex, saveIndex } from '../../kernel/core/index/index.ts';
import { exportIndex } from '../../kernel/core/backup/index.ts';
import { createBackup } from '../../kernel/store/backup-fs/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { parseYaml as parseYamlDocument } from '../../kernel/store/yaml/index.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const NOW = '2026-10-15T00:00:00Z';

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
  const ok = validate(data);
  assert.equal(ok, true, `${hint} 应通过 ${name}：${JSON.stringify(validate.errors)}`);
}

function assertInvalid(name: string, data: unknown, hint: string): void {
  const validate = compile(name);
  assert.equal(validate(data), false, `${hint} 应被 ${name} 拒绝`);
}

/**
 * 递归收集 schema 中出现的属性名。
 * 既收集裸名，也收集点号路径，便于与规范文档里 `validation.status` 这类写法对齐。
 */
function propertyNames(
  schema: unknown,
  collected = new Set<string>(),
  prefix = '',
  root: unknown = schema,
  visited = new Set<string>(),
): Set<string> {
  if (schema === null || typeof schema !== 'object') return collected;
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, collected, prefix, root, visited);
    return collected;
  }
  const node = schema as Record<string, unknown>;
  // 解析本地引用，并沿用当前点号路径继续下钻
  const reference = node['$ref'];
  if (typeof reference === 'string' && reference.startsWith('#/')) {
    // 同一个定义在不同路径下要各记一次，因此访问标记带上当前路径前缀；
    // 同时限制下钻深度，避免自引用定义导致无限递归
    const visitKey = `${prefix}|${reference}`;
    if (visited.has(visitKey) || prefix.split('.').length > 4) return collected;
    visited.add(visitKey);
    const target = reference
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (current, segment) =>
          current === null || typeof current !== 'object'
            ? undefined
            : (current as Record<string, unknown>)[segment.replace(/~1/g, '/')],
        root,
      );
    propertyNames(target, collected, prefix, root, visited);
    return collected;
  }
  const properties = node['properties'];
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      collected.add(key);
      collected.add(`${prefix}${key}`);
      propertyNames(value, collected, `${prefix}${key}.`, root, visited);
    }
  }
  for (const key of ['items', 'allOf', 'oneOf', 'anyOf', 'if', 'then']) {
    if (key in node) propertyNames(node[key], collected, prefix, root, visited);
  }
  // $defs 是定义映射，逐个定义下钻
  for (const key of ['$defs', 'definitions']) {
    const definitions = node[key];
    if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) {
      continue;
    }
    for (const definition of Object.values(definitions as Record<string, unknown>)) {
      propertyNames(definition, collected, prefix, root, visited);
    }
  }
  return collected;
}

/**
 * 取指定章节内的字段表：返回字段名与是否需要必填。
 * 起点为 to 标记，终点默认为下一个二级标题，可用 until 收紧。
 */
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
    // 表格首列偶尔是文件名而非字段名，按扩展名排除
    if (name.endsWith('.yaml') || name.endsWith('.json')) continue;
    names.push(name);
    // 「条件必填」不是无条件必填，单列一档
    const requirement = (match[3] ?? '').trim();
    if (requirement === '是' || requirement === '必填') required.push(name);
  }
  return { names, required };
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sm-schema-'));
  mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(dir, 'backups'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '# alpha');
  writeFileSync(
    join(dir, 'skills', 'alpha', 'skill_meta.yaml'),
    [
      'id: alpha',
      'name: alpha',
      'version: 1.0.0',
      'status: enabled',
      'path: ./skills/alpha',
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/alpha',
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );
  return dir;
}

test('契约：元数据 schema 接受真实元文件，拒绝必填缺失、类型不符与枚举非法', () => {
  const dir = workspace();
  const meta = parseYaml(readFileSync(join(dir, 'skills', 'alpha', 'skill_meta.yaml'), 'utf8'));
  assertValid('skill_meta.schema.json', meta, '真实元文件');

  const missingId = { ...(meta as Record<string, unknown>) };
  delete missingId['id'];
  assertInvalid('skill_meta.schema.json', missingId, '缺少必填的标识');

  assertInvalid(
    'skill_meta.schema.json',
    { ...(meta as Record<string, unknown>), status: 'paused' },
    '启用状态枚举非法',
  );
  assertInvalid(
    'skill_meta.schema.json',
    { ...(meta as Record<string, unknown>), targets: 'none' },
    '落位目标类型不符',
  );
  assertInvalid(
    'skill_meta.schema.json',
    { ...(meta as Record<string, unknown>), id: 'Bad_Id' },
    '标识不符合命名规范',
  );
  assertInvalid(
    'skill_meta.schema.json',
    { ...(meta as Record<string, unknown>), path: 'C:/outside/alpha' },
    '落位路径为绝对路径',
  );
  assertInvalid(
    'skill_meta.schema.json',
    {
      ...(meta as Record<string, unknown>),
      targets: [
        {
          target: 'claude',
          scope: 'galaxy',
          path: '.claude/x',
          mode: 'copy',
          enabled: true,
          file_map: { 'SKILL.md': 'SKILL.md' },
        },
      ],
    },
    '作用域枚举非法',
  );
  assertInvalid(
    'skill_meta.schema.json',
    { ...(meta as Record<string, unknown>), created_at: '2026-10-15 00:00' },
    '派生区时间格式不合规',
  );
});

test('契约：索引 schema 接受真实索引，拒绝版本、结构与运行期结论异常', () => {
  const dir = workspace();
  const layout = layoutOf(dir);
  const scanned = scanWorkspace({ layout, index: createInitialIndex(NOW), now: NOW });
  saveIndex(layout.indexFile, scanned.index);
  const index = parseYaml(readFileSync(layout.indexFile, 'utf8'));
  assertValid('skill_index.schema.json', index, '真实索引');

  const record = (index as { skills: Array<Record<string, unknown>> }).skills[0] as Record<
    string,
    unknown
  >;
  assertInvalid(
    'skill_index.schema.json',
    { ...(index as Record<string, unknown>), schema_version: '2' },
    '格式版本不受支持',
  );
  assertInvalid(
    'skill_index.schema.json',
    { ...(index as Record<string, unknown>), config: {} },
    '配置区缺少必填的根目录集合',
  );
  const withoutUpdatedAt = { ...record };
  delete withoutUpdatedAt['updated_at'];
  assertInvalid(
    'skill_index.schema.json',
    { ...(index as Record<string, unknown>), skills: [withoutUpdatedAt] },
    '记录缺少必填的派生区字段',
  );
  assertInvalid(
    'skill_index.schema.json',
    {
      ...(index as Record<string, unknown>),
      skills: [{ ...record, validation: { status: 'bad', errors: [] } }],
    },
    '运行期结论取值非法',
  );
  assertInvalid(
    'skill_index.schema.json',
    {
      ...(index as Record<string, unknown>),
      skills: [
        {
          ...record,
          validation: { status: 'ok', errors: [], last_scan_at: '2026/10/15 00:00' },
        },
      ],
    },
    '最近扫描时间格式不合规',
  );
});

test('契约：结果 schema 接受真实结果，拒绝字段缺失与取值越界', async () => {
  const dir = workspace();
  assert.equal(await run(['init', '--workspace', dir]), 0);
  assert.equal(await run(['scan', '--workspace', dir]), 0);

  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run(['scan', '--workspace', dir, '--json']);
  } finally {
    process.stdout.write = original;
  }
  const result = JSON.parse(chunks.join('')) as Record<string, unknown>;
  assertValid('result.schema.json', result, '真实结果封装');

  const withoutFindings = { ...result };
  delete withoutFindings['findings'];
  assertInvalid('result.schema.json', withoutFindings, '缺少必填的问题列表');
  assertInvalid('result.schema.json', { ...result, exit_code: 9 }, '退出码越界');
  assertInvalid(
    'result.schema.json',
    {
      ...result,
      findings: [
        {
          code: 'X-ABC-001',
          severity: 'fatal',
          source: 'meta',
          target: 'a',
          message: 'm',
          remedy: 'r',
        },
      ],
    },
    '问题码与严重级别取值非法',
  );
  assertInvalid('result.schema.json', { ...result, command: '' }, '指令名为空');
});

test('契约：备份 schema 接受导出清单与备份载体清单', () => {
  const dir = workspace();
  const layout = layoutOf(dir);
  const scanned = scanWorkspace({ layout, index: createInitialIndex(NOW), now: NOW });
  saveIndex(layout.indexFile, scanned.index);
  const exported = exportIndex({
    layout,
    index: scanned.index,
    target: 'backups/snapshot.yaml',
    now: NOW,
  });
  assert.deepEqual(exported.findings, []);
  const document = parseYamlDocument(readFileSync(join(dir, 'backups', 'snapshot.yaml'), 'utf8'));
  assertValid('backup.schema.json', document, '真实导出清单');

  const backup = createBackup({
    workspaceRoot: layout.root,
    backupsDir: layout.backupsDir,
    id: 'alpha',
    sourceDir: join(dir, 'skills', 'alpha'),
    now: NOW,
    checksum: String(document['skills'] instanceof Array ? '' : ''),
  });
  const manifest = parseYamlDocument(readFileSync(join(backup.dir, 'backup_meta.yaml'), 'utf8'));
  const schema = loadSchema('backup.schema.json') as {
    $defs: Record<string, unknown>;
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  // 载体清单是同一份文件里的独立定义，直接按该定义编译
  const validateManifest = ajv.compile(schema.$defs['backupManifest'] as object);
  assert.equal(
    validateManifest(manifest),
    true,
    `备份载体清单应通过：${JSON.stringify(validateManifest.errors)}`,
  );

  const withoutSkills = { ...document };
  delete withoutSkills['skills'];
  assertInvalid('backup.schema.json', withoutSkills, '缺少必填的记录区');
  assertInvalid(
    'backup.schema.json',
    { ...document, backup_format_version: '2' },
    '备份格式版本不受支持',
  );
  assertInvalid(
    'backup.schema.json',
    {
      ...document,
      skills: [{ id: 'alpha', name: 'alpha', status: 'paused' }],
    },
    '记录枚举非法',
  );
  assertInvalid(
    'backup.schema.json',
    { ...document, skills: [{ id: 'alpha', name: 'alpha' }] },
    '记录缺少必填字段',
  );
});

test('契约：schema 的字段集与规范文档逐字段一致', () => {
  const metaDoc = tableFields('skill-meta-spec.md', '## 3.');
  const metaSchema = propertyNames(loadSchema('skill_meta.schema.json'));
  const metaMissing = metaDoc.names.filter((name) => !metaSchema.has(name));
  assert.deepEqual(
    metaMissing,
    [],
    `元数据规范声明但 schema 未覆盖的字段：${metaMissing.join('、')}`,
  );

  const indexSingle = tableFields('skill-meta-spec.md', '## 4.');
  const indexSchema = propertyNames(loadSchema('skill_index.schema.json'));
  const indexMissing = indexSingle.names.filter((name) => !indexSchema.has(name));
  assert.deepEqual(
    indexMissing,
    [],
    `索引规范声明但 schema 未覆盖的字段：${indexMissing.join('、')}`,
  );

  const resultDoc = tableFields('result-and-exit-codes.md', '### 2.1');
  const resultTop = tableFields('result-and-exit-codes.md', '### 2.1', '### 2.2');
  const resultSchema = loadSchema('result.schema.json');
  const resultSchemaNames = propertyNames(resultSchema);
  const resultMissing = resultDoc.names.filter((name) => !resultSchemaNames.has(name));
  assert.deepEqual(
    resultMissing,
    [],
    `结果规范声明但 schema 未覆盖的字段：${resultMissing.join('、')}`,
  );

  const resultRequired = (resultSchema['required'] as string[]).slice().sort();
  const documentedRequired = resultTop.required.slice().sort();
  assert.deepEqual(resultRequired, documentedRequired, '结果封装的必填集合应与规范一致');
});
