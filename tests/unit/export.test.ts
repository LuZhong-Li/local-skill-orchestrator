import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_FORMAT_VERSION, exportIndex } from '../../kernel/core/backup/index.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex, saveIndex } from '../../kernel/core/index/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { parseYaml } from '../../kernel/store/yaml/index.ts';
import { CODES } from '../../kernel/store/contract.ts';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-15T00:00:00Z';
const LATER = '2026-10-15T01:00:00Z';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-export-'));
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

function scenario(): { root: string; index: SkillIndex } {
  const root = workspace();
  putSkill(root, 'alpha');
  putSkill(root, 'beta');
  const layout = layoutOf(root);
  const scanned = scanWorkspace({ layout, index: createInitialIndex(NOW), now: NOW });
  saveIndex(layout.indexFile, scanned.index);
  return { root, index: scanned.index };
}

function readDocument(root: string, target: string): Record<string, unknown> {
  return parseYaml(readFileSync(join(root, target), 'utf8'), {
    source: 'export',
    target,
  });
}

test('K-08 导出文档带格式版本与导出时间，索引部分与索引一致', () => {
  const { root, index } = scenario();
  const outcome = exportIndex({
    layout: layoutOf(root),
    index,
    target: 'backups/snapshot.yaml',
    now: LATER,
  });
  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.data['path'], 'backups/snapshot.yaml');
  assert.equal(outcome.data['entry_count'], 2);
  assert.equal(outcome.data['backup_format_version'], BACKUP_FORMAT_VERSION);
  assert.deepEqual(outcome.data['stripped'], []);
  assert.equal(outcome.data['config_included'], true);

  const document = readDocument(root, 'backups/snapshot.yaml');
  assert.equal(document['backup_format_version'], BACKUP_FORMAT_VERSION);
  assert.equal(document['exported_at'], LATER);
  // N-07：逐文件摘要属内核内部派生数据，不进导出物；其余字段与索引逐字一致
  const withoutDigests = index.skills.map((record) => {
    const clone = { ...record };
    delete clone.digests;
    return clone;
  });
  assert.deepEqual(document['skills'], withoutDigests, '记录区与索引逐字一致（去掉内部派生数据）');
  const exportedRecord = (document['skills'] as Array<Record<string, unknown>>)[0]!;
  assert.ok(!('digests' in exportedRecord), '逐文件摘要不入导出物');
  assert.deepEqual(
    Object.keys(exportedRecord).sort(),
    Object.keys(index.skills[0] ?? {})
      .filter((key) => key !== 'digests')
      .sort(),
    '导出记录的字段集 = 索引记录字段集去掉内部派生数据',
  );
  assert.deepEqual(document['config'], index.config);
  assert.equal(document['schema_version'], index.schema_version);
  assert.equal(document['tool_version'], index.tool_version);
});

test('K-08 --no-config 时不含配置区并记入剥离清单', () => {
  const { root, index } = scenario();
  const outcome = exportIndex({
    layout: layoutOf(root),
    index,
    target: 'backups/no-config.yaml',
    now: LATER,
    noConfig: true,
  });
  assert.equal(outcome.data['config_included'], false);
  assert.deepEqual(outcome.data['stripped'], ['config']);
  const document = readDocument(root, 'backups/no-config.yaml');
  assert.ok(!('config' in document));
});

test('K-08 未知字段与绝对路径形式的落位路径被剥离并登记', () => {
  const { root, index } = scenario();
  const dirty: SkillIndex = {
    ...index,
    extension_flag: 'x',
    skills: index.skills.map((record, position) =>
      position === 0
        ? ({ ...record, secret_token: 'sh', path: 'C:/outside/alpha' } as unknown as typeof record)
        : record,
    ),
  };
  const outcome = exportIndex({
    layout: layoutOf(root),
    index: dirty,
    target: 'backups/stripped.yaml',
    now: LATER,
  });
  assert.deepEqual([...(outcome.data['stripped'] as string[])].sort(), [
    'alpha.path',
    'alpha.secret_token',
    'extension_flag',
  ]);
  const document = readDocument(root, 'backups/stripped.yaml');
  assert.ok(!('extension_flag' in document), '未知顶层字段被剥离');
  const first = (document['skills'] as Array<Record<string, unknown>>)[0]!;
  assert.ok(!('secret_token' in first), '未知记录字段被剥离');
  assert.ok(!('path' in first), '绝对路径不写入备份');
});

test('K-08 重复导出覆盖既有文件', () => {
  const { root, index } = scenario();
  const layout = layoutOf(root);
  exportIndex({ layout, index, target: 'backups/same.yaml', now: NOW });
  const first = readFileSync(join(root, 'backups', 'same.yaml'), 'utf8');
  const second = exportIndex({ layout, index, target: 'backups/same.yaml', now: LATER });
  assert.deepEqual(second.findings, []);
  const after = readFileSync(join(root, 'backups', 'same.yaml'), 'utf8');
  assert.notEqual(after, first, '覆盖后内容应为新的一份');
  assert.equal(readDocument(root, 'backups/same.yaml')['exported_at'], LATER);
});

test('K-08 目标路径越出工作区时被拒绝', () => {
  const { root, index } = scenario();
  const outcome = exportIndex({
    layout: layoutOf(root),
    index,
    target: '../outside.yaml',
    now: NOW,
  });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.PATH_INVALID],
  );
  assert.ok(!existsSync(join(root, '..', 'outside.yaml')));
});

test('K-08 目标上级目录不存在时报文件系统类问题', () => {
  const { root, index } = scenario();
  const outcome = exportIndex({
    layout: layoutOf(root),
    index,
    target: 'nodir/out.yaml',
    now: NOW,
  });
  assert.deepEqual(
    outcome.findings.map((item) => item.code),
    [CODES.IO_FAILED],
  );
  assert.equal(outcome.findings[0]?.severity, 'error');
});

test('K-08 导出不改动索引文件', () => {
  const { root, index } = scenario();
  const layout = layoutOf(root);
  const before = readFileSync(layout.indexFile);
  exportIndex({ layout, index, target: 'backups/readonly.yaml', now: LATER });
  assert.deepEqual(readFileSync(layout.indexFile), before);
});
