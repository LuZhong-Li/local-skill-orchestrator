import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { makeTempDir } from '../helpers/temp.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { computeChecksum, computeLandingChecksum } from '../../kernel/core/integrity/index.ts';
import type { HostLanding, HostLandingIndex } from '../../contract/src/index.ts';

const CLI = fileURLToPath(new URL('../../kernel/entry/cli.ts', import.meta.url));

function runCli(
  root: string,
  argv: string[],
): { code: number; result: Record<string, unknown>; stderr: string } {
  const child = spawnSync(process.execPath, [CLI, ...argv, '--workspace', root, '--json'], {
    encoding: 'utf8',
  });
  const text = child.stdout.trim();
  return {
    code: child.status ?? -1,
    result: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    stderr: child.stderr,
  };
}

function ledger(root: string): HostLandingIndex {
  return parseYaml(readFileSync(join(root, 'host_landings.yaml'), 'utf8')) as HostLandingIndex;
}

function recordsOf(root: string, skillId: string): HostLanding[] {
  return ledger(root).landings.filter((item) => item.skill_id === skillId);
}

function claudeRecord(root: string, skillId: string): HostLanding {
  const found = recordsOf(root, skillId).find((item) => item.host_id === 'claude');
  assert.ok(found);
  return found;
}

function setupHost(): { root: string; hostRoot: string } {
  const root = makeTempDir('sm-l2-e2e-');
  const hostRoot = makeHostRoot('sm-l2-host-');
  assert.equal(runCli(root, ['init']).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.claude.root', hostRoot]).code, 0);
  return { root, hostRoot };
}

test('L-2 e2e：install/disable/enable/update 写账本且摘要同源', () => {
  const { root, hostRoot } = setupHost();
  const source = makeSkillSource('ledger-skill', { description: '账本链路' });
  assert.equal(runCli(root, ['install', source, '--host', 'claude', '--yes']).code, 0);

  const record = claudeRecord(root, 'ledger-skill');
  assert.equal(record.host_id, 'claude');
  assert.equal(record.target_path, join(hostRoot, 'ledger-skill'));
  assert.equal(record.format, 'skill');
  assert.equal(record.visibility, 'visible');
  assert.equal(record.state, 'active');
  assert.equal(record.origin, 'distributed');
  assert.equal(
    record.content_digest,
    computeLandingChecksum({ targetPath: record.target_path, format: 'skill' }),
  );
  assert.equal(record.source_checksum, computeChecksum(join(root, 'skills', 'ledger-skill')));

  const digest = record.content_digest;
  assert.equal(runCli(root, ['disable', 'ledger-skill', '--host', 'claude', '--yes']).code, 0);
  const disabled = claudeRecord(root, 'ledger-skill');
  assert.equal(disabled.visibility, 'disabled');
  assert.equal(disabled.content_digest, digest, '可见性切换不得改变摘要');
  assert.equal(existsSync(join(hostRoot, 'ledger-skill', 'SKILL.md.disabled')), true);

  assert.equal(runCli(root, ['enable', 'ledger-skill', '--host', 'claude', '--yes']).code, 0);
  assert.equal(claudeRecord(root, 'ledger-skill').visibility, 'visible');
  assert.equal(runCli(root, ['update', 'ledger-skill', '--host', 'claude', '--yes']).code, 0);
  const updated = claudeRecord(root, 'ledger-skill');
  assert.equal(updated.content_digest, digest);
  assert.equal(
    updated.content_digest,
    computeLandingChecksum({ targetPath: updated.target_path, format: 'skill' }),
  );
});

test('L-2 e2e：共享根一次写盘、多宿主记录同步', () => {
  const root = makeTempDir('sm-l2-e2e-');
  const shared = makeHostRoot('sm-l2-shared-');
  assert.equal(runCli(root, ['init']).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.codex.root', shared]).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.cursor.root', shared]).code, 0);
  const source = makeSkillSource('shared-ledger-skill', { description: '共享根' });
  assert.equal(runCli(root, ['install', source, '--host', 'codex', '--yes']).code, 0);

  const records = recordsOf(root, 'shared-ledger-skill');
  assert.deepEqual(
    records.map((item) => item.host_id).sort(),
    ['codex', 'cursor'],
    '共享根应按消费宿主各记一条',
  );
  assert.equal(new Set(records.map((item) => item.target_path)).size, 1);
  assert.equal(new Set(records.map((item) => item.content_digest)).size, 1);
  assert.equal(existsSync(join(shared, 'shared-ledger-skill', 'SKILL.md')), true);

  assert.equal(
    runCli(root, ['disable', 'shared-ledger-skill', '--host', 'codex', '--yes']).code,
    0,
  );
  assert.deepEqual(
    recordsOf(root, 'shared-ledger-skill').map((item) => item.visibility),
    ['disabled', 'disabled'],
    '共享根可见性必须整体同步',
  );
  assert.equal(existsSync(join(shared, 'shared-ledger-skill', 'SKILL.md.disabled')), true);

  assert.equal(
    runCli(root, ['enable', 'shared-ledger-skill', '--host', 'cursor', '--yes']).code,
    0,
  );
  assert.deepEqual(
    recordsOf(root, 'shared-ledger-skill').map((item) => item.visibility),
    ['visible', 'visible'],
  );
  assert.equal(existsSync(join(shared, 'shared-ledger-skill', 'SKILL.md')), true);
});

