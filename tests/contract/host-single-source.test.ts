import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adapterFor, allAdapters, formImplementationOf } from '../../kernel/core/adapters/index.ts';
import { defaultRootFor } from '../../kernel/core/adapters/roots.ts';
import { inventoryRootsForAll, inventoryRootsForHost } from '../../kernel/core/hosts/inventory.ts';
import { inventoryRootsForPluginCatalog } from '../../kernel/core/plugins/inventory.ts';
import { hostById, loadHostRegistry } from '../../kernel/core/hosts/index.ts';
import { validateHostRegistry } from '../../kernel/core/hosts/validate.ts';
import type { LoadedPluginCatalog } from '../../kernel/core/plugins/host.ts';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

test('契约：每个内置宿主的形态/分发根/盘点根均来自注册表单一来源', () => {
  const registry = loadHostRegistry();
  for (const entry of registry.hosts) {
    if (entry.support_state === 'not_applicable') {
      assert.equal(entry.adapter_forms, undefined);
      assert.equal(entry.landing_roots, undefined);
      assert.equal(entry.inventory_roots, undefined);
      assert.equal(adapterFor(entry.host_id), undefined);
      continue;
    }
    assert.ok((entry.adapter_forms ?? []).length > 0, `${entry.host_id} 缺少 adapter_forms`);
    assert.ok(Array.isArray(entry.landing_roots), `${entry.host_id} 缺少 landing_roots`);
    assert.ok(Array.isArray(entry.inventory_roots), `${entry.host_id} 缺少 inventory_roots`);
    assert.deepEqual(
      adapterFor(entry.host_id)?.forms,
      entry.adapter_forms,
      `${entry.host_id} 的适配器形态必须由注册表派生`,
    );
  }
  assert.deepEqual(
    allAdapters().map((adapter) => adapter.host_id),
    ['agents-md', 'agentskills', 'claude', 'codex', 'cursor', 'doubao'],
  );
});

test('契约：形态 selector 与旧三处行为等价，且不再存在 FORM_BY_HOST 第二定义', () => {
  const skill = formImplementationOf('claude');
  assert.equal(skill, formImplementationOf('codex'));
  assert.equal(skill, formImplementationOf('doubao'));
  assert.equal(skill, formImplementationOf('agentskills'));
  assert.notEqual(skill, formImplementationOf('cursor'));
  assert.notEqual(skill, formImplementationOf('agents-md'));

  const adaptersSource = read('kernel/core/adapters/index.ts');
  assert.equal(adaptersSource.includes('FORM_BY_HOST'), false, 'FORM_BY_HOST 不得残留');
  const rootsSource = read('kernel/core/adapters/roots.ts');
  assert.equal(
    rootsSource.includes("hostId === 'claude'"),
    false,
    '默认根不得在 selector 内硬编码',
  );
  assert.equal(rootsSource.includes(".claude'"), false, '默认根不得在 selector 内硬编码');
  const registrySource = read('kernel/core/hosts/registry-data.ts');
  assert.equal(
    registrySource.includes('adapter_forms:'),
    false,
    '形态数据应集中在 host-root-models',
  );
  assert.equal(
    registrySource.includes('landing_roots:'),
    false,
    '分发根数据应集中在 host-root-models',
  );
  assert.equal(
    registrySource.includes('inventory_roots:'),
    false,
    '盘点根数据应集中在 host-root-models',
  );
});

