import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { computeChecksum } from '../../kernel/core/integrity/index.ts';
import { loadIndex } from '../../kernel/core/index/index.ts';
import { loadHostLandings } from '../../kernel/store/host-landings/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeCorruptHostSkill, writeHostSkill } from '../helpers/host.ts';
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

async function json(
  argv: string[],
  interaction?: Interaction,
): Promise<{ code: number; result: Record<string, unknown> }> {
  const captured = await capture([...argv, '--json'], interaction);
  return {
    code: captured.code,
    result: JSON.parse(captured.out) as Record<string, unknown>,
  };
}

interface ReconciliationCopy {
  path: string;
  reconciliation: {
    classification: string;
    ledger_source: string;
    evidence: Record<string, string>;
  };
}

interface PlanItem {
  status: string;
  reason?: string;
  writes: Array<{ kind: string; path: string }>;
  after: { classification: string; authority: string };
}

interface ApplyData {
  applied: boolean;
  results: Array<{ status: string; findings?: Array<{ code: string }> }>;
  items: PlanItem[];
}

function inventoryCopies(result: Record<string, unknown>): ReconciliationCopy[] {
  const data = result['data'] as { copies?: ReconciliationCopy[] };
  return data.copies ?? [];
}

function itemOf(result: Record<string, unknown>): PlanItem {
  const data = result['data'] as { items?: PlanItem[] };
  return (data.items ?? [])[0] as PlanItem;
}

