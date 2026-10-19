import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { makeTempDir } from '../helpers/temp.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { makePluginDir, writePluginManifest } from '../helpers/plugin.ts';
import type { HostLanding, HostLandingIndex, PluginIndex } from '../../contract/src/index.ts';

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

function hostLedger(root: string): HostLandingIndex {
  return parseYaml(readFileSync(join(root, 'host_landings.yaml'), 'utf8')) as HostLandingIndex;
}

function pluginLedger(root: string): PluginIndex {
  return parseYaml(readFileSync(join(root, 'plugin_index.yaml'), 'utf8')) as PluginIndex;
}

function hostRecord(root: string, hostId: string): HostLanding | undefined {
  return hostLedger(root).landings.find(
    (item) => item.skill_id === 'uninstall-skill' && item.host_id === hostId,
  );
}

function setupWorkspace(): { root: string; doubao: string; agents: string } {
  const root = makeTempDir('sm-l3-e2e-');
  const doubao = makeHostRoot('sm-l3-doubao-');
  const agents = makeHostRoot('sm-l3-agents-');
  assert.equal(runCli(root, ['init']).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.doubao.root', doubao]).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.agentskills.root', agents]).code, 0);
  return { root, doubao, agents };
}

test('L-3 e2e：多宿主单宿主卸载只删指定副本并标 orphaned', () => {
  const { root, doubao, agents } = setupWorkspace();
  const source = makeSkillSource('uninstall-skill', { description: '卸载链路' });
  assert.equal(runCli(root, ['install', source, '--host', 'doubao', '--yes']).code, 0);
  assert.equal(
    runCli(root, ['update', 'uninstall-skill', '--host', 'agentskills', '--yes']).code,
    0,
  );
  assert.equal(existsSync(join(doubao, 'uninstall-skill')), true);
  assert.equal(existsSync(join(agents, 'uninstall-skill')), true);

  const removed = runCli(root, ['uninstall', 'uninstall-skill', '--host', 'doubao', '--yes']);
  assert.equal(removed.code, 0);
  assert.equal(existsSync(join(doubao, 'uninstall-skill')), false);
  assert.equal(existsSync(join(agents, 'uninstall-skill')), true, '其他宿主副本不动');
  assert.equal(hostRecord(root, 'doubao')?.state, 'orphaned');
  assert.equal(hostRecord(root, 'agentskills')?.state, 'active');
  assert.equal(
    existsSync(join(root, 'skills', 'uninstall-skill')),
    true,
    '工作区原件不被 --host 删除',
  );
  const data = removed.result['data'] as Record<string, unknown>;
  assert.equal(data['backup'], null);
  assert.equal(data['workspace_unchanged'], true);
});

test('L-3 e2e：共享根单宿主拒绝 001，--host all 一次清理', () => {
  const root = makeTempDir('sm-l3-e2e-');
  const shared = makeHostRoot('sm-l3-shared-');
  assert.equal(runCli(root, ['init']).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.codex.root', shared]).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.cursor.root', shared]).code, 0);
  const source = makeSkillSource('uninstall-skill', { description: '共享根' });
  assert.equal(runCli(root, ['install', source, '--host', 'codex', '--yes']).code, 0);

  const dry = runCli(root, ['uninstall', 'uninstall-skill', '--host', 'all', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(existsSync(join(shared, 'uninstall-skill')), true);
  assert.deepEqual(
    hostLedger(root).landings.map((item) => item.state),
    ['active', 'active'],
    'dry-run 不得改账本',
  );

  const blocked = runCli(root, ['uninstall', 'uninstall-skill', '--host', 'codex', '--yes']);
  assert.equal(blocked.code, 1);
  const codes = (blocked.result['findings'] as Array<{ code: string }>).map((item) => item.code);
  assert.ok(codes.includes('E-LANDING-001'));
  assert.equal(existsSync(join(shared, 'uninstall-skill')), true);

  const all = runCli(root, ['uninstall', 'uninstall-skill', '--host', 'all', '--yes']);
  assert.equal(all.code, 0);
  assert.equal(existsSync(join(shared, 'uninstall-skill')), false);
  assert.deepEqual(
    hostLedger(root).landings.map((item) => item.state),
    ['orphaned', 'orphaned'],
  );
});

