import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { CODES } from '../../contract/src/index.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

function loadSchema(): Record<string, unknown> {
  return JSON.parse(read('schemas/host_landings.schema.json')) as Record<string, unknown>;
}

type Validator = ((data: unknown) => boolean) & { errors?: unknown };

const validate = (() => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(loadSchema()) as unknown as Validator;
})();

function assertValid(data: unknown, hint: string): void {
  assert.equal(
    validate(data),
    true,
    `${hint} 应通过 host_landings.schema.json：${JSON.stringify(validate.errors)}`,
  );
}

function assertInvalid(data: unknown, hint: string): void {
  assert.equal(validate(data), false, `${hint} 应被 host_landings.schema.json 拒绝`);
}

function yamlExampleAfter(marker: string): unknown {
  const document = read('docs/specification/host-landings.spec.md');
  const start = document.indexOf(marker);
  assert.ok(start >= 0, `未找到章节标记：${marker}`);
  const fence = document.indexOf('```yaml', start);
  assert.ok(fence >= 0, '章节缺少 yaml 示例');
  const bodyStart = document.indexOf('\n', fence) + 1;
  const bodyEnd = document.indexOf('```', bodyStart);
  return parseYaml(document.slice(bodyStart, bodyEnd));
}

function tableFields(
  from: string,
  to: string,
  until: string,
): { names: string[]; required: string[] } {
  const document = read(`docs/specification/${from}`);
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
    names.push(name);
    if ((match[3] ?? '').trim() === '是') required.push(name);
  }
  return { names, required };
}

type Landing = Record<string, unknown>;

function primaryKey(record: Landing): string {
  return [record['skill_id'], record['host_id'], record['target_path']].join('\u0000');
}