test('契约：defaultRootFor 保持旧默认分发根等价', () => {
  const linux = { home: '/home/u', platform: 'linux' as const, env: {} };
  assert.equal(defaultRootFor('claude', 'skill', linux), join('/home/u', '.claude', 'skills'));
  assert.equal(defaultRootFor('codex', 'skill', linux), join('/home/u', '.agents', 'skills'));
  assert.equal(defaultRootFor('cursor', 'skill', linux), join('/home/u', '.cursor', 'skills'));
  assert.equal(defaultRootFor('cursor', 'rules', linux), join('/home/u', '.cursor', 'rules'));
  assert.equal(defaultRootFor('agentskills', 'skill', linux), undefined);
  assert.equal(defaultRootFor('agents-md', 'rules', linux), undefined);
  assert.equal(defaultRootFor('deepseek', 'skill', linux), undefined);
  assert.equal(defaultRootFor('doubao', 'external', linux), undefined);

  const windows = {
    home: 'C:/Users/u',
    platform: 'win32' as const,
    env: { LOCALAPPDATA: 'C:/Local' },
  };
  assert.equal(
    defaultRootFor('doubao', 'external', windows),
    join(
      'C:/Local',
      'Doubao',
      'User Data',
      'Default',
      '.doubao',
      'agent_mode',
      'workspace',
      '.user_skills',
    ),
  );
});

test('契约：inventory_roots 覆盖角色、深度、legacy/system 与跨平台候选', () => {
  const linux = {
    workspaceRoot: '/work',
    home: '/home/u',
    platform: 'linux' as const,
    env: {},
  };
  const codex = inventoryRootsForHost('codex', linux);
  assert.deepEqual(codex.map((root) => root.root_id).sort(), [
    'codex/agents-user',
    'codex/legacy-user',
    'codex/project',
    'codex/system',
  ]);
  assert.equal(codex.find((root) => root.root_id === 'codex/legacy-user')?.origin, 'legacy');
  assert.equal(codex.find((root) => root.root_id === 'codex/system')?.role, 'system');
  assert.equal(
    codex.find((root) => root.root_id === 'codex/agents-user')?.pending_verification,
    true,
  );
  const cursor = inventoryRootsForHost('cursor', linux);
  assert.equal(
    inventoryRootsForHost('claude', linux).find((root) => root.root_id === 'claude/user')
      ?.pending_verification,
    undefined,
    'M4c-7 CI 已覆盖 HOME 展开机制，Claude 用户根不再 pending',
  );
  assert.equal(
    cursor.find((root) => root.root_id === 'cursor/user-skills')?.pending_verification,
    undefined,
    'M4c-7 CI 已覆盖 Cursor 递归技能根机制',
  );
  assert.equal(
    cursor.find((root) => root.root_id === 'cursor/user-rules')?.pending_verification,
    undefined,
    'M4c-7 CI 已覆盖 Cursor 规则根机制',
  );

  assert.equal(
    cursor.find((root) => root.root_id === 'cursor/user-skills')?.depth,
    'recursive',
    'Cursor 技能根应递归发现',
  );
  assert.equal(
    cursor.find((root) => root.root_id === 'cursor/user-rules')?.depth,
    'direct',
    'Cursor 规则文件根应顶层发现',
  );

  assert.deepEqual(inventoryRootsForHost('doubao', linux), [], '豆包静态根仅 Windows 实测');
  const doubaoWin = inventoryRootsForHost('doubao', {
    ...linux,
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/Local' },
  });
  assert.deepEqual(doubaoWin.map((root) => root.role).sort(), ['platform', 'user']);
  assert.equal(inventoryRootsForHost('deepseek', linux).length, 0);
});

function assertConfiguredBuiltinRoots(): void {
  const context = {
    workspaceRoot: '/work',
    home: '/home/u',
    platform: 'linux' as const,
    env: {},
    config: { 'host.agentskills.root': '/custom/skills' },
  };
  const configured = inventoryRootsForHost('agentskills', context);
  assert.equal(configured.length, 1);
  assert.equal(configured[0]?.origin, 'config');
  assert.equal(configured[0]?.role, 'user');
  assert.equal(configured[0]?.kind, 'skill');
  assert.equal(configured[0]?.path, '/custom/skills');

  const rulesConfigured = inventoryRootsForHost('agents-md', {
    ...context,
    config: { 'host.agents-md.root': 'custom/agents' },
  });
  const configRoot = rulesConfigured.find((root) => root.origin === 'config');
  assert.equal(configRoot?.kind, 'rules');
  assert.equal(configRoot?.path, resolve('/work', 'custom/agents'));

  const all = inventoryRootsForAll(context);
  assert.ok(all.some((root) => root.host_group === 'builtin'));
  assert.equal(new Set(all.map((root) => root.root_id)).size, all.length);
}

