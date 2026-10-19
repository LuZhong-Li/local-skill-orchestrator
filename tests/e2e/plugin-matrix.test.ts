import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { allAdapters } from '../../kernel/core/adapters/index.ts';
import { loadHostRegistry } from '../../kernel/core/hosts/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { loadPluginIndex } from '../../kernel/store/plugin-registry/index.ts';

const repoRoot = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cliEntry = join(repoRoot, 'kernel', 'entry', 'cli.ts');

function temp(prefix: string): string {
  return makeTempDir(prefix);
}

function runCli(root: string, argv: string[]): { code: number; result: Record<string, unknown> } {
  const child = spawnSync(process.execPath, [cliEntry, ...argv, '--workspace', root, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse((child.stdout ?? '').trim()) as Record<string, unknown>;
  } catch {
    // 失败时保留空结果，断言会给出退出码与 stderr 诊断
  }
  return { code: child.status ?? -1, result };
}

function init(root: string): void {
  assert.equal(runCli(root, ['init']).code, 0);
}

function manifest(
  id: string,
  patch: (value: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    manifest_version: '1',
    plugin_id: id,
    name: `Plugin ${id}`,
    version: '1.0.0',
    compatibility: { skill_manager: '>=0.2.0 <1.0.0', plugin_api: '1' },
    capabilities: ['host_profile'],
    hosts: [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'rules',
        roots: [
          {
            kind: 'rules',
            path_template: '.zed/rules/<skill_id>.md',
            scope: 'project',
          },
        ],
        render_policy: { field_mode: 'standard6' },
      },
    ],
  };
  patch(value);
  return value;
}

function pluginSource(id: string, patch?: (value: Record<string, unknown>) => void): string {
  const base = temp(`sm-matrix-${id}-`);
  const dir = join(base, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest(id, patch), null, 2)}\n`);
  return dir;
}

function skillSource(id: string): string {
  const dir = temp(`sm-matrix-skill-${id}-`);
  writeFileSync(join(dir, 'SKILL.md'), `# ${id}\n\nbody ${id}\n`);
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      `description: ${id} description`,
      'version: 1.0.0',
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: project',
      `    path: .claude/skills/${id}`,
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );
  return dir;
}

function indexOf(root: string): ReturnType<typeof loadPluginIndex> {
  return loadPluginIndex(layoutOf(root).pluginIndexFile);
}

function findingsOf(result: Record<string, unknown>): string[] {
  return ((result['findings'] ?? []) as Array<Record<string, unknown>>).map(
    (item) => `${String(item['code'])} ${String(item['message'])}`,
  );
}

test('T3 失败矩阵：非法 manifest、安全字段、代码文件与不兼容 API 均不登记', () => {
  const cases: Array<{
    name: string;
    patch: (value: Record<string, unknown>) => void;
    code: string;
    file?: string;
  }> = [
    {
      name: '缺少 name',
      patch: (value) => {
        delete value['name'];
      },
      code: 'E-FIELD-001',
    },
    {
      name: '安全控制字段',
      patch: (value) => {
        const hosts = value['hosts'] as Array<Record<string, unknown>>;
        const roots = hosts[0]?.['roots'] as Array<Record<string, unknown>>;
        roots[0] = { ...roots[0], security_control_evidence: {} };
      },
      code: 'E-FIELD-002',
    },
    {
      name: '代码文件',
      patch: () => undefined,
      code: 'E-FIELD-002',
      file: 'index.js',
    },
    {
      name: '不兼容 API',
      patch: (value) => {
        value['compatibility'] = {
          skill_manager: '>=0.2.0 <1.0.0',
          plugin_api: '2',
        };
      },
      code: 'E-VER-002',
    },
  ];

  for (const item of cases) {
    const root = temp('sm-matrix-invalid-');
    init(root);
    const source = pluginSource('acme-tools', item.patch);
    if (item.file !== undefined) writeFileSync(join(source, item.file), 'export default 1;\n');
    const result = runCli(root, ['install', source, '--kind', 'plugin', '--yes']);
    assert.notEqual(result.code, 0, `${item.name} 应失败`);
    assert.ok(
      findingsOf(result.result).some((finding) => finding.includes(item.code)),
      `${item.name} 应报告 ${item.code}：${JSON.stringify(result.result)}`,
    );
    assert.equal(indexOf(root).index?.plugins.length, 0, `${item.name} 不得留下登记`);
  }
});

