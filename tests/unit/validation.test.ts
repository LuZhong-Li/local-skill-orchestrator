import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWorkspace } from '../../kernel/core/validation/index.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex, saveIndex } from '../../kernel/core/index/index.ts';
import { layoutOf, type WorkspaceLayout } from '../../kernel/store/workspace/index.ts';
import { CODES } from '../../kernel/store/contract.ts';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-14T00:00:00Z';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-val-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  return root;
}

function putSkill(root: string, dir: string, meta: string | null, content = '# skill'): void {
  const target = join(root, 'skills', dir);
  mkdirSync(target, { recursive: true });
  if (content !== '') writeFileSync(join(target, 'SKILL.md'), content);
  if (meta !== null) writeFileSync(join(target, 'skill_meta.yaml'), meta);
}

const validMeta = (id: string): string =>
  [
    `id: ${id}`,
    `name: ${id}`,
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
    '    file_map:',
    '      SKILL.md: SKILL.md',
    '',
  ].join('\n');

function metaFile(root: string, id: string): string {
  return join(root, 'skills', id, 'skill_meta.yaml');
}

/** 建立工作区并完成一次扫描，索引同时落盘，便于校验只读性 */
function prepare(): { root: string; layout: WorkspaceLayout; index: SkillIndex } {
  const root = workspace();
  putSkill(root, 'code-review', validMeta('code-review'));
  const layout = layoutOf(root);
  const scanned = scanWorkspace({ layout, index: createInitialIndex(NOW), now: NOW });
  saveIndex(layout.indexFile, scanned.index);
  return { root, layout, index: scanned.index };
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((item) => item.code);
}

test('K-05 干净工作区不产生问题，记录判为通过', () => {
  const { layout, index } = prepare();
  const outcome = validateWorkspace({ layout, index });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.report.scope, 'environment');
  assert.equal(outcome.report.total, 1);
  assert.equal(outcome.report.passed, 1);
  assert.equal(outcome.report.invalid, 0);
  assert.equal(outcome.report.stale, 0);
  assert.deepEqual(outcome.report.records[0]?.errors, []);
});

test('K-05 V-07 内容漂移：重算指纹与记录不一致时报警告', () => {
  const { root, layout, index } = prepare();
  writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), '# skill changed');
  const outcome = validateWorkspace({ layout, index });
  assert.ok(codes(outcome.findings).includes(CODES.DRIFT));
  const drift = outcome.findings.find((item) => item.code === CODES.DRIFT);
  assert.match(drift?.message ?? '', /记录指纹 sha256:/);
  assert.match(drift?.message ?? '', /重算指纹 sha256:/);
  assert.equal(drift?.severity, 'warning');
});

test('K-05 V-07 不把元文件自身的改动当作内容漂移', () => {
  const { root, layout, index } = prepare();
  appendFileSync(metaFile(root, 'code-review'), 'description: 补充描述\n');
  const outcome = validateWorkspace({ layout, index });
  assert.ok(!codes(outcome.findings).includes(CODES.DRIFT), '元文件不参与指纹计算');
});

test('K-05 V-08 技能内容全部缺失时判为错误级', () => {
  const { root, layout, index } = prepare();
  rmSync(join(root, 'skills', 'code-review', 'SKILL.md'));
  const outcome = validateWorkspace({ layout, index });
  assert.ok(codes(outcome.findings).includes(CODES.HASH_MISSING));
  assert.equal(outcome.report.records[0]?.status, 'invalid');
  assert.equal(outcome.report.invalid, 1);
});

test('K-05 V-14 派生区被改写时报警告，缺失时不报', () => {
  const { root, layout, index } = prepare();

  const clean = validateWorkspace({ layout, index });
  assert.ok(!codes(clean.findings).includes(CODES.DERIVED_TAMPER), '缺失派生区字段不算问题');

  const tampered =
    readFileSync(metaFile(root, 'code-review'), 'utf8') + `checksum: sha256:${'0'.repeat(64)}\n`;
  writeFileSync(metaFile(root, 'code-review'), tampered);
  const outcome = validateWorkspace({ layout, index });
  const finding = outcome.findings.find((item) => item.code === CODES.DERIVED_TAMPER);
  assert.ok(finding !== undefined, '应检出派生区篡改');
  assert.equal(finding?.target, 'code-review.checksum');
  assert.equal(finding?.severity, 'warning');
});

