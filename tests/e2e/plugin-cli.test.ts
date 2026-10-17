import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { parseYaml } from '../../kernel/store/yaml/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await run(argv);
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writePlugin(root: string, patch: Record<string, unknown> = {}): string {
  const dir = join(root, 'plugins', 'acme-tools');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    manifest_version: '1',
    plugin_id: 'acme-tools',
    name: 'Acme Tools',
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
    ...patch,
  };
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function writeSkillSource(root: string, id: string): string {
  const dir = join(root, `source-${id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${id}\n\nbody of ${id}\n`);
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      `description: ${id} skill`,
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

function readPluginIndex(root: string): Record<string, unknown> {
  return parseYaml(readFileSync(layoutOf(root).pluginIndexFile, 'utf8'), {
    source: 'test',
    target: layoutOf(root).pluginIndexFile,
  });
}

async function json(argv: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
  const captured = await capture([...argv, '--json']);
  return {
    code: captured.code,
    result: JSON.parse(captured.out) as Record<string, unknown>,
  };
}

test('T1 --kind：插件安装默认 disabled，list/inspect 分区，插件 ID 可启停', async () => {
  const root = temp('sm-plugin-cli-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const plugin = writePlugin(temp('sm-plugin-src-'));

  const installed = await json([
    'install',
    plugin,
    '--kind',
    'plugin',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0);
  assert.equal(installed.result['command'], 'install');
  const pluginIndex = readPluginIndex(root);
  const record = (pluginIndex['plugins'] as Array<Record<string, unknown>>)[0] as Record<
    string,
    unknown
  >;
  assert.equal(record['id'], 'acme-tools');
  assert.equal(record['state'], 'disabled');

  const listed = await json(['list', '--kind', 'plugin', '--workspace', root]);
  assert.equal(listed.code, 0);
  const data = listed.result['data'] as Record<string, unknown>;
  assert.equal(data['kind'], 'plugin');
  assert.equal((data['plugins'] as unknown[]).length, 1);
  assert.equal(Array.isArray(data['records']), false, '插件分支不得混入 Skill records');

  const inspected = await json(['inspect', 'acme-tools', '--kind', 'plugin', '--workspace', root]);
  assert.equal(inspected.code, 0);
  const detail = inspected.result['data'] as Record<string, unknown>;
  assert.equal(detail['kind'], 'plugin');
  assert.equal((detail['plugin'] as Record<string, unknown>)['state'], 'disabled');
  assert.equal((detail['plugin'] as Record<string, unknown>)['hosts'] instanceof Array, true);

  const enabled = await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root]);
  assert.equal(enabled.code, 0);
  assert.equal(
    (readPluginIndex(root)['plugins'] as Array<Record<string, unknown>>)[0]?.['state'],
    'enabled',
  );

  const disabled = await capture([
    'disable',
    'acme-tools',
    '--kind',
    'plugin',
    '--workspace',
    root,
  ]);
  assert.equal(disabled.code, 0);
  assert.equal(
    (readPluginIndex(root)['plugins'] as Array<Record<string, unknown>>)[0]?.['state'],
    'disabled',
  );
});

test('T1 宿主：启用后技能可分发给 x- 宿主，账本留存，停用后拒绝，卸载给孤儿副本提示', async () => {
  const root = temp('sm-plugin-host-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const plugin = writePlugin(temp('sm-plugin-src-'));
  assert.equal(
    (await capture(['install', plugin, '--kind', 'plugin', '--workspace', root, '--yes'])).code,
    0,
  );

  const beforeEnable = await capture(['scan', '--kind', 'plugin', '--workspace', root]);
  assert.equal(beforeEnable.code, 0);
  assert.equal(
    (
      await capture([
        'install',
        writeSkillSource(root, 'early-skill'),
        '--host',
        'x-acme-tools-zed',
        '--workspace',
        root,
        '--yes',
      ])
    ).code,
    2,
    'disabled 插件宿主不可落位',
  );

  assert.equal(
    (await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  const skillSource = writeSkillSource(root, 'zed-skill');
  const installed = await capture([
    'install',
    skillSource,
    '--host',
    'x-acme-tools-zed',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0);
  const landed = join(root, '.zed', 'rules', 'zed-skill.md');
  assert.equal(existsSync(landed), true, '插件宿主规则文件应落位');
  assert.match(readFileSync(landed, 'utf8'), /body of zed-skill/);

  const indexAfterLanding = readPluginIndex(root);
  const landings = indexAfterLanding['landings'] as Array<Record<string, unknown>>;
  assert.equal(landings.length, 1);
  assert.equal(landings[0]?.['plugin_id'], 'acme-tools');
  assert.equal(landings[0]?.['skill_id'], 'zed-skill');
  assert.equal(landings[0]?.['target_path'], landed);

  assert.equal(
    (await capture(['disable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  assert.equal(
    (
      await capture([
        'install',
        writeSkillSource(root, 'late-skill'),
        '--host',
        'x-acme-tools-zed',
        '--workspace',
        root,
        '--yes',
      ])
    ).code,
    2,
    'disabled 插件不得继续分发',
  );
  assert.equal(existsSync(landed), true, '停用不删除既有宿主副本');

  const skillIndexBefore = readFileSync(layoutOf(root).indexFile);
  const removed = await json([
    'uninstall',
    'acme-tools',
    '--kind',
    'plugin',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(removed.code, 0);
  const removedData = removed.result['data'] as Record<string, unknown>;
  assert.equal(Array.isArray(removedData['orphaned_landings']), true);
  assert.equal((removedData['orphaned_landings'] as unknown[]).length, 1);
  assert.equal(existsSync(join(root, 'plugins', 'acme-tools')), false);
  assert.deepEqual(
    readFileSync(layoutOf(root).indexFile),
    skillIndexBefore,
    '插件卸载不改 Skill 索引',
  );
  assert.equal(existsSync(landed), true, '卸载不删除 Skill 产物');
});

test('T1 配置与扫描：global 根必须显式配置；未登记插件只报告候选', async () => {
  const root = temp('sm-plugin-config-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const plugin = writePlugin(temp('sm-plugin-src-'), {
    hosts: [
      {
        host_key: 'zed',
        display_name: 'Zed',
        form: 'rules',
        roots: [
          {
            kind: 'rules',
            path_template: 'rules/<skill_id>.md',
            scope: 'global',
          },
        ],
        render_policy: { field_mode: 'standard6' },
      },
    ],
  });
  assert.equal(
    (await capture(['install', plugin, '--kind', 'plugin', '--workspace', root, '--yes'])).code,
    0,
  );
  assert.equal(
    (await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root])).code,
    0,
  );
  const missing = await capture([
    'install',
    writeSkillSource(root, 'global-skill'),
    '--host',
    'x-acme-tools-zed',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(missing.code, 2, '未配置 global 根应拒绝');
  assert.match(missing.out, /plugin\.acme-tools\.zed\.rules_root/);

  const globalRoot = temp('sm-plugin-global-');
  assert.equal(
    (
      await capture([
        'config',
        'set',
        'plugin.acme-tools.zed.rules_root',
        globalRoot,
        '--workspace',
        root,
      ])
    ).code,
    0,
  );
  const config = await json(['config', 'get', '--workspace', root]);
  assert.equal(
    (config.result['data'] as Record<string, unknown>)['plugin_config']?.[
      'plugin.acme-tools.zed.rules_root'
    ],
    globalRoot,
  );
  const secondGlobal = await capture([
    'install',
    writeSkillSource(root, 'global-skill-two'),
    '--host',
    'x-acme-tools-zed',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(secondGlobal.code, 0, secondGlobal.out);
  assert.equal(existsSync(join(globalRoot, 'rules', 'global-skill-two.md')), true);

  rmSync(join(root, 'plugins', 'acme-tools'), { recursive: true, force: true });
  const unregistered = await json(['scan', '--kind', 'plugin', '--workspace', root]);
  assert.equal(unregistered.code, 1, '插件包缺失应作为失效结论报告');
  const data = unregistered.result['data'] as Record<string, unknown>;
  assert.equal(Array.isArray(data['unregistered']), true);
  assert.equal(data['unregistered'].length, 0, '被删包应表现为 registered 失效，而非候选');
});

test('T1 门禁：--kind 只属于七条指令，重复给出拒绝；插件包含代码文件拒绝', async () => {
  const root = temp('sm-plugin-gate-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const update = await capture(['update', 'x', '--kind', 'plugin', '--workspace', root]);
  assert.equal(update.code, 2);
  const repeated = await capture([
    'list',
    '--kind',
    'plugin',
    '--kind',
    'plugin',
    '--workspace',
    root,
  ]);
  assert.equal(repeated.code, 2);

  const bad = writePlugin(temp('sm-plugin-bad-src-'));
  writeFileSync(join(bad, 'index.js'), 'export default 1;\n');
  const rejected = await capture([
    'install',
    bad,
    '--kind',
    'plugin',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(rejected.code, 1);
  const index = readPluginIndex(root);
  assert.equal((index['plugins'] as unknown[]).length, 0);

  const secured = writePlugin(temp('sm-plugin-secure-src-'), {
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
            security_control_evidence: {},
          },
        ],
        render_policy: { field_mode: 'standard6' },
      },
    ],
  });
  const securedInstall = await capture([
    'install',
    secured,
    '--kind',
    'plugin',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(securedInstall.code, 1);
  assert.equal((readPluginIndex(root)['plugins'] as unknown[]).length, 0);
});

test('T1 enable 重校验：安装后 manifest 被篡改时拒绝启用并标记 invalid', async () => {
  const root = temp('sm-plugin-revalidate-');
  const source = writePlugin(temp('sm-plugin-revalidate-src-'));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['install', source, '--kind', 'plugin', '--workspace', root, '--yes'])).code,
    0,
  );
  const pluginFile = join(root, 'plugins', 'acme-tools', 'plugin.json');
  const manifest = JSON.parse(readFileSync(pluginFile, 'utf8')) as Record<string, unknown>;
  const hosts = manifest['hosts'] as Array<Record<string, unknown>>;
  const roots = hosts[0]?.['roots'] as Array<Record<string, unknown>>;
  roots[0] = { ...roots[0], security_control_evidence: {} };
  writeFileSync(pluginFile, JSON.stringify(manifest));

  const enable = await capture(['enable', 'acme-tools', '--kind', 'plugin', '--workspace', root]);
  assert.equal(enable.code, 1);
  const index = readPluginIndex(root);
  const record = (index['plugins'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(record['state'], 'invalid');
  assert.equal(record['validation']['status'], 'invalid');
});

test('T1 待实现：未登记插件候选必须出现在 scan 的 unregistered 区', async () => {
  const root = temp('sm-plugin-candidate-');
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  writePlugin(root);
  const scanned = await json(['scan', '--kind', 'plugin', '--workspace', root]);
  const data = scanned.result['data'] as Record<string, unknown>;
  assert.equal(Array.isArray(data['unregistered']), true);
  assert.equal(data['unregistered'].length, 1);
});