test('T3 失败矩阵：canonical 冲突整插件拒绝，重复/非法插件标识有明确问题码', () => {
  const root = temp('sm-matrix-conflict-');
  init(root);
  const first = pluginSource('acme-tools');
  const colliding = pluginSource('acme', (value) => {
    value['hosts'] = [
      {
        host_key: 'tools-zed',
        display_name: 'Zed',
        form: 'rules',
        roots: [{ kind: 'rules', path_template: '.zed/rules/<skill_id>.md', scope: 'project' }],
        render_policy: { field_mode: 'standard6' },
      },
    ];
  });
  assert.equal(runCli(root, ['install', first, '--kind', 'plugin', '--yes']).code, 0);
  assert.equal(runCli(root, ['install', colliding, '--kind', 'plugin', '--yes']).code, 0);
  assert.equal(runCli(root, ['enable', 'acme-tools', '--kind', 'plugin']).code, 0);
  const conflict = runCli(root, ['enable', 'acme', '--kind', 'plugin']);
  assert.equal(conflict.code, 1);
  assert.ok(findingsOf(conflict.result).some((finding) => finding.includes('E-CONFLICT-004')));
  const listed = runCli(root, ['list', '--kind', 'plugin']);
  const hostIds = (
    ((listed.result['data'] as Record<string, unknown>)['plugin_hosts'] ?? []) as Array<
      Record<string, unknown>
    >
  )
    .filter((host) => host['plugin_state'] === 'enabled')
    .map((host) => host['host_id']);
  assert.deepEqual(hostIds, ['x-acme-tools-zed'], '冲突插件不得部分加载');

  const duplicate = pluginSource('acme-tools');
  writeFileSync(
    join(duplicate, 'plugin.json'),
    JSON.stringify(manifest('acme-tools', (value) => (value['version'] = '2.0.0'))),
  );
  const duplicateResult = runCli(root, ['install', duplicate, '--kind', 'plugin', '--yes']);
  assert.equal(duplicateResult.code, 1);
  assert.ok(findingsOf(duplicateResult.result).some((finding) => finding.includes('E-ID-005')));

  const badId = pluginSource('Bad_Id');
  const badIdResult = runCli(root, ['install', badId, '--kind', 'plugin', '--yes']);
  assert.equal(badIdResult.code, 1);
  assert.ok(findingsOf(badIdResult.result).some((finding) => finding.includes('E-ID-004')));
});

test('T3 失败矩阵：disabled/global 未配置/未登记宿主的落位被拒绝', () => {
  const root = temp('sm-matrix-host-');
  init(root);
  const source = pluginSource('acme-tools');
  assert.equal(runCli(root, ['install', source, '--kind', 'plugin', '--yes']).code, 0);
  const skill = skillSource('host-guard-skill');

  const disabled = runCli(root, ['install', skill, '--host', 'x-acme-tools-zed', '--yes']);
  assert.equal(disabled.code, 2);
  assert.ok(findingsOf(disabled.result).some((finding) => finding.includes('E-INPUT-002')));

  assert.equal(runCli(root, ['enable', 'acme-tools', '--kind', 'plugin']).code, 0);
  const missing = runCli(root, [
    'install',
    skillSource('host-missing-skill'),
    '--host',
    'x-not-installed-zed',
    '--yes',
  ]);
  assert.equal(missing.code, 2);
  assert.ok(findingsOf(missing.result).some((finding) => finding.includes('E-INPUT-002')));

  const global = pluginSource('global-tools', (value) => {
    value['hosts'] = [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'rules',
        roots: [{ kind: 'rules', path_template: 'rules/<skill_id>.md', scope: 'global' }],
        render_policy: { field_mode: 'standard6' },
      },
    ];
  });
  assert.equal(runCli(root, ['install', global, '--kind', 'plugin', '--yes']).code, 0);
  assert.equal(runCli(root, ['enable', 'global-tools', '--kind', 'plugin']).code, 0);
  const globalMissing = runCli(root, [
    'install',
    skillSource('global-missing-skill'),
    '--host',
    'x-global-tools-zed',
    '--yes',
  ]);
  assert.equal(globalMissing.code, 2);
  assert.ok(
    findingsOf(globalMissing.result).some((finding) =>
      finding.includes('plugin.global-tools.zed.rules_root'),
    ),
  );
  const hostConfig = runCli(root, ['config', 'set', 'host.x-global-tools-zed.root', '/tmp/nope']);
  assert.equal(hostConfig.code, 2);
});

test('T3 失败矩阵：来源失败不产生半截登记', () => {
  const root = temp('sm-matrix-source-');
  init(root);
  const badProtocol = runCli(root, ['install', 'file:///tmp/plugin', '--kind', 'plugin', '--yes']);
  assert.equal(badProtocol.code, 4);
  assert.ok(findingsOf(badProtocol.result).some((finding) => finding.includes('E-SRC-009')));
  assert.equal(indexOf(root).index?.plugins.length, 0);

  const unreachable = runCli(root, [
    'install',
    'https://127.0.0.1:1/plugin.git',
    '--kind',
    'plugin',
    '--yes',
  ]);
  assert.equal(unreachable.code, 4);
  assert.ok(
    findingsOf(unreachable.result).some((finding) =>
      ['E-SRC-002', 'E-SRC-003', 'E-SRC-007'].some((code) => finding.includes(code)),
    ),
  );
  assert.equal(indexOf(root).index?.plugins.length, 0);
});

