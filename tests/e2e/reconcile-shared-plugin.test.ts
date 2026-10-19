import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { cleanItem } from '../../kernel/dispatch/reconcile/clean.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import {
  applyHostLandingRecords,
  buildHostLandingRecord,
} from '../../kernel/core/host-landings/index.ts';
import { computeChecksum, computeLandingChecksum } from '../../kernel/core/integrity/index.ts';
import {
  createInitialHostLandings,
  loadHostLandings,
  saveHostLandings,
} from '../../kernel/store/host-landings/index.ts';
import { loadPluginIndex, savePluginIndex } from '../../kernel/store/plugin-registry/index.ts';
import { upsertPluginLanding } from '../../kernel/core/plugins/host.ts';
import { makePluginDir, writePluginManifest } from '../helpers/plugin.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type { ReconcilePlanItem } from '@skill-manager/contract';

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

function itemsOf(result: Record<string, unknown>) {
  return (result['data'] as { items?: Array<Record<string, unknown>> }).items ?? [];
}

function groupsOf(result: Record<string, unknown>) {
  return (
    (result['data'] as { transaction_groups?: Array<Record<string, unknown>> })
      .transaction_groups ?? []
  );
}

async function init(root: string, hosts: Array<[string, string]>): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  for (const [host, hostRoot] of hosts) {
    assert.equal(
      (await capture(['config', 'set', `host.${host}.root`, hostRoot, '--workspace', root])).code,
      0,
    );
  }
}

test('T4 共享根：track/accept 一次物理写、全部消费宿主账本同步', async (t) => {
  const root = makeTempDir('sm-t4-shared-');
  const shared = makeHostRoot('sm-t4-shared-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['codex', shared],
    ['cursor', shared],
  ]);
  const source = makeSkillSource('shared-action', {
    description: 'shared action',
    content: '---\nname: shared-action\ndescription: shared action\n---\n\n# shared action\n',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'codex', '--workspace', root, '--yes'])).code,
    0,
  );
  const pluginBefore = readFileSync(join(root, 'plugin_index.yaml'));
  const hostDir = join(shared, 'shared-action');
  rmSync(join(root, 'host_landings.yaml'));

  const track = await json([
    'reconcile',
    '--action',
    'track',
    '--path',
    hostDir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(track.code, 0, JSON.stringify(track.result));
  assert.equal(
    (track.result['data'] as { results?: Array<{ status: string }> }).results?.[0]?.status,
    'succeeded',
  );
  assert.equal(groupsOf(track.result)[0]?.['shared'], true);
  assert.deepEqual(
    loadHostLandings(join(root, 'host_landings.yaml'))
      .index?.landings.filter((item) => item.skill_id === 'shared-action')
      .map((item) => item.host_id)
      .sort(),
    ['codex', 'cursor'],
  );

  writeFileSync(
    join(hostDir, 'SKILL.md'),
    '---\nname: shared-action\ndescription: accepted\n---\n\n# accepted\n',
  );
  const accept = await json([
    'reconcile',
    '--action',
    'accept',
    '--path',
    hostDir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(accept.code, 0, JSON.stringify(accept.result));
  const records = loadHostLandings(join(root, 'host_landings.yaml')).index?.landings.filter(
    (item) => item.skill_id === 'shared-action',
  );
  assert.equal(records?.length, 2);
  assert.equal(new Set(records?.map((item) => item.content_digest)).size, 1);
  assert.equal(new Set(records?.map((item) => item.source_checksum)).size, 1);
  assert.deepEqual(readFileSync(join(root, 'plugin_index.yaml')), pluginBefore);
});

test('T4 共享根 clean：有 active 消费者只清账本，全部 orphaned 才删物理', async (t) => {
  const root = makeTempDir('sm-t4-refcount-');
  const shared = makeHostRoot('sm-t4-refcount-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['codex', shared],
    ['cursor', shared],
  ]);
  const hostDir = writeHostSkill(shared, 'refcount-skill');
  const now = '2026-01-01T00:00:00Z';
  const base = createInitialHostLandings(now, '0.4.0');
  const common = {
    skillId: 'refcount-skill',
    targetPath: hostDir,
    format: 'skill' as const,
    visibility: 'visible' as const,
    origin: 'adopted' as const,
    sourceChecksum: computeChecksum(hostDir),
    contentDigest: computeLandingChecksum({ targetPath: hostDir, format: 'skill' }),
    now,
  };
  const codex = buildHostLandingRecord({ ...common, hostId: 'codex' });
  const cursor = buildHostLandingRecord({ ...common, hostId: 'cursor' });
  const withRecords = applyHostLandingRecords(base, [codex, cursor]);
  saveHostLandings(join(root, 'host_landings.yaml'), {
    ...withRecords,
    landings: withRecords.landings.map((item) => ({
      ...item,
      state: item.host_id === 'codex' ? ('orphaned' as const) : ('active' as const),
    })),
  });

  const preview = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  const previewChanges = itemsOf(preview.result)[0]?.['ledger_changes'] as
    Array<{ from_state: string; to_state: string }> | undefined;
  assert.deepEqual(previewChanges, [
    {
      source: 'host_landings',
      record_key: `codex:${hostDir}`,
      from_state: 'orphaned',
      to_state: 'removed',
    },
  ]);

  const partial = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    hostDir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(partial.code, 0, JSON.stringify(partial.result));
  assert.equal(existsSync(hostDir), true);
  assert.deepEqual(
    loadHostLandings(join(root, 'host_landings.yaml'))
      .index?.landings.filter((item) => item.skill_id === 'refcount-skill')
      .map((item) => `${item.host_id}:${item.state}`),
    ['cursor:active'],
  );

  const current = loadHostLandings(join(root, 'host_landings.yaml')).index;
  assert.ok(current);
  saveHostLandings(join(root, 'host_landings.yaml'), {
    ...current,
    landings: current.landings.map((item) => ({
      ...item,
      state: 'orphaned' as const,
    })),
  });
  const full = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    hostDir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(full.code, 0, JSON.stringify(full.result));
  assert.equal(existsSync(hostDir), false);
  assert.equal(loadHostLandings(join(root, 'host_landings.yaml')).index?.landings.length, 0);
});

test('T4 共享根 clean 组内账本失败：整组记录与物理副本保持原状', async (t) => {
  const root = makeTempDir('sm-t4-group-fail-');
  const shared = makeHostRoot('sm-t4-group-fail-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['codex', shared],
    ['cursor', shared],
  ]);
  const hostDir = writeHostSkill(shared, 'group-fail');
  const now = '2026-01-01T00:00:00Z';
  const base = createInitialHostLandings(now, '0.4.0');
  const common = {
    skillId: 'group-fail',
    targetPath: hostDir,
    format: 'skill' as const,
    visibility: 'visible' as const,
    origin: 'adopted' as const,
    sourceChecksum: computeChecksum(hostDir),
    contentDigest: computeLandingChecksum({ targetPath: hostDir, format: 'skill' }),
    now,
  };
  const withRecords = applyHostLandingRecords(base, [
    buildHostLandingRecord({ ...common, hostId: 'codex' }),
    buildHostLandingRecord({ ...common, hostId: 'cursor' }),
  ]);
  saveHostLandings(join(root, 'host_landings.yaml'), {
    ...withRecords,
    landings: withRecords.landings.map((item) => ({
      ...item,
      state: item.host_id === 'codex' ? ('orphaned' as const) : ('active' as const),
    })),
  });
  const before = readFileSync(join(root, 'host_landings.yaml'));
  const preview = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  const item = itemsOf(preview.result)[0] as unknown as ReconcilePlanItem;
  const failed = cleanItem({
    item,
    layout: layoutOf(root),
    now,
    hooks: {
      beforeLedger: () => {
        throw new Error('injected shared ledger failure');
      },
    },
  });
  assert.equal(failed.result.status, 'failed');
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), before);
  assert.equal(existsSync(hostDir), true);
});

