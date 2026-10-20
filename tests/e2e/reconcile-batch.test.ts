import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { loadHostLandings } from '../../kernel/store/host-landings/index.ts';
import { executeReconcilePlan } from '../../kernel/dispatch/reconcile/execute.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { loadIndex } from '../../kernel/core/index/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type {
  ReconcileApplyData,
  ReconcilePlanItem,
  ReconcilePreviewData,
} from '@skill-manager/contract';

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

async function json(argv: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
  const captured = await capture([...argv, '--json']);
  return { code: captured.code, result: JSON.parse(captured.out) as Record<string, unknown> };
}

function previewOf(result: Record<string, unknown>): ReconcilePreviewData {
  return result['data'] as ReconcilePreviewData;
}

function applyOf(result: Record<string, unknown>): ReconcileApplyData {
  return result['data'] as ReconcileApplyData;
}

async function init(root: string, hosts: Array<[string, string]> = []): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  for (const [host, hostRoot] of hosts) {
    assert.equal(
      (await capture(['config', 'set', `host.${host}.root`, hostRoot, '--workspace', root])).code,
      0,
    );
  }
}

test('T1 批量：root 选择展开全部副本且物理键去重', async (t) => {
  const root = makeTempDir('sm-t1-root-');
  const hostRoot = makeHostRoot('sm-t1-root-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  for (const id of ['alpha', 'beta', 'gamma']) writeHostSkill(hostRoot, id);

  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--root',
    hostRoot,
    '--root',
    hostRoot,
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const data = previewOf(preview.result);
  assert.equal(data.selection.mode, 'batch');
  assert.equal(data.items.length, 3);
  assert.equal(new Set(data.items.map((item) => item.physical_key)).size, 3);
  assert.deepEqual(data.items.map((item) => item.skill_id).sort(), ['alpha', 'beta', 'gamma']);
});

test('T1 批量：重复 ids 与 roles 取并集且不扩大未选范围', async (t) => {
  const root = makeTempDir('sm-t1-union-');
  const hostRoot = makeHostRoot('sm-t1-union-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  for (const id of ['alpha', 'beta', 'outside']) writeHostSkill(hostRoot, id);
  const projectRoot = join(root, '.claude', 'skills');
  writeHostSkill(projectRoot, 'project-only');

  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--id',
    'alpha',
    '--id',
    'beta',
    '--role',
    'project',
    '--host',
    'all',
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const data = previewOf(preview.result);
  assert.deepEqual(data.items.map((item) => item.skill_id).sort(), [
    'alpha',
    'beta',
    'project-only',
  ]);
  assert.equal(
    data.items.some((item) => item.skill_id === 'outside'),
    false,
  );
  assert.equal(new Set(data.items.map((item) => item.physical_key)).size, data.items.length);
});

test('T1 批量：20 副本中单副本失败，其余成功并返回真实 summary', async (t) => {
  const root = makeTempDir('sm-t1-failure-');
  const hostRoot = makeHostRoot('sm-t1-failure-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const ids = Array.from(
    { length: 20 },
    (_value, index) => `batch-${String(index + 1).padStart(2, '0')}`,
  );
  for (const id of ids) writeHostSkill(hostRoot, id);
  const failedId = ids[10]!;
  const occupied = join(root, '.claude', 'skills', failedId);
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, 'SKILL.md'), '---\nname: occupied\ndescription: occupied\n---\n');

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--root',
    hostRoot,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 1, JSON.stringify(applied.result));
  const data = applyOf(applied.result);
  assert.equal(data.results.length, 20);
  assert.equal(data.results.filter((item) => item.status === 'succeeded').length, 19);
  assert.equal(data.results.filter((item) => item.status === 'failed').length, 1);
  const failed = data.results.find((item) => item.status === 'failed');
  assert.equal(failed?.target_path, join(hostRoot, failedId));
  assert.equal(failed?.stage, 'execute');
  assert.ok(failed?.reason);
  assert.equal(data.summary.succeeded, 19);
  assert.equal(data.summary.failed, 1);
  assert.equal(data.summary.skipped, 0);
  assert.equal(data.summary.cancelled, 0);
  assert.ok((data.summary.duration_ms ?? -1) >= 0);
  assert.equal(
    (data.summary.succeeded ?? 0) +
      (data.summary.failed ?? 0) +
      (data.summary.skipped ?? 0) +
      (data.summary.cancelled ?? 0),
    data.summary.selected,
  );
  assert.equal(existsSync(join(root, 'skills', failedId)), false);
  assert.equal(existsSync(join(root, 'skills', ids[0]!)), true);
});

