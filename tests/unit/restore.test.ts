import { makeTempDir } from '../helpers/temp.ts';
import { makeBackup } from '../helpers/backup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  disableSkill,
  installSkill,
  restoreSkill,
  uninstallSkill,
} from '../../kernel/core/lifecycle/index.ts';
import { createInitialIndex } from '../../kernel/core/index/index.ts';
import { scanWorkspace } from '../../kernel/core/discovery/index.ts';
import { computeChecksum, computeDigests } from '../../kernel/core/integrity/index.ts';
import { layoutOf, ensureWorkspaceDirs } from '../../kernel/store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import {
  BACKUP_CONTENT_DIR_NAME,
  BACKUP_META_FILE_NAME,
  timestampToDirName,
} from '../../kernel/store/backup-fs/index.ts';
import type { SkillIndex } from '../../kernel/core/metadata/types.ts';

const NOW = '2026-10-15T00:00:00Z';
const LATER = '2026-10-15T08:00:00Z';
const LATEST = '2026-10-15T16:00:00Z';

function workspace(): string {
  const root = makeTempDir('sm-restore-');
  ensureWorkspaceDirs(layoutOf(root));
  return root;
}

/** 造一份可安装的来源目录 */
function sourceSkill(id: string, options: { content?: string } = {}): string {
  const dir = makeTempDir('sm-restore-src-');
  writeFileSync(join(dir, 'SKILL.md'), options.content ?? '# skill');
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
  return dir;
}

function emptyIndex(): SkillIndex {
  return createInitialIndex(NOW);
}

/** 对当前中心库原件造一份备份载体，返回载体目录的绝对路径 */
function backupAt(root: string, id: string, now: string): string {
  const sourceDir = join(root, 'skills', id);
  return makeBackup(root, id, sourceDir, now, computeChecksum(sourceDir));
}

/** 装一份合法 Skill 并返回安装后的索引 */
async function installed(root: string, id: string, options: { content?: string } = {}) {
  return installSkill({
    layout: layoutOf(root),
    index: emptyIndex(),
    sourcePath: sourceSkill(id, options),
    now: NOW,
  });
}

function codesOf(findings: Array<{ code: string }>): string[] {
  return findings.map((item) => item.code);
}

/** 把载体整棵树读成「相对路径 → 文本内容」，用于比对恢复前后载体是否被改动 */
function snapshotOf(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string, rel: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next, key);
      else files.set(key, readFileSync(next, 'utf8'));
    }
  };
  walk(dir, '');
  return files;
}

test('验收一：缺省取最新备份，内容写回中心库、副本重分发、记录刷新', async () => {
  const root = workspace();
  const first = await installed(root, 'code-review', { content: '# v1' });
  backupAt(root, 'code-review', NOW);

  // 内容演进后再备份一份，用于验证「缺省取最新」
  writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), '# v2');
  const second = backupAt(root, 'code-review', LATER);

  // 模拟现场损毁：中心库原件与副本都不在
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  rmSync(join(root, '.claude', 'skills', 'code-review'), { recursive: true, force: true });

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: first.index,
    id: 'code-review',
    now: LATEST,
  });

  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.data['backup_timestamp'], LATER, '缺省应取最新的一份备份');
  assert.equal(outcome.data['backup_type'], 'full');
  assert.equal(outcome.data['backup_path'], `backups/code-review/${timestampToDirName(LATER)}`);
  assert.equal(outcome.data['record_action'], 'refreshed');
  assert.equal(outcome.data['library_path'], 'skills/code-review');
  assert.equal(outcome.data['file_count'], 2);
  assert.deepEqual(outcome.data['files'], [
    'skills/code-review/SKILL.md',
    'skills/code-review/skill_meta.yaml',
  ]);

  assert.equal(
    readFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), 'utf8'),
    '# v2',
    '应恢复最新一份的内容',
  );
  assert.equal(
    readFileSync(join(root, '.claude', 'skills', 'code-review', 'SKILL.md'), 'utf8'),
    '# v2',
    '副本应重分发并保持同一内容',
  );

  const restored = outcome.data['targets'] as Array<Record<string, unknown>>;
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.['target'], 'claude');
  assert.equal(restored[0]?.['path'], '.claude/skills/code-review');
  assert.equal(restored[0]?.['created'], true, '副本原本不在，应记为新建成');
  assert.equal(restored[0]?.['enabled'], true);
  // 落位按元文件的 file_map 逐文件执行，副本里的文件数由映射决定
  assert.equal(restored[0]?.['file_count'], 1);
  assert.deepEqual(restored[0]?.['files'], ['.claude/skills/code-review/SKILL.md']);

  const record = outcome.index.skills.find((item) => item.id === 'code-review');
  assert.equal(record?.created_at, NOW, '首次登记时间不因恢复而改变');
  assert.equal(record?.updated_at, LATEST, '派生区按恢复时点刷新');
  assert.equal(record?.validation.status, 'ok', '已登记记录保持原运行期结论');
  assert.equal(record?.checksum, computeChecksum(join(root, 'skills', 'code-review')));
  assert.deepEqual(
    record?.digests,
    computeDigests(join(root, 'skills', 'code-review')),
    '逐文件摘要按写回的内容重算',
  );
  assert.ok(existsSync(join(second, 'content', 'SKILL.md')), '载体本身保留');
});

