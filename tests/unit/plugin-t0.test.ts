import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../../kernel/entry/cli.ts';
import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_VERSION,
  canonicalHostId,
  validatePluginManifest,
  type PluginManifest,
} from '../../kernel/core/plugins/manifest.ts';
import {
  createInitialPluginIndex,
  loadPluginIndex,
  savePluginIndex,
} from '../../kernel/store/plugin-registry/index.ts';
import { discoverPluginPackages } from '../../kernel/core/plugins/discovery.ts';
import { buildHostCatalog } from '../../kernel/core/plugins/catalog.ts';
import { createPluginRecord } from '../../kernel/core/plugins/record.ts';
import type {
  PluginCatalogEntry,
  PluginHostRecord,
  PluginIndex,
  PluginRecord,
} from '../../kernel/core/plugins/types.ts';
import { allAdapters } from '../../kernel/core/adapters/index.ts';
import { hostIds, loadHostRegistry } from '../../kernel/core/hosts/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { CODES } from '../../kernel/store/contract.ts';
import { setConfig } from '../../kernel/core/index/index.ts';

const NOW = '2026-10-17T00:00:00Z';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sm-plugin-'));
}

function manifest(patch: Record<string, unknown> = {}): PluginManifest {
  return {
    manifest_version: PLUGIN_MANIFEST_VERSION,
    plugin_id: 'acme-tools',
    name: 'Acme Tools',
    version: '1.0.0',
    compatibility: {
      skill_manager: '>=0.2.0 <1.0.0',
      plugin_api: PLUGIN_API_VERSION,
    },
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
        render_policy: {
          field_mode: 'standard6',
        },
      },
    ],
    ...patch,
  } as PluginManifest;
}

function hostRecord(patch: Partial<PluginHostRecord> = {}): PluginHostRecord {
  return {
    host_id: canonicalHostId('acme-tools', 'zed'),
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
    ...patch,
  };
}

function record(patch: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: 'acme-tools',
    kind: 'plugin',
    name: 'Acme Tools',
    version: '1.0.0',
    capabilities: ['host_profile'],
    compatibility: {
      skill_manager: '>=0.2.0 <1.0.0',
      plugin_api: PLUGIN_API_VERSION,
    },
    manifest_path: './plugins/acme-tools/plugin.json',
    manifest_hash: `sha256:${'a'.repeat(64)}`,
    hosts: [hostRecord()],
    state: 'disabled',
    validation: { status: 'ok', errors: [] },
    installed_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

function entry(
  patch: Partial<PluginCatalogEntry> = {},
  recordPatch: Partial<PluginRecord> = {},
): PluginCatalogEntry {
  return {
    record: record(recordPatch),
    manifest: manifest(),
    findings: [],
    ...patch,
  };
}

function writeManifest(dir: string, value: unknown = manifest()): string {
  const target = join(dir, 'plugin.json');
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

test('T0 工作区：init 建立 plugins 目录与空的 plugin_index.yaml', async () => {
  const root = tempDir();
  assert.equal(await run(['init', '--workspace', root]), 0);
  const layout = layoutOf(root);
  assert.equal(existsSync(layout.pluginsDir), true, 'plugins 目录应建立');
  assert.equal(existsSync(layout.pluginIndexFile), true, 'plugin_index.yaml 应建立');
  const loaded = loadPluginIndex(layout.pluginIndexFile);
  assert.deepEqual(loaded.findings, []);
  assert.equal(loaded.index?.schema_version, '1');
  assert.deepEqual(loaded.index?.plugins, []);
});

test('T0 manifest：合法声明通过并生成 canonical host id', () => {
  const outcome = validatePluginManifest(manifest(), { toolVersion: '0.2.0' });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.manifest?.plugin_id, 'acme-tools');
  assert.equal(canonicalHostId('acme-tools', 'zed'), 'x-acme-tools-zed');
});

test('T0 manifest：缺少必填字段、非法标识与不兼容 API 被拒绝', () => {
  const missing = manifest();
  delete (missing as unknown as Record<string, unknown>)['plugin_id'];
  assert.equal(validatePluginManifest(missing, { toolVersion: '0.2.0' }).manifest, null);
  assert.ok(
    validatePluginManifest(missing, { toolVersion: '0.2.0' }).findings.some(
      (item) => item.code === CODES.FIELD_REQUIRED,
    ),
  );

  const badId = validatePluginManifest(manifest({ plugin_id: 'Bad_Id' }), {
    toolVersion: '0.2.0',
  });
  assert.equal(badId.manifest, null);
  assert.ok(badId.findings.some((item) => item.code === CODES.ID_PLUGIN_INVALID));

  const badApi = validatePluginManifest(
    manifest({
      compatibility: {
        skill_manager: '>=0.2.0 <1.0.0',
        plugin_api: '2',
      },
    }),
    { toolVersion: '0.2.0' },
  );
  assert.equal(badApi.manifest, null);
  assert.ok(badApi.findings.some((item) => item.code === CODES.VERSION_PLUGIN_API));

  const badDescription = validatePluginManifest(manifest({ description: 42 }), {
    toolVersion: '0.2.0',
  });
  assert.equal(badDescription.manifest, null);
  assert.ok(badDescription.findings.some((item) => item.code === CODES.FIELD_TYPE));
});

test('T0 manifest：代码入口、安全控制字段与越界路径整插件拒绝', () => {
  const code = validatePluginManifest(manifest({ main: 'index.js' }), {
    toolVersion: '0.2.0',
  });
  assert.equal(code.manifest, null);
  assert.ok(code.findings.some((item) => item.code === CODES.FIELD_INVALID_VALUE));

  const security = validatePluginManifest(
    manifest({
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
              security_control_evidence: { semantics: 'fake' },
            },
          ],
          render_policy: { field_mode: 'standard6' },
        },
      ],
    }),
    { toolVersion: '0.2.0' },
  );
  assert.equal(security.manifest, null);
  assert.ok(security.findings.some((item) => item.code === CODES.FIELD_INVALID_VALUE));

  const escape = validatePluginManifest(
    manifest({
      hosts: [
        {
          host_key: 'zed',
          display_name: 'Zed',
          form: 'rules',
          roots: [
            {
              kind: 'rules',
              path_template: '../outside/<skill_id>.md',
              scope: 'project',
            },
          ],
          render_policy: { field_mode: 'standard6' },
        },
      ],
    }),
    { toolVersion: '0.2.0' },
  );
  assert.equal(escape.manifest, null);
  assert.ok(escape.findings.some((item) => item.code === CODES.PATH_INVALID));
});

