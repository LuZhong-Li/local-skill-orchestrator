import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCycles,
  validateDependencies,
  validateMetaRecord,
  validateSource,
} from '../../kernel/core/metadata/validate.ts';
import { CODES } from '@skill-manager/contract';
import type { SkillMeta } from '../../kernel/core/metadata/types.ts';

const ctx = { dirName: 'code-review', dirPath: '/ws/skills/code-review' };

function codesOf(findings: Array<{ code: string }>): string[] {
  return findings.map((item) => item.code);
}

function fullRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'code-review',
    name: 'code-review',
    status: 'enabled',
    path: './skills/code-review',
    source: { type: 'local' },
    targets: [
      {
        target: 'claude',
        scope: 'global',
        path: '.claude/skills/code-review',
        mode: 'copy',
        enabled: true,
        file_map: { 'SKILL.md': 'SKILL.md' },
      },
    ],
    ...overrides,
  };
}

test('K-01 完整且合法的记录不产生问题', () => {
  assert.deepEqual(validateMetaRecord(fullRecord(), ctx), []);
});

test('K-01 派生区字段缺失不算不合格，由内核回填', () => {
  const findings = validateMetaRecord(fullRecord(), ctx);
  assert.ok(!codesOf(findings).includes(CODES.FIELD_REQUIRED));
});

test('K-01 标识与目录名不一致被检出', () => {
  const findings = validateMetaRecord(fullRecord({ id: 'other-name' }), ctx);
  assert.deepEqual(codesOf(findings), [CODES.ID_DIR_MISMATCH]);
});

test('K-01 标识命名不合规被检出', () => {
  const findings = validateMetaRecord(fullRecord({ id: 'Code_Review' }), {
    dirName: 'Code_Review',
    dirPath: '/ws/skills/Code_Review',
  });
  assert.ok(codesOf(findings).includes(CODES.ID_INVALID));
});

test('K-01 启用状态只接受两个取值，且不承载校验结论', () => {
  const findings = validateMetaRecord(fullRecord({ status: 'invalid' }), ctx);
  assert.deepEqual(codesOf(findings), [CODES.STATUS_INVALID]);
});

test('K-01 必填字段缺失逐项报告', () => {
  const findings = validateMetaRecord({ id: 'code-review' }, ctx);
  const codes = codesOf(findings);
  for (const field of ['name', 'status', 'path', 'source', 'targets']) {
    assert.ok(
      findings.some((item) => item.code === CODES.FIELD_REQUIRED && item.target.endsWith(field)),
      `应报告缺少 ${field}`,
    );
  }
  assert.ok(codes.length >= 5);
});

test('K-01 时间格式与先后关系被校验', () => {
  assert.ok(
    codesOf(validateMetaRecord(fullRecord({ created_at: '2026-10-12 04:03:58' }), ctx)).includes(
      CODES.TIME_FORMAT,
    ),
  );
  assert.ok(
    codesOf(
      validateMetaRecord(
        fullRecord({ created_at: '2026-10-12T04:03:58Z', updated_at: '2026-10-11T04:03:58Z' }),
        ctx,
      ),
    ).includes(CODES.TIME_ORDER),
  );
});

test('K-01 描述与触发关键词的长度上限被校验', () => {
  assert.ok(
    codesOf(validateMetaRecord(fullRecord({ description: 'x'.repeat(1025) }), ctx)).includes(
      CODES.FIELD_LENGTH,
    ),
  );
  assert.ok(
    codesOf(validateMetaRecord(fullRecord({ trigger_keywords: ['k'.repeat(33)] }), ctx)).includes(
      CODES.FIELD_LENGTH,
    ),
  );
  assert.ok(
    codesOf(validateMetaRecord(fullRecord({ trigger_keywords: ['a', 'a'] }), ctx)).includes(
      CODES.FIELD_INVALID_VALUE,
    ),
  );
});

test('K-01 来源地址与引用标识的条件必填被校验', () => {
  assert.deepEqual(validateSource({ type: 'local' }, ctx), []);
  assert.deepEqual(validateSource({ type: 'unknown' }, ctx), []);
  const git = validateSource({ type: 'git' }, ctx);
  assert.equal(git.length, 2);
  assert.ok(git.every((item) => item.code === CODES.FIELD_REQUIRED));
});

test('K-01 落位目标的枚举与重复被校验', () => {
  const findings = validateMetaRecord(
    fullRecord({
      targets: [
        { target: 'claude', scope: 'world', mode: 'copy', enabled: true },
        { target: 'claude', scope: 'global', mode: 'copy', enabled: true },
      ],
    }),
    ctx,
  );
  const codes = codesOf(findings);
  assert.ok(codes.includes(CODES.FIELD_INVALID_VALUE));
});

test('K-01 内容指纹格式不合规被检出', () => {
  assert.ok(
    codesOf(validateMetaRecord(fullRecord({ checksum: 'md5:abc' }), ctx)).includes(
      CODES.HASH_FORMAT,
    ),
  );
});

function metaWithDependencies(id: string, skills: string[] = []): SkillMeta {
  return {
    id,
    name: id,
    status: 'enabled',
    path: `./skills/${id}`,
    source: { type: 'local' },
    targets: [],
    dependencies: { skills },
    created_at: '2026-10-12T04:03:58Z',
    updated_at: '2026-10-12T04:03:58Z',
    checksum: `sha256:${'0'.repeat(64)}`,
  };
}

test('K-01 依赖不存在时判定为依赖未满足', () => {
  const availability = new Map<string, boolean>([['a', true]]);
  const findings = validateDependencies([metaWithDependencies('a', ['ghost'])], availability);
  assert.deepEqual(codesOf(findings), [CODES.DEP_MISSING]);
});

test('K-01 被依赖对象校验不通过时，依赖方判为依赖未满足', () => {
  const availability = new Map<string, boolean>([
    ['a', true],
    ['b', false],
  ]);
  const findings = validateDependencies([metaWithDependencies('a', ['b'])], availability);
  assert.deepEqual(codesOf(findings), [CODES.VALIDATION_DEPENDENCY]);
});

test('K-01 依赖成环被检出', () => {
  const availability = new Map<string, boolean>([
    ['a', true],
    ['b', true],
  ]);
  const metas = [metaWithDependencies('a', ['b']), metaWithDependencies('b', ['a'])];
  const findings = validateDependencies(metas, availability);
  // 2026-10-17 内核核查批次：环在**全量图**上定死，环上每个技能各报一次（target 为自身），
  // 且环成员不再叠加 E-VALIDATION-002（根因只归一次环）
  assert.deepEqual(codesOf(findings), [CODES.DEP_CYCLE, CODES.DEP_CYCLE]);
  assert.deepEqual(
    findings.map((item) => item.target),
    ['a', 'b'],
  );
});

test('K-01 自环被检出且只报告一次', () => {
  const findings = detectCycles(new Map([['a', ['a']]]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, CODES.DEP_CYCLE);
});

test('K-01 无依赖时不成环', () => {
  assert.deepEqual(
    detectCycles(
      new Map([
        ['a', []],
        ['b', []],
      ]),
    ),
    [],
  );
});