test('T3 运行期损坏与隔离：scan 标记失效，卸载保留 Skill 索引与孤儿账本', () => {
  const root = temp('sm-matrix-damage-');
  init(root);
  const plugin = pluginSource('acme-tools');
  assert.equal(runCli(root, ['install', plugin, '--kind', 'plugin', '--yes']).code, 0);
  assert.equal(runCli(root, ['enable', 'acme-tools', '--kind', 'plugin']).code, 0);
  assert.equal(
    runCli(root, ['install', skillSource('damage-skill'), '--host', 'x-acme-tools-zed', '--yes'])
      .code,
    0,
  );
  const beforeRegistry = JSON.stringify(loadHostRegistry());
  const beforeForms = allAdapters()
    .map((adapter) => adapter.host_id)
    .sort();
  const beforeSkillIndex = readFileSync(layoutOf(root).indexFile);
  const landed = join(root, '.zed', 'rules', 'damage-skill.md');
  assert.equal(existsSync(landed), true);

  writeFileSync(
    join(root, 'plugins', 'acme-tools', 'plugin.json'),
    JSON.stringify(manifest('acme-tools', (value) => (value['version'] = '9.0.0'))),
  );
  const scan = runCli(root, ['scan', '--kind', 'plugin']);
  assert.equal(scan.code, 1);
  assert.ok(findingsOf(scan.result).some((finding) => finding.includes('E-HASH-001')));

  const removed = runCli(root, ['uninstall', 'acme-tools', '--kind', 'plugin', '--yes']);
  assert.equal(removed.code, 0);
  assert.equal(existsSync(join(root, 'plugins', 'acme-tools')), false);
  assert.deepEqual(
    readFileSync(layoutOf(root).indexFile),
    beforeSkillIndex,
    '插件操作不改 Skill 索引',
  );
  assert.equal(existsSync(landed), true, '卸载插件不删除 Skill 产物');
  const index = indexOf(root).index;
  assert.equal(index?.plugins.length, 0);
  assert.equal(index?.landings[0]?.state, 'orphaned');
  assert.equal(JSON.stringify(loadHostRegistry()), beforeRegistry);
  assert.equal(
    loadHostRegistry().hosts.some((host) => host.host_id.startsWith('x-')),
    false,
    '内置注册表不得出现 x- 插件宿主',
  );
  assert.deepEqual(
    allAdapters()
      .map((adapter) => adapter.host_id)
      .sort(),
    beforeForms,
  );
});

test('T3 失败隔离：多个坏插件候选存在时，Skill 主路径仍可用', () => {
  const root = temp('sm-matrix-isolation-');
  init(root);
  const good = pluginSource('good-tools');
  assert.equal(runCli(root, ['install', good, '--kind', 'plugin', '--yes']).code, 0);
  assert.equal(runCli(root, ['enable', 'good-tools', '--kind', 'plugin']).code, 0);

  const badCode = join(root, 'plugins', 'bad-code');
  mkdirSync(badCode, { recursive: true });
  writeFileSync(join(badCode, 'plugin.json'), JSON.stringify(manifest('bad-code')));
  writeFileSync(join(badCode, 'index.mjs'), 'export default 1;\n');
  const badManifest = join(root, 'plugins', 'bad-manifest');
  mkdirSync(badManifest, { recursive: true });
  writeFileSync(join(badManifest, 'plugin.json'), '{ "manifest_version": "1" }\n');

  const skill = skillSource('isolation-skill');
  assert.equal(runCli(root, ['install', skill, '--yes']).code, 0);
  assert.equal(runCli(root, ['scan']).code, 0);
  assert.equal(runCli(root, ['validate']).code, 0);
  assert.equal(runCli(root, ['list']).code, 0);
  const scannedPlugins = runCli(root, ['scan', '--kind', 'plugin']);
  assert.equal(scannedPlugins.code, 0);
  const unregistered = (scannedPlugins.result['data'] as Record<string, unknown>)[
    'unregistered'
  ] as Array<unknown> | undefined;
  assert.ok(Array.isArray(unregistered) && unregistered.length >= 2);

  assert.equal(runCli(root, ['disable', 'good-tools', '--kind', 'plugin']).code, 0);
  assert.equal(runCli(root, ['uninstall', 'good-tools', '--kind', 'plugin', '--yes']).code, 0);
  assert.equal(runCli(root, ['scan']).code, 0);
  assert.equal(runCli(root, ['validate']).code, 0);
  assert.equal(runCli(root, ['list']).code, 0);
});
