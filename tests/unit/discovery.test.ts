import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { CODES } from '../../kernel/store/contract.ts';

const NOW = '2026-10-14T00:00:00Z';
const LATER = '2026-10-14T01:00:00Z';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-scan-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  return root;
}

function putSkill(root: string, dir: string, meta: string | null, content = '# skill'): void {
  const target = join(root, 'skills', dir);
  mkdirSync(target, { recursive: true });
  if (content !== '') writeFileSync(join(target, 'SKILL.md'), content);
  if (meta !== null) writeFileSync(join(target, 'skill_meta.yaml'), meta);
}

const validMeta = (id: string): string =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'status: enabled',
    `path: ./skills/${id}`,
    'source:',
    '  type: local',
    'targets:',
    '  - target: claude',
    '    scope: global',
    '    path: .claude/skills/' + id,
    '    mode: copy',
    '    enabled: true',
    '    file_map:',
    '      SKILL.md: SKILL.md',
    '',
  ].join('\n');

function scan(root: string, now = NOW) {
  const layout = layoutOf(root);
  return scanWorkspace({ layout, index: createInitialIndex(NOW), now });
}

test('K-02 合格 Skill 生成校验通过的记录', () => {
  const root = workspace();
  putSkill(root, 'code-review', validMeta('code-review'));
  const outcome = scan(root);
  const record = outcome.index.skills.find((item) => item.id === 'code-review');
  assert.equal(outcome.summary.available, 1);
  assert.equal(outcome.summary.invalid, 0);
  assert.equal(record?.validation.status, 'ok');
  assert.deepEqual(record?.validation.errors, []);
  assert.equal(record?.source_type, 'local');
  assert.deepEqual(record?.targets, [{ target: 'claude', scope: 'global', enabled: true }]);
  assert.ok(record?.checksum.startsWith('sha256:'));
});

test('K-02 不合格 Skill 入索引并携带问题码，不静默丢弃', () => {
  const root = workspace();
  putSkill(root, 'broken', 'id: broken\nstatus: paused\n');
  const outcome = scan(root);
  assert.equal(outcome.index.skills.length, 1, '不合格记录必须写入索引');
  const record = outcome.index.skills[0];
  assert.equal(record?.validation.status, 'invalid');
  assert.ok((record?.validation.errors ?? []).includes(CODES.STATUS_INVALID));
  assert.equal(outcome.summary.invalid, 1);
  assert.equal(outcome.summary.available, 0);
});

test('K-02 合格与不合格混合时计数分别落在可用集合内外', () => {
  const root = workspace();
  putSkill(root, 'good', validMeta('good'));
  putSkill(root, 'bad', 'id: bad\n');
  const outcome = scan(root);
  assert.equal(outcome.index.skills.length, 2);
  assert.equal(outcome.summary.available, 1);
  assert.equal(outcome.summary.invalid, 1);
});

test('K-02 重复扫描不新增重复条目', () => {
  const root = workspace();
  putSkill(root, 'code-review', validMeta('code-review'));
  const first = scan(root);
  const second = scanWorkspace({ layout: layoutOf(root), index: first.index, now: LATER });
  assert.equal(second.index.skills.length, 1);
  assert.equal(second.summary.added, 0);
  assert.equal(second.summary.updated, 0);
  assert.equal(second.changes.length, 0);
});

test('K-02 内容未变时不刷新更新时间，避免无谓抖动', () => {
  const root = workspace();
  putSkill(root, 'code-review', validMeta('code-review'));
  const first = scan(root);
  const second = scanWorkspace({ layout: layoutOf(root), index: first.index, now: LATER });
  assert.equal(second.index.skills[0]?.updated_at, first.index.skills[0]?.updated_at);
  assert.equal(second.index.skills[0]?.created_at, first.index.skills[0]?.created_at);
});