function applyOf(result: Record<string, unknown>): ApplyData {
  return result['data'] as ApplyData;
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

function ledger(root: string) {
  return loadHostLandings(join(root, 'host_landings.yaml')).index;
}

function hostBytes(root: string, id: string): string {
  return computeChecksum(join(root, id));
}

test('T2 adopt：untracked 导入中心库、unknown 元数据、索引与 adopted 账本', async (t) => {
  const root = makeTempDir('sm-adopt-e2e-');
  const hostRoot = makeHostRoot('sm-adopt-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const dir = writeHostSkill(hostRoot, 'adopt-skill', { description: 'adopt fixture' });
  const beforeHost = hostBytes(hostRoot, 'adopt-skill');

  const scanned = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(scanned.code, 0);
  assert.equal(
    inventoryCopies(scanned.result).find((copy) => copy.path === dir)?.reconciliation
      .classification,
    'untracked',
  );

  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const planned = itemOf(preview.result);
  assert.equal(planned.status, 'planned');
  assert.equal(planned.after.authority, 'inferred');
  assert.deepEqual(
    planned.writes.map((write) => write.kind),
    ['library', 'skill_meta', 'index', 'host_landings'],
  );

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(applyOf(applied.result).results[0]?.status, 'succeeded');
  assert.equal(existsSync(join(root, 'skills', 'adopt-skill', 'SKILL.md')), true);
  const meta = readFileSync(join(root, 'skills', 'adopt-skill', 'skill_meta.yaml'), 'utf8');
  assert.match(meta, /source:\n {2}type: unknown/);
  assert.doesNotMatch(meta, /\n\s+(url|ref|location):/);
  const index = loadIndex(join(root, 'skill_index.yaml')).index;
  assert.equal(index?.skills.find((record) => record.id === 'adopt-skill')?.source_type, 'unknown');
  const record = ledger(root)?.landings.find((landing) => landing.skill_id === 'adopt-skill');
  assert.equal(record?.state, 'active');
  assert.equal(record?.origin, 'adopted');
  assert.equal(record?.visibility, 'visible');
  assert.equal(hostBytes(hostRoot, 'adopt-skill'), beforeHost);

  const after = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(
    inventoryCopies(after.result).find((copy) => copy.path === dir)?.reconciliation.classification,
    'managed_consistent',
  );
});

test('T2 adopt：disabled 副本规范化入库，账本保留 disabled', async (t) => {
  const root = makeTempDir('sm-adopt-disabled-');
  const hostRoot = makeHostRoot('sm-adopt-disabled-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const dir = writeHostSkill(hostRoot, 'disabled-skill', { disabled: true });

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(existsSync(join(root, 'skills', 'disabled-skill', 'SKILL.md')), true);
  assert.equal(existsSync(join(root, 'skills', 'disabled-skill', 'SKILL.md.disabled')), false);
  const index = loadIndex(join(root, 'skill_index.yaml')).index;
  assert.equal(index?.skills.find((record) => record.id === 'disabled-skill')?.status, 'disabled');
  assert.equal(
    ledger(root)?.landings.find((landing) => landing.skill_id === 'disabled-skill')?.visibility,
    'disabled',
  );
  const after = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(
    inventoryCopies(after.result).find((copy) => copy.path === dir)?.reconciliation.classification,
    'managed_consistent',
  );
});

test('T2 track：只补账本，工作区、宿主与索引字节不变', async (t) => {
  const root = makeTempDir('sm-track-e2e-');
  const hostRoot = makeHostRoot('sm-track-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('track-skill', {
    description: 'track fixture',
    content: '---\nname: track-skill\ndescription: track fixture\n---\n\n# track-skill\n',
  });
  assert.equal((await capture(['install', source, '--workspace', root, '--yes'])).code, 0);
  const hostDir = join(hostRoot, 'track-skill');
  mkdirSync(hostDir, { recursive: true });
  copyFileSync(join(root, 'skills', 'track-skill', 'SKILL.md'), join(hostDir, 'SKILL.md'));

  const scanned = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(scanned.code, 0);
  assert.equal(
    inventoryCopies(scanned.result).find((copy) => copy.path === hostDir)?.reconciliation
      .classification,
    'inferred_consistent',
  );
  const indexBefore = readFileSync(join(root, 'skill_index.yaml'));
  const ledgerBefore = readFileSync(join(root, 'host_landings.yaml'));
  const libraryBefore = computeChecksum(join(root, 'skills', 'track-skill'));
  const hostBefore = computeChecksum(hostDir);

  const preview = await json([
    'reconcile',
    '--action',
    'track',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.equal(itemOf(preview.result).status, 'planned');
  assert.deepEqual(
    itemOf(preview.result).writes.map((write) => write.kind),
    ['host_landings'],
  );

  const applied = await json([
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
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(applyOf(applied.result).results[0]?.status, 'succeeded');
  assert.deepEqual(readFileSync(join(root, 'skill_index.yaml')), indexBefore);
  assert.notDeepEqual(readFileSync(join(root, 'host_landings.yaml')), ledgerBefore);
  assert.equal(computeChecksum(join(root, 'skills', 'track-skill')), libraryBefore);
  assert.equal(computeChecksum(hostDir), hostBefore);
  assert.equal(
    ledger(root)?.landings.find((landing) => landing.skill_id === 'track-skill')?.origin,
    'adopted',
  );
});

test('T2 adopt：已有工作区一致副本引导 track，不一致副本拒绝覆盖', async (t) => {
  const root = makeTempDir('sm-adopt-conflict-');
  const hostRoot = makeHostRoot('sm-adopt-conflict-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const source = makeSkillSource('conflict-skill', {
    description: 'conflict fixture',
    content: '---\nname: conflict-skill\ndescription: conflict fixture\n---\n\n# conflict-skill\n',
  });
  assert.equal((await capture(['install', source, '--workspace', root, '--yes'])).code, 0);
  const hostDir = join(hostRoot, 'conflict-skill');
  mkdirSync(hostDir, { recursive: true });
  copyFileSync(join(root, 'skills', 'conflict-skill', 'SKILL.md'), join(hostDir, 'SKILL.md'));

  const consistent = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(consistent.result).status, 'skipped');
  assert.equal(itemOf(consistent.result).reason, 'content_already_matches_use_track');

  writeFileSync(
    join(hostDir, 'SKILL.md'),
    '---\nname: conflict-skill\ndescription: changed\n---\n',
  );
  const drifted = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(drifted.result).status, 'skipped');
  assert.equal(itemOf(drifted.result).reason, 'content_differs_use_accept_or_repair');
});

test('T2 adopt：目标占用要求 --target，显式目标可成功', async (t) => {
  const root = makeTempDir('sm-adopt-target-');
  const hostRoot = makeHostRoot('sm-adopt-target-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const dir = writeHostSkill(hostRoot, 'target-skill');
  const occupied = join(root, '.claude', 'skills', 'target-skill');
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, 'SKILL.md'), '---\nname: other-skill\ndescription: occupied\n---\n');

  const blocked = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.notEqual(blocked.code, 0);
  assert.equal(applyOf(blocked.result).results[0]?.findings?.[0]?.code, 'E-CONFLICT-003');
  assert.equal(existsSync(join(root, 'skills', 'target-skill')), false);

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--target',
    'other',
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  const meta = readFileSync(join(root, 'skills', 'target-skill', 'skill_meta.yaml'), 'utf8');
  assert.match(meta, /target: other/);
  assert.match(meta, /path: \.other\/skills\/target-skill/);
});

test('T2 adopt：损坏副本与共享根均不执行写动作', async (t) => {
  const root = makeTempDir('sm-adopt-skip-');
  const hostRoot = makeHostRoot('sm-adopt-skip-host-');
  const shared = makeHostRoot('sm-adopt-shared-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['claude', hostRoot],
    ['cursor', shared],
    ['doubao', shared],
  ]);
  const broken = writeCorruptHostSkill(hostRoot, 'broken-adopt', 'bad-yaml');
  const sharedDir = writeHostSkill(shared, 'shared-adopt');

  const brokenPreview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    broken,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(brokenPreview.result).status, 'skipped');
  assert.equal(existsSync(join(root, 'skills', 'broken-adopt')), false);

  const sharedPreview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    sharedDir,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(sharedPreview.result).status, 'skipped');
  assert.equal(itemOf(sharedPreview.result).reason, 'shared_root_t4');
  assert.equal(existsSync(join(root, 'skills', 'shared-adopt')), false);
});

