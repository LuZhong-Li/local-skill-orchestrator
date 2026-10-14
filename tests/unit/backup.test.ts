import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_CONTENT_DIR_NAME,
  BACKUP_META_FILE_NAME,
  backupRootOf,
  createBackup,
  timestampToDirName,
} from '../../kernel/store/backup-fs/index.ts';
import { parseYaml } from '../../kernel/store/yaml/index.ts';
import { CODES } from '../../kernel/store/contract.ts';
import { layoutOf } from '../../kernel/store/workspace/index.ts';
import { computeChecksum } from '../../kernel/core/integrity/index.ts';

const NOW = '2026-10-14T00:00:00Z';
const SAME_SECOND = '2026-10-14T00:00:00Z';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'sm-backup-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'backups'), { recursive: true });
  return root;
}

/** 造一份中心库原件：内容文件加元文件 */
function library(root: string, id: string): string {
  const dir = join(root, 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# skill');
  writeFileSync(join(dir, 'skill_meta.yaml'), `id: ${id}\nname: ${id}\n`);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'note.txt'), 'note');
  return dir;
}

interface BackupOptions {
  hooks?: { onAfterCopy?: (contentDir: string) => void };
  now?: string;
}

function backup(root: string, id: string, options: BackupOptions = {}) {
  const layout = layoutOf(root);
  const sourceDir = join(root, 'skills', id);
  return createBackup({
    workspaceRoot: layout.root,
    backupsDir: layout.backupsDir,
    id,
    sourceDir,
    now: options.now ?? NOW,
    checksum: computeChecksum(sourceDir),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  });
}

test('S-08 备份落位到 backups/<标识>/<时间戳>，清单记录文件数与摘要', () => {
  const root = workspace();
  library(root, 'code-review');
  const result = backup(root, 'code-review');

  assert.equal(
    result.dir,
    join(root, 'backups', 'code-review', timestampToDirName(NOW)),
    '目录名由时间戳转换而来',
  );
  assert.equal(result.portableDir, `backups/code-review/${timestampToDirName(NOW)}`);
  assert.equal(result.timestamp, NOW, '清单内保留契约格式的原始时间戳');
  assert.equal(result.fileCount, 3, '含元文件与附属文件');
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);

  const manifest = parseYaml(readFileSync(join(result.dir, BACKUP_META_FILE_NAME), 'utf8'), {
    source: 'backup',
    target: BACKUP_META_FILE_NAME,
  });
  assert.equal(manifest['timestamp'], NOW);
  assert.equal(manifest['skill_id'], 'code-review');
  assert.equal(manifest['source'], 'skills/code-review');
  assert.equal(manifest['file_count'], 3);
  assert.equal(manifest['backup_digest'], result.digest);
  assert.match(String(manifest['content_checksum']), /^sha256:[0-9a-f]{64}$/);
});

test('S-08 副本与原件逐文件一致，且覆盖元文件与附属目录', () => {
  const root = workspace();
  library(root, 'code-review');
  const result = backup(root, 'code-review');
  const content = join(result.dir, BACKUP_CONTENT_DIR_NAME);

  for (const rel of ['SKILL.md', 'skill_meta.yaml', 'assets/note.txt']) {
    assert.deepEqual(
      readFileSync(join(content, rel)),
      readFileSync(join(root, 'skills', 'code-review', rel)),
      `${rel} 应与原件一致`,
    );
  }
});

test('S-08 同一时间戳重复备份不覆盖前一份', () => {
  const root = workspace();
  library(root, 'code-review');
  const first = backup(root, 'code-review');
  const firstDigest = first.digest;

  const second = backup(root, 'code-review', { now: SAME_SECOND });
  assert.notEqual(second.dir, first.dir, '应另起一个目录');
  assert.equal(second.timestamp, SAME_SECOND);

  const dirs = readdirSync(backupRootOf(layoutOf(root).backupsDir, 'code-review'));
  assert.equal(dirs.length, 2, '两份备份都在');
  // 第一份内容未被触碰
  assert.equal(
    readFileSync(join(first.dir, BACKUP_META_FILE_NAME), 'utf8').includes(firstDigest),
    true,
  );
});

test('S-08 校验不通过时报 E-BAK-001，并清理半份备份', () => {
  const root = workspace();
  library(root, 'code-review');
  const layout = layoutOf(root);

  assert.throws(
    () =>
      backup(root, 'code-review', {
        hooks: {
          onAfterCopy: (contentDir) => rmSync(join(contentDir, 'SKILL.md'), { force: true }),
        },
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, CODES.BACKUP_FAILED);
      return true;
    },
  );
  assert.equal(
    existsSync(backupRootOf(layout.backupsDir, 'code-review')),
    false,
    '失败时不得留下半份备份',
  );
});

test('S-08 备份目录不可创建时报 E-BAK-002', () => {
  const root = workspace();
  library(root, 'code-review');
  // 用同名文件占住 backups/<标识>，使目录无法创建
  writeFileSync(join(root, 'backups', 'code-review'), 'occupied');

  assert.throws(
    () => backup(root, 'code-review'),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, CODES.BACKUP_UNAVAILABLE);
      return true;
    },
  );
});

test('S-08 来源不是目录时报 E-BAK-001，且不产生备份目录', () => {
  const root = workspace();
  const layout = layoutOf(root);
  const sourceFile = join(root, 'skills', 'not-a-dir');
  writeFileSync(sourceFile, 'content');

  assert.throws(
    () =>
      createBackup({
        workspaceRoot: layout.root,
        backupsDir: layout.backupsDir,
        id: 'not-a-dir',
        sourceDir: sourceFile,
        now: NOW,
        checksum: '',
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, CODES.BACKUP_FAILED);
      return true;
    },
  );
  assert.equal(existsSync(backupRootOf(layout.backupsDir, 'not-a-dir')), false);
});

test('S-08 标识不能用作单一路径段时被拒绝', () => {
  const root = workspace();
  library(root, 'code-review');
  const layout = layoutOf(root);

  assert.throws(
    () =>
      createBackup({
        workspaceRoot: layout.root,
        backupsDir: layout.backupsDir,
        id: '..',
        sourceDir: join(root, 'skills', 'code-review'),
        now: NOW,
        checksum: '',
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, CODES.BACKUP_FAILED);
      return true;
    },
  );
});
