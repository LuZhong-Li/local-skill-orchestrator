import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportIndex, importIndex, BACKUP_FORMAT_VERSION } from '../../kernel/core/backup/index.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex, saveIndex } from '../../kernel/core/index/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { CODES } from '../../kernel/store/contract.ts';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-15T00:00:00Z';
const LATER = '2026-10-15T03:00:00Z';

function workspace(): string {
  const root = makeTempDir('sm-import-');
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'backups'), { recursive: true });
  return root;
}

function putSkill(root: string, id: string): void {
  const dir = join(root, 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# skill');
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
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
    ].join('\n'),
  );
}

/** 造一份真实导出的清单，返回清单路径与导出时的索引 */
function exported(): { root: string; index: SkillIndex; file: string; document: string } {
  const root = workspace();
  putSkill(root, 'alpha');
  putSkill(root, 'beta');
  const layout = layoutOf(root);
  const scanned = scanWorkspace({ layout, index: createInitialIndex(NOW), now: NOW });
  saveIndex(layout.indexFile, scanned.index);
  const outcome = exportIndex({
    layout,
    index: scanned.index,
    target: 'backups/snapshot.yaml',
    now: NOW,
  });
  assert.deepEqual(outcome.findings, []);
  return {
    root,
    index: scanned.index,
    file: 'backups/snapshot.yaml',
    document: readFileSync(join(root, 'backups', 'snapshot.yaml'), 'utf8'),
  };
}

/** 清空索引的记录区，模拟需要恢复的空工作区 */
function emptied(index: SkillIndex): SkillIndex {
  return { ...index, skills: [] };
}

function writeDocument(root: string, name: string, body: string): string {
  writeFileSync(join(root, 'backups', name), body);
  return `backups/${name}`;
}

test('K-08 导入：逐条登记并把派生区按导入时点回填', () => {
  const { root, index, file } = exported();
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.index.skills.length, 2);
  const alpha = outcome.index.skills.find((item) => item.id === 'alpha');
  assert.equal(alpha?.name, 'alpha', '声明区字段照原样落位');
  assert.equal(alpha?.status, 'enabled');
  assert.equal(alpha?.source_type, 'local');
  assert.equal(alpha?.created_at, LATER, '派生区按导入时点回填');
  assert.equal(alpha?.updated_at, LATER);
  assert.match(String(alpha?.checksum), /^sha256:[0-9a-f]{64}$/, '指纹按磁盘重算');
  assert.equal(
    alpha?.checksum,
    index.skills.find((item) => item.id === 'alpha')?.checksum,
    '导入前后的内容指纹一致',
  );
});

test('K-08 导入：载荷给出导入条数、冲突条数、标识列表与往返结论', () => {
  const { root, index, file } = exported();
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  assert.equal(outcome.data['imported'], 2);
  assert.equal(outcome.data['conflicts'], 0);
  assert.deepEqual(outcome.data['ids'], ['alpha', 'beta']);
  assert.equal(outcome.data['format_version'], BACKUP_FORMAT_VERSION);
  assert.equal(outcome.data['roundtrip'], 'consistent');
  assert.match(String((outcome.data['notes'] as string[])[0]), /scan/);
});

test('K-08 导入：已存在的标识一律跳过，不覆盖既有记录', () => {
  const { root, index, file } = exported();
  const outcome = importIndex({ layout: layoutOf(root), index, source: file, now: LATER });
  assert.equal(outcome.data['imported'], 0);
  assert.equal(outcome.data['conflicts'], 2);
  assert.equal(outcome.index, index, '索引对象原样返回');
  const conflict = (outcome.data['conflict_entries'] as Array<Record<string, unknown>>)[0];
  assert.equal(conflict['reason'], 'already_registered');
  assert.equal(outcome.data['roundtrip'], 'no_records');
});

test('K-08 导入：磁盘目录缺失时仍登记，运行期结论取保守值', () => {
  const { root, index, file } = exported();
  rmSync(join(root, 'skills', 'beta'), { recursive: true, force: true });
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  const beta = outcome.index.skills.find((item) => item.id === 'beta');
  assert.equal(beta?.checksum, '', '无内容可算时不伪造指纹');
  assert.equal(beta?.validation.status, 'invalid', '未经扫描的记录不冒充可用');
  assert.deepEqual(beta?.validation.errors, [CODES.INDEX_RECORD_INVALID]);

  // 后续扫描按磁盘实况给出结论
  const scanned = scanWorkspace({ layout: layoutOf(root), index: outcome.index, now: LATER });
  const after = scanned.index.skills.find((item) => item.id === 'beta');
  assert.equal(after?.validation.status, 'invalid');
  assert.equal(
    scanned.index.skills.find((item) => item.id === 'alpha')?.validation.status,
    'ok',
    '磁盘存在的记录扫描后转为通过',
  );
});