test('T2 多宿主同 id：adopt 一份后对第二份 track，不重复中心库', async (t) => {
  const root = makeTempDir('sm-adopt-multi-');
  const claudeRoot = makeHostRoot('sm-adopt-multi-claude-');
  const doubaoRoot = makeHostRoot('sm-adopt-multi-doubao-');
  t.after(isolateHostEnvironment(root));
  await init(root, [
    ['claude', claudeRoot],
    ['doubao', doubaoRoot],
  ]);
  const first = writeHostSkill(claudeRoot, 'multi-skill', { description: 'multi' });
  const second = writeHostSkill(doubaoRoot, 'multi-skill', { description: 'multi' });
  assert.equal(computeChecksum(first), computeChecksum(second));

  const adopted = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    first,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(adopted.code, 0, JSON.stringify(adopted.result));
  const scanned = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(
    inventoryCopies(scanned.result).find((copy) => copy.path === second)?.reconciliation
      .classification,
    'inferred_consistent',
  );

  const tracked = await json([
    'reconcile',
    '--action',
    'track',
    '--path',
    second,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(tracked.code, 0, JSON.stringify(tracked.result));
  assert.deepEqual(
    ledger(root)
      ?.landings.filter((landing) => landing.skill_id === 'multi-skill')
      .map((landing) => landing.host_id)
      .sort(),
    ['claude', 'doubao'],
  );
  assert.equal(existsSync(join(root, 'skills', 'multi-skill')), true);
});

test('T2 adopt：目录名与 frontmatter id 不一致时按 id 建立中心库', async (t) => {
  const root = makeTempDir('sm-adopt-dirname-');
  const hostRoot = makeHostRoot('sm-adopt-dirname-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const hostDir = join(hostRoot, 'weird-dir');
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(
    join(hostDir, 'SKILL.md'),
    '---\nname: canonical-id\ndescription: directory mismatch\n---\n\n# canonical\n',
  );

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    hostDir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(existsSync(join(root, 'skills', 'canonical-id', 'SKILL.md')), true);
  assert.equal(
    ledger(root)?.landings.find((landing) => landing.skill_id === 'canonical-id')?.target_path,
    hostDir,
  );
});

test('T2 adopt：中心库同名目录未登记时拒绝，不覆盖也不写账本', async (t) => {
  const root = makeTempDir('sm-adopt-library-conflict-');
  const hostRoot = makeHostRoot('sm-adopt-library-conflict-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const dir = writeHostSkill(hostRoot, 'library-conflict');
  const library = join(root, 'skills', 'library-conflict');
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, 'SKILL.md'), 'existing content');
  const ledgerBefore = readFileSync(join(root, 'host_landings.yaml'));

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.notEqual(applied.code, 0);
  assert.equal(applyOf(applied.result).results[0]?.findings?.[0]?.code, 'E-CONFLICT-001');
  assert.equal(readFileSync(join(library, 'SKILL.md'), 'utf8'), 'existing content');
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), ledgerBefore);
});

