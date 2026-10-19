import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SnapshotEntry {
  type: 'dir' | 'file' | 'link' | 'missing' | 'unreadable';
  mtimeMs?: number;
  size?: number;
  hash?: string;
  target?: string;
}

/** 递归记录相对路径、类型、mtime、大小与内容哈希；不跟随符号链接。 */
export function snapshotTree(root: string): Record<string, SnapshotEntry> {
  const result: Record<string, SnapshotEntry> = {};
  const visit = (relative: string): void => {
    const absolute = relative === '' ? root : join(root, relative);
    const stat = statOf(absolute);
    if (stat === undefined) {
      result[relative === '' ? '__root__' : relative.replaceAll('\\', '/')] = { type: 'missing' };
      return;
    }
    const key = keyOf(relative);
    if (stat.isSymbolicLink()) {
      result[key] = { type: 'link', mtimeMs: stat.mtimeMs, target: relative };
      return;
    }
    if (stat.isDirectory()) {
      visitDirectory(absolute, relative, key, result, visit);
      return;
    }
    visitFile(absolute, key, stat, result);
  };
  visit('');
  return result;
}

function statOf(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function keyOf(relative: string): string {
  return relative === '' ? '.' : relative.replaceAll('\\', '/');
}

function visitDirectory(
  absolute: string,
  relative: string,
  key: string,
  result: Record<string, SnapshotEntry>,
  visit: (relative: string) => void,
): void {
  result[key] = { type: 'dir', mtimeMs: lstatSync(absolute).mtimeMs };
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    result[key] = { ...result[key], type: 'unreadable' };
    return;
  }
  for (const entry of entries) {
    visit(relative === '' ? entry.name : join(relative, entry.name));
  }
}

function visitFile(
  absolute: string,
  key: string,
  stat: NonNullable<ReturnType<typeof statOf>>,
  result: Record<string, SnapshotEntry>,
): void {
  result[key] = stat.isFile()
    ? {
        type: 'file',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      }
    : { type: 'unreadable', mtimeMs: stat.mtimeMs };
}