test('K-05 V-16 投影不一致逐字段报告', () => {
  const { root, layout, index } = prepare();
  const meta = readFileSync(metaFile(root, 'code-review'), 'utf8')
    .replace('name: code-review', 'name: renamed')
    .replace('status: enabled', 'version: 2.0.0\nstatus: enabled');
  writeFileSync(metaFile(root, 'code-review'), meta);

  const outcome = validateWorkspace({ layout, index });
  const projection = outcome.findings.filter((item) => item.code === CODES.INDEX_PROJECTION);
  const targets = projection.map((item) => item.target).sort();
  assert.deepEqual(targets, ['code-review.name', 'code-review.version']);
});

test('K-05 V-17 记录指向的目录不存在时报路径问题', () => {
  const { root, layout, index } = prepare();
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  const outcome = validateWorkspace({ layout, index });
  const paths = outcome.findings.filter((item) => item.code === CODES.PATH_INVALID);
  assert.equal(paths.length, 2, '标识与落位路径各报一条');
  assert.equal(paths[0]?.severity, 'error');
});

test('K-05 V-17 配置区声明的根目录不可达时报路径问题', () => {
  const { layout, index } = prepare();
  const broken: SkillIndex = { ...index, config: { ...index.config, skill_roots: ['./nowhere'] } };
  const outcome = validateWorkspace({ layout, index: broken });
  const finding = outcome.findings.find((item) => item.code === CODES.PATH_INVALID);
  assert.ok(finding !== undefined);
  assert.equal(finding?.target, './nowhere');
});

test('K-05 结论过期：实时结论与索引内结论不一致时报 W-INDEX-002', () => {
  const { root, layout, index } = prepare();
  rmSync(join(root, 'skills', 'code-review', 'SKILL.md'));
  const outcome = validateWorkspace({ layout, index });
  assert.ok(codes(outcome.findings).includes(CODES.INDEX_STALE));
  assert.equal(outcome.report.stale, 1);
  assert.equal(outcome.report.records[0]?.stored, 'ok');
  assert.equal(outcome.report.records[0]?.status, 'invalid');
});

test('K-05 只读：校验前后索引文件字节完全一致', () => {
  const { root, layout, index } = prepare();
  writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), '# drifted');
  const before = readFileSync(layout.indexFile);
  validateWorkspace({ layout, index });
  const after = readFileSync(layout.indexFile);
  assert.deepEqual(after, before, '校验动作不得写入索引，含运行期结论');
});

test('K-05 单对象：只报告指定对象的问题', () => {
  const { root, layout, index } = prepare();
  putSkill(root, 'broken-skill', validMeta('broken-skill'), '');
  const scanned = scanWorkspace({ layout, index, now: NOW });

  const healthy = validateWorkspace({ layout, index: scanned.index, subject: 'code-review' });
  assert.deepEqual(healthy.findings, []);
  assert.equal(healthy.report.scope, 'record');
  assert.equal(healthy.report.subject, 'code-review');
  assert.equal(healthy.report.total, 1);

  const broken = validateWorkspace({ layout, index: scanned.index, subject: 'broken-skill' });
  assert.ok(codes(broken.findings).includes(CODES.HASH_MISSING));
  assert.equal(broken.report.total, 1);
});

test('K-05 单对象可按工作区路径定位已登记对象', () => {
  const { layout, index } = prepare();
  const outcome = validateWorkspace({ layout, index, subject: './skills/code-review' });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.report.scope, 'record');
  assert.equal(outcome.report.total, 1);
});

test('K-05 未登记目录：报告未登记警告', () => {
  const { root, layout, index } = prepare();
  putSkill(root, 'orphan', validMeta('orphan'));
  const outcome = validateWorkspace({ layout, index, subject: './skills/orphan' });
  const finding = outcome.findings.find((item) => item.code === CODES.INDEX_PROJECTION);
  assert.ok(finding !== undefined);
  assert.equal(finding?.severity, 'warning');
  assert.match(finding?.message ?? '', /未登记/);
});

test('K-05 未知对象：返回参数类问题且不产生记录', () => {
  const { layout, index } = prepare();
  const outcome = validateWorkspace({ layout, index, subject: 'nosuch' });
  assert.deepEqual(codes(outcome.findings), [CODES.INPUT_INVALID_ARG]);
  assert.equal(outcome.findings[0]?.severity, 'error');
  assert.equal(outcome.report.total, 0);
});
