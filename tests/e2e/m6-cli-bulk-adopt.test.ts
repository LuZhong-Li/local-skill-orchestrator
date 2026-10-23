import assert from 'node:assert/strict';
import test from 'node:test';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { capture, initWorkspace, writeM6Skill } from '../helpers/m6-fixtures.ts';
import { makeTempDir } from '../helpers/temp.ts';

async function json(argv: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
  const executed = await capture([...argv, '--json']);
  return { code: executed.code, result: JSON.parse(executed.out) as Record<string, unknown> };
}

test('M6 CLI：reconcile --action adopt --bulk 确定性预览并返回 bulk summary', async (t) => {
  const root = makeTempDir('sm-m6-cli-bulk-');
  const claudeRoot = makeHostRoot('sm-m6-cli-bulk-claude-');
  const codexRoot = makeHostRoot('sm-m6-cli-bulk-codex-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root, [
    ['claude', claudeRoot],
    ['codex', codexRoot],
  ]);
  writeM6Skill(claudeRoot, 'b-skill');
  writeM6Skill(codexRoot, 'a-skill');

  const executed = await json([
    'reconcile',
    '--action',
    'adopt',
    '--bulk',
    '--role',
    'user',
    '--limit',
    '1',
    '--dry-run',
    '--workspace',
    root,
  ]);

  assert.equal(executed.code, 0, JSON.stringify(executed.result));
  const data = executed.result['data'] as {
    items: Array<{ skill_id: string; adopt_preview?: { target_skill_id: string } }>;
    summary: { bulk: { candidates: number; limited: number } };
  };
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0]?.skill_id, 'a-skill');
  assert.equal(data.items[0]?.adopt_preview?.target_skill_id, 'a-skill');
  assert.equal(data.summary.bulk.candidates, 1);
  assert.equal(data.summary.bulk.limited, 1);
});

test('M6 CLI：--rename 与 --force 互斥，且只属于 batch adopt', async (t) => {
  const root = makeTempDir('sm-m6-cli-conflict-flags-');
  const restore = isolateHostEnvironment(root);
  t.after(restore);
  await initWorkspace(root);

  const both = await json([
    'reconcile',
    '--action',
    'adopt',
    '--bulk',
    '--rename',
    '--force',
    '--workspace',
    root,
  ]);
  const wrongAction = await json([
    'reconcile',
    '--action',
    'repair',
    '--rename',
    '--workspace',
    root,
  ]);

  assert.equal(both.code, 2);
  assert.match(JSON.stringify(both.result['findings']), /rename_force_mutually_exclusive|不能同时/);
  assert.equal(wrongAction.code, 2);
});