function duplicateKeys(records: Landing[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of records) {
    const key = primaryKey(record);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

function sharedPathConflicts(records: Landing[]): string[] {
  const byPath = new Map<string, Landing[]>();
  for (const record of records) {
    const path = String(record['target_path']);
    const list = byPath.get(path) ?? [];
    list.push(record);
    byPath.set(path, list);
  }
  const conflicts: string[] = [];
  for (const [path, list] of byPath) {
    if (new Set(list.map((item) => item['skill_id'])).size > 1) {
      conflicts.push(`${path}:skill_id`);
      continue;
    }
    const active = list.filter((item) => item['state'] === 'active');
    if (
      new Set(active.map((item) => item['content_digest'])).size > 1 ||
      new Set(active.map((item) => item['visibility'])).size > 1
    ) {
      conflicts.push(`${path}:active-state`);
    }
  }
  return conflicts;
}

function landingsOf(document: unknown): Landing[] {
  if (document === null || typeof document !== 'object') return [];
  const value = (document as Record<string, unknown>)['landings'];
  return Array.isArray(value) ? (value as Landing[]) : [];
}

function hasTimeOrderViolation(records: Landing[]): boolean {
  return records.some((record) => {
    const created = record['created_at'];
    const updated = record['updated_at'];
    return typeof created === 'string' && typeof updated === 'string' && updated < created;
  });
}

/** Schema 不能表达主键唯一性与共享路径一致性，契约层在测试中补齐这两项。 */
function contractViolations(document: unknown): string[] {
  const violations: string[] = [];
  if (!validate(document)) violations.push('schema');
  const landings = landingsOf(document);
  if (duplicateKeys(landings).length > 0) violations.push('duplicate-primary-key');
  if (sharedPathConflicts(landings).length > 0) violations.push('shared-path-conflict');
  if (hasTimeOrderViolation(landings)) violations.push('time-order');
  return violations;
}

test('契约：host_landings schema 接受规范示例，拒绝字段、枚举、路径与摘要异常', () => {
  const example = yamlExampleAfter('### 11.1') as { landings: Landing[] };
  assertValid(example, '规范最小账本示例');

  const record = example.landings[0] as Landing;
  assertValid(
    {
      ...example,
      landings: [{ ...record, target_path: 'C:\\Users\\u\\.claude\\skills\\code-review' }],
    },
    'Windows 绝对路径',
  );
  assertValid({ ...example, landings: [{ ...record, unknown_note: 'kept' }] }, '未知字段保留');

  assertInvalid(
    { ...example, landings: [{ ...record, content_digest: undefined }] },
    '缺少内容摘要',
  );
  assertInvalid({ ...example, landings: [{ ...record, format: 'entry' }] }, 'entry 不是落盘形态');
  assertInvalid({ ...example, landings: [{ ...record, state: 'missing' }] }, '状态枚举非法');
  assertInvalid({ ...example, landings: [{ ...record, visibility: 'enabled' }] }, '可见性枚举非法');
  assertInvalid(
    { ...example, landings: [{ ...record, target_path: 'relative/skills/code-review' }] },
    '目标路径不是绝对路径',
  );
  assertInvalid(
    { ...example, landings: [{ ...record, content_digest: 'sha1:0123' }] },
    '摘要算法不是 sha256',
  );
  assertInvalid(
    { ...example, landings: [{ ...record, host_id: 'x-acme-zed' }] },
    '插件宿主不得写入内置账本',
  );
  assertInvalid(
    { ...example, landings: [{ ...record, root_role: 'user' }] },
    'root_role 是根属性，不得固化进账本',
  );
  assertInvalid(
    { ...example, landings: [{ ...record, host_key: 'zed' }] },
    '插件 host_key 不得写入内置账本',
  );
  assertInvalid(
    {
      ...example,
      landings: [{ ...record, format: 'rules', visibility: 'disabled' }],
    },
    '规则形态没有禁用标记',
  );
  assertInvalid(
    { ...example, landings: [{ ...record, source_version: null }] },
    '可选字符串不得写成 null',
  );
});

test('契约：host_landings 主键与共享根不变量', () => {
  const example = yamlExampleAfter('### 11.2') as { landings: Landing[] };
  assertValid(example, '共享根规范示例');
  assert.deepEqual(contractViolations(example), [], '共享根规范示例应无契约违例');

  const [codex, cursor] = example.landings as [Landing, Landing];
  assert.deepEqual(
    contractViolations({ ...example, landings: [codex, { ...codex }] }),
    ['duplicate-primary-key'],
    '同一主键必须被契约层拒绝',
  );
  assert.deepEqual(
    contractViolations({ ...example, landings: [codex, { ...cursor, visibility: 'disabled' }] }),
    ['shared-path-conflict'],
    '同一物理路径的活跃可见性必须一致',
  );
  assert.deepEqual(
    contractViolations({ ...example, landings: [codex, { ...cursor, skill_id: 'other-skill' }] }),
    ['shared-path-conflict'],
    '同一物理路径只能对应一个 Skill',
  );
  assert.deepEqual(
    contractViolations({
      ...example,
      landings: [{ ...codex, updated_at: '2026-10-17T00:00:00Z' }],
    }),
    ['time-order'],
    'updated_at 不得早于 created_at',
  );
});

test('契约：host-landings 规范字段表与 schema 逐字段一致', () => {
  const schema = loadSchema();
  const top = tableFields('host-landings.spec.md', '### 2.2 顶层字段', '### 2.3');
  assert.deepEqual(
    [...(schema['required'] as string[])].sort(),
    top.required.slice().sort(),
    '顶层必填集合应与规范一致',
  );
  assert.deepEqual(
    Object.keys(schema['properties'] as Record<string, unknown>).sort(),
    top.names.slice().sort(),
    '顶层字段集合应与规范一致',
  );

  const defs = schema['$defs'] as Record<string, Record<string, unknown>>;
  const landing = defs['landing'] as Record<string, unknown>;
  const record = tableFields('host-landings.spec.md', '### 3.1 记录字段', '### 3.2');
  assert.deepEqual(
    [...(landing['required'] as string[])].sort(),
    record.required.slice().sort(),
    '记录必填集合应与规范一致',
  );
  assert.deepEqual(
    Object.keys(landing['properties'] as Record<string, unknown>).sort(),
    record.names.slice().sort(),
    '记录字段集合应与规范一致',
  );

  const properties = landing['properties'] as Record<string, Record<string, unknown>>;
  assert.equal('root_role' in properties, false, 'root_role 是根属性，不得固化进账本');
  assert.equal('root_id' in properties, false, 'root_id 是根属性，不得固化进账本');
  assert.deepEqual(properties['visibility']?.['enum'], ['visible', 'disabled']);

  const document = read('docs/specification/host-landings.spec.md');
  assert.ok(document.includes('computeChecksum'), 'digest 必须复用既有完整性算法');
  assert.ok(document.includes('collectHashEntries'), '参与文件集合必须复用既有口径');
  assert.ok(document.includes('只做一次 SHA-256'), '聚合摘要必须只做一次哈希');
  assert.equal(
    document.includes('再对所有行按序拼接计算'),
    false,
    '不得保留逐文件再聚合的第二套算法',
  );
});

test('契约：E-LANDING 两码登记且不重叠', () => {
  assert.equal(CODES.LANDING_LEDGER_INVALID, 'E-LANDING-001');
  assert.equal(CODES.LANDING_UNINSTALL_BLOCKED, 'E-LANDING-002');

  const resultSpec = read('docs/specification/result-and-exit-codes.md');
  assert.match(resultSpec, /\|\s*`LANDING`\s*\|/);
  assert.ok(resultSpec.includes('E-LANDING-001'));
  assert.ok(resultSpec.includes('E-LANDING-002'));
  assert.match(resultSpec, /`ENV`、`LANDING`/);

  const landingSpec = read('docs/specification/host-landings.spec.md');
  assert.ok(landingSpec.includes('E-LANDING-001'));
  assert.ok(landingSpec.includes('E-LANDING-002'));
  assert.ok(landingSpec.includes('001 是「账本或绑定本身不可用」'));
  assert.ok(landingSpec.includes('002 是「账本可用且明确阻止原件卸载」'));
});
