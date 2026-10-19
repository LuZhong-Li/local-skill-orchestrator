import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { computeChecksum, computeLandingChecksum } from '../../kernel/core/integrity/index.ts';
import {
  applyHostLandingRecords,
  buildHostLandingRecord,
} from '../../kernel/core/host-landings/index.ts';
import {
  createInitialHostLandings,
  loadHostLandings,
  saveHostLandings,
} from '../../kernel/store/host-landings/index.ts';
import { TOOL_VERSION } from '../../kernel/core/index/index.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { writeCorruptHostSkill, writeHostSkill } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { snapshotTree } from '../helpers/snapshot.ts';
import { makeTempDir } from '../helpers/temp.ts';
import type {
  HostRootRole,
  ReconcileApplyData,
  ReconcilePreviewData,
} from '@skill-manager/contract';
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

async function json(argv: string[]) {
  const result = await capture([...argv, '--json']);
  return { code: result.code, result: JSON.parse(result.out) as Record<string, unknown> };
}

function contentSnapshot(root: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(snapshotTree(root)).map(([key, value]) => [
      key,
      { type: value.type, size: value.size, hash: value.hash, target: value.target },
    ]),
  );
}

async function expectSkipped(
  root: string,
  roleRoot: string,
  role: HostRootRole,
  action: string,
  args: string[],
): Promise<void> {
  const preview = await json(['reconcile', '--action', action, ...args, '--workspace', root]);
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  const data = preview.result['data'] as ReconcilePreviewData;
  const item = data.items[0];
  assert.equal(item?.status, 'skipped', `${role}/${action}`);
  assert.equal(item?.reason, 'non_user_role_read_only', `${role}/${action}`);
  assert.deepEqual(item?.writes, [], `${role}/${action} writes`);
  assert.deepEqual(item?.ledger_changes, [], `${role}/${action} ledger`);
  assert.ok(item?.root_roles.includes(role), `${role}/${action} root_roles`);

  const beforeRoot = contentSnapshot(roleRoot);
  const beforeWorkspace = contentSnapshot(root);
  const applied = await json([
    'reconcile',
    '--action',
    action,
    ...args,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  assert.equal((applied.result['data'] as ReconcileApplyData).applied, false);
  assert.deepEqual(contentSnapshot(roleRoot), beforeRoot, `${role}/${action} role bytes`);
  assert.deepEqual(contentSnapshot(root), beforeWorkspace, `${role}/${action} workspace bytes`);
}

function addLedgerRecord(root: string, hostId: string, hostDir: string, skillId: string): void {
  const now = '2026-01-01T00:00:00Z';
  const path = join(root, 'host_landings.yaml');
  const base = loadHostLandings(path).index ?? createInitialHostLandings(now, TOOL_VERSION);
  const record = buildHostLandingRecord({
    skillId,
    hostId,
    targetPath: hostDir,
    format: 'skill',
    visibility: 'visible',
    origin: 'adopted',
    sourceChecksum: computeChecksum(hostDir),
    contentDigest: computeLandingChecksum({ targetPath: hostDir, format: 'skill' }),
    now,
  });
  saveHostLandings(path, { ...applyHostLandingRecords(base, [record]), generated_at: now });
}

interface RoleFixture {
  name: HostRootRole;
  host: string;
  root: string;
  enabled: boolean;
}

function ensureRoleCopy(root: string, role: RoleFixture, id: string): string {
  const dir = join(role.root, id);
  if (!existsSync(join(dir, 'SKILL.md'))) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(root, 'skills', id, 'SKILL.md'), join(dir, 'SKILL.md'));
  }
  return dir;
}