test('T1 批量：20 副本 repair 共用同一扁平计划与执行骨架', async (t) => {
  const root = makeTempDir('sm-t1-repair-');
  const hostRoot = makeHostRoot('sm-t1-repair-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const ids = Array.from(
    { length: 20 },
    (_value, index) => `repair-${String(index + 1).padStart(2, '0')}`,
  );
  for (const id of ids) {
    const source = makeSkillSource(id, { description: `${id} source` });
    assert.equal(
      (await capture(['install', source, '--library-only', '--workspace', root, '--yes'])).code,
      0,
    );
    writeHostSkill(hostRoot, id, { description: `${id} drifted copy` });
  }

  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--root',
    hostRoot,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  const data = applyOf(applied.result);
  assert.equal(data.results.length, 20);
  assert.equal(data.results.filter((item) => item.status === 'succeeded').length, 20);
  assert.equal(data.summary.succeeded, 20);
  assert.equal(data.summary.failed, 0);
  assert.equal(data.summary.selected, 20);
});

test('T1 批量：执行器捕获意外异常后继续后续 item', async (t) => {
  const root = makeTempDir('sm-t1-isolation-');
  const hostRoot = makeHostRoot('sm-t1-isolation-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  writeHostSkill(hostRoot, 'fault-a');
  writeHostSkill(hostRoot, 'fault-b');
  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--root',
    hostRoot,
    '--workspace',
    root,
  ]);
  const plan = previewOf(preview.result) as ReconcileApplyData;
  const faulty = plan.items.find((item) => item.skill_id === 'fault-a');
  assert.ok(faulty);
  (faulty as ReconcilePlanItem & { root_roles?: undefined }).root_roles = undefined;

  const execution = executeReconcilePlan({
    plan,
    layout: layoutOf(root),
    index: loadIndex(join(root, 'skill_index.yaml')).index,
    now: '2026-01-01T00:00:00Z',
  });
  const failed = execution.data.results.find((item) => item.item_id === faulty.item_id);
  const succeeded = execution.data.results.find(
    (item) => item.target_path === join(hostRoot, 'fault-b'),
  );
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.stage, 'execute');
  assert.ok(failed?.reason);
  assert.equal(succeeded?.status, 'succeeded');
  assert.equal(existsSync(join(root, 'skills', 'fault-a')), false);
  assert.equal(existsSync(join(root, 'skills', 'fault-b')), true);
});

test('T1 批量：共享根只生成一个 item 和事务组', async (t) => {
  const root = makeTempDir('sm-t1-shared-');
  const shared = makeHostRoot('sm-t1-shared-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['codex', shared],
    ['cursor', shared],
  ]);
  writeHostSkill(shared, 'shared-skill');

  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--id',
    'shared-skill',
    '--id',
    'shared-skill',
    '--host',
    'all',
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const data = previewOf(preview.result);
  assert.equal(data.items.length, 1);
  assert.deepEqual(data.items[0]?.host_ids.sort(), ['codex', 'cursor']);
  assert.equal(data.transaction_groups.length, 1);
  assert.equal(data.transaction_groups[0]?.shared, true);
});

test('T1 批量：共享根失败不写账本，独立副本继续成功', async (t) => {
  const root = makeTempDir('sm-t1-group-rollback-');
  const shared = makeHostRoot('sm-t1-group-rollback-shared-');
  const solo = makeHostRoot('sm-t1-group-rollback-solo-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['codex', shared],
    ['cursor', shared],
    ['claude', solo],
  ]);
  writeHostSkill(shared, 'shared-fail');
  writeHostSkill(solo, 'solo-pass');
  const occupied = join(root, '.claude', 'skills', 'shared-fail');
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, 'SKILL.md'), '---\nname: occupied\ndescription: occupied\n---\n');

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--id',
    'shared-fail',
    '--id',
    'solo-pass',
    '--host',
    'all',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 1, JSON.stringify(applied.result));
  const data = applyOf(applied.result);
  assert.equal(data.results.filter((item) => item.status === 'succeeded').length, 1);
  assert.equal(data.results.filter((item) => item.status === 'failed').length, 1);
  assert.equal(existsSync(join(root, 'skills', 'shared-fail')), false);
  assert.equal(existsSync(join(root, 'skills', 'solo-pass')), true);
  assert.equal(
    loadHostLandings(join(root, 'host_landings.yaml')).index?.landings.some(
      (item) => item.skill_id === 'shared-fail',
    ),
    false,
  );
});

test('T1 批量：非 user 角色计划项保持 skipped', async (t) => {
  const root = makeTempDir('sm-t1-project-');
  t.after(isolateHostEnvironment(root));
  await init(root);
  const projectRoot = join(root, '.claude', 'skills');
  writeHostSkill(projectRoot, 'project-skill');

  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--role',
    'project',
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const data = previewOf(preview.result);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0]?.status, 'skipped');
  assert.equal(data.items[0]?.reason, 'non_user_role_read_only');
  assert.deepEqual(data.items[0]?.writes, []);
  assert.equal(data.summary.skipped, 1);
});
