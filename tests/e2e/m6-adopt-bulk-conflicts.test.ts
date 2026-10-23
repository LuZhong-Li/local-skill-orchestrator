import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { ReconcileResultItem } from '@skill-manager/contract';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot } from '../helpers/host.ts';
import {
  bulkSelection,
  capture,
  executeBulk,
  initWorkspace,
  writeM6Skill,
} from '../helpers/m6-fixtures.ts';
import { validateBulkAdoptFlags } from '../../kernel/dispatch/reconcile/adopt-bulk.ts';
import { snapshotTree } from '../helpers/snapshot.ts';
import { makeTempDir } from '../helpers/temp.ts';

function resultByIdentity(
  results: readonly ReconcileResultItem[],
  targetPath: string,
): ReconcileResultItem | undefined {
  return results.find((item) => item.target_path === targetPath);
}

async function adoptOne(root: string, sourcePath: string): Promise<void> {
  const adopted = await capture([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    sourcePath,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(adopted.code, 0, adopted.out);
}

test('M6 conflict 1: same frontmatter name across hosts', async (t) => {
  const root = makeTempDir('sm-m6-adopt-hosts-');
  const claudeRoot = makeHostRoot('sm-m6-adopt-claude-');
  const codexRoot = makeHostRoot('sm-m6-adopt-codex-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root, [
    ['claude', claudeRoot],
    ['codex', codexRoot],
  ]);
  const claudeCopy = writeM6Skill(claudeRoot, 'same-name');
  const codexCopy = writeM6Skill(codexRoot, 'same-name');

  const { execution } = executeBulk(root, bulkSelection({ conflict: 'skip' }));

  const first = resultByIdentity(execution.results, claudeCopy);
  const second = resultByIdentity(execution.results, codexCopy);
  assert.equal(first?.status, 'succeeded');
  assert.equal(second?.status, 'skipped');
  assert.equal(second?.reason, 'duplicate_skill_id');
  assert.equal(existsSync(join(root, 'skills', 'same-name')), true);
});

test('M6 conflict 2: same frontmatter name across roles', async (t) => {
  const root = makeTempDir('sm-m6-adopt-roles-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root);
  const home = process.env['HOME'] as string;
  const userCopy = writeM6Skill(join(home, '.claude', 'skills'), 'cross-role');
  const systemCopy = writeM6Skill(join(home, '.codex', 'skills', '.system'), 'cross-role');

  const { execution } = executeBulk(
    root,
    bulkSelection({ roles: ['user', 'system'], conflict: 'skip' }),
  );

  const user = resultByIdentity(execution.results, userCopy);
  const system = resultByIdentity(execution.results, systemCopy);
  assert.equal(user?.status, 'succeeded');
  assert.equal(system?.status, 'skipped');
  assert.equal(system?.reason, 'non_user_role_read_only');
});

test('M6 conflict 3: workspace ID exists with identical content', async (t) => {
  const root = makeTempDir('sm-m6-adopt-same-content-');
  const claudeRoot = makeHostRoot('sm-m6-adopt-same-content-host-');
  const codexRoot = makeHostRoot('sm-m6-adopt-same-content-second-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root, [
    ['claude', claudeRoot],
    ['codex', codexRoot],
  ]);
  const firstSource = writeM6Skill(claudeRoot, 'same-content');
  const secondSource = writeM6Skill(codexRoot, 'same-content');
  await adoptOne(root, firstSource);
  const before = snapshotTree(root);

  const { plan, execution } = executeBulk(root, bulkSelection({ conflict: 'skip' }));

  const result = resultByIdentity(execution.results, secondSource);
  assert.equal(result?.status, 'skipped');
  assert.equal(result?.reason, 'same_content_existing_skill');
  assert.equal(plan.items[0]?.status, 'skipped');
  assert.deepEqual(snapshotTree(root), before);
});

test('M6 conflict 4: workspace ID exists with different content and later item succeeds', async (t) => {
  const root = makeTempDir('sm-m6-adopt-different-content-');
  const claudeRoot = makeHostRoot('sm-m6-adopt-different-host-');
  const codexRoot = makeHostRoot('sm-m6-adopt-different-second-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root, [
    ['claude', claudeRoot],
    ['codex', codexRoot],
  ]);
  const firstSource = writeM6Skill(claudeRoot, 'different-content', {
    description: 'workspace content',
  });
  const conflictSource = writeM6Skill(codexRoot, 'different-content', {
    description: 'host content',
  });
  const laterSource = writeM6Skill(codexRoot, 'later-skill');
  await adoptOne(root, firstSource);

  const { execution } = executeBulk(root, bulkSelection({ conflict: 'skip' }));

  const conflict = resultByIdentity(execution.results, conflictSource);
  const later = resultByIdentity(execution.results, laterSource);
  assert.equal(conflict?.status, 'skipped');
  assert.equal(conflict?.reason, 'different_content_existing_skill');
  assert.equal(later?.status, 'succeeded');
});

