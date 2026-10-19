#!/usr/bin/env node
/**
 * M4c-7 三平台盘点探针：真实执行 CLI，构造隔离 HOME/LOCALAPPDATA fixture，
 * 验证路径展开、发现、去重、对账、未初始化与插件 rules .md。
 *
 * 本脚本不读取真实用户目录，不写工作区之外的真实位置；CI 在
 * Windows / macOS / Linux runner 上以同一入口运行。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const checks = [];

function expect(name, condition, detail = '') {
  checks.push({ name, ok: condition === true, detail: condition === true ? '' : detail });
  if (condition !== true) throw new Error(`${name}${detail === '' ? '' : `：${detail}`}`);
}

function skillText(name, description = `${name} fixture`) {
  return [
    `---`,
    `name: ${name}`,
    `description: ${description}`,
    'version: 1.0.0',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n');
}

function writeSkill(dir, name, { references = false } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillText(name));
  if (references) {
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'note.md'), '# reference');
  }
}

function writeDisabledSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md.disabled'), skillText(name));
}

function writeCorrupt(dir, name, kind) {
  mkdirSync(dir, { recursive: true });
  const body =
    kind === 'bad-yaml'
      ? '---\nname: broken\ndescription: [unclosed\n---\n'
      : '---\ndescription: no name\n---\n';
  writeFileSync(join(dir, 'SKILL.md'), body);
}

function writeRules(dir, name, extension) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.${extension}`), '---\nalwaysApply: false\n---\n');
}

function writeSource(dir, id) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillText(id));
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      `description: ${id} fixture`,
      'version: 1.0.0',
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      `    path: .claude/skills/${id}`,
      '    mode: copy',
      '    enabled: true',
      '',
    ].join('\n'),
  );
}

function prepareFixtures() {
  const base = mkdtempSync(join(tmpdir(), 'sm-probe-inventory-'));
  const home = join(base, 'home');
  const local = join(base, 'local');
  const shared = join(base, 'shared');
  const rules = join(base, 'rules');
  mkdirSync(home, { recursive: true });
  mkdirSync(local, { recursive: true });
  writeSkill(join(shared, 'alpha'), 'alpha', { references: true });
  writeDisabledSkill(join(shared, 'beta'), 'beta');
  writeSkill(join(shared, 'outer', 'inner'), 'inner');
  writeCorrupt(join(shared, 'broken-bad-yaml'), 'broken-bad-yaml', 'bad-yaml');
  writeCorrupt(join(shared, 'broken-no-name'), 'broken-no-name', 'no-name');
  mkdirSync(join(shared, 'no-skill'), { recursive: true });
  writeFileSync(join(shared, 'no-skill', 'notes.txt'), 'not a skill');
  writeRules(rules, 'config-rule', 'mdc');
  writeRules(rules, 'ignored', 'md');
  writeSkill(join(home, '.claude', 'skills', 'default-claude'), 'default-claude');
  writeSkill(join(home, '.agents', 'skills', 'default-codex'), 'default-codex');
  writeSkill(join(home, '.cursor', 'skills', 'default-cursor'), 'default-cursor');
  writeRules(join(home, '.cursor', 'rules'), 'default-rule', 'mdc');
  const cursorLink = join(base, 'cursor-link');
  let symlink = 'skipped';
  if (process.platform !== 'win32') {
    symlinkSync(shared, cursorLink, 'dir');
    symlink = 'created';
  }
  return {
    base,
    home,
    local,
    shared,
    rules,
    cursorRoot: symlink === 'created' ? cursorLink : shared,
    source: join(base, 'source', 'probe-skill'),
    pluginSource: join(base, 'plugin-source'),
    pluginSkill: join(base, 'plugin-skill-source'),
    symlink,
  };
}

function envOf(fixture) {
  return {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    LOCALAPPDATA: fixture.local,
  };
}

function runCli(fixture, args) {
  const result = spawnSync(process.execPath, ['kernel/entry/cli.ts', ...args], {
    cwd: ROOT,
    env: envOf(fixture),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `CLI 失败：${args.join(' ')}（退出码 ${String(result.status)}）\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runJson(fixture, args) {
  return JSON.parse(runCli(fixture, [...args, '--json']));
}

function scan(fixture, workspace) {
  return runJson(fixture, ['scan', '--inventory', '--workspace', workspace]).data;
}

function rootOf(data, rootId) {
  return data.roots.find((item) => item.root_id === rootId);
}

function copyOf(data, predicate) {
  return data.copies.find(predicate);
}

function checkMechanism(fixture, data) {
  const expected = [
    ['claude/user', join(fixture.home, '.claude', 'skills')],
    ['codex/agents-user', join(fixture.home, '.agents', 'skills')],
    ['cursor/user-skills', join(fixture.home, '.cursor', 'skills')],
    ['cursor/user-rules', join(fixture.home, '.cursor', 'rules')],
  ];
  for (const [rootId, path] of expected) {
    expect(
      `HOME 展开：${rootId}`,
      rootOf(data, rootId)?.path === path,
      `${rootOf(data, rootId)?.path} != ${path}`,
    );
  }
  expect('fixture 根路径使用平台分隔符', rootOf(data, 'claude/user')?.path.includes(sep) === true);
  expect(
    'config 根被追加',
    data.roots.some((item) => item.origin === 'config' && item.path === fixture.shared),
  );
  expect(
    'config rules 根被追加',
    data.roots.some(
      (item) => item.origin === 'config' && item.kind === 'rules' && item.path === fixture.rules,
    ),
  );
  expect(
    '机制验证根已移除 pending',
    ['claude/user', 'cursor/user-skills', 'cursor/user-rules'].every(
      (rootId) => rootOf(data, rootId)?.pending_verification !== true,
    ),
  );
  expect(
    'Codex 事实根保留 pending',
    ['codex/agents-user', 'codex/legacy-user', 'codex/system'].every(
      (rootId) => rootOf(data, rootId)?.pending_verification === true,
    ),
  );
  if (process.platform === 'win32') {
    expect(
      'Windows 豆包平台根存在',
      data.roots.some((item) => item.root_id === 'doubao/platform'),
    );
  } else {
    expect(
      '非 Windows 不注入豆包静态根',
      data.roots.every((item) => item.root_id !== 'doubao/platform'),
    );
  }
}

function checkDiscovery(fixture, data) {
  const alpha = copyOf(data, (copy) => copy.path === join(fixture.shared, 'alpha'));
  expect('有效技能被发现', alpha !== undefined);
  expect('共享根去重', alpha?.root_ids.length >= 3, JSON.stringify(alpha?.root_ids));
  expect(
    '共享根消费宿主聚合',
    ['claude', 'codex', 'cursor'].every((id) => alpha?.consumed_by.includes(id)),
    JSON.stringify(alpha?.consumed_by),
  );
  expect(
    '.disabled 可见性',
    copyOf(data, (copy) => copy.path === join(fixture.shared, 'beta'))?.visibility === 'disabled',
  );
  const inner = data.copies.find((copy) => copy.skill_id === 'inner');
  expect(
    '递归只由 Cursor 根发现',
    inner !== undefined && inner.root_ids.includes('cursor/config-root'),
    JSON.stringify(data.copies.map((copy) => copy.path)),
  );
  expect(
    'references 不计数',
    data.copies.every((copy) => !copy.path.endsWith('references')),
  );
  expect(
    '无 SKILL.md 目录不计数',
    data.copies.every((copy) => !copy.path.endsWith('no-skill')),
  );
  expect(
    '坏 YAML 进入 corrupt',
    data.corrupt.some(
      (copy) => copy.path.endsWith('broken-bad-yaml') && copy.reason === 'bad_yaml',
    ),
  );
  expect(
    '缺 name 进入 corrupt',
    data.corrupt.some(
      (copy) => copy.path.endsWith('broken-no-name') && copy.reason === 'missing_name',
    ),
  );
  expect(
    '内置 rules 只认 .mdc',
    data.copies.some((copy) => copy.path.endsWith('config-rule.mdc')) &&
      data.copies.every((copy) => !copy.path.endsWith('ignored.md')),
  );
  expect('损坏不计入有效副本', data.corrupt.length === 2, String(data.corrupt.length));
}

function checkClassification(fixture, workspace, source) {
  const before = scan(fixture, workspace);
  expect('未纳管分类存在', before.summary.classification_groups.untracked > 0);
  runCli(fixture, ['install', source, '--workspace', workspace, '--yes']);
  runCli(fixture, ['update', 'probe-skill', '--host', 'claude', '--workspace', workspace, '--yes']);
  const managed = scan(fixture, workspace);
  const managedCopy = copyOf(managed, (copy) => copy.path === join(fixture.shared, 'probe-skill'));
  expect(
    'managed 副本落位',
    managedCopy !== undefined,
    JSON.stringify(managed.copies.map((copy) => copy.path)),
  );
  expect(
    'managed 分类',
    managedCopy?.reconciliation.classification === 'managed_consistent',
    managedCopy?.reconciliation.classification,
  );
  expect('managed 证据权威', managedCopy?.reconciliation.authority === 'authoritative');
  writeFileSync(
    join(fixture.shared, 'probe-skill', 'SKILL.md'),
    skillText('probe-skill', 'changed'),
  );
  const drift = scan(fixture, workspace);
  expect(
    '内容漂移分类',
    copyOf(drift, (copy) => copy.path === join(fixture.shared, 'probe-skill'))?.reconciliation
      .classification === 'drift',
  );
  rmSync(join(fixture.shared, 'probe-skill'), { recursive: true, force: true });
  const missing = scan(fixture, workspace);
  expect(
    '账本反向 missing',
    missing.missing.some((item) => item.target_path === join(fixture.shared, 'probe-skill')),
  );
  expect(
    'missing 权威',
    missing.missing.find((item) => item.target_path === join(fixture.shared, 'probe-skill'))
      ?.authority === 'authoritative',
  );
}

function checkPluginRules(fixture, workspace) {
  mkdirSync(fixture.pluginSource, { recursive: true });
  writeFileSync(
    join(fixture.pluginSource, 'plugin.json'),
    JSON.stringify({
      manifest_version: '1',
      plugin_id: 'probe-tools',
      name: 'Probe Tools',
      version: '1.0.0',
      compatibility: { skill_manager: '>=0.2.0 <1.0.0', plugin_api: '1' },
      capabilities: ['host_profile'],
      hosts: [
        {
          host_key: 'zed',
          display_name: 'Zed',
          form: 'rules',
          roots: [{ kind: 'rules', path_template: '.zed/rules/<skill_id>.md', scope: 'project' }],
          render_policy: { field_mode: 'standard6' },
        },
      ],
    }),
  );
  runCli(fixture, [
    'install',
    fixture.pluginSource,
    '--kind',
    'plugin',
    '--workspace',
    workspace,
    '--yes',
  ]);
  runCli(fixture, ['enable', 'probe-tools', '--kind', 'plugin', '--workspace', workspace, '--yes']);
  writeSource(fixture.pluginSkill, 'plugin-skill');
  runCli(fixture, ['install', fixture.pluginSkill, '--workspace', workspace, '--yes']);
  runCli(fixture, [
    'update',
    'plugin-skill',
    '--host',
    'x-probe-tools-zed',
    '--workspace',
    workspace,
    '--yes',
  ]);
  const data = scan(fixture, workspace);
  const host = data.hosts.find((item) => item.host_id === 'x-probe-tools-zed');
  const copy = copyOf(
    data,
    (item) => item.host_id === 'x-probe-tools-zed' && item.format === 'rules',
  );
  expect('x- 宿主进入盘点', host !== undefined);
  expect('x- 宿主 rules .md 兼容', copy?.path.endsWith('plugin-skill.md') === true, copy?.path);
  expect('x- 宿主 rules 识别 id', copy?.skill_id === 'plugin-skill', copy?.skill_id);
}

function checkUninitialized(fixture) {
  const workspace = join(fixture.base, 'uninitialized');
  const data = scan(fixture, workspace);
  expect('未初始化工作区可运行', data.workspace.state === 'uninitialized');
  expect('未初始化不产生 missing', data.missing.length === 0);
  expect('未初始化不伪造 managed', data.summary.classification_groups.managed.total === 0);
}

function main() {
  const fixture = prepareFixtures();
  try {
    writeSource(fixture.source, 'probe-skill');
    const workspace = join(fixture.base, 'workspace');
    runCli(fixture, ['init', '--workspace', workspace]);
    for (const [key, value] of [
      ['host.claude.root', fixture.shared],
      ['host.codex.root', fixture.shared],
      ['host.cursor.root', fixture.cursorRoot],
      ['host.cursor.rules_root', fixture.rules],
    ]) {
      runCli(fixture, ['config', 'set', key, value, '--workspace', workspace]);
    }
    const config = runJson(fixture, ['config', 'get', '--workspace', workspace]).data;
    expect(
      'config 覆盖写入',
      config.config['host.claude.root'] === fixture.shared,
      JSON.stringify(config),
    );
    const initial = scan(fixture, workspace);
    checkMechanism(fixture, initial);
    checkDiscovery(fixture, initial);
    checkClassification(fixture, workspace, fixture.source);
    checkPluginRules(fixture, workspace);
    checkUninitialized(fixture);
    for (const item of checks) {
      console.log(
        `${item.ok ? '✔' : '✖'} ${item.name}${item.detail === '' ? '' : `（${item.detail}）`}`,
      );
    }
    console.log(
      `PROBE_RESULT=ok platform=${process.platform} checks=${checks.length} copies=${initial.copies.length} corrupt=${initial.corrupt.length} symlink=${fixture.symlink}`,
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
}

main();
