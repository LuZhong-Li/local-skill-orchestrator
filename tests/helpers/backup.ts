import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup } from '../../kernel/store/backup-fs/index.ts';

export function makeBackup(
  root: string,
  id: string,
  sourceDir: string,
  now = '2026-01-01T00:00:00Z',
  checksum = '',
): string {
  const backupsDir = join(root, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  return createBackup({
    workspaceRoot: root,
    backupsDir,
    id,
    sourceDir,
    now,
    checksum,
  }).dir;
}