test('验收二：--timestamp 指定历史备份时恢复该时间点的内容', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review', { content: '# v1' });
  backupAt(root, 'code-review', NOW);
  writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), '# v2');
  backupAt(root, 'code-review', LATER);
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  rmSync(join(root, '.claude', 'skills', 'code-review'), { recursive: true, force: true });

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATEST,
    timestamp: NOW,
  });

  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.data['backup_timestamp'], NOW);
  assert.equal(
    readFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), 'utf8'),
    '# v1',
    '应恢复指定时间点的历史内容',
  );
});

test('验收三：已卸载的标识按备份重建记录，状态交由扫描判定', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  const removed = uninstallSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
    hard: true,
  });
  assert.deepEqual(removed.findings, []);
  assert.equal(removed.index.skills.length, 0);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '硬卸载后原件不在');

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: removed.index,
    id: 'code-review',
    now: LATEST,
  });

  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.data['record_action'], 'rebuilt');
  const record = outcome.index.skills.find((item) => item.id === 'code-review');
  assert.equal(record?.name, 'code-review');
  assert.equal(record?.status, 'enabled');
  assert.equal(record?.created_at, LATEST, '无历史基准时按恢复时点回填');
  assert.equal(record?.updated_at, LATEST);
  assert.equal(record?.source_type, 'local');
  assert.match(String(record?.checksum), /^sha256:[0-9a-f]{64}$/);
  assert.equal(record?.validation.status, 'invalid', '重建记录取保守值，不预判为通过');
  assert.deepEqual(record?.validation.errors, [CODES.INDEX_RECORD_INVALID]);
  assert.match(String((outcome.data['notes'] as string[])[0]), /扫描/);

  // 扫描后结论应回到 ok，与磁盘实况一致
  const scanned = scanWorkspace({ layout: layoutOf(root), index: outcome.index, now: LATEST });
  assert.equal(
    scanned.index.skills.find((item) => item.id === 'code-review')?.validation.status,
    'ok',
  );
});

test('恢复不预判运行期结论：已登记的失效记录恢复后仍是失效', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  backupAt(root, 'code-review', NOW);
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });

  const degraded: SkillIndex = {
    ...installedOutcome.index,
    skills: installedOutcome.index.skills.map((item) => ({
      ...item,
      validation: { status: 'invalid', errors: [CODES.INDEX_RECORD_INVALID] },
    })),
  };
  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: degraded,
    id: 'code-review',
    now: LATER,
  });

  assert.deepEqual(outcome.findings, []);
  const record = outcome.index.skills.find((item) => item.id === 'code-review');
  assert.equal(record?.validation.status, 'invalid', '恢复不改写运行期结论');
  assert.deepEqual(record?.validation.errors, [CODES.INDEX_RECORD_INVALID]);
});

