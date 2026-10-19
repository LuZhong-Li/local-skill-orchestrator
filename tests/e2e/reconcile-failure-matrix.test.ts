import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { loadIndex } from '../../kernel/core/index/index.ts';
import { computeChecksum } from '../../kernel/core/integrity/index.ts';
import { executeReconcilePlan } from '../../kernel/dispatch/reconcile/execute.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type { ReconcileApplyData, ReconcilePreviewData } from '@skill-manager/contract';
import type { Interaction } from '../../kernel/dispatch/policy/index.ts';

async function capture(argv: string[], interaction?: Interaction) {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(argv, interaction), out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function json(argv: string[], interaction?: Interaction) {
  const result = await capture([...argv, '--json'], interaction);
  return { code: result.code, result: JSON.parse(result.out) as Record<string, unknown> };
}

function previewOf(result: Record<string, unknown>): ReconcilePreviewData {
  return result['data'] as ReconcilePreviewData;
}

async function initWithHost(root: string, hostRoot: string): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
}

function layoutAndIndex(root: string) {
  return {
    layout: layoutOf(root),
    index: loadIndex(join(root, 'skill_index.yaml')).index,
  };
}

test('失败矩阵：track 账本损坏时不写账本、不碰宿主与索引', async (t) => {
  const root = makeTempDir('sm-failure-track-');
  const hostRoot = makeHostRoot('sm-failure-track-host-');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  const source = makeSkillSource('track-failure', {
    description: 'track failure',
    content: '---\nname: track-failure\ndescription: track failure\n---\n\n# track-failure\n',
  });
  assert.equal((await capture(['install', source, '--workspace', root, '--yes'])).code, 0);
  const hostDir = join(hostRoot, 'track-failure');
  mkdirSync(hostDir, { recursive: true });
  copyFileSync(join(root, 'skills', 'track-failure', 'SKILL.md'), join(hostDir, 'SKILL.md'));
  const preview = await json([
    'reconcile',
    '--action',
    'track',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  const ledgerPath = join(root, 'host_landings.yaml');
  const indexPath = join(root, 'skill_index.yaml');
  const ledgerBefore = readFileSync(ledgerPath);
  const indexBefore = readFileSync(indexPath);
  const hostBefore = readFileSync(join(hostDir, 'SKILL.md'));
  writeFileSync(ledgerPath, 'schema_version: [broken\n');
  const damaged = readFileSync(ledgerPath);

  const execution = executeReconcilePlan({
    plan: previewOf(preview.result) as ReconcileApplyData,
    ...layoutAndIndex(root),
    now: '2026-01-01T00:00:00Z',
  });
  assert.equal(execution.data.results[0]?.status, 'failed');
  assert.equal(execution.findings[0]?.code, 'E-LANDING-001');
  assert.deepEqual(readFileSync(ledgerPath), damaged);
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.deepEqual(readFileSync(join(hostDir, 'SKILL.md')), hostBefore);
  assert.notDeepEqual(ledgerBefore, damaged);
});

test('失败矩阵：forget 账本损坏时副本仍缺失、账本字节不变', async (t) => {
  const root = makeTempDir('sm-failure-forget-');
  const hostRoot = makeHostRoot('sm-failure-forget-host-');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  const source = makeSkillSource('forget-failure', { description: 'forget failure' });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  const hostDir = join(hostRoot, 'forget-failure');
  rmSync(hostDir, { recursive: true, force: true });
  const preview = await json([
    'reconcile',
    '--action',
    'forget',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  const ledgerPath = join(root, 'host_landings.yaml');
  writeFileSync(ledgerPath, 'schema_version: [broken\n');
  const damaged = readFileSync(ledgerPath);
  const execution = executeReconcilePlan({
    plan: previewOf(preview.result) as ReconcileApplyData,
    ...layoutAndIndex(root),
    now: '2026-01-01T00:00:00Z',
  });
  assert.equal(execution.data.results[0]?.status, 'failed');
  assert.equal(execution.findings[0]?.code, 'E-LANDING-001');
  assert.equal(existsSync(hostDir), false);
  assert.deepEqual(readFileSync(ledgerPath), damaged);
});

test('失败矩阵：accept 计划过期返回 E-RECONCILE-002 且零写入', async (t) => {
  const root = makeTempDir('sm-failure-accept-stale-');
  const hostRoot = makeHostRoot('sm-failure-accept-stale-host-');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  const source = makeSkillSource('accept-stale', { description: 'accept stale' });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  const hostDir = join(hostRoot, 'accept-stale');
  writeFileSync(join(hostDir, 'SKILL.md'), '---\nname: accept-stale\ndescription: drifted\n---\n');
  const preview = await json([
    'reconcile',
    '--action',
    'accept',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0);
  const libraryBefore = computeChecksum(join(root, 'skills', 'accept-stale'));
  const indexBefore = readFileSync(join(root, 'skill_index.yaml'));
  const ledgerBefore = readFileSync(join(root, 'host_landings.yaml'));
  const interaction: Interaction = {
    interactive: true,
    write: () => undefined,
    read: async () => {
      writeFileSync(
        join(hostDir, 'SKILL.md'),
        '---\nname: accept-stale\ndescription: changed during confirm\n---\n',
      );
      return 'y';
    },
  };
  const applied = await json(
    ['reconcile', '--action', 'accept', '--path', hostDir, '--workspace', root, '--apply'],
    interaction,
  );
  assert.equal(applied.code, 1);
  assert.equal((applied.result['findings'] as Array<{ code: string }>)[0]?.code, 'E-RECONCILE-002');
  assert.equal(computeChecksum(join(root, 'skills', 'accept-stale')), libraryBefore);
  assert.deepEqual(readFileSync(join(root, 'skill_index.yaml')), indexBefore);
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), ledgerBefore);
});

test('失败矩阵：accept 账本写入失败时中心库与索引恢复原状', async (t) => {
  const root = makeTempDir('sm-failure-accept-ledger-');
  const hostRoot = makeHostRoot('sm-failure-accept-ledger-host-');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  const source = makeSkillSource('accept-ledger', { description: 'accept ledger' });
  assert.equal(
    (await capture(['install', source, '--host', 'claude', '--workspace', root, '--yes'])).code,
    0,
  );
  const hostDir = join(hostRoot, 'accept-ledger');
  writeFileSync(
    join(hostDir, 'SKILL.md'),
    '---\nname: accept-ledger\ndescription: accepted content\n---\n\n# accepted\n',
  );
  const preview = await json([
    'reconcile',
    '--action',
    'accept',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  const ledgerPath = join(root, 'host_landings.yaml');
  const indexPath = join(root, 'skill_index.yaml');
  const libraryBefore = computeChecksum(join(root, 'skills', 'accept-ledger'));
  const indexBefore = readFileSync(indexPath);
  writeFileSync(ledgerPath, 'schema_version: [broken\n');
  const damaged = readFileSync(ledgerPath);

  const execution = executeReconcilePlan({
    plan: previewOf(preview.result) as ReconcileApplyData,
    ...layoutAndIndex(root),
    now: '2026-01-01T00:00:00Z',
  });
  assert.equal(execution.data.results[0]?.status, 'failed');
  assert.equal(execution.findings[0]?.code, 'E-LANDING-001');
  assert.equal(computeChecksum(join(root, 'skills', 'accept-ledger')), libraryBefore);
  assert.deepEqual(readFileSync(indexPath), indexBefore);
  assert.deepEqual(readFileSync(ledgerPath), damaged);
  assert.equal(
    readFileSync(join(root, 'skills', 'accept-ledger', 'SKILL.md'), 'utf8').includes('# accepted'),
    false,
    '中心库不得残留被接受的宿主内容',
  );
});
