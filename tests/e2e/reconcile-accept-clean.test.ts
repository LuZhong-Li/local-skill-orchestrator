import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { cleanItem } from '../../kernel/dispatch/reconcile/clean.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import {
  createInitialHostLandings,
  loadHostLandings,
  saveHostLandings,
} from '../../kernel/store/host-landings/index.ts';
import {
  applyHostLandingRecords,
  buildHostLandingRecord,
} from '../../kernel/core/host-landings/index.ts';
import { TOOL_VERSION, loadIndex, saveIndex } from '../../kernel/core/index/index.ts';
import { computeChecksum, computeLandingChecksum } from '../../kernel/core/integrity/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot, writeCorruptHostSkill, writeHostSkill } from '../helpers/host.ts';
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
  return {
    code: captured.code,
    result: JSON.parse(captured.out) as Record<string, unknown>,
  };
}

interface PlanItem {
  status: string;
  reason?: string;
  after: { classification: string };
  writes: Array<{ kind: string }>;
  backups: string[];
}

interface ApplyData {
  applied: boolean;
  results: Array<{ status: string; message?: string; changes?: Array<{ kind: string }> }>;
}

function itemOf(result: Record<string, unknown>): PlanItem {
  const data = result['data'] as { items?: PlanItem[] };
  return (data.items ?? [])[0] as PlanItem;
}

function applyOf(result: Record<string, unknown>): ApplyData {
  return result['data'] as ApplyData;
}

async function init(root: string, hostRoot: string): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.doubao.root', hostRoot, '--workspace', root])).code,
    0,
  );
}

function ledger(root: string) {
  return loadHostLandings(join(root, 'host_landings.yaml')).index;
}

function classificationAt(result: Record<string, unknown>, path: string): string | undefined {
  const data = result['data'] as {
    copies?: Array<{ path: string; reconciliation: { classification: string } }>;
  };
  return (data.copies ?? []).find((item) => item.path === path)?.reconciliation.classification;
}

function indexRecord(root: string, id: string) {
  return loadIndex(join(root, 'skill_index.yaml')).index?.skills.find((item) => item.id === id);
}

function ledgerRecord(root: string, id: string) {
  return ledger(root)?.landings.find((landing) => landing.skill_id === id);
}