test('T4 共享根 forget：只把选中宿主记录转 orphaned，其他消费记录保留', async (t) => {
  const root = makeTempDir('sm-t4-forget-shared-');
  const shared = makeHostRoot('sm-t4-forget-shared-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['codex', shared],
    ['cursor', shared],
  ]);
  const source = makeSkillSource('forget-shared', {
    description: 'forget shared',
    content: '---\nname: forget-shared\ndescription: forget shared\n---\n\n# forget shared\n',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'codex', '--workspace', root, '--yes'])).code,
    0,
  );
  rmSync(join(shared, 'forget-shared'), { recursive: true, force: true });
  const forgotten = await json([
    'reconcile',
    '--action',
    'forget',
    '--id',
    'forget-shared',
    '--host',
    'codex',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(forgotten.code, 0, JSON.stringify(forgotten.result));
  assert.deepEqual(
    loadHostLandings(join(root, 'host_landings.yaml'))
      .index?.landings.filter((item) => item.skill_id === 'forget-shared')
      .map((item) => `${item.host_id}:${item.state}`)
      .sort(),
    ['codex:orphaned', 'cursor:active'],
  );
});

test('T4 插件 x-：repair/track/forget/clean 写 plugin_index，adopt/accept 拒绝', async (t) => {
  const root = makeTempDir('sm-t4-plugin-');
  t.after(isolateHostEnvironment(root));
  await capture(['init', '--workspace', root]);
  const plugin = makePluginDir('sm-t4-plugin-src-');
  writePluginManifest(plugin);
  assert.equal(
    (await capture(['install', plugin, '--kind', 'plugin', '--workspace', root, '--yes'])).code,
    0,
  );
  assert.equal(
    (await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  const source = makeSkillSource('plugin-action', {
    description: 'plugin action',
    content: '---\nname: plugin-action\ndescription: plugin action\n---\n\n# plugin action\n',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'x-acme-tools-zed', '--workspace', root, '--yes']))
      .code,
    0,
  );
  const rulePath = join(root, '.zed', 'rules', 'plugin-action.md');
  const hostBefore = readFileSync(join(root, 'host_landings.yaml'));
  assert.equal(existsSync(rulePath), true);

  rmSync(rulePath, { force: true });
  const repaired = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'plugin-action',
    '--host',
    'x-acme-tools-zed',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(repaired.code, 0, JSON.stringify(repaired.result));
  assert.equal(existsSync(rulePath), true);
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), hostBefore);

  const pluginIndex = loadPluginIndex(join(root, 'plugin_index.yaml')).index;
  assert.ok(pluginIndex);
  savePluginIndex(join(root, 'plugin_index.yaml'), {
    ...pluginIndex,
    landings: pluginIndex.landings.filter((item) => item.skill_id !== 'plugin-action'),
  });
  const tracked = await json([
    'reconcile',
    '--action',
    'track',
    '--path',
    rulePath,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(tracked.code, 0, JSON.stringify(tracked.result));
  assert.equal(
    loadPluginIndex(join(root, 'plugin_index.yaml')).index?.landings.find(
      (item) => item.skill_id === 'plugin-action',
    )?.state,
    'active',
  );
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), hostBefore);

  const adopt = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    rulePath,
    '--workspace',
    root,
  ]);
  assert.equal(itemsOf(adopt.result)[0]?.['status'], 'skipped');
  const accept = await json([
    'reconcile',
    '--action',
    'accept',
    '--path',
    rulePath,
    '--workspace',
    root,
  ]);
  assert.equal(itemsOf(accept.result)[0]?.['status'], 'skipped');

  rmSync(rulePath, { force: true });
  const forgotten = await json([
    'reconcile',
    '--action',
    'forget',
    '--id',
    'plugin-action',
    '--host',
    'x-acme-tools-zed',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(forgotten.code, 0, JSON.stringify(forgotten.result));
  assert.equal(
    loadPluginIndex(join(root, 'plugin_index.yaml')).index?.landings.find(
      (item) => item.skill_id === 'plugin-action',
    )?.state,
    'orphaned',
  );
});