test('L-3 e2e：原件卸载被 002 阻断，清理后 host 孤儿记录物理清除', () => {
  const { root, doubao } = setupWorkspace();
  const source = makeSkillSource('uninstall-skill', { description: '原件阻断' });
  assert.equal(runCli(root, ['install', source, '--host', 'doubao', '--yes']).code, 0);

  const blocked = runCli(root, ['uninstall', 'uninstall-skill', '--yes']);
  assert.equal(blocked.code, 1);
  const finding = (blocked.result['findings'] as Array<Record<string, unknown>>)[0];
  assert.equal(finding?.['code'], 'E-LANDING-002');
  assert.match(String(finding?.['message']), /doubao:/);
  assert.match(String(finding?.['remedy']), /--host all/);
  const data = blocked.result['data'] as { active_hosts?: Array<Record<string, unknown>> };
  assert.equal(data.active_hosts?.length, 1);
  assert.equal(existsSync(join(doubao, 'uninstall-skill')), true);
  const hardBlocked = runCli(root, ['uninstall', 'uninstall-skill', '--hard', '--yes']);
  assert.equal(hardBlocked.code, 1);
  assert.equal(
    (hardBlocked.result['findings'] as Array<{ code: string }>)[0]?.code,
    'E-LANDING-002',
  );

  assert.equal(runCli(root, ['uninstall', 'uninstall-skill', '--host', 'all', '--yes']).code, 0);
  assert.equal(hostRecord(root, 'doubao')?.state, 'orphaned');
  assert.equal(runCli(root, ['uninstall', 'uninstall-skill', '--yes']).code, 0);
  assert.deepEqual(hostLedger(root).landings, [], 'host orphaned 记录应在原件卸载后清除');
  const index = parseYaml(readFileSync(join(root, 'skill_index.yaml'), 'utf8')) as {
    skills: Array<{ id: string }>;
  };
  assert.equal(
    index.skills.some((item) => item.id === 'uninstall-skill'),
    false,
  );
});

test('L-3 e2e：互斥、非法宿主与无记录均不误删', () => {
  const { root } = setupWorkspace();
  assert.equal(runCli(root, ['uninstall', 'none', '--host', 'doubao', '--hard', '--yes']).code, 2);
  assert.equal(
    runCli(root, ['uninstall', 'none', '--host', 'doubao', '--kind', 'plugin', '--yes']).code,
    2,
  );
  assert.equal(runCli(root, ['uninstall', 'none', '--host', 'not-a-host', '--yes']).code, 2);
  assert.equal(runCli(root, ['uninstall', 'none', '--host', 'doubao', '--yes']).code, 2);
});

test('L-3 e2e：orphaned 后重新 update 回到 active 且不重复', () => {
  const { root, doubao } = setupWorkspace();
  const source = makeSkillSource('uninstall-skill', { description: '再激活' });
  assert.equal(runCli(root, ['install', source, '--host', 'doubao', '--yes']).code, 0);
  assert.equal(runCli(root, ['uninstall', 'uninstall-skill', '--host', 'doubao', '--yes']).code, 0);
  assert.equal(runCli(root, ['update', 'uninstall-skill', '--host', 'doubao', '--yes']).code, 0);
  const records = hostLedger(root).landings.filter((item) => item.skill_id === 'uninstall-skill');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.state, 'active');
  assert.equal(existsSync(join(doubao, 'uninstall-skill')), true);
});

test('L-3 e2e：x- 宿主卸载路由 plugin_index 且不卸载插件包', () => {
  const root = makeTempDir('sm-l3-e2e-');
  assert.equal(runCli(root, ['init']).code, 0);
  const plugin = makePluginDir('sm-l3-plugin-');
  writePluginManifest(plugin, {
    hosts: [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'skill',
        roots: [
          {
            kind: 'skill',
            path_template: '.zed/skills/<skill_id>',
            scope: 'project',
          },
        ],
        render_policy: { field_mode: 'standard6' },
      },
    ],
  });
  assert.equal(runCli(root, ['install', plugin, '--kind', 'plugin', '--yes']).code, 0);
  assert.equal(runCli(root, ['enable', 'acme-tools', '--kind', 'plugin']).code, 0);
  const source = makeSkillSource('uninstall-skill', { description: '插件宿主' });
  assert.equal(runCli(root, ['install', source, '--host', 'x-acme-tools-zed', '--yes']).code, 0);
  assert.equal(
    runCli(root, ['uninstall', 'uninstall-skill', '--host', 'x-acme-tools-zed', '--yes']).code,
    0,
  );
  const index = pluginLedger(root);
  assert.equal(
    index.plugins.some((item) => item.id === 'acme-tools'),
    true,
  );
  assert.equal(index.landings[0]?.state, 'orphaned');
  assert.equal(existsSync(join(root, '.zed', 'skills', 'uninstall-skill')), false);
});