function pluginCatalogFixture(): LoadedPluginCatalog {
  const catalog = {
    index: {
      config: { 'plugin.acme.zed.root': '/plugin-root' },
    },
    entries: [
      {
        record: { id: 'acme' },
        manifest: { hosts: [{ host_key: 'zed' }] },
      },
    ],
    view: {
      pluginHosts: [
        {
          host_id: 'x-acme-zed',
          host_key: 'zed',
          roots: [
            {
              kind: 'skill',
              path_template: '.zed/skills/<skill_id>',
              scope: 'global',
            },
            {
              kind: 'skill',
              path_template: '.zed/project-skills/<skill_id>',
              scope: 'project',
            },
          ],
        },
      ],
    },
  } as unknown as LoadedPluginCatalog;
  return catalog;
}

function assertPluginInventoryRoots(): void {
  const catalog = pluginCatalogFixture();
  const pluginRoots = inventoryRootsForPluginCatalog(catalog, {
    workspaceRoot: '/work',
    platform: 'linux',
  });
  assert.equal(pluginRoots.length, 2);
  assert.equal(pluginRoots[0]?.host_group, 'plugin');
  assert.equal(pluginRoots[0]?.configured, true);
  assert.equal(pluginRoots[0]?.path, resolve('/plugin-root', '.zed/skills'));
  assert.equal(pluginRoots[1]?.role, 'project');
  assert.equal(pluginRoots[1]?.path, resolve('/work', '.zed/project-skills'));
}

function assertStaticInventoryRejectsConfigOrigin(): void {
  const registry = JSON.parse(JSON.stringify(loadHostRegistry())) as {
    hosts: Array<Record<string, unknown>>;
  };
  const claude = registry.hosts.find((entry) => entry['host_id'] === 'claude');
  const roots = claude?.['inventory_roots'] as Array<Record<string, unknown>>;
  assert.ok(roots[0], 'claude 应有静态盘点根');
  roots[0]['origin'] = 'config';
  assert.ok(
    validateHostRegistry(registry).some((item) => item.message.includes('静态根来源')),
    '静态 inventory_roots 不得接受 config 来源',
  );
}

test('契约：config 覆盖根作为额外 user 根，x- 宿主输出同一视图接口', () => {
  assertConfiguredBuiltinRoots();
  assertPluginInventoryRoots();
});

test('契约：新宿主只需注册表一条 + 适配器即可通过校验', () => {
  const registry = JSON.parse(JSON.stringify(loadHostRegistry())) as {
    hosts: Array<Record<string, unknown>>;
  };
  registry.hosts.push({
    host_id: 'synthetic-host',
    display_name: 'Synthetic',
    adapter_state: 'implemented',
    support_state: 'confirmed',
    evidence: { level: 'verified_official', sources: ['https://example.invalid'] },
    classification: { skill_mechanism: true, rules_only: false },
    roots: [{ kind: 'skill', path_template: './skills/<Skill 标识>', scope: 'project' }],
    adapter_forms: ['skill'],
    landing_roots: [],
    inventory_roots: [],
    capability: {},
    render_policy: { field_mode: 'standard6', allowed_extensions: [] },
    adapter_ref: 'synthetic-host',
  });
  assert.deepEqual(
    validateHostRegistry(registry).filter((item) => item.severity === 'error'),
    [],
    '新增宿主只需注册表一条记录即可通过注册表校验',
  );
  assertStaticInventoryRejectsConfigOrigin();
  assert.equal(hostById('synthetic-host'), undefined, '运行期注册表仍冻结于原数据');
});