test('L-2 e2e：历史副本 enable 以 adopted 入账', () => {
  const { root, hostRoot } = setupHost();
  const source = makeSkillSource('adopted-skill', { description: '历史副本' });
  assert.equal(runCli(root, ['install', source, '--yes']).code, 0);
  writeHostSkill(hostRoot, 'adopted-skill', { description: '历史副本' });

  const enabled = runCli(root, ['enable', 'adopted-skill', '--host', 'claude', '--yes']);
  assert.equal(enabled.code, 0);
  const data = enabled.result['data'] as Record<string, unknown>;
  assert.equal(data['adopted'], true);
  const [record] = recordsOf(root, 'adopted-skill');
  assert.equal(record?.origin, 'adopted');
  assert.equal(record?.state, 'active');
  assert.equal(record?.visibility, 'visible');
});

test('L-2 e2e：entry 形态不产生物理副本与账本记录', () => {
  const root = makeTempDir('sm-l2-e2e-');
  assert.equal(runCli(root, ['init']).code, 0);
  const source = makeSkillSource('entry-skill', { description: 'entry' });
  assert.equal(runCli(root, ['install', source, '--host', 'agents-md', '--yes']).code, 0);
  assert.deepEqual(ledger(root).landings, []);
});

test('L-2 e2e：rules 只记 visible，禁止切换可见性', () => {
  const root = makeTempDir('sm-l2-e2e-');
  const rulesRoot = makeHostRoot('sm-l2-rules-');
  assert.equal(runCli(root, ['init']).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.cursor.rules_root', rulesRoot]).code, 0);
  const source = makeSkillSource('rule-ledger-skill', { description: '规则账本' });
  assert.equal(runCli(root, ['install', source, '--host', 'cursor-rules', '--yes']).code, 0);
  const [record] = recordsOf(root, 'rule-ledger-skill');
  assert.equal(record?.format, 'rules');
  assert.equal(record?.visibility, 'visible');
  assert.equal(record?.target_path, join(rulesRoot, 'rule-ledger-skill.mdc'));
  assert.equal(
    record?.content_digest,
    computeLandingChecksum({ targetPath: record?.target_path ?? '', format: 'rules' }),
  );

  const toggle = runCli(root, ['disable', 'rule-ledger-skill', '--host', 'cursor-rules', '--yes']);
  assert.equal(toggle.code, 2, 'rules 没有可见性切换');
  assert.equal(existsSync(join(rulesRoot, 'rule-ledger-skill.mdc')), true);
});

test('L-2 e2e：账本损坏在物理写盘前中止', () => {
  const { root, hostRoot } = setupHost();
  writeFileSync(join(root, 'host_landings.yaml'), 'schema_version: "1"\nlandings: [\n');
  const source = makeSkillSource('corrupt-ledger-skill', { description: '损坏账本' });
  const result = runCli(root, ['install', source, '--host', 'claude', '--yes']);
  assert.equal(result.code, 1);
  const findings = result.result['findings'] as Array<{ code: string }>;
  assert.ok(findings.some((item) => item.code === 'E-LANDING-001'));
  assert.equal(existsSync(join(hostRoot, 'corrupt-ledger-skill')), false);
});

test('L-2 e2e：目标路径冲突时不写账本', () => {
  const { root, hostRoot } = setupHost();
  writeFileSync(join(hostRoot, 'conflict-skill'), 'not a directory');
  const source = makeSkillSource('conflict-skill', { description: '冲突' });
  const result = runCli(root, ['install', source, '--host', 'claude', '--yes']);
  assert.notEqual(result.code, 0);
  assert.deepEqual(ledger(root).landings, []);
  assert.equal(readFileSync(join(hostRoot, 'conflict-skill'), 'utf8'), 'not a directory');
});
