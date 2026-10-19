import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeTempDir } from '../helpers/temp.ts';
import { snapshotTree } from '../helpers/snapshot.ts';

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(argv), out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function json(argv: string[]) {
  const captured = await capture([...argv, '--json']);
  return {
    code: captured.code,
    result: JSON.parse(captured.out) as Record<string, unknown>,
  };
}

test('T0 reconcile 预览：精确 path 只选中一个副本，且全程只读', async (t) => {
  const root = makeTempDir('sm-reconcile-preview-');
  t.after(isolateHostEnvironment(root));
  const hostRoot = makeHostRoot('sm-reconcile-host-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
  writeHostSkill(hostRoot, 'alpha', { description: 'untracked alpha' });
  writeHostSkill(hostRoot, 'beta', { description: 'untracked beta' });

  const beforeWorkspace = snapshotTree(root);
  const beforeHost = snapshotTree(hostRoot);
  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    join(hostRoot, 'alpha'),
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const data = preview.result['data'] as {
    mode: string;
    applied: boolean;
    items: Array<Record<string, unknown>>;
    transaction_groups: Array<Record<string, unknown>>;
    summary: Record<string, number>;
  };
  assert.equal(data.mode, 'reconcile');
  assert.equal(data.applied, false);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0]?.['target_path'], join(hostRoot, 'alpha'));
  assert.equal(
    (data.items[0]?.['before'] as { classification_key: string }).classification_key,
    'untracked',
  );
  assert.equal(data.summary['selected'], 1);
  assert.equal(data.summary['planned'], 1);
  assert.equal(data.transaction_groups.length, 1);
  const writes = data.items[0]?.['writes'] as Array<{ kind: string; path: string }>;
  assert.ok(writes.some((item) => item.kind === 'library'));
  assert.ok(writes.some((item) => item.kind === 'skill_meta'));
  assert.ok(writes.some((item) => item.kind === 'index'));
  assert.ok(writes.some((item) => item.kind === 'host_landings'));
  assert.equal(
    writes.some((item) => item.kind === 'target_copy'),
    false,
  );

  assert.deepEqual(snapshotTree(root), beforeWorkspace, '预览不得改变工作区');
  assert.deepEqual(snapshotTree(hostRoot), beforeHost, '预览不得改变宿主根');
});

test('T0 reconcile：未实现动作的 --apply 明确拒绝且不写盘', async (t) => {
  const root = makeTempDir('sm-reconcile-apply-');
  t.after(isolateHostEnvironment(root));
  const hostRoot = makeHostRoot('sm-reconcile-host-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
  writeHostSkill(hostRoot, 'alpha');
  const beforeWorkspace = snapshotTree(root);
  const beforeHost = snapshotTree(hostRoot);
  const attempted = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    join(hostRoot, 'alpha'),
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(attempted.code, 1);
  const findings = attempted.result['findings'] as Array<{ code: string; message: string }>;
  assert.equal(findings[0]?.code, 'E-RECONCILE-001');
  assert.match(findings[0]?.message ?? '', /尚未实现/);
  const data = attempted.result['data'] as { applied: boolean };
  assert.equal(data.applied, false);
  assert.deepEqual(snapshotTree(root), beforeWorkspace);
  assert.deepEqual(snapshotTree(hostRoot), beforeHost);
});

test('T0 reconcile：分类批量必须有 host/root 限定', async (t) => {
  const root = makeTempDir('sm-reconcile-batch-');
  t.after(isolateHostEnvironment(root));
  const invalid = await json([
    'reconcile',
    '--action',
    'repair',
    '--classification',
    'missing',
    '--workspace',
    root,
  ]);
  assert.equal(invalid.code, 2);
  const findings = invalid.result['findings'] as Array<{ code: string }>;
  assert.equal(findings[0]?.code, 'E-INPUT-002');
});