test('T2 track：untracked 与 inferred_drift 均拒绝补账本', async (t) => {
  const root = makeTempDir('sm-track-reject-');
  const hostRoot = makeHostRoot('sm-track-reject-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const loose = writeHostSkill(hostRoot, 'loose-track');
  const loosePreview = await json([
    'reconcile',
    '--action',
    'track',
    '--path',
    loose,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(loosePreview.result).status, 'skipped');
  assert.equal(itemOf(loosePreview.result).reason, 'content_not_in_workspace_use_adopt');

  const source = makeSkillSource('drift-track', {
    description: 'drift track',
    content: '---\nname: drift-track\ndescription: drift track\n---\n\n# drift-track\n',
  });
  assert.equal((await capture(['install', source, '--workspace', root, '--yes'])).code, 0);
  const hostDir = join(hostRoot, 'drift-track');
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(
    join(hostDir, 'SKILL.md'),
    '---\nname: drift-track\ndescription: changed\n---\n\n# changed\n',
  );
  const driftPreview = await json([
    'reconcile',
    '--action',
    'track',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(driftPreview.result).status, 'skipped');
  assert.equal(itemOf(driftPreview.result).reason, 'drift_use_accept_or_repair');
  assert.equal(ledger(root)?.landings.length, 0);
});

test('T2 adopt：预览后来源内容变化返回 E-RECONCILE-002 且零写入', async (t) => {
  const root = makeTempDir('sm-adopt-stale-');
  const hostRoot = makeHostRoot('sm-adopt-stale-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const dir = writeHostSkill(hostRoot, 'stale-adopt');
  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0);
  const interaction: Interaction = {
    interactive: true,
    write: () => undefined,
    read: async () => {
      writeFileSync(
        join(dir, 'SKILL.md'),
        '---\nname: stale-adopt\ndescription: changed after preview\n---\n\n# changed\n',
      );
      return 'y';
    },
  };
  const applied = await json(
    ['reconcile', '--action', 'adopt', '--path', dir, '--workspace', root, '--apply'],
    interaction,
  );
  assert.equal(applied.code, 1);
  assert.equal((applied.result['findings'] as Array<{ code: string }>)[0]?.code, 'E-RECONCILE-002');
  assert.equal(existsSync(join(root, 'skills', 'stale-adopt')), false);
  assert.equal(ledger(root)?.landings.length, 0);
});

test('T2 adopt：损坏账本在写中心库前中止且字节不变', async (t) => {
  const root = makeTempDir('sm-adopt-ledger-');
  const hostRoot = makeHostRoot('sm-adopt-ledger-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, [['claude', hostRoot]]);
  const dir = writeHostSkill(hostRoot, 'broken-ledger-adopt');
  const ledgerPath = join(root, 'host_landings.yaml');
  writeFileSync(ledgerPath, 'schema_version: [broken\n');
  const before = readFileSync(ledgerPath);

  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    dir,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.notEqual(applied.code, 0);
  assert.equal(applyOf(applied.result).results[0]?.findings?.[0]?.code, 'E-LANDING-001');
  assert.equal(existsSync(join(root, 'skills', 'broken-ledger-adopt')), false);
  assert.deepEqual(readFileSync(ledgerPath), before);
});
