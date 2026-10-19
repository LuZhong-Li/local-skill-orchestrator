/** T6 三平台探针的插件 x- 段：repair / track / forget / clean 与 adopt/accept 拒绝。 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

function pluginText(fixture) {
  return readFileSync(join(fixture.workspace, 'plugin_index.yaml'), 'utf8');
}

function dropPluginLanding(fixture, skillId) {
  const path = join(fixture.workspace, 'plugin_index.yaml');
  const document = parseYaml(readFileSync(path, 'utf8'));
  document.landings = (document.landings ?? []).filter((item) => item.skill_id !== skillId);
  writeFileSync(path, stringifyYaml(document));
}

function orphanPluginCopy(fixture, skillId) {
  const pluginPath = join(fixture.workspace, 'plugin_index.yaml');
  const pluginDocument = parseYaml(readFileSync(pluginPath, 'utf8'));
  for (const landing of pluginDocument.landings ?? []) {
    if (landing.skill_id === skillId) landing.state = 'orphaned';
  }
  writeFileSync(pluginPath, stringifyYaml(pluginDocument));
  const indexPath = join(fixture.workspace, 'skill_index.yaml');
  const indexDocument = parseYaml(readFileSync(indexPath, 'utf8'));
  indexDocument.skills = (indexDocument.skills ?? []).filter((item) => item.id !== skillId);
  writeFileSync(indexPath, stringifyYaml(indexDocument));
}

export function writePluginPackage(fixture) {
  mkdirSync(fixture.pluginSource, { recursive: true });
  writeFileSync(
    join(fixture.pluginSource, 'plugin.json'),
    `${JSON.stringify(
      {
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
            roots: [{ kind: 'rules', path_template: '<skill_id>.md', scope: 'global' }],
            render_policy: { field_mode: 'standard6' },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function installPluginHost(context) {
  const { fixture, cli } = context;
  writePluginPackage(fixture);
  cli(fixture, [
    'install',
    fixture.pluginSource,
    '--kind',
    'plugin',
    '--workspace',
    fixture.workspace,
    '--yes',
  ]);
  cli(fixture, [
    'config',
    'set',
    'plugin.probe-tools.zed.rules_root',
    join(fixture.workspace, '.zed', 'rules'),
    '--workspace',
    fixture.workspace,
  ]);
  cli(fixture, [
    'enable',
    'probe-tools',
    '--kind',
    'plugin',
    '--workspace',
    fixture.workspace,
    '--yes',
  ]);
}

function installPluginSkill(context, id) {
  const { fixture, cli, writeSource } = context;
  cli(fixture, [
    'install',
    writeSource(join(fixture.pluginSkillSource, id), id),
    '--host',
    'x-probe-tools-zed',
    '--workspace',
    fixture.workspace,
    '--yes',
  ]);
  return join(fixture.workspace, '.zed', 'rules', `${id}.md`);
}

function checkRejections(context, rule) {
  const { fixture, expect, preview } = context;
  expect(
    '插件副本拒绝 adopt',
    preview(fixture, ['--action', 'adopt', '--path', rule]).items[0]?.status === 'skipped',
  );
  expect(
    '插件副本拒绝 accept',
    preview(fixture, ['--action', 'accept', '--path', rule]).items[0]?.status === 'skipped',
  );
}

function checkRepair(context) {
  const { fixture, expect, preview, apply, scan, copyAt } = context;
  const rule = installPluginSkill(context, 'plugin-skill');
  expect('插件 rules .md 落位', existsSync(rule));
  expect('插件副本进入 x- 宿主', copyAt(scan(fixture), rule)?.host_group === 'plugin');
  writeFileSync(rule, '---\nname: plugin-skill\ndescription: local drift\n---\n\n# local drift\n');
  expect(
    '插件副本进入 drift',
    copyAt(scan(fixture), rule)?.reconciliation.classification === 'drift',
  );
  checkRejections(context, rule);
  const plan = preview(fixture, ['--action', 'repair', '--path', rule]);
  expect(
    '插件 repair 只写插件账本',
    plan.items[0]?.ledger_changes[0]?.source === 'plugin_landings' &&
      plan.items[0]?.writes.some((write) => write.kind === 'plugin_index'),
  );
  const repaired = apply(fixture, ['--action', 'repair', '--path', rule]);
  expect('插件 repair succeeded', repaired.data?.results[0]?.status === 'succeeded');
  expect('插件 repair 重渲染规则', !readFileSync(rule, 'utf8').includes('local drift'));
}

function checkTrackForget(context) {
  const { fixture, expect, apply, scan, copyAt } = context;
  const extra = installPluginSkill(context, 'plugin-extra');
  dropPluginLanding(fixture, 'plugin-extra');
  expect(
    '插件无账本副本为 inferred',
    copyAt(scan(fixture), extra)?.reconciliation.classification === 'inferred_consistent',
  );
  const tracked = apply(fixture, ['--action', 'track', '--path', extra]);
  expect('插件 track succeeded', tracked.data?.results[0]?.status === 'succeeded');
  expect('插件 track 写 plugin_index', pluginText(fixture).includes('skill_id: plugin-extra'));
  rmSync(extra, { force: true });
  const forgotten = apply(fixture, [
    '--action',
    'forget',
    '--id',
    'plugin-extra',
    '--host',
    'x-probe-tools-zed',
  ]);
  expect('插件 forget succeeded', forgotten.data?.results[0]?.status === 'succeeded');
  expect('插件 forget 转 orphaned', pluginText(fixture).includes('state: orphaned'));
}

function checkClean(context) {
  const { fixture, expect, apply, scan, copyAt } = context;
  const orphan = installPluginSkill(context, 'plugin-orphan');
  orphanPluginCopy(fixture, 'plugin-orphan');
  expect(
    '插件孤儿副本可识别',
    copyAt(scan(fixture), orphan)?.reconciliation.classification === 'orphaned',
  );
  const cleaned = apply(fixture, ['--action', 'clean', '--path', orphan]);
  expect('插件 clean succeeded', cleaned.data?.results[0]?.status === 'succeeded');
  expect('插件 clean 删除副本', !existsSync(orphan));
  expect('插件 clean 清掉 landing', !pluginText(fixture).includes('skill_id: plugin-orphan'));
  expect('插件包保留', existsSync(join(fixture.workspace, 'plugins', 'probe-tools')));
  expect(
    '插件 repair 后 landing 仍 active',
    pluginText(fixture).includes('skill_id: plugin-skill'),
  );
}

export function runPluginChecks(context) {
  installPluginHost(context);
  checkRepair(context);
  checkTrackForget(context);
  checkClean(context);
}