test('恢复保持副本原有可见性：禁用态的副本恢复后仍为禁用', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  backupAt(root, 'code-review', NOW);
  const disabled = disableSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });
  assert.deepEqual(disabled.findings, []);

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: disabled.index,
    id: 'code-review',
    now: LATEST,
  });

  assert.deepEqual(outcome.findings, []);
  const copyDir = join(root, '.claude', 'skills', 'code-review');
  assert.ok(existsSync(join(copyDir, 'SKILL.md.disabled')), '禁用标记应保留');
  assert.ok(!existsSync(join(copyDir, 'SKILL.md')), '不应把禁用副本改回启用');
  assert.equal((outcome.data['targets'] as Array<Record<string, unknown>>)[0]?.['enabled'], false);
  assert.equal(outcome.index.skills.find((item) => item.id === 'code-review')?.status, 'disabled');
});

test('恢复是只读消费：恢复前后载体逐字节不变', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  const backupDir = backupAt(root, 'code-review', NOW);
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  const before = snapshotOf(backupDir);

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });
  assert.deepEqual(outcome.findings, []);

  const after = snapshotOf(backupDir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), '载体文件集不变');
  for (const [key, value] of before) {
    assert.equal(after.get(key), value, `${key} 内容不变`);
  }
  assert.match(
    readFileSync(join(backupDir, BACKUP_META_FILE_NAME), 'utf8'),
    /^type: full$/m,
    '载体清单须带有 type 字段',
  );
});

test('验收五：--dry-run 给出将写回的文件清单，不写入任何文件', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  backupAt(root, 'code-review', NOW);
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  rmSync(join(root, '.claude', 'skills', 'code-review'), { recursive: true, force: true });

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
    dryRun: true,
  });

  assert.deepEqual(outcome.findings, []);
  assert.equal(outcome.preview, true);
  assert.equal(outcome.data['preview'], true);
  assert.equal(outcome.data['library_exists'], false);
  assert.equal(outcome.data['action'], 'refresh_record');
  assert.equal(outcome.data['file_count'], 2);
  assert.deepEqual(outcome.data['files'], [
    'skills/code-review/SKILL.md',
    'skills/code-review/skill_meta.yaml',
  ]);
  assert.deepEqual(outcome.data['targets'], ['.claude/skills/code-review']);
  assert.ok(!existsSync(join(root, 'skills', 'code-review')), '预演不得写回中心库');
  assert.ok(!existsSync(join(root, '.claude', 'skills', 'code-review')), '预演不得创建副本');
  assert.equal(outcome.index, installedOutcome.index, '预演不得改写索引');
});

test('验收四之一：没有可恢复的备份时报 E-BAK-003', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });

  assert.deepEqual(codesOf(outcome.findings), [CODES.BACKUP_MISSING]);
  assert.equal(outcome.data['rejected'], 'no_backup');
  assert.equal(outcome.index, installedOutcome.index, '失败时索引原样返回');
});

test('验收四之二：时间戳不存在时报参数类问题并列出可用取值', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  backupAt(root, 'code-review', NOW);

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
    timestamp: LATEST,
  });

  assert.deepEqual(codesOf(outcome.findings), [CODES.INPUT_INVALID_ARG]);
  assert.equal(outcome.data['rejected'], 'timestamp_not_found');
  assert.deepEqual(outcome.data['available'], [NOW]);
  assert.match(outcome.findings[0]?.remedy ?? '', /2026-10-15T00:00:00Z/, '应列出可选时间戳');
});