test('K-02 问题修复后再次扫描自动转为校验通过', () => {
  const root = workspace();
  putSkill(root, 'code-review', 'id: code-review\nstatus: paused\n');
  const broken = scan(root);
  assert.equal(broken.index.skills[0]?.validation.status, 'invalid');

  putSkill(root, 'code-review', validMeta('code-review'));
  const repaired = scanWorkspace({ layout: layoutOf(root), index: broken.index, now: LATER });
  assert.equal(repaired.index.skills[0]?.validation.status, 'ok');
  assert.equal(repaired.summary.available, 1);
  assert.equal(repaired.index.skills[0]?.created_at, broken.index.skills[0]?.created_at);
});

test('K-02 磁盘上消失的记录保留并以校验不通过标记', () => {
  const root = workspace();
  putSkill(root, 'code-review', validMeta('code-review'));
  const first = scan(root);
  const empty = workspace();
  const second = scanWorkspace({ layout: layoutOf(empty), index: first.index, now: LATER });
  assert.equal(second.index.skills.length, 1);
  assert.equal(second.index.skills[0]?.validation.status, 'invalid');
  assert.ok((second.index.skills[0]?.validation.errors ?? []).includes(CODES.INDEX_RECORD_INVALID));
  assert.equal(second.summary.missing, 1);
});

test('K-02 依赖指向不存在的 Skill 时依赖方判为未满足', () => {
  const root = workspace();
  putSkill(
    root,
    'needs-ghost',
    validMeta('needs-ghost').replace('targets:', 'dependencies:\n  skills:\n    - ghost\ntargets:'),
  );
  const outcome = scan(root);
  const record = outcome.index.skills[0];
  assert.equal(record?.validation.status, 'invalid');
  assert.ok((record?.validation.errors ?? []).includes(CODES.DEP_MISSING));
});

test('K-02 白名单外字段只给警告，不影响可用性', () => {
  const root = workspace();
  putSkill(root, 'code-review', `${validMeta('code-review')}extra_field: 1\n`);
  const outcome = scan(root);
  const record = outcome.index.skills[0];
  assert.equal(record?.validation.status, 'ok');
  assert.ok((record?.validation.errors ?? []).includes(CODES.FIELD_WHITELIST));
});

test('K-02 无内容文件的目录判为内容缺失', () => {
  const root = workspace();
  putSkill(root, 'empty-one', validMeta('empty-one'), '');
  const outcome = scan(root);
  assert.ok((outcome.index.skills[0]?.validation.errors ?? []).includes(CODES.HASH_MISSING));
});

test('K-02 缺少元文件的目录被忽略，不产生记录', () => {
  const root = workspace();
  mkdirSync(join(root, 'skills', 'not-a-skill'), { recursive: true });
  const outcome = scan(root);
  assert.equal(outcome.index.skills.length, 0);
  assert.equal(outcome.summary.available, 0);
});

test('K-02 依赖失效级联到依赖方，并沿依赖链传递', () => {
  const root = workspace();
  putSkill(root, 'alpha', validMeta('alpha'));
  putSkill(root, 'beta', `${validMeta('beta')}dependencies:\n  skills:\n    - ghost\n`);
  putSkill(root, 'gamma', `${validMeta('gamma')}dependencies:\n  skills:\n    - beta\n`);
  putSkill(root, 'delta', `${validMeta('delta')}dependencies:\n  skills:\n    - gamma\n`);

  const outcome = scan(root);
  const byId = new Map(outcome.index.skills.map((item) => [item.id, item.validation]));
  assert.equal(byId.get('alpha')?.status, 'ok', '无依赖的 Skill 不受影响');
  assert.equal(byId.get('beta')?.status, 'invalid', '依赖缺失导致自身不通过');
  assert.deepEqual(byId.get('beta')?.errors, [CODES.DEP_MISSING]);
  assert.equal(byId.get('gamma')?.status, 'invalid', '依赖方随之不通过');
  assert.deepEqual(byId.get('gamma')?.errors, [CODES.VALIDATION_DEPENDENCY]);
  assert.equal(byId.get('delta')?.status, 'invalid', '级联沿依赖链传递');
  assert.equal(outcome.summary.available, 1);
  assert.equal(outcome.summary.invalid, 3);
});
