import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostRootRole, ReconciliationOutput } from '@skill-manager/contract';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';
import type { Candidate } from '../../kernel/dispatch/reconcile/candidate-model.ts';
import {
  bulkAdoptCandidates,
  resolveAdoptConflict,
} from '../../kernel/dispatch/reconcile/adopt-bulk.ts';

function reconciliation(
  classification: ReconciliationOutput['classification'],
): ReconciliationOutput {
  return {
    classification,
    ledger_source: 'none',
    authority: 'insufficient',
    evidence: {
      managed: 'insufficient',
      content: 'insufficient',
      source: 'insufficient',
    },
    reasons: [],
    drift_reasons: [],
    untracked_candidate: classification === 'untracked',
  };
}

function candidate(input: {
  key: string;
  skillId: string;
  host: string;
  role?: HostRootRole;
  classification?: ReconciliationOutput['classification'];
}): Candidate {
  return {
    physical_key: input.key,
    target_path: `/hosts/${input.host}/${input.skillId}`,
    host_ids: [input.host],
    consumed_by: [input.host],
    format: 'skill',
    skill_id: input.skillId,
    exists: true,
    root_ids: [`${input.host}-root`],
    root_roles: [input.role ?? 'user'],
    reconciliation: reconciliation(input.classification ?? 'untracked'),
    is_plugin: false,
    format_conflict: false,
    ledger_conflict: false,
  };
}

function indexWithChecksum(id: string, checksum: string): SkillIndex {
  return {
    schema_version: '1',
    tool_version: '0.6.0',
    generated_at: '2026-10-23T00:00:00Z',
    config: { skill_roots: ['./skills'] },
    skills: [
      {
        id,
        name: id,
        status: 'enabled',
        path: `./skills/${id}`,
        source_type: 'unknown',
        targets: [],
        created_at: '2026-10-23T00:00:00Z',
        updated_at: '2026-10-23T00:00:00Z',
        checksum,
        validation: { status: 'ok', errors: [] },
      },
    ],
  };
}

test('M6 bulk：只选 adoptable，按角色过滤、物理键去重后稳定排序并 limit', () => {
  const candidates = [
    candidate({ key: 'b', skillId: 'z-skill', host: 'codex' }),
    candidate({ key: 'a', skillId: 'a-skill', host: 'codex' }),
    candidate({ key: 'a', skillId: 'a-skill', host: 'codex' }),
    candidate({
      key: 'sys',
      skillId: 'system-skill',
      host: 'claude',
      role: 'system',
    }),
    candidate({
      key: 'tracked',
      skillId: 'tracked-skill',
      host: 'claude',
      classification: 'managed_consistent',
    }),
  ];

  const selected = bulkAdoptCandidates(candidates, {
    enabled: true,
    roles: ['user'],
    limit: 2,
    conflict: 'skip',
    dry_run: false,
  });

  assert.deepEqual(
    selected.map((item) => `${item.skill_id}:${item.host_ids[0]}`),
    ['a-skill:codex', 'z-skill:codex'],
  );
});

test('M6 bulk：显式非 user 角色仍进入候选，由既有写保护跳过', () => {
  const selected = bulkAdoptCandidates(
    [
      candidate({
        key: 'sys',
        skillId: 'system-skill',
        host: 'claude',
        role: 'system',
      }),
    ],
    {
      enabled: true,
      roles: ['system'],
      conflict: 'skip',
      dry_run: false,
    },
  );

  assert.equal(selected[0]?.root_roles[0], 'system');
});

test('M6 conflict：workspace 同 ID 内容一致时返回 same_content', () => {
  const resolved = resolveAdoptConflict({
    requestedId: 'demo',
    sourceDigest: 'sha256:same',
    index: indexWithChecksum('demo', 'sha256:same'),
    reservedIds: new Set(),
    policy: 'skip',
  });

  assert.deepEqual(resolved, { targetId: 'demo', conflict: 'same_content' });
});

test('M6 conflict：默认策略对内容不同返回 different_content', () => {
  const resolved = resolveAdoptConflict({
    requestedId: 'demo',
    sourceDigest: 'sha256:new',
    index: indexWithChecksum('demo', 'sha256:old'),
    reservedIds: new Set(),
    policy: 'skip',
  });

  assert.deepEqual(resolved, { targetId: 'demo', conflict: 'different_content' });
});

test('M6 conflict：rename 跳过已占用和后缀序号，force 保持同 ID', () => {
  const renamed = resolveAdoptConflict({
    requestedId: 'demo',
    sourceDigest: 'sha256:new',
    index: {
      ...indexWithChecksum('demo', 'sha256:old'),
      skills: [
        ...indexWithChecksum('demo', 'sha256:old').skills,
        ...indexWithChecksum('demo-2', 'sha256:old-two').skills,
      ],
    },
    reservedIds: new Set(['demo-3']),
    policy: 'rename',
  });
  const forced = resolveAdoptConflict({
    requestedId: 'demo',
    sourceDigest: 'sha256:new',
    index: indexWithChecksum('demo', 'sha256:old'),
    reservedIds: new Set(),
    policy: 'force',
  });

  assert.deepEqual(renamed, { targetId: 'demo-4', conflict: 'different_content' });
  assert.deepEqual(forced, { targetId: 'demo', conflict: 'different_content' });
});

test('M6 conflict：同批次已预留 ID 时默认跳过，rename 继续找下一个', () => {
  const skipped = resolveAdoptConflict({
    requestedId: 'demo',
    sourceDigest: 'sha256:same',
    index: indexWithChecksum('other', 'sha256:other'),
    reservedIds: new Set(['demo']),
    policy: 'skip',
  });
  const renamed = resolveAdoptConflict({
    requestedId: 'demo',
    sourceDigest: 'sha256:same',
    index: indexWithChecksum('other', 'sha256:other'),
    reservedIds: new Set(['demo']),
    policy: 'rename',
  });

  assert.deepEqual(skipped, { targetId: 'demo', conflict: 'same_content' });
  assert.deepEqual(renamed, { targetId: 'demo-2', conflict: 'different_content' });
});