async function checkRoleActions(root: string, role: RoleFixture): Promise<void> {
  const adoptDir = writeHostSkill(role.root, `adopt-${role.name}`);
  await expectSkipped(root, role.root, role.name, 'adopt', ['--path', adoptDir]);

  const trackId = `track-${role.name}`;
  const trackSource = makeSkillSource(trackId, {
    description: `${trackId} fixture`,
    content: `---\nname: ${trackId}\ndescription: ${trackId} fixture\n---\n\n# ${trackId}\n`,
  });
  assert.equal((await capture(['install', trackSource, '--workspace', root, '--yes'])).code, 0);
  const trackDir = ensureRoleCopy(root, role, trackId);
  await expectSkipped(root, role.root, role.name, 'track', ['--path', trackDir]);

  const repairId = `repair-${role.name}`;
  const repairSource = makeSkillSource(repairId, { description: `${repairId} fixture` });
  assert.equal(
    (await capture(['install', repairSource, '--library-only', '--workspace', root, '--yes'])).code,
    0,
  );
  await expectSkipped(root, role.root, role.name, 'repair', [
    '--id',
    repairId,
    '--host',
    role.host,
    '--root',
    role.root,
  ]);

  const acceptId = `accept-${role.name}`;
  const acceptSource = makeSkillSource(acceptId, { description: `${acceptId} fixture` });
  assert.equal((await capture(['install', acceptSource, '--workspace', root, '--yes'])).code, 0);
  const acceptDir = ensureRoleCopy(root, role, acceptId);
  writeFileSync(join(acceptDir, 'SKILL.md'), `---\nname: ${acceptId}\ndescription: drifted\n---\n`);
  await expectSkipped(root, role.root, role.name, 'accept', ['--path', acceptDir]);

  const cleanDir = writeCorruptHostSkill(role.root, `clean-${role.name}`, 'bad-yaml');
  await expectSkipped(root, role.root, role.name, 'clean', ['--path', cleanDir]);

  const forgetId = `forget-${role.name}`;
  const forgetSource = makeSkillSource(forgetId, { description: `${forgetId} fixture` });
  assert.equal(
    (await capture(['install', forgetSource, '--library-only', '--workspace', root, '--yes'])).code,
    0,
  );
  const forgetDir = writeHostSkill(role.root, forgetId);
  addLedgerRecord(root, role.host, forgetDir, forgetId);
  rmSync(forgetDir, { recursive: true, force: true });
  await expectSkipped(root, role.root, role.name, 'forget', ['--path', forgetDir]);
}

async function configureSharedRoots(root: string, shared: string): Promise<void> {
  for (const host of ['codex', 'cursor']) {
    assert.equal(
      (await capture(['config', 'set', `host.${host}.root`, shared, '--workspace', root])).code,
      0,
    );
  }
}

function linkProjectToShared(shared: string, projectAgents: string): boolean {
  mkdirSync(join(projectAgents, '..'), { recursive: true });
  try {
    symlinkSync(shared, projectAgents, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

test('dogfood：六动作对 system / platform / project 副本全部 skipped 且零写入', async (t) => {
  const root = makeTempDir('sm-role-guard-');
  t.after(isolateHostEnvironment(root));
  await capture(['init', '--workspace', root]);
  const home = join(root, 'home');
  const local = join(root, 'local');
  const roles: RoleFixture[] = [
    {
      name: 'system',
      host: 'codex',
      root: join(home, '.codex', 'skills', '.system'),
      enabled: true,
    },
    {
      name: 'platform',
      host: 'doubao',
      root: join(
        local,
        'Doubao',
        'User Data',
        'Default',
        '.doubao',
        'agent_mode',
        'workspace',
        '.skills',
      ),
      enabled: process.platform === 'win32',
    },
    {
      name: 'project',
      host: 'claude',
      root: join(root, '.claude', 'skills'),
      enabled: true,
    },
  ];

  for (const role of roles.filter((item) => item.enabled)) {
    mkdirSync(role.root, { recursive: true });
    await checkRoleActions(root, role);
  }
});

test('dogfood：共享根混入非 user 角色时整组保守跳过并告警', async (t) => {
  const root = makeTempDir('sm-role-mixed-');
  t.after(isolateHostEnvironment(root));
  await capture(['init', '--workspace', root]);
  const shared = join(root, 'shared');
  mkdirSync(shared, { recursive: true });
  await configureSharedRoots(root, shared);
  const projectAgents = join(root, '.agents', 'skills');
  if (!linkProjectToShared(shared, projectAgents)) {
    t.skip('当前平台无法创建目录链接，混合角色由内核 root_roles 合并测试覆盖');
    return;
  }
  const mixedDir = writeHostSkill(shared, 'mixed-role-skill');
  const preview = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    mixedDir,
    '--workspace',
    root,
  ]);
  const data = preview.result['data'] as ReconcilePreviewData;
  const item = data.items[0];
  assert.equal(preview.code, 0, JSON.stringify(preview.result));
  assert.equal(item?.status, 'skipped');
  assert.equal(item?.reason, 'non_user_role_read_only');
  assert.ok(item?.root_roles.includes('user'));
  assert.ok(item?.root_roles.includes('project'));
  assert.ok(item?.warnings.includes('shared_root_non_user_role'));
  assert.deepEqual(item?.writes, []);
});
