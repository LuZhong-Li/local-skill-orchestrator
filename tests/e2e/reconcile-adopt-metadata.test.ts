import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import { readMetaFile } from '../../kernel/core/metadata/read.ts';
import { isolateHostEnvironment } from '../helpers/env.ts';
import { makeHostRoot } from '../helpers/host.ts';
import { makeSkillMeta, makeSkillSource, makeWorkspaceSkill } from '../helpers/skill.ts';
import { makeTempDir } from '../helpers/temp.ts';

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(argv), out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function json(argv: string[]): Promise<{ code: number; result: Record<string, unknown> }> {
  const captured = await capture([...argv, '--json']);
  return { code: captured.code, result: JSON.parse(captured.out) as Record<string, unknown> };
}

async function init(root: string, hostRoot: string): Promise<void> {
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  assert.equal(
    (await capture(['config', 'set', 'host.claude.root', hostRoot, '--workspace', root])).code,
    0,
  );
}

function writeSkill(dir: string, content: string, meta?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  if (meta !== undefined) writeFileSync(join(dir, 'skill_meta.yaml'), meta);
}

function metaOf(root: string, id: string): Record<string, unknown> {
  const read = readMetaFile(join(root, 'skills', id), id);
  assert.ok(read.raw, JSON.stringify(read.findings));
  return read.raw;
}

async function adopt(root: string, path: string) {
  const applied = await json([
    'reconcile',
    '--action',
    'adopt',
    '--path',
    path,
    '--workspace',
    root,
    '--apply',
    '--yes',
  ]);
  assert.equal(applied.code, 0, JSON.stringify(applied.result));
  return applied;
}