test('T0 插件索引：原子写往返保留未知字段，损坏索引不静默清空', () => {
  const root = tempDir();
  const layout = layoutOf(root);
  const index = createInitialPluginIndex(NOW);
  const withRecord: PluginIndex = {
    ...index,
    plugins: [record()],
    extension_flag: 'kept',
  } as PluginIndex;
  savePluginIndex(layout.pluginIndexFile, withRecord);
  const loaded = loadPluginIndex(layout.pluginIndexFile);
  assert.deepEqual(loaded.findings, []);
  assert.equal(loaded.index?.plugins[0]?.id, 'acme-tools');
  assert.equal((loaded.index as unknown as Record<string, unknown>)['extension_flag'], 'kept');

  writeFileSync(layout.pluginIndexFile, 'schema_version: "1"\n  broken: [\n');
  const broken = loadPluginIndex(layout.pluginIndexFile);
  assert.equal(broken.index, null);
  assert.ok(broken.findings.some((item) => item.code === CODES.YAML_INVALID));

  writeFileSync(
    layout.pluginIndexFile,
    'schema_version: "1"\ntool_version: 0.2.0\ngenerated_at: 2026-10-17T00:00:00Z\nconfig: []\nplugins:\n  - 42\n',
  );
  const malformed = loadPluginIndex(layout.pluginIndexFile);
  assert.ok(malformed.index !== null, '结构问题应可报告，不应直接丢弃整个索引');
  assert.ok(malformed.findings.some((item) => item.code === CODES.FIELD_TYPE));
});

test('T0 登记：插件记录默认 disabled，host 全部使用 canonical id', () => {
  const recordValue = createPluginRecord({
    manifest: manifest(),
    manifestPath: './plugins/acme-tools/plugin.json',
    manifestHash: `sha256:${'b'.repeat(64)}`,
    now: NOW,
  });
  assert.equal(recordValue.state, 'disabled');
  assert.equal(recordValue.kind, 'plugin');
  assert.deepEqual(
    recordValue.hosts.map((host) => host.host_id),
    ['x-acme-tools-zed'],
  );
  assert.equal(recordValue.validation.status, 'ok');
});

test('T0 发现：manifest 哈希与代码文件拒绝可同时报告', () => {
  const root = tempDir();
  const pluginDir = join(root, 'acme-tools');
  mkdirSync(pluginDir, { recursive: true });
  const manifestFile = writeManifest(pluginDir);
  writeFileSync(join(pluginDir, 'index.js'), 'export default 1;\n');

  const discovered = discoverPluginPackages(root);
  assert.equal(discovered.candidates.length, 1);
  const candidate = discovered.candidates[0];
  assert.equal(candidate?.plugin_id, 'acme-tools');
  assert.equal(
    candidate?.manifest_hash,
    `sha256:${createHash('sha256').update(readFileSync(manifestFile)).digest('hex')}`,
  );
  assert.ok(
    candidate?.findings.some((item) => item.code === CODES.FIELD_INVALID_VALUE),
    '代码文件应被拒绝',
  );
});