test('K-08 导入：预演不写入任何文件且原样返回索引', () => {
  const { root, index, file } = exported();
  const before = readFileSync(layoutOf(root).indexFile, 'utf8');
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
    dryRun: true,
  });
  assert.equal(outcome.preview, true);
  assert.equal(outcome.index.skills.length, 0);
  assert.equal(outcome.data['imported'], 2);
  assert.equal(readFileSync(layoutOf(root).indexFile, 'utf8'), before, '预演不写索引');
  void index;
});

test('K-08 导入：导入过程不触碰磁盘上的 Skill 文件', () => {
  const { root, index, file } = exported();
  const skillFile = join(root, 'skills', 'alpha', 'SKILL.md');
  const before = readFileSync(skillFile, 'utf8');
  importIndex({ layout: layoutOf(root), index: emptied(index), source: file, now: LATER });
  assert.equal(readFileSync(skillFile, 'utf8'), before);
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'alpha')), '导入不重建副本');
});

test('K-08 导入：备份内标识重复时整体拒绝', () => {
  const { root, index } = exported();
  const body = [
    'backup_format_version: "1"',
    'skills:',
    '  - id: alpha',
    '    name: alpha',
    '    status: enabled',
    '  - id: alpha',
    '    name: alpha',
    '    status: enabled',
    '',
  ].join('\n');
  const file = writeDocument(root, 'dup.yaml', body);
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  assert.equal(outcome.refused, true);
  assert.equal(outcome.data['rejected'], 'invalid_format');
  assert.ok(outcome.findings.some((item) => item.code === CODES.ID_DUPLICATED));
  assert.deepEqual(outcome.index.skills, [], '整体拒绝，不做部分导入');
});

test('K-08 导入：必填字段缺失、标识不合规、枚举非法都判为格式问题', () => {
  const { root, index } = exported();
  const body = [
    'backup_format_version: "1"',
    'skills:',
    '  - id: UPPER',
    '    status: paused',
    '',
  ].join('\n');
  const file = writeDocument(root, 'bad.yaml', body);
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  const codes = outcome.findings.map((item) => item.code);
  assert.equal(outcome.refused, true);
  assert.ok(codes.includes(CODES.FIELD_REQUIRED), '缺少 name');
  assert.ok(codes.includes(CODES.ID_INVALID), '标识不合规');
  assert.ok(codes.includes(CODES.STATUS_INVALID), '枚举非法');
  assert.deepEqual(outcome.data['problem_codes'], [...new Set(codes)].sort(), '详情不得静默丢弃');
});

test('K-08 导入：格式版本不受支持时拒绝', () => {
  const { root, index } = exported();
  const file = writeDocument(
    root,
    'future.yaml',
    ['backup_format_version: "2"', 'skills: []', ''].join('\n'),
  );
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.VERSION_UNSUPPORTED],
  );
  assert.equal(outcome.refused, true);
});

test('K-08 导入：文件无法解析时按语法类问题拒绝', () => {
  const { root, index } = exported();
  const file = writeDocument(root, 'broken.yaml', 'skills: [\n  - id: alpha\n');
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.YAML_INVALID],
  );
  assert.equal(outcome.refused, true);
});

test('K-08 导入：来源不可读按来源类问题返回，路径越界按路径类问题返回', () => {
  const { root, index, file } = exported();
  const missing = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: 'backups/nosuch.yaml',
    now: LATER,
  });
  assert.deepEqual(
    missing.findings.map((item) => item.code),
    [CODES.SRC_UNRESOLVED],
  );

  const escaped = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: '../outside.yaml',
    now: LATER,
  });
  assert.deepEqual(
    escaped.findings.map((item) => item.code),
    [CODES.PATH_INVALID],
  );
  void file;
});

test('K-08 导入：契约之外的字段只给警告，不阻断导入', () => {
  const { root, index } = exported();
  const body = [
    'backup_format_version: "1"',
    'extension_flag: x',
    'skills:',
    '  - id: alpha',
    '    name: alpha',
    '    status: enabled',
    '    secret_token: sh',
    '',
  ].join('\n');
  const file = writeDocument(root, 'extra.yaml', body);
  const outcome = importIndex({
    layout: layoutOf(root),
    index: emptied(index),
    source: file,
    now: LATER,
  });
  assert.equal(outcome.refused, undefined);
  assert.equal(outcome.index.skills.length, 1);
  assert.equal(outcome.index.skills[0]?.id, 'alpha');
  const warnings = outcome.findings.filter((item) => item.code === CODES.FIELD_WHITELIST);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((item) => item.severity === 'warning'));
  assert.ok(!('secret_token' in (outcome.index.skills[0] as unknown as Record<string, unknown>)));
});