test('T3 adopt：官方六字段落位，metadata 提升且冲突警告', async (t) => {
  const root = makeTempDir('sm-t3-official-');
  const hostRoot = makeHostRoot('sm-t3-official-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const dir = join(hostRoot, 'official-fields');
  writeSkill(
    dir,
    [
      '---',
      'name: official-fields',
      'description: official field fixture',
      'license: Apache-2.0',
      'compatibility: Works with Agent Skills',
      'allowed-tools: Read Grep',
      'metadata:',
      '  author: Metadata Author',
      '  version: 2.3.4',
      '  custom:',
      '    nested: true',
      'author: Top Author',
      'version: 1.0.0',
      'mcp-server:',
      '  command: example',
      'activation: /official-fields',
      'provenance:',
      '  maintainer: Example',
      '---',
      '',
      '# official fields',
    ].join('\n'),
  );

  const applied = await adopt(root, dir);
  const meta = metaOf(root, 'official-fields');
  assert.equal(meta['author'], 'Metadata Author');
  assert.equal(meta['version'], '2.3.4');
  assert.equal(meta['license'], 'Apache-2.0');
  assert.equal(meta['compatibility'], 'Works with Agent Skills');
  assert.equal(meta['allowed_tools'], 'Read Grep');
  assert.deepEqual(meta['metadata'], {
    author: 'Metadata Author',
    version: '2.3.4',
    custom: { nested: true },
  });
  assert.deepEqual(meta['extensions'], {
    'mcp-server': { command: 'example' },
    activation: '/official-fields',
    provenance: { maintainer: 'Example' },
  });
  assert.equal('dependencies' in meta, false, 'metadata.dependencies 不得自动搬移');

  const findings = applied.result['findings'] as Array<{ code: string; target: string }>;
  const warnings = findings.filter((item) => item.code === 'W-FIELD-004');
  assert.ok(warnings.some((item) => item.target.includes('metadata.author')));
  assert.ok(warnings.some((item) => item.target.includes('metadata.version')));
  assert.ok(warnings.some((item) => item.target.includes('mcp-server')));
  assert.ok(warnings.some((item) => item.target.includes('activation')));
  assert.ok(warnings.some((item) => item.target.includes('provenance')));
});

test('T3 adopt：metadata 缺失时兼容读取顶层 author/version', async (t) => {
  const root = makeTempDir('sm-t3-legacy-');
  const hostRoot = makeHostRoot('sm-t3-legacy-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const dir = join(hostRoot, 'legacy-fields');
  writeSkill(
    dir,
    [
      '---',
      'name: legacy-fields',
      'description: legacy field fixture',
      'author: Legacy Author',
      'version: 1.2.3',
      '---',
      '',
      '# legacy',
    ].join('\n'),
  );

  await adopt(root, dir);
  const meta = metaOf(root, 'legacy-fields');
  assert.equal(meta['author'], 'Legacy Author');
  assert.equal(meta['version'], '1.2.3');
  assert.equal('metadata' in meta, false);
});

test('T3 adopt：SKILL.md 胜来源内既有 skill_meta', async (t) => {
  const root = makeTempDir('sm-t3-source-meta-');
  const hostRoot = makeHostRoot('sm-t3-source-meta-host-');
  t.after(isolateHostEnvironment(root));
  await init(root, hostRoot);
  const dir = join(hostRoot, 'source-wins');
  writeSkill(
    dir,
    [
      '---',
      'name: source-wins',
      'description: from SKILL.md',
      'compatibility: Source Compatibility',
      'metadata:',
      '  author: Source Author',
      '  version: 3.0.0',
      '---',
      '',
      '# source wins',
    ].join('\n'),
    [
      'id: source-wins',
      'name: source-wins',
      'description: from stale meta',
      'author: Stale Author',
      'version: 9.9.9',
      'compatibility: Stale Compatibility',
      'status: enabled',
      'path: ./skills/source-wins',
      'source:',
      '  type: unknown',
      'targets: []',
      '',
    ].join('\n'),
  );

  await adopt(root, dir);
  const meta = metaOf(root, 'source-wins');
  assert.equal(meta['author'], 'Source Author');
  assert.equal(meta['version'], '3.0.0');
  assert.equal(meta['compatibility'], 'Source Compatibility');
  assert.notEqual(meta['description'], 'from stale meta');
});

test('T3 install：只消费 skill_meta，不重新解析裸 SKILL.md', async (t) => {
  const root = makeTempDir('sm-t3-install-boundary-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  const meta = [makeSkillMeta('install-boundary'), 'author: Meta Author', 'version: 4.5.6'].join(
    '\n',
  );
  const source = makeSkillSource('install-boundary', {
    meta,
    content: [
      '---',
      'name: install-boundary',
      'description: SKILL.md description',
      'compatibility: SKILL.md Compatibility',
      'metadata:',
      '  author: Frontmatter Author',
      '  version: 9.9.9',
      '---',
      '',
      '# install boundary',
    ].join('\n'),
  });

  const installed = await capture([
    'install',
    source,
    '--library-only',
    '--workspace',
    root,
    '--yes',
  ]);
  assert.equal(installed.code, 0, installed.out);
  const written = metaOf(root, 'install-boundary');
  assert.equal(written['author'], 'Meta Author');
  assert.equal(written['version'], '4.5.6');
  assert.equal('compatibility' in written, false);
  assert.equal('metadata' in written, false);
  assert.match(
    readFileSync(join(root, 'skills', 'install-boundary', 'SKILL.md'), 'utf8'),
    /Frontmatter Author/,
    '安装复制正文不得被当成元数据来源',
  );
});

test('T3 scan：新增承载字段在元文件白名单内，不产生 W-FIELD-004', async (t) => {
  const root = makeTempDir('sm-t3-scan-fields-');
  t.after(isolateHostEnvironment(root));
  assert.equal((await capture(['init', '--workspace', root])).code, 0);
  makeWorkspaceSkill(root, 'scan-fields', {
    description: 'scan fields',
    meta: [
      makeSkillMeta('scan-fields', { description: 'scan fields' }),
      'compatibility: Agent Skills',
      'allowed_tools: Read Grep',
      'metadata:',
      '  author: Author',
      'extensions:',
      '  activation: /scan-fields',
    ].join('\n'),
  });

  const scanned = await json(['scan', '--workspace', root]);
  assert.equal(scanned.code, 0, JSON.stringify(scanned.result));
  const findings = scanned.result['findings'] as Array<{ code: string; target: string }>;
  assert.equal(
    findings.some((item) => item.code === 'W-FIELD-004'),
    false,
    JSON.stringify(findings),
  );
});