test('验收四之三：载体内容与清单不符时报 E-BAK-004', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  const dir = backupAt(root, 'code-review', NOW);

  // 数量不符：删掉一个内容文件
  rmSync(join(dir, BACKUP_CONTENT_DIR_NAME, 'SKILL.md'), { force: true });
  const missing = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });
  assert.deepEqual(codesOf(missing.findings), [CODES.BACKUP_CORRUPT]);
  assert.match(missing.findings[0]?.message ?? '', /文件数/);
  assert.equal(missing.data['rejected'], 'backup_corrupt');

  // 摘要不符：文件数不变但内容被改写
  writeFileSync(join(dir, BACKUP_CONTENT_DIR_NAME, 'SKILL.md'), '# tampered');
  const tampered = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });
  assert.deepEqual(codesOf(tampered.findings), [CODES.BACKUP_CORRUPT]);
  assert.match(tampered.findings[0]?.message ?? '', /摘要/);
  assert.equal(
    readFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), 'utf8'),
    '# skill',
    '校验不通过时不得写回任何内容',
  );
});

test('验收四之四：载体类型不受支持时报 E-BAK-005', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  const dir = backupAt(root, 'code-review', NOW);

  const metaFile = join(dir, BACKUP_META_FILE_NAME);
  const text = readFileSync(metaFile, 'utf8');
  assert.match(text, /^type: full$/m, '前置：载体清单应记有 type');
  writeFileSync(metaFile, text.replace(/^type: full$/m, 'type: delta'));

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });

  assert.deepEqual(codesOf(outcome.findings), [CODES.BACKUP_TYPE_UNSUPPORTED]);
  assert.equal(outcome.data['rejected'], 'type_unsupported');
  assert.equal(outcome.data['backup_type'], 'delta');
});

test('验收四之五：中心库位置被同名文件占用时报目标占用冲突', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  backupAt(root, 'code-review', NOW);
  rmSync(join(root, 'skills', 'code-review'), { recursive: true, force: true });
  writeFileSync(join(root, 'skills', 'code-review'), 'occupied');

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });

  assert.deepEqual(codesOf(outcome.findings), [CODES.CONFLICT_OCCUPIED]);
  assert.equal(outcome.data['rejected'], 'target_occupied');
  assert.equal(
    readFileSync(join(root, 'skills', 'code-review'), 'utf8'),
    'occupied',
    '不得覆盖占位文件',
  );
});

test('标识不合规时按参数类问题拒绝', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'Bad_ID',
    now: LATER,
  });

  assert.deepEqual(codesOf(outcome.findings), [CODES.INPUT_INVALID_ARG]);
  assert.equal(outcome.data['rejected'], 'invalid_id');
});

test('载体内的元文件不合格时报 E-BAK-004，且不写回内容', async () => {
  const root = workspace();
  const installedOutcome = await installed(root, 'code-review');
  const dir = backupAt(root, 'code-review', NOW);
  // 破坏载体内的元文件：把 id 改成不合规取值
  const metaFile = join(dir, BACKUP_CONTENT_DIR_NAME, 'skill_meta.yaml');
  writeFileSync(metaFile, readFileSync(metaFile, 'utf8').replace('id: code-review', 'id: BAD'));
  // 载体摘要随之变化，先重算清单以免先撞上载体损坏判定
  const metaManifest = join(dir, BACKUP_META_FILE_NAME);
  const text = readFileSync(metaManifest, 'utf8');
  writeFileSync(metaManifest, text.replace(/^backup_digest: .*$/m, 'backup_digest: '));

  const outcome = restoreSkill({
    layout: layoutOf(root),
    index: installedOutcome.index,
    id: 'code-review',
    now: LATER,
  });

  const codes = codesOf(outcome.findings);
  assert.equal(codes[0], CODES.BACKUP_CORRUPT, '载体层面的判定排在前面');
  assert.ok(codes.includes('E-ID-001'), '载体内的元数据问题详情一并给出，不静默丢弃');
  assert.equal(outcome.data['rejected'], 'backup_corrupt');
  assert.equal(
    readFileSync(join(root, 'skills', 'code-review', 'skill_meta.yaml'), 'utf8').includes(
      'id: BAD',
    ),
    false,
    '不合格载体的内容不得写回',
  );
});
