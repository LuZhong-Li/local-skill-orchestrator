import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { loadHostLandings } from '../../kernel/store/host-landings/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type { Interaction } from '../../kernel/dispatch/policy/index.ts';

async function capture(
  argv: string[],
  interaction?: Interaction,
): Promise<{ code: number; out: string }> {
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
  const captured = await capture([...argv, '--json'], interaction);
  return {
    code: captured.code,
    result: JSON.parse(captured.out) as Record<string, unknown>,
  };
}

function setup(id = 'repair-skill') {
  const root = makeTempDir('sm-repair-e2e-');
  const hostRoot = makeHostRoot('sm-repair-host-');
  const source = makeSkillSource(id, { description: `${id} fixture` });
  return { root, hostRoot, source, id };
}

async function initWithHost(root: string, hostRoot: string): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.doubao.root', hostRoot, '--workspace', root])).code,
    0,
  );
}

function hostLedger(root: string) {
  return loadHostLandings(join(root, 'host_landings.yaml')).index;
}

test('T1 repair：missing 副本重建并写回 active 账本', async (t) => {
  const { root, hostRoot, source, id } = setup();
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  rmSync(join(hostRoot, id), { recursive: true, force: true });

  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    id,
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(existsSync(join(hostRoot, id, 'SKILL.md')), true);
  const record = hostLedger(root)?.landings.find((item) => item.skill_id === id);
  assert.equal(record?.state, 'active');
  assert.equal(record?.visibility, 'visible');
  const data = applied.result['data'] as {
    applied: boolean;
    results: Array<{ status: string }>;
  };
  assert.equal(data.applied, true);
  assert.equal(data.results[0]?.status, 'succeeded');
});

test('T1 repair：not_distributed、drift 与 orphaned 可按工作区恢复', async (t) => {
  const { root, hostRoot, source, id } = setup('repair-modes');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  assert.equal((await capture(['install', source, '--workspace', root, '--yes'])).code, 0);
  const first = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    id,
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(first.code, 0, JSON.stringify(first.result));
  assert.equal(existsSync(join(hostRoot, id, 'SKILL.md')), true);

  writeFileSync(
    join(hostRoot, id, 'SKILL.md'),
    `---\nname: ${id}\ndescription: changed\n---\n# changed\n`,
  );
  const drift = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    id,
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(drift.code, 0, JSON.stringify(drift.result));
  assert.match(readFileSync(join(hostRoot, id, 'SKILL.md'), 'utf8'), /# repair-modes/);

  assert.equal(
    (await capture(['uninstall', id, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  const orphaned = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    id,
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(orphaned.code, 0, JSON.stringify(orphaned.result));
  assert.equal(hostLedger(root)?.landings.find((item) => item.skill_id === id)?.state, 'active');
});

test('T1 repair：visibility drift 按工作区恢复可见性', async (t) => {
  const { root, hostRoot, source, id } = setup('repair-visibility');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  renameSync(join(hostRoot, id, 'SKILL.md'), join(hostRoot, id, 'SKILL.md.disabled'));
  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    id,
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(existsSync(join(hostRoot, id, 'SKILL.md')), true);
  assert.equal(existsSync(join(hostRoot, id, 'SKILL.md.disabled')), false);
});

test('T1 repair：损坏副本在有工作区基线时按 path 重建', async (t) => {
  const { root, hostRoot, source, id } = setup('repair-corrupt');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  writeFileSync(join(hostRoot, id, 'SKILL.md'), '---\nname: [bad\n---\n');
  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--path',
    join(hostRoot, id),
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.match(readFileSync(join(hostRoot, id, 'SKILL.md'), 'utf8'), /# repair-corrupt/);
});

test('T1 repair：目标被文件占用时失败并保留原账本与占用文件', async (t) => {
  const { root, hostRoot, source, id } = setup('repair-occupied');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  rmSync(join(hostRoot, id), { recursive: true, force: true });
  writeFileSync(join(hostRoot, id), 'occupied');
  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    id,
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.notEqual(applied.code, 0);
  assert.equal(readFileSync(join(hostRoot, id), 'utf8'), 'occupied');
  assert.equal(hostLedger(root)?.landings.find((item) => item.skill_id === id)?.state, 'active');
  const data = applied.result['data'] as { applied: boolean };
  assert.equal(data.applied, false);
});

test('T1 repair：预览后宿主内容变化时拒绝执行旧计划', async (t) => {
  const { root, hostRoot, source, id } = setup('repair-stale');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  renameSync(join(hostRoot, id, 'SKILL.md'), join(hostRoot, id, 'SKILL.md.disabled'));
  const interaction: Interaction = {
    interactive: true,
    write: () => undefined,
    read: async () => {
      renameSync(join(hostRoot, id, 'SKILL.md.disabled'), join(hostRoot, id, 'SKILL.md'));
      return 'y';
    },
  };
  const applied = await json(
    [
      'reconcile',
      '--action',
      'repair',
      '--id',
      id,
      '--host',
      'doubao',
      '--workspace',
      root,
      '--apply',
    ],
    interaction,
  );
  assert.equal(applied.code, 1);
  const findings = applied.result['findings'] as Array<{ code: string }>;
  assert.equal(findings[0]?.code, 'E-RECONCILE-002');
});

test('T1 forget：仅账本转 orphaned，不删除或改写磁盘', async (t) => {
  const { root, hostRoot, source, id } = setup('forget-skill');
  t.after(isolateHostEnvironment(root));
  await initWithHost(root, hostRoot);
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  rmSync(join(hostRoot, id), { recursive: true, force: true });
  const indexBefore = readFileSync(join(root, 'skill_index.yaml'));
  const hostBefore = readFileSync(join(root, 'host_landings.yaml'));
  const applied = await json([
    'reconcile',
    '--action',
    'forget',
    '--id',
    id,
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.deepEqual(readFileSync(join(root, 'skill_index.yaml')), indexBefore);
  assert.equal(existsSync(join(hostRoot, id)), false);
  assert.equal(hostLedger(root)?.landings.find((item) => item.skill_id === id)?.state, 'orphaned');
  assert.notDeepEqual(readFileSync(join(root, 'host_landings.yaml')), hostBefore);
});

test('T1 边界：共享根 repair 留到 T4，apply 只返回 skipped 不写盘', async (t) => {
  const root = makeTempDir('sm-repair-shared-');
  const shared = makeHostRoot('sm-repair-shared-host-');
  const source = makeSkillSource('shared-repair-skill', { description: 'shared' });
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.codex.root', shared, '--workspace', root])).code,
    0,
  );
  assert.equal(
    (await capture(['config', 'set', 'host.cursor.root', shared, '--workspace', root])).code,
    0,
  );
  assert.equal(
    (await capture(['install', source, '--host', 'codex', '--workspace', root, '--yes'])).code,
    0,
  );
  const before = readFileSync(join(root, 'host_landings.yaml'));
  const applied = await json([
    'reconcile',
    '--action',
    'repair',
    '--id',
    'shared-repair-skill',
    '--host',
    'codex',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  const data = applied.result['data'] as {
    applied: boolean;
    items: Array<{ status: string; reason: string }>;
  };
  assert.equal(data.applied, false);
  assert.equal(data.items[0]?.status, 'skipped');
  assert.equal(data.items[0]?.reason, 'shared_root_t4');
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), before);
});
