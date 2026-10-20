import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMetaRecord } from '../../kernel/core/metadata/validate.ts';

function baseMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'metadata-fields',
    name: 'metadata-fields',
    status: 'enabled',
    path: './skills/metadata-fields',
    source: { type: 'unknown' },
    targets: [
      {
        target: 'claude',
        scope: 'global',
        path: '.claude/skills/metadata-fields',
        mode: 'copy',
        enabled: true,
      },
    ],
    ...extra,
  };
}

const ctx = { dirName: 'metadata-fields', dirPath: '/workspace/skills/metadata-fields' };

test('T3 元数据校验：官方扩展承载字段均为合法声明', () => {
  const findings = validateMetaRecord(
    baseMeta({
      author: 'Author',
      version: '1.2.3',
      license: 'MIT',
      compatibility: 'Agent Skills',
      allowed_tools: 'Read Grep',
      metadata: { author: 'Author', version: '1.2.3', nested: { enabled: true } },
      extensions: { activation: '/metadata-fields', 'mcp-server': { command: 'example' } },
    }),
    ctx,
  );
  assert.deepEqual(findings, []);
});

test('T3 元数据校验：metadata/extensions 必须是映射，compatibility 有长度上限', () => {
  const findings = validateMetaRecord(
    baseMeta({
      compatibility: 'x'.repeat(501),
      metadata: ['not', 'a', 'map'],
      extensions: 'not-a-map',
    }),
    ctx,
  );
  assert.ok(
    findings.some((item) => item.code === 'E-FIELD-003' && item.target.endsWith('.compatibility')),
  );
  assert.ok(
    findings.some((item) => item.code === 'E-FIELD-005' && item.target.endsWith('.metadata')),
  );
  assert.ok(
    findings.some((item) => item.code === 'E-FIELD-005' && item.target.endsWith('.extensions')),
  );
});