test('M6 conflict 5: rename and force boundaries', async (t) => {
  await t.test('rename resolves -2 and reserves it across the batch', async (tt) => {
    const root = makeTempDir('sm-m6-adopt-rename-');
    const hostRoot = makeHostRoot('sm-m6-adopt-rename-host-');
    const codexRoot = makeHostRoot('sm-m6-adopt-rename-second-');
    const restore = isolateHostEnvironment(root);
    tt.after(restore);
    await initWorkspace(root, [
      ['claude', hostRoot],
      ['codex', codexRoot],
    ]);
    const existing = writeM6Skill(hostRoot, 'rename-demo', { description: 'original' });
    await adoptOne(root, existing);
    const firstConflict = writeM6Skill(codexRoot, 'rename-demo', {
      description: 'first changed',
    });
    const secondConflict = writeM6Skill(codexRoot, 'rename-demo-2', {
      name: 'rename-demo',
      description: 'second changed',
    });

    const { plan, execution } = executeBulk(root, bulkSelection({ conflict: 'rename' }));

    const previews = plan.items.map((item) => item.adopt_preview?.target_skill_id);
    assert.deepEqual(previews, ['rename-demo-2', 'rename-demo-3']);
    assert.equal(resultByIdentity(execution.results, firstConflict)?.status, 'succeeded');
    assert.equal(resultByIdentity(execution.results, secondConflict)?.status, 'succeeded');
    assert.equal(existsSync(join(root, 'skills', 'rename-demo-2')), true);
    assert.equal(existsSync(join(root, 'skills', 'rename-demo-3')), true);
  });

  await t.test('force replaces only the same ID and backs up existing skill', async (tt) => {
    const root = makeTempDir('sm-m6-adopt-force-');
    const hostRoot = makeHostRoot('sm-m6-adopt-force-host-');
    const codexRoot = makeHostRoot('sm-m6-adopt-force-second-');
    const restore = isolateHostEnvironment(root);
    tt.after(restore);
    await initWorkspace(root, [
      ['claude', hostRoot],
      ['codex', codexRoot],
    ]);
    const existing = writeM6Skill(hostRoot, 'force-demo', { description: 'original' });
    await adoptOne(root, existing);
    const changed = writeM6Skill(codexRoot, 'force-demo', { description: 'changed' });

    const { execution } = executeBulk(root, bulkSelection({ conflict: 'force' }));

    assert.equal(resultByIdentity(execution.results, changed)?.status, 'succeeded');
    assert.match(
      readFileSync(join(root, 'skills', 'force-demo', 'SKILL.md'), 'utf8'),
      /description: changed/,
    );
    assert.equal(existsSync(join(root, 'backups', 'force-demo')), true);
  });

  await t.test('unrelated occupied target fails without being overwritten', async (tt) => {
    const root = makeTempDir('sm-m6-adopt-occupied-');
    const hostRoot = makeHostRoot('sm-m6-adopt-occupied-host-');
    const restore = isolateHostEnvironment(root);
    tt.after(restore);
    await initWorkspace(root, [['claude', hostRoot]]);
    writeM6Skill(join(root, '.claude', 'skills'), 'occupied', { name: 'another-skill' });
    const source = writeM6Skill(hostRoot, 'occupied', { name: 'occupied' });

    const { execution } = executeBulk(root, bulkSelection({ conflict: 'force' }));

    const result = resultByIdentity(execution.results, source);
    assert.equal(result?.status, 'failed');
    assert.match(result?.findings?.[0]?.message ?? '', /其他 Skill/);
  });

  await t.test('rename and force are mutually exclusive policy inputs', () => {
    assert.equal(
      validateBulkAdoptFlags({ rename: true, force: true }),
      'rename_force_mutually_exclusive',
    );
  });
});