test('T0 发现：符号链接插件目录被拒绝（无权限平台跳过）', (t) => {
  const root = tempDir();
  const real = join(root, 'real-plugin');
  mkdirSync(real, { recursive: true });
  writeManifest(real);
  try {
    symlinkSync(real, join(root, 'linked-plugin'), 'dir');
  } catch {
    t.skip('当前平台不允许创建目录符号链接');
    return;
  }
  const discovered = discoverPluginPackages(root);
  assert.ok(
    discovered.findings.some((item) => item.code === CODES.PATH_INVALID),
    '符号链接应被拒绝',
  );
});

test('T0 合并：六条机械保证逐条成立', () => {
  const builtinBefore = JSON.stringify(loadHostRegistry());
  const formBefore = allAdapters()
    .map((adapter) => adapter.host_id)
    .sort();

  // 1. 加载前后内置注册表深比较完全一致
  const disabled = entry({}, { state: 'disabled' });
  const disabledView = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries: [disabled],
  });
  assert.equal(disabledView.pluginHosts.length, 0, 'disabled 插件不加载');
  assert.equal(JSON.stringify(loadHostRegistry()), builtinBefore, '内置注册表不得变化');

  // 2. FORM_BY_HOST 键集合不变
  assert.deepEqual(
    allAdapters()
      .map((adapter) => adapter.host_id)
      .sort(),
    formBefore,
    'FORM_BY_HOST 键集合不得变化',
  );

  // 3. canonical 冲突整插件拒绝
  const collidingManifest = manifest({
    plugin_id: 'acme',
    hosts: [
      {
        host_key: 'tools-zed',
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
  });
  const conflict = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries: [
      entry({}, { state: 'enabled' }),
      entry({ manifest: collidingManifest }, { id: 'acme', state: 'enabled' }),
    ],
  });
  assert.equal(conflict.pluginHosts.length, 1, '冲突插件不得部分加载');
  assert.ok(conflict.findings.some((item) => item.code === CODES.CONFLICT_PLUGIN_HOST));

  const duplicate = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries: [entry({}, { state: 'enabled' }), entry({}, { state: 'enabled' })],
  });
  assert.equal(duplicate.pluginHosts.length, 1, '重复插件标识不得加载两次');
  assert.ok(duplicate.findings.some((item) => item.code === CODES.ID_PLUGIN_DUPLICATED));

  // 4. manifest schema 非法不加载
  const invalid = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries: [entry({ manifest: null }, { state: 'enabled' })],
  });
  assert.equal(invalid.pluginHosts.length, 0);

  // 5. disabled 不加载（与 1 同一断言的正向对照）
  const enabledInput = entry({}, { state: 'enabled' });
  const enabledInputBefore = JSON.stringify(enabledInput);
  const enabled = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries: [enabledInput],
  });
  const enabledAgain = buildHostCatalog({
    builtins: loadHostRegistry().hosts,
    entries: [entry({}, { state: 'enabled' })],
  });
  assert.deepEqual(enabled, enabledAgain, '同输入必须产出同输出');
  assert.equal(JSON.stringify(enabledInput), enabledInputBefore, '合并不得修改输入条目');
  assert.deepEqual(
    enabled.pluginHosts.map((item) => item.host_id),
    ['x-acme-tools-zed'],
  );
  assert.ok(enabled.pluginHosts.every((item) => item.host_id.startsWith('x-')));
  assert.ok(!hostIds().includes('x-acme-tools-zed'));
});

test('T0 合并：安全字段在 manifest 校验阶段即整插件拒绝', () => {
  const outcome = validatePluginManifest(
    manifest({
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
          render_policy: { field_mode: 'standard6', security_control_evidence: {} },
        },
      ],
    }),
    { toolVersion: '0.2.0' },
  );
  assert.equal(outcome.manifest, null);
  assert.ok(outcome.findings.some((item) => item.code === CODES.FIELD_INVALID_VALUE));
});

test('T0 配置隔离：host.* 拒绝插件 canonical id', () => {
  const root = tempDir();
  const outcome = setConfig({
    index: {
      schema_version: '1',
      tool_version: '0.2.0',
      generated_at: NOW,
      config: { skill_roots: ['./skills'] },
      skills: [],
    },
    key: 'host.x-acme-tools-zed.root',
    value: '/tmp/outside',
    workspaceRoot: root,
  });
  assert.equal(outcome.index, null);
  assert.equal(outcome.findings[0]?.code, CODES.INPUT_INVALID_ARG);
});

test('T0 静态审计：插件模块不含 import/require/eval 代码加载', () => {
  const files = [
    'kernel/core/plugins/manifest.ts',
    'kernel/core/plugins/discovery.ts',
    'kernel/core/plugins/catalog.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, /\bimport\s*\(/, `${file} 不得动态 import`);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${file} 不得调用 require`);
    assert.doesNotMatch(source, /\beval\s*\(/, `${file} 不得调用 eval`);
    assert.doesNotMatch(source, /\bnew\s+Function\s*\(/, `${file} 不得构造 Function`);
  }
});
