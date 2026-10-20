import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeChecksum, computeDigests } from '../../kernel/core/integrity/index.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { installSkill, updateSkill } from '../../kernel/core/lifecycle/index.ts';
import { validateWorkspace } from '../../kernel/core/validation/index.ts';
import { exportIndex, importIndex } from '../../kernel/core/backup/index.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import { parseYaml } from '../../kernel/store/yaml/index.ts';
import { readFileSync } from 'node:fs';
import type { Finding } from '@skill-manager/contract';
import type { IndexRecord, SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-15T00:00:00Z';
const LATER = '2026-10-15T02:00:00Z';

function workspace(): string {
  const root = makeTempDir('sm-drift-');
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'backups'), { recursive: true });
  return root;
}

function metaOf(id: string): string {
  return [
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
}

function putSkill(root: string, id: string): void {
  const dir = join(root, 'skills', id);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# skill');
  writeFileSync(join(dir, 'assets', 'note.txt'), 'note');
  writeFileSync(join(dir, 'skill_meta.yaml'), metaOf(id));
}

function scanned(root: string): SkillIndex {
  const outcome = scanWorkspace({
    layout: layoutOf(root),
    index: createInitialIndex(NOW),
    now: NOW,
  });
  assert.deepEqual(outcome.findings, []);
  return outcome.index;
}

function recordOf(index: SkillIndex, id: string): IndexRecord {
  const record = index.skills.find((item) => item.id === id);
  assert.ok(record !== undefined, `前置：索引中应有 ${id}`);
  return record;
}

function codes(findings: Finding[]): string[] {
  return findings.map((item) => item.code);
}

/** 只保留指向具体文件的漂移条目 */
function fileDrift(findings: Finding[], id: string): Finding[] {
  return findings.filter((item) => item.code === CODES.DRIFT && item.target.startsWith(`${id}/`));
}

test('K-09 逐文件摘要与聚合指纹同范围：排除元文件与临时文件，取值为单文件字节摘要', () => {
  const root = workspace();
  putSkill(root, 'alpha');
  const dir = join(root, 'skills', 'alpha');
  writeFileSync(join(dir, 'draft.tmp'), 'temp');
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), 'vcs');

  const digests = computeDigests(dir);
  assert.deepEqual(Object.keys(digests).sort(), ['SKILL.md', 'assets/note.txt']);
  for (const value of Object.values(digests)) assert.match(value, /^sha256:[0-9a-f]{64}$/);
  // 聚合指纹与逐文件摘要同源：改了文件，两级取值同时变化
  const checksumBefore = computeChecksum(dir);
  writeFileSync(join(dir, 'SKILL.md'), '# changed');
  assert.notEqual(computeChecksum(dir), checksumBefore, '聚合指纹随内容变化');
  assert.notEqual(computeDigests(dir)['SKILL.md'], digests['SKILL.md'], '逐文件摘要随内容变化');
  assert.equal(
    computeDigests(dir)['assets/note.txt'],
    digests['assets/note.txt'],
    '未动的文件摘要不变',
  );
});

test('K-02 扫描写入逐文件摘要，内容增删改后随之刷新', () => {
  const root = workspace();
  putSkill(root, 'alpha');
  const dir = join(root, 'skills', 'alpha');
  const first = recordOf(scanned(root), 'alpha');
  assert.deepEqual(first.digests, computeDigests(dir), '扫描后摘要与磁盘实况一致');
  assert.equal(first.digests?.['assets/note.txt'], computeDigests(dir)['assets/note.txt']);

  writeFileSync(join(dir, 'SKILL.md'), '# changed');
  writeFileSync(join(dir, 'assets', 'extra.md'), 'extra');
  rmSync(join(dir, 'assets', 'note.txt'));

  const second = recordOf(scanned(root), 'alpha');
  assert.deepEqual(Object.keys(second.digests ?? {}).sort(), ['SKILL.md', 'assets/extra.md']);
  assert.notEqual(second.digests?.['SKILL.md'], first.digests?.['SKILL.md'], '内容变化即摘要变化');
  assert.deepEqual(second.digests, computeDigests(dir));
});

test('验收二：V-07 漂移报告定位到具体文件并给出新旧摘要', () => {
  const root = workspace();
  putSkill(root, 'alpha');
  const index = scanned(root);
  const before = recordOf(index, 'alpha');
  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '# changed');
  const after = computeDigests(join(root, 'skills', 'alpha'));

  const outcome = validateWorkspace({ layout: layoutOf(root), index });

  // 聚合级报告仍在，同时逐文件定位
  assert.ok(codes(outcome.findings).includes(CODES.DRIFT));
  const aggregate = outcome.findings.find(
    (item) => item.code === CODES.DRIFT && item.target === 'alpha',
  );
  assert.match(aggregate?.message ?? '', /记录指纹 sha256:/);

  const located = fileDrift(outcome.findings, 'alpha');
  assert.equal(located.length, 1, '只有 SKILL.md 变了');
  assert.equal(located[0]?.target, 'alpha/SKILL.md', '报告文件相对路径');
  assert.equal(located[0]?.severity, 'warning', 'V-07 为警告级');
  assert.match(located[0]?.message ?? '', new RegExp(before.digests?.['SKILL.md'] ?? 'x'));
  assert.match(located[0]?.message ?? '', new RegExp(after['SKILL.md'] ?? 'x'));
  assert.match(located[0]?.message ?? '', /文件内容已变化/);
});

