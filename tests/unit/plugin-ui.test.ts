import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionPluginHosts, selectableHostIds } from '../../gui/main/plugins/hosts.ts';
import {
  pluginInstallNotice,
  pluginStateLabel,
} from '../../gui/renderer/src/plugin-presentation.ts';

function listData(): Record<string, unknown> {
  return {
    kind: 'plugin',
    builtin_hosts: [
      {
        host_id: 'claude',
        display_name: 'Claude Code',
        adapter_state: 'implemented',
        support_state: 'confirmed',
      },
      {
        host_id: 'deepseek',
        display_name: 'DeepSeek',
        adapter_state: 'planned',
        support_state: 'not_applicable',
      },
    ],
    plugin_hosts: [
      {
        host_id: 'x-acme-tools-zed',
        host_key: 'zed',
        display_name: 'Zed',
        plugin_id: 'acme-tools',
        plugin_name: 'Acme Tools',
        plugin_state: 'enabled',
        roots: [{ kind: 'rules', scope: 'project' }],
        root_config: [],
      },
      {
        host_id: 'x-acme-tools-other',
        host_key: 'other',
        display_name: 'Other',
        plugin_id: 'acme-tools',
        plugin_name: 'Acme Tools',
        plugin_state: 'disabled',
        roots: [{ kind: 'rules', scope: 'project' }],
        root_config: [],
      },
      {
        host_id: 'x-acme-tools-global',
        host_key: 'global',
        display_name: 'Global',
        plugin_id: 'acme-tools',
        plugin_name: 'Acme Tools',
        plugin_state: 'enabled',
        roots: [{ kind: 'rules', scope: 'global' }],
        root_config: [
          {
            key: 'plugin.acme-tools.global.rules_root',
            configured: null,
          },
        ],
      },
    ],
  };
}

test('T2 宿主分区：内置与第三方分组，deepseek 不适用', () => {
  const partition = partitionPluginHosts(listData());
  assert.deepEqual(
    partition.builtin.map((item) => item.host_id),
    ['claude', 'deepseek'],
  );
  assert.equal(partition.builtin[0]?.selectable, true);
  assert.equal(partition.builtin[1]?.selectable, false);
  assert.deepEqual(
    partition.third_party.map((item) => item.host_id),
    ['x-acme-tools-zed', 'x-acme-tools-other', 'x-acme-tools-global'],
  );
  assert.equal(partition.third_party[0]?.plugin_name, 'Acme Tools');
});

test('T2 宿主分区：disabled 与 global 未配置的第三方宿主不可选，并给配置引导', () => {
  const partition = partitionPluginHosts(listData());
  const disabled = partition.third_party.find((item) => item.host_id === 'x-acme-tools-other');
  assert.equal(disabled?.selectable, false);
  assert.match(disabled?.reason ?? '', /停用/);

  const global = partition.third_party.find((item) => item.host_id === 'x-acme-tools-global');
  assert.equal(global?.selectable, false);
  assert.deepEqual(global?.config_hint, ['config set plugin.acme-tools.global.rules_root <路径>']);
  assert.deepEqual(selectableHostIds(partition), ['claude', 'x-acme-tools-zed']);
});

test('T2 插件视图文案：状态与安装后默认 disabled 明示', () => {
  assert.equal(pluginStateLabel('enabled'), '已启用');
  assert.equal(pluginStateLabel('disabled'), '已停用');
  assert.equal(pluginStateLabel('invalid'), '失效');
  assert.match(pluginInstallNotice(), /默认 disabled/);
});
