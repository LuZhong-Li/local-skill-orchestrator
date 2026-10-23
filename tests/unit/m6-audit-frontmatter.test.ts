import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostRootRole } from '@skill-manager/contract';
import {
  compareFrontmatterGroup,
  type AuditFrontmatterCopy,
} from '../../kernel/audit/audit-frontmatter.ts';

function copy(
  host: string,
  frontmatter: Record<string, unknown> | null = {
    name: 'demo',
    description: 'demo',
  },
  role: HostRootRole = 'user',
  checksumMatches?: boolean,
): AuditFrontmatterCopy {
  return {
    skill_id: 'demo',
    host_id: host,
    root_role: role,
    copy_path: `/${host}/skills/demo`,
    frontmatter,
    ...(checksumMatches === undefined ? {} : { checksum_matches: checksumMatches }),
  };
}

test('M6 drift：单副本不比较也不报 drift', () => {
  const result = compareFrontmatterGroup([copy('one')]);

  assert.equal(result.comparable, false);
  assert.equal(result.drift_subtype, undefined);
  assert.deepEqual(result.frontmatter_diffs, []);
  assert.equal(result.version_diff, undefined);
});

test('M6 drift：frontmatter name 与 workspace skill_id 不一致时命中 name', () => {
  const result = compareFrontmatterGroup([
    copy('claude', { name: 'demo', description: 'same' }),
    copy('codex', { name: 'renamed', description: 'same' }),
  ]);

  assert.equal(result.comparable, true);
  assert.deepEqual(result.frontmatter_diffs, [
    {
      field: 'name',
      values: [
        { host: 'claude', role: 'user', value: 'demo' },
        { host: 'codex', role: 'user', value: 'renamed' },
      ],
    },
  ]);
  assert.equal(result.drift_subtype, 'frontmatter');
});

test('M6 drift：description 组内不一致时列出全部有效值', () => {
  const result = compareFrontmatterGroup([
    copy('claude', { name: 'demo', description: 'A' }),
    copy('codex', { name: 'demo', description: 'B' }),
  ]);

  assert.deepEqual(result.frontmatter_diffs, [
    {
      field: 'description',
      values: [
        { host: 'claude', role: 'user', value: 'A' },
        { host: 'codex', role: 'user', value: 'B' },
      ],
    },
  ]);
  assert.equal(result.drift_subtype, 'frontmatter');
});

test('M6 drift：version 回退 metadata.version，等值不报 drift', () => {
  const result = compareFrontmatterGroup([
    copy('claude', {
      name: 'demo',
      description: 'same',
      metadata: { version: '1.0.0' },
    }),
    copy('codex', { name: 'demo', description: 'same', version: '1.0.0' }),
  ]);

  assert.equal(result.version_diff, undefined);
  assert.equal(result.drift_subtype, undefined);
  assert.equal(result.metadata_incomplete, false);
});

test('M6 drift：一个有 version、一个缺失时命中 version', () => {
  const result = compareFrontmatterGroup([
    copy('claude', { name: 'demo', description: 'same', version: '1.0.0' }),
    copy('codex', { name: 'demo', description: 'same' }),
  ]);

  assert.deepEqual(result.version_diff, {
    values: [
      { host: 'claude', role: 'user', version: '1.0.0' },
      { host: 'codex', role: 'user', version: null },
    ],
  });
  assert.equal(result.drift_subtype, 'version');
  assert.equal(result.metadata_incomplete, false);
});

test('M6 drift：全部 version 缺失只降级 note，不报 version drift', () => {
  const result = compareFrontmatterGroup([
    copy('claude', { name: 'demo', description: 'same' }),
    copy('codex', { name: 'demo', description: 'same' }),
  ]);

  assert.equal(result.version_diff, undefined);
  assert.equal(result.drift_subtype, undefined);
  assert.equal(result.metadata_incomplete, true);
});

test('M6 drift：checksum 不一致优先，且不再重复比较 frontmatter/version', () => {
  const result = compareFrontmatterGroup([
    copy('claude', { name: 'demo', description: 'A', version: '1.0.0' }, 'user', true),
    copy('codex', { name: 'renamed', description: 'B', version: '2.0.0' }, 'user', false),
  ]);

  assert.equal(result.drift_subtype, 'checksum');
  assert.deepEqual(result.frontmatter_diffs, []);
  assert.equal(result.version_diff, undefined);
  assert.equal(result.metadata_incomplete, false);
});