test('验收二续：新增与删除的文件各成一条，含相对路径与两侧摘要', () => {
  const root = workspace();
  putSkill(root, 'alpha');
  const index = scanned(root);
  const baseline = recordOf(index, 'alpha').digests ?? {};
  const dir = join(root, 'skills', 'alpha');
  writeFileSync(join(dir, 'assets', 'added.md'), 'new file');
  rmSync(join(dir, 'assets', 'note.txt'));

  const outcome = validateWorkspace({ layout: layoutOf(root), index });
  const located = fileDrift(outcome.findings, 'alpha');
  assert.deepEqual(located.map((item) => item.target).sort(), [
    'alpha/assets/added.md',
    'alpha/assets/note.txt',
  ]);

  const added = located.find((item) => item.target === 'alpha/assets/added.md');
  assert.match(added?.message ?? '', /新增文件/);
  assert.match(added?.message ?? '', /现有摘要 sha256:[0-9a-f]{64}/);

  const removed = located.find((item) => item.target === 'alpha/assets/note.txt');
  assert.match(removed?.message ?? '', /文件已删除/);
  assert.match(removed?.message ?? '', new RegExp(baseline['assets/note.txt'] ?? 'x'));
});

test('验收三：旧索引缺逐文件基准时只给聚合级报告，扫描回填后即可定位', () => {
  const root = workspace();
  putSkill(root, 'alpha');
  const legacy = legacyOf(scanned(root));
  assert.equal(recordOf(legacy, 'alpha').digests, undefined, '前置：旧索引没有逐文件摘要');
  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '# changed');

  const before = validateWorkspace({ layout: layoutOf(root), index: legacy });
  assert.ok(codes(before.findings).includes(CODES.DRIFT), '聚合级报告仍在');
  assert.deepEqual(fileDrift(before.findings, 'alpha'), [], '没有基准就不猜文件，不误报');
  assert.equal(
    before.findings.every((item) => item.severity === 'warning'),
    true,
    '漂移不影响结论等级',
  );

  // 扫一次即回填逐文件基准，随后同样的漂移可以被定位
  const backfilled = scanned(root);
  assert.deepEqual(
    recordOf(backfilled, 'alpha').digests,
    computeDigests(join(root, 'skills', 'alpha')),
  );
  writeFileSync(join(root, 'skills', 'alpha', 'assets', 'note.txt'), 'note changed');
  const after = validateWorkspace({ layout: layoutOf(root), index: backfilled });
  const located = fileDrift(after.findings, 'alpha');
  assert.equal(located.length, 1, '回填基准后同样的漂移可以被定位');
  assert.equal(located[0]?.target, 'alpha/assets/note.txt');
});

test('验收五：安装与刷新都会写入与刷新逐文件摘要', async () => {
  const root = workspace();
  const source = makeTempDir('sm-drift-src-');
  writeFileSync(join(source, 'SKILL.md'), '# skill');
  mkdirSync(join(source, 'assets'), { recursive: true });
  writeFileSync(join(source, 'assets', 'data.txt'), 'one');
  writeFileSync(join(source, 'skill_meta.yaml'), metaOf('alpha'));

  const installed = await installSkill({
    layout: layoutOf(root),
    index: createInitialIndex(NOW),
    sourcePath: source,
    now: NOW,
  });
  assert.deepEqual(installed.findings, []);
  const library = join(root, 'skills', 'alpha');
  assert.deepEqual(recordOf(installed.index, 'alpha').digests, computeDigests(library));

  writeFileSync(join(library, 'assets', 'data.txt'), 'two');
  const updated = await updateSkill({
    layout: layoutOf(root),
    index: installed.index,
    id: 'alpha',
    now: LATER,
  });
  assert.deepEqual(codes(updated.findings), [], '成功刷新不得携带更新前旧快照的漂移警告');
  const record = recordOf(updated.index, 'alpha');
  assert.deepEqual(record.digests, computeDigests(library), '刷新后摘要按磁盘重算');
  assert.equal(record.checksum, computeChecksum(library));
  assert.equal(
    validateWorkspace({ layout: layoutOf(root), index: updated.index }).findings.length,
    0,
    '刷新后不应再有漂移',
  );
});

test('验收四续：导入按磁盘重算逐文件摘要', () => {
  const root = workspace();
  putSkill(root, 'alpha');
  const index = scanned(root);
  const exported = exportIndex({
    layout: layoutOf(root),
    index,
    target: 'backups/snapshot.yaml',
    now: NOW,
  });
  assert.deepEqual(exported.findings, []);
  assert.ok(
    !(exported.data['stripped'] as string[]).includes('alpha.digests'),
    '内部派生数据不计入剥离清单',
  );

  const document = parseYaml(readFileSync(join(root, 'backups', 'snapshot.yaml'), 'utf8'), {
    source: 'export',
    target: 'snapshot.yaml',
  });
  assert.ok(
    !('digests' in ((document['skills'] as Array<Record<string, unknown>>)[0] ?? {})),
    '导出物中不含逐文件摘要',
  );

  const imported = importIndex({
    layout: layoutOf(root),
    index: createInitialIndex(NOW),
    source: 'backups/snapshot.yaml',
    now: LATER,
  });
  assert.deepEqual(imported.findings, []);
  assert.deepEqual(
    recordOf(imported.index, 'alpha').digests,
    computeDigests(join(root, 'skills', 'alpha')),
    '导入按磁盘现状重算逐文件摘要',
  );
});

/** 去掉逐文件摘要，模拟本字段引入之前生成的旧索引 */
function legacyOf(index: SkillIndex): SkillIndex {
  return {
    ...index,
    skills: index.skills.map((record) => {
      const clone = { ...record };
      delete clone.digests;
      return clone;
    }),
  };
}