test('T3 accept content：宿主内容覆盖中心库、保留元文件、更新索引与账本并留备份', async (t) => {
  const root = makeTempDir('sm-accept-content-');
  const hostRoot = makeHostRoot('sm-accept-content-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const source = makeSkillSource('accept-skill', {
    description: 'accept source',
    content: '---\nname: accept-skill\ndescription: accept source\n---\n\n# source\n',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  const hostDir = join(hostRoot, 'accept-skill');
  writeFileSync(
    join(hostDir, 'SKILL.md'),
    '---\nname: accept-skill\ndescription: host accepted\n---\n\n# accepted\n',
  );
  const metaBefore = readFileSync(join(root, 'skills', 'accept-skill', 'skill_meta.yaml'));
  const scanned = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(scanned.code, 0);
  assert.equal(classificationAt(scanned.result, hostDir), 'drift');

  const preview = await json([
    'reconcile',
    '--action',
    'accept',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.equal(itemOf(preview.result).status, 'planned');
  assert.equal(itemOf(preview.result).backups.length, 1);

  const applied = await json([
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
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  const appliedItem = applyOf(applied.result).results[0];
  assert.ok(appliedItem);
  assert.equal(appliedItem.status, 'succeeded');
  assert.match(appliedItem.message ?? '', /下次 update/);
  assert.equal(
    readFileSync(join(root, 'skills', 'accept-skill', 'SKILL.md'), 'utf8'),
    readFileSync(join(hostDir, 'SKILL.md'), 'utf8'),
  );
  assert.deepEqual(
    readFileSync(join(root, 'skills', 'accept-skill', 'skill_meta.yaml')),
    metaBefore,
  );
  const backupEntries = readdirSync(join(root, 'backups', 'accept-skill'));
  assert.ok(backupEntries.length > 0);
  const record = indexRecord(root, 'accept-skill');
  assert.ok(record);
  assert.equal(record.checksum, computeChecksum(join(root, 'skills', 'accept-skill')));
  const landing = ledgerRecord(root, 'accept-skill');
  assert.ok(landing);
  assert.equal(
    landing.content_digest,
    computeLandingChecksum({ targetPath: hostDir, format: 'skill' }),
  );
  const after = await json(['scan', '--inventory', '--workspace', root]);
  assert.equal(classificationAt(after.result, hostDir), 'managed_consistent');
});

test('T3 accept visibility：只同步状态与账本，中心库和宿主内容不变', async (t) => {
  const root = makeTempDir('sm-accept-visibility-');
  const hostRoot = makeHostRoot('sm-accept-visibility-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const source = makeSkillSource('visible-skill', {
    description: 'visibility source',
    content: '---\nname: visible-skill\ndescription: visibility source\n---\n\n# visible\n',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  const hostDir = join(hostRoot, 'visible-skill');
  renameSync(join(hostDir, 'SKILL.md'), join(hostDir, 'SKILL.md.disabled'));
  const libraryBefore = computeChecksum(join(root, 'skills', 'visible-skill'));
  const hostBefore = computeChecksum(hostDir);

  const applied = await json([
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
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(computeChecksum(join(root, 'skills', 'visible-skill')), libraryBefore);
  assert.equal(computeChecksum(hostDir), hostBefore);
  assert.equal(
    loadIndex(join(root, 'skill_index.yaml')).index?.skills.find(
      (item) => item.id === 'visible-skill',
    )?.status,
    'disabled',
  );
  assert.equal(
    ledger(root)?.landings.find((landing) => landing.skill_id === 'visible-skill')?.visibility,
    'disabled',
  );
});

test('T3 accept：source/version drift 拒绝，提示 repair 且零写入', async (t) => {
  const root = makeTempDir('sm-accept-source-');
  const hostRoot = makeHostRoot('sm-accept-source-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const source = makeSkillSource('source-skill', {
    description: 'source drift',
    content: '---\nname: source-skill\ndescription: source drift\n---\n\n# source\n',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  const hostDir = join(hostRoot, 'source-skill');
  const index = loadIndex(join(root, 'skill_index.yaml')).index;
  assert.ok(index !== null);
  const changed = {
    ...index,
    skills: index.skills.map((record) =>
      record.id === 'source-skill' ? { ...record, version: '9.9.9' } : record,
    ),
  };
  saveIndex(join(root, 'skill_index.yaml'), changed);
  const preview = await json([
    'reconcile',
    '--action',
    'accept',
    '--path',
    hostDir,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(preview.result).status, 'skipped');
  assert.equal(itemOf(preview.result).reason, 'accept_only_content_or_visibility');
});

test('T3 accept 失败注入：备份失败时中心库/索引/账本不变且暂存清理', async (t) => {
  const root = makeTempDir('sm-accept-backup-fail-');
  const hostRoot = makeHostRoot('sm-accept-backup-fail-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const source = makeSkillSource('backup-fail-skill', {
    description: 'backup fail',
    content: '---\nname: backup-fail-skill\ndescription: backup fail\n---\n\n# source\n',
  });
  assert.equal(
    (await capture(['install', source, '--host', 'doubao', '--workspace', root, '--yes'])).code,
    0,
  );
  const hostDir = join(hostRoot, 'backup-fail-skill');
  writeFileSync(
    join(hostDir, 'SKILL.md'),
    '---\nname: backup-fail-skill\ndescription: changed\n---\n\n# changed\n',
  );
  const libraryDir = join(root, 'skills', 'backup-fail-skill');
  const libraryBefore = computeChecksum(libraryDir);
  const indexBefore = readFileSync(join(root, 'skill_index.yaml'));
  const ledgerBefore = readFileSync(join(root, 'host_landings.yaml'));
  rmSync(join(root, 'backups'), { recursive: true, force: true });
  writeFileSync(join(root, 'backups'), 'blocked');

  const applied = await json([
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
  assert.notEqual(applied.code, 0);
  assert.equal(computeChecksum(libraryDir), libraryBefore);
  assert.deepEqual(readFileSync(join(root, 'skill_index.yaml')), indexBefore);
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), ledgerBefore);
  assert.equal(
    readdirSync(join(root, 'skills')).filter((name) => name.startsWith('.accept-')).length,
    0,
  );
});

test('T3 clean：orphaned 无工作区副本移走、清账本并删除临时快照', async (t) => {
  const root = makeTempDir('sm-clean-orphan-');
  const hostRoot = makeHostRoot('sm-clean-orphan-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const hostDir = writeHostSkill(hostRoot, 'orphan-skill');
  const now = '2026-01-01T00:00:00Z';
  const base = createInitialHostLandings(now, TOOL_VERSION);
  const record = buildHostLandingRecord({
    skillId: 'orphan-skill',
    hostId: 'doubao',
    targetPath: hostDir,
    format: 'skill',
    visibility: 'visible',
    origin: 'adopted',
    sourceChecksum: computeChecksum(hostDir),
    contentDigest: computeLandingChecksum({ targetPath: hostDir, format: 'skill' }),
    now,
  });
  const withRecord = applyHostLandingRecords(base, [record]);
  saveHostLandings(join(root, 'host_landings.yaml'), {
    ...withRecord,
    landings: withRecord.landings.map((item) => ({ ...item, state: 'orphaned' as const })),
  });

  const applied = await json([
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
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal(existsSync(hostDir), false);
  assert.equal(ledger(root)?.landings.length, 0);
  assert.equal(readdirSync(hostRoot).filter((name) => name.startsWith('.clean-')).length, 0);
});

test('T3 clean：无基线损坏副本可删除，未纳管副本不被分类/批量误删', async (t) => {
  const root = makeTempDir('sm-clean-corrupt-');
  const hostRoot = makeHostRoot('sm-clean-corrupt-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const broken = writeCorruptHostSkill(hostRoot, 'broken-clean', 'bad-yaml');
  const untracked = writeHostSkill(hostRoot, 'untracked-clean');

  const blocked = await capture([
    'reconcile',
    '--action',
    'clean',
    '--classification',
    'unreadable',
    '--host',
    'doubao',
    '--workspace',
    root,
    '--apply',
    '--yes',
    '--json',
  ]);
  assert.equal(blocked.code, 2);
  const untrackedPreview = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    untracked,
    '--workspace',
    root,
  ]);
  assert.equal(itemOf(untrackedPreview.result).status, 'skipped');
  assert.equal(itemOf(untrackedPreview.result).reason, 'clean_only_orphaned_or_unreadable');

  const cleaned = await json([
    'reconcile',
    '--action',
    'clean',
    '--path',
    broken,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(cleaned.code, 0, JSON.stringify(cleaned.result));
  assert.equal(existsSync(broken), false);
  assert.equal(existsSync(untracked), true);
});

test('T3 clean 失败注入：账本失败与删除失败均恢复副本/账本且无快照残留', async (t) => {
  const root = makeTempDir('sm-clean-inject-');
  const hostRoot = makeHostRoot('sm-clean-inject-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const hostDir = writeHostSkill(hostRoot, 'inject-clean');
  const now = '2026-01-01T00:00:00Z';
  const base = createInitialHostLandings(now, TOOL_VERSION);
  const record = buildHostLandingRecord({
    skillId: 'inject-clean',
    hostId: 'doubao',
    targetPath: hostDir,
    format: 'skill',
    visibility: 'visible',
    origin: 'adopted',
    sourceChecksum: computeChecksum(hostDir),
    contentDigest: computeLandingChecksum({ targetPath: hostDir, format: 'skill' }),
    now,
  });
  const withRecord = applyHostLandingRecords(base, [record]);
  saveHostLandings(join(root, 'host_landings.yaml'), {
    ...withRecord,
    landings: withRecord.landings.map((item) => ({ ...item, state: 'orphaned' as const })),
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
  const planItem = (preview.result['data'] as { items: ReconcilePlanItem[] }).items[0];
  const ledgerBefore = readFileSync(join(root, 'host_landings.yaml'));

  const ledgerFailure = cleanItem({
    item: planItem,
    layout: layoutOf(root),
    now,
    hooks: {
      beforeLedger: () => {
        throw new Error('injected ledger failure');
      },
    },
  });
  assert.equal(ledgerFailure.result.status, 'failed');
  assert.equal(existsSync(hostDir), true);
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), ledgerBefore);

  const deleteFailure = cleanItem({
    item: planItem,
    layout: layoutOf(root),
    now,
    hooks: {
      beforeDelete: () => {
        throw new Error('injected delete failure');
      },
    },
  });
  assert.equal(deleteFailure.result.status, 'failed');
  assert.equal(existsSync(hostDir), true);
  assert.deepEqual(readFileSync(join(root, 'host_landings.yaml')), ledgerBefore);
  assert.equal(readdirSync(hostRoot).filter((name) => name.startsWith('.clean-')).length, 0);
});
