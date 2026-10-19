import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { makeTempDir } from '../helpers/temp.ts';
import {
  createInitialHostLandings,
  saveHostLandings,
} from '../../kernel/store/host-landings/index.ts';
import {
  createInitialPluginIndex,
  savePluginIndex,
} from '../../kernel/store/plugin-registry/index.ts';
import { ensureWorkspaceDirs, layoutOf } from '../../kernel/store/workspace/index.ts';
import {
  activeBlockers,
  collectUnifiedLandings,
  groupByPhysicalPath,
  orphanHostLandingsForPaths,
  orphanPluginLandingsForPaths,
  purgeHostOrphanedLandings,
} from '../../kernel/core/host-landings/uninstall.ts';
import {
  blockedOriginalUninstall,
  executeHostUninstall,
  planHostUninstall,
} from '../../kernel/dispatch/host/uninstall.ts';
import type {
  HostLanding,
  HostLandingIndex,
  PluginIndex,
  PluginLanding,
} from '../../contract/src/index.ts';

const NOW = '2026-10-18T00:00:00Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function hostLanding(overrides: Partial<HostLanding> = {}): HostLanding {
  return {
    skill_id: 'alpha',
    host_id: 'codex',
    target_path: join(makeTempDir('sm-uninstall-target-'), 'alpha'),
    format: 'skill',
    visibility: 'visible',
    state: 'active',
    origin: 'distributed',
    source_checksum: DIGEST,
    content_digest: DIGEST,
    adapter_ref: 'codex',
    registry_version: '1',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function pluginLanding(overrides: Partial<PluginLanding> = {}): PluginLanding {
  const root = makeTempDir('sm-uninstall-plugin-');
  return {
    plugin_id: 'acme',
    skill_id: 'alpha',
    host_id: 'x-acme-zed',
    host_key: 'zed',
    target_path: join(root, 'alpha', 'SKILL.md'),
    state: 'active',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function ledger(landings: HostLanding[]): HostLandingIndex {
  return { ...createInitialHostLandings(NOW, '0.3.0'), landings };
}

function pluginLedger(landings: PluginLanding[]): PluginIndex {
  return { ...createInitialPluginIndex(NOW, '0.3.0'), landings };
}

test('单元：统一两账本并按物理副本分组', () => {
  const host = hostLanding();
  const plugin = pluginLanding({ target_path: join(host.target_path, 'SKILL.md') });
  const unified = collectUnifiedLandings(ledger([host]), pluginLedger([plugin]), 'alpha');
  assert.equal(unified.length, 2);
  assert.equal(unified[1]?.physical_path, host.target_path);
  assert.equal(unified[1]?.format, 'skill');
  assert.equal(groupByPhysicalPath(unified).size, 1);
  assert.equal(activeBlockers(ledger([host]), pluginLedger([plugin]), 'alpha').length, 2);
});

test('单元：单宿主共享根冲突与 --host all 分组', () => {
  const target = join(makeTempDir('sm-uninstall-shared-'), 'alpha');
  const codex = hostLanding({ target_path: target, host_id: 'codex' });
  const cursor = hostLanding({ target_path: target, host_id: 'cursor' });
  const index = ledger([codex, cursor]);

  const single = planHostUninstall({
    hostValue: 'codex',
    skillId: 'alpha',
    hostIndex: index,
    pluginIndex: pluginLedger([]),
  });
  assert.ok(single.findings.some((item) => item.code === 'E-LANDING-001'));

  const all = planHostUninstall({
    hostValue: 'all',
    skillId: 'alpha',
    hostIndex: index,
    pluginIndex: pluginLedger([]),
  });
  assert.deepEqual(all.findings, []);
  assert.equal(all.groups.length, 1);
  assert.equal(all.groups[0]?.shared, true);
});

test('单元：无记录与非法宿主返回参数类错误', () => {
  const empty = ledger([]);
  const missing = planHostUninstall({
    hostValue: 'codex',
    skillId: 'alpha',
    hostIndex: empty,
    pluginIndex: pluginLedger([]),
  });
  assert.ok(missing.findings.some((item) => item.code === 'E-INPUT-002'));

  const unknown = planHostUninstall({
    hostValue: 'not-a-host',
    skillId: 'alpha',
    hostIndex: ledger([hostLanding()]),
    pluginIndex: pluginLedger([]),
  });
  assert.ok(unknown.findings.some((item) => item.code === 'E-INPUT-002'));
});

test('单元：孤儿化与原件卸载后的 host orphaned 清理', () => {
  const host = hostLanding();
  const other = hostLanding({
    skill_id: 'beta',
    target_path: join(process.cwd(), 'virtual', 'beta'),
  });
  const plugin = pluginLanding();
  const hostIndex = ledger([host, other]);
  const pluginIndex = pluginLedger([plugin]);
  const orphanedHost = orphanHostLandingsForPaths(hostIndex, 'alpha', [host.target_path], NOW);
  const orphanedPlugin = orphanPluginLandingsForPaths(
    pluginIndex,
    'alpha',
    [join(plugin.target_path, '..')],
    NOW,
  );
  assert.equal(orphanedHost.landings.find((item) => item.skill_id === 'alpha')?.state, 'orphaned');
  assert.equal(orphanedHost.landings.find((item) => item.skill_id === 'beta')?.state, 'active');
  assert.equal(orphanedPlugin.landings[0]?.state, 'orphaned');

  const purged = purgeHostOrphanedLandings(orphanedHost, 'alpha');
  assert.equal(
    purged.landings.some((item) => item.skill_id === 'alpha'),
    false,
  );
  assert.equal(
    purged.landings.some((item) => item.skill_id === 'beta'),
    true,
  );
});

test('单元：原件卸载阻断返回宿主、路径与引导数据', () => {
  const host = hostLanding();
  const ws = makeTempDir('sm-uninstall-ws-');
  ensureWorkspaceDirs(layoutOf(ws));
  saveHostLandings(join(ws, 'host_landings.yaml'), ledger([host]));
  savePluginIndex(join(ws, 'plugin_index.yaml'), pluginLedger([]));
  const blocked = blockedOriginalUninstall({ layout: layoutOf(ws), now: NOW, skillId: 'alpha' });
  assert.ok(blocked);
  assert.equal(blocked?.ok, false);
  assert.equal(blocked?.findings[0]?.code, 'E-LANDING-002');
  const data = blocked?.data as { active_hosts?: unknown[] };
  assert.equal(data.active_hosts?.length, 1);

  saveHostLandings(join(ws, 'host_landings.yaml'), ledger([{ ...host, state: 'orphaned' }]));
  assert.equal(
    blockedOriginalUninstall({ layout: layoutOf(ws), now: NOW, skillId: 'alpha' }),
    null,
  );
});

test('单元：多宿主部分失败只回滚失败组，成功组保持 orphaned', () => {
  const ws = makeTempDir('sm-uninstall-exec-');
  ensureWorkspaceDirs(layoutOf(ws));
  const firstPath = join(makeTempDir('sm-uninstall-copy-'), 'first');
  const secondPath = join(makeTempDir('sm-uninstall-copy-'), 'second');
  mkdirSync(firstPath, { recursive: true });
  mkdirSync(secondPath, { recursive: true });
  writeFileSync(join(firstPath, 'SKILL.md'), '# first');
  writeFileSync(join(secondPath, 'SKILL.md'), '# second');
  const first = hostLanding({ host_id: 'codex', target_path: firstPath });
  const second = hostLanding({ host_id: 'doubao', target_path: secondPath });
  const hostIndex = ledger([first, second]);
  const pluginIndex = pluginLedger([]);
  saveHostLandings(join(ws, 'host_landings.yaml'), hostIndex);
  savePluginIndex(join(ws, 'plugin_index.yaml'), pluginIndex);
  const plan = planHostUninstall({
    hostValue: 'all',
    skillId: 'alpha',
    hostIndex,
    pluginIndex,
  });
  const execution = executeHostUninstall({
    plan,
    layout: layoutOf(ws),
    now: NOW,
    skillId: 'alpha',
    hostIndex,
    pluginIndex,
    hooks: {
      onBeforeDelete: (path) => {
        if (path === secondPath) throw new Error('injected group failure');
      },
    },
  });
  assert.equal(existsSync(firstPath), false);
  assert.equal(existsSync(secondPath), true);
  assert.equal(execution.results.find((item) => item.host_id === 'codex')?.status, 'removed');
  assert.equal(execution.results.find((item) => item.host_id === 'doubao')?.status, 'failed');
  const saved = parseYaml(readFileSync(join(ws, 'host_landings.yaml'), 'utf8')) as {
    landings: HostLanding[];
  };
  assert.equal(saved.landings.find((item) => item.host_id === 'codex')?.state, 'orphaned');
  assert.equal(saved.landings.find((item) => item.host_id === 'doubao')?.state, 'active');
});