test('T4 分类批量：指定宿主逐项执行，成功项不回滚', async (t) => {
  const root = makeTempDir('sm-t4-batch-');
  const hostRoot = makeHostRoot('sm-t4-batch-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['doubao', hostRoot]]);
  writeHostSkill(hostRoot, 'batch-a', { description: 'batch a' });
  writeHostSkill(hostRoot, 'batch-b', { description: 'batch b' });
  mkdirSync(join(root, '.claude', 'skills', 'batch-b'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'skills', 'batch-b', 'SKILL.md'),
    '---\nname: occupied-skill\ndescription: occupied\n---\n',
  );
  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--classification',
    'untracked',
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 1, JSON.stringify(applied.result));
  const results = (applied.result['data'] as { results?: Array<{ status: string }> }).results ?? [];
  assert.equal(results.length, 2);
  assert.equal(results.filter((item) => item.status === 'succeeded').length, 1);
  assert.equal(results.filter((item) => item.status === 'failed').length, 1);
  assert.equal(existsSync(join(root, 'skills', 'batch-a')), true);
  assert.equal(existsSync(join(root, 'skills', 'batch-b')), false);
});

test('T4 插件包禁用后的 orphaned 副本可由 clean 清理，插件包保留', async (t) => {
  const root = makeTempDir('sm-t4-plugin-clean-');
  t.after(isolateHostEnvironment(root));
  await capture(['init', '--workspace', root]);
  const plugin = makePluginDir('sm-t4-plugin-clean-src-');
  writePluginManifest(plugin);
  assert.equal(
    (await capture(['install', plugin, '--kind', 'plugin', '--workspace', root, '--yes'])).code,
    0,
  );
  assert.equal(
    (await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  const rulePath = join(root, '.zed', 'rules', 'plugin-orphan.md');
  mkdirSync(join(root, '.zed', 'rules'), { recursive: true });
  writeFileSync(rulePath, '---\ndescription: orphan\n---\n');
  const now = '2026-01-01T00:00:00Z';
  const loaded = loadPluginIndex(join(root, 'plugin_index.yaml')).index;
  assert.ok(loaded);
  const withLanding = upsertPluginLanding(loaded, {
    pluginId: 'acme-tools',
    skillId: 'plugin-orphan',
    hostId: 'x-acme-tools-zed',
    hostKey: 'zed',
    targetPath: rulePath,
    now,
  });
  savePluginIndex(join(root, 'plugin_index.yaml'), {
    ...withLanding,
    landings: withLanding.landings.map((item) => ({ ...item, state: 'orphaned' as const })),
  });
  assert.equal(
    (await capture(['disable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );

  const cleaned = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    rulePath,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(cleaned.code, 0, JSON.stringify(cleaned.result));
  assert.equal(existsSync(rulePath), false);
  const index = loadPluginIndex(join(root, 'plugin_index.yaml')).index;
  assert.equal(index?.landings.length, 0);
  assert.equal(
    index?.plugins.some((item) => item.id === 'acme-tools'),
    true,
  );
});
