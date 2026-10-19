import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { makeTempDir } from '../helpers/temp.ts';
import { makeHostRoot, writeHostSkill } from '../helpers/host.ts';
import { makeSkillSource } from '../helpers/skill.ts';
import { computeChecksum, computeLandingChecksum } from '../../kernel/core/integrity/index.ts';
import { loadHostLandings } from '../../kernel/store/host-landings/index.ts';
import { reconcileHostCopy } from '../../kernel/core/host-landings/reconcile.ts';

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

function oldWorkspace(): { root: string; hostRoot: string } {
  const root = makeTempDir('sm-l5-e2e-');
  const hostRoot = makeHostRoot('sm-l5-host-');
  assert.equal(runCli(root, ['init']).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.doubao.root', hostRoot]).code, 0);
  const source = makeSkillSource('legacy-skill', { description: '旧工作区' });
  assert.equal(runCli(root, ['install', source, '--yes']).code, 0);
  rmSync(join(root, 'host_landings.yaml'), { force: true });
  writeHostSkill(hostRoot, 'legacy-skill', { description: '旧工作区历史副本' });
  return { root, hostRoot };
}

function indexBytes(root: string): {
  skill: Buffer;
  plugin: Buffer;
} {
  return {
    skill: readFileSync(join(root, 'skill_index.yaml')),
    plugin: readFileSync(join(root, 'plugin_index.yaml')),
  };
}

test('L-5：旧工作区缺失账本按空读取，历史副本 inferred 且不判 missing', () => {
  const { root, hostRoot } = oldWorkspace();
  const before = indexBytes(root);
  assert.equal(runCli(root, ['list']).code, 0);

  const loaded = loadHostLandings(join(root, 'host_landings.yaml'));
  assert.equal(loaded.exists, false);
  assert.equal(loaded.index, null);
  assert.deepEqual(loaded.findings, []);
  assert.equal(existsSync(join(root, 'host_landings.yaml')), false);

  const target = join(hostRoot, 'legacy-skill');
  const observedDigest = computeLandingChecksum({ targetPath: target, format: 'skill' });
  const reconciled = reconcileHostCopy({
    observed: {
      host_id: 'doubao',
      target_path: target,
      exists: true,
      readable: true,
      format: 'skill',
      visibility: 'visible',
      content_digest: observedDigest,
      skill_id: 'legacy-skill',
    },
    ledger_state: 'missing',
    workspace: {
      state: 'ok',
      record: {
        skill_id: 'legacy-skill',
        checksum: computeChecksum(join(root, 'skills', 'legacy-skill')),
        expected_content_digest: observedDigest,
      },
    },
    root_readable: true,
  });
  assert.equal(reconciled.classification, 'inferred_consistent');
  assert.equal(reconciled.evidence.managed, 'inferred');
  assert.notEqual(reconciled.classification, 'missing');
  assert.notEqual(reconciled.ledger_source, 'host_landings');
  assert.deepEqual(indexBytes(root), before, '只读路径不得改写两索引');
});

test('L-5：首次 disable --host 补建账本并以 adopted 入账', () => {
  const { root, hostRoot } = oldWorkspace();
  const before = indexBytes(root);
  const result = runCli(root, ['disable', 'legacy-skill', '--host', 'doubao', '--yes']);
  assert.equal(result.code, 0);
  const data = result.result['data'] as Record<string, unknown>;
  assert.equal(data['adopted'], true);
  assert.equal(data['ledger_recorded'], true);

  const loaded = loadHostLandings(join(root, 'host_landings.yaml'));
  assert.equal(loaded.exists, true);
  assert.equal(loaded.index?.landings.length, 1);
  const record = loaded.index?.landings[0];
  assert.equal(record?.origin, 'adopted');
  assert.notEqual(record?.origin, 'distributed');
  assert.equal(record?.state, 'active');
  assert.equal(record?.visibility, 'disabled');
  assert.equal(existsSync(join(hostRoot, 'legacy-skill', 'SKILL.md.disabled')), true);
  const raw = parseYaml(readFileSync(join(root, 'host_landings.yaml'), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(raw['schema_version'], '1');
  assert.match(String(raw['tool_version']), /^\d+\.\d+\.\d+/);
  assert.deepEqual(indexBytes(root), before, 'host 可见性操作不得改写两索引');
});

test('L-5：首次 update --host 补建账本并正常 distributed 落账', () => {
  const { root } = oldWorkspace();
  const pluginBefore = readFileSync(join(root, 'plugin_index.yaml'));
  const result = runCli(root, ['update', 'legacy-skill', '--host', 'doubao', '--yes']);
  assert.equal(result.code, 0);
  const record = loadHostLandings(join(root, 'host_landings.yaml')).index?.landings[0];
  assert.equal(record?.origin, 'distributed');
  assert.equal(record?.state, 'active');
  assert.equal(readFileSync(join(root, 'plugin_index.yaml')).equals(pluginBefore), true);
});

test('L-5：首次 install --host 在旧工作区补建账本', () => {
  const root = makeTempDir('sm-l5-e2e-');
  const hostRoot = makeHostRoot('sm-l5-host-');
  assert.equal(runCli(root, ['init']).code, 0);
  assert.equal(runCli(root, ['config', 'set', 'host.doubao.root', hostRoot]).code, 0);
  rmSync(join(root, 'host_landings.yaml'), { force: true });
  const source = makeSkillSource('fresh-skill', { description: '首次安装' });
  assert.equal(runCli(root, ['install', source, '--host', 'doubao', '--yes']).code, 0);
  const record = loadHostLandings(join(root, 'host_landings.yaml')).index?.landings[0];
  assert.equal(record?.skill_id, 'fresh-skill');
  assert.equal(record?.origin, 'distributed');
});

test('L-5：损坏账本返回 E-LANDING-001，不被静默清空', () => {
  const { root, hostRoot } = oldWorkspace();
  const file = join(root, 'host_landings.yaml');
  writeFileSync(file, 'schema_version: "1"\nlandings: [\n');
  const before = indexBytes(root);
  const corruptBefore = readFileSync(file);
  const result = runCli(root, ['disable', 'legacy-skill', '--host', 'doubao', '--yes']);
  assert.equal(result.code, 1);
  const codes = (result.result['findings'] as Array<{ code: string }>).map((item) => item.code);
  assert.ok(codes.includes('E-LANDING-001'));
  assert.equal(readFileSync(file).equals(corruptBefore), true, '损坏文件不得被重置');
  assert.equal(existsSync(join(hostRoot, 'legacy-skill', 'SKILL.md')), true, '不得先改副本');
  assert.deepEqual(indexBytes(root), before);
});
