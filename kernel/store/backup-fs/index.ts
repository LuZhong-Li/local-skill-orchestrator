/**
 * S-08 备份载体读写。
 *
 * 载体布局（工作区根目录下的备份目录之内）：
 *   <备份目录>/<Skill 标识>/<时间戳>/
 *     backup_meta.yaml   备份清单：时间戳、标识、来源、文件数、载体摘要、内容指纹
 *     content/           中心库原件的完整副本（含 skill_meta.yaml 与附属文件）
 *
 * 时间戳目录名把协调世界时时间戳中的冒号替换为短横线，因为冒号在部分文件系统上非法；
 * 清单里保存的 `timestamp` 字段仍是契约规定的原始时间戳，可读性与可比较性不丢失。
 *
 * 原子性：副本写入后必须逐文件核对相对路径与内容摘要，核对通过才写入清单；
 * 任何一步失败都清理本次产生的整个备份目录，不留下半份备份。
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../atomic/index.ts';
import { CODES } from '../contract.ts';
import { KernelError } from '../errors.ts';
import { resolveWithin } from '../paths/index.ts';
import { stringifyYaml } from '../yaml/index.ts';

export const BACKUP_META_FILE_NAME = 'backup_meta.yaml';
export const BACKUP_CONTENT_DIR_NAME = 'content';

export interface BackupRequest {
  /** 工作区根目录，用于路径防护与生成可移植路径 */
  workspaceRoot: string;
  /** 备份目录，必须位于工作区之内 */
  backupsDir: string;
  /** Skill 标识，作为备份目录的第一级 */
  id: string;
  /** 被备份的内容目录，通常为中心库原件 */
  sourceDir: string;
  /** 备份时间戳，协调世界时秒级，与契约时间规范一致 */
  now: string;
  /** 内容指纹，按契约算法对该内容计算，写入清单供回溯 */
  checksum: string;
  /** 注入点：复制完成、校验之前调用，用于测试校验失败与清理路径 */
  hooks?: { onAfterCopy?: (contentDir: string) => void };
}

export interface BackupResult {
  /** 备份目录绝对路径 */
  dir: string;
  /** 备份目录相对工作区的可移植路径 */
  portableDir: string;
  /** 契约格式的时间戳 */
  timestamp: string;
  /** 副本内的文件数，含元文件 */
  fileCount: number;
  /** 载体自身的内容摘要，覆盖全部文件（含元文件） */
  digest: string;
}

/** 把时间戳转换为可作目录名的形式：冒号在部分文件系统上非法 */
export function timestampToDirName(timestamp: string): string {
  return timestamp.replace(/:/g, '-');
}

/** 某个 Skill 的备份根目录 */
export function backupRootOf(backupsDir: string, id: string): string {
  return join(backupsDir, id);
}

/**
 * 生成一份备份，返回载体信息。
 * 失败时抛出 KernelError（E-BAK-001 或 E-BAK-002），并清理本次产生的全部内容。
 */
export function createBackup(request: BackupRequest): BackupResult {
  const { workspaceRoot, backupsDir, id, sourceDir, now, checksum } = request;

  // 标识与时间戳都要用作目录名：必须是单一路径段，阻断路径分隔符与上级目录穿越
  if (!isSafeSegment(id) || !isSafeSegment(timestampToDirName(now))) {
    throw new KernelError({
      code: CODES.BACKUP_FAILED,
      message: `标识或时间戳不能用作备份目录名：${id} / ${now}`,
      source: 'backup-fs',
      target: id,
      remedy: '请确认该 Skill 的标识仅含单一路径段，且时间戳格式合规',
    });
  }

  if (!isDirectory(sourceDir)) {
    throw new KernelError({
      code: CODES.BACKUP_FAILED,
      message: `备份来源不存在或不是目录：${sourceDir}`,
      source: 'backup-fs',
      target: id,
      remedy: '请确认该 Skill 的中心库原件是否存在',
    });
  }

  // 路径防护：标识与时间戳都参与拼接，必须解析后仍落在工作区之内
  let parentDir: string;
  let backupDir: string;
  try {
    parentDir = resolveWithin(
      workspaceRoot,
      join(portableOf(workspaceRoot, backupsDir), id),
      '工作区',
    );
    // 同一秒内重复备份时另起一个目录，绝不覆盖或清空已有的备份
    backupDir = join(parentDir, uniqueDirName(parentDir, timestampToDirName(now)));
  } catch (error) {
    throw toBackupError(error, id);
  }

  const contentDir = join(backupDir, BACKUP_CONTENT_DIR_NAME);
  try {
    mkdirSync(backupDir, { recursive: true });
  } catch (error) {
    throw new KernelError({
      code: CODES.BACKUP_UNAVAILABLE,
      message: `无法创建备份目录：${error instanceof Error ? error.message : String(error)}`,
      source: 'backup-fs',
      target: backupDir,
      remedy: '请检查备份目录是否可写',
      cause: error,
    });
  }

  try {
    cpSync(sourceDir, contentDir, { recursive: true, force: true, errorOnExist: false });
    request.hooks?.onAfterCopy?.(contentDir);
    const manifest = verifyCopy(sourceDir, contentDir, id);
    atomicWriteFile(
      join(backupDir, BACKUP_META_FILE_NAME),
      stringifyYaml({
        timestamp: now,
        skill_id: id,
        source: portableOf(workspaceRoot, sourceDir),
        file_count: manifest.fileCount,
        backup_digest: manifest.digest,
        content_checksum: checksum,
      }),
    );
    return {
      dir: backupDir,
      portableDir: portableOf(workspaceRoot, backupDir),
      timestamp: now,
      fileCount: manifest.fileCount,
      digest: manifest.digest,
    };
  } catch (error) {
    // 任何失败都不留下半份备份
    rmSync(backupDir, { recursive: true, force: true });
    removeIfEmpty(parentDir);
    throw toBackupError(error, id);
  }
}

interface CopyVerdict {
  fileCount: number;
  digest: string;
}

/** 在父目录下取一个未被占用的目录名；已被占用时追加序号 */
function uniqueDirName(parentDir: string, base: string): string {
  if (!existsSync(join(parentDir, base))) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(join(parentDir, candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 逐文件核对副本与来源：文件集合与内容摘要必须完全一致。
 * 只统计普通文件，不跟随符号链接。
 */
function verifyCopy(sourceDir: string, contentDir: string, id: string): CopyVerdict {
  const source = digestTree(sourceDir);
  const copy = digestTree(contentDir);

  const missing = [...source.keys()].filter((rel) => !copy.has(rel)).sort();
  const extra = [...copy.keys()].filter((rel) => !source.has(rel)).sort();
  const changed = [...source.keys()]
    .filter((rel) => copy.has(rel) && copy.get(rel) !== source.get(rel))
    .sort();

  if (missing.length > 0 || extra.length > 0 || changed.length > 0) {
    const detail = [
      missing.length > 0 ? `缺失 ${missing.join('、')}` : '',
      extra.length > 0 ? `多余 ${extra.join('、')}` : '',
      changed.length > 0 ? `内容不一致 ${changed.join('、')}` : '',
    ]
      .filter((item) => item !== '')
      .join('；');
    throw new KernelError({
      code: CODES.BACKUP_FAILED,
      message: `备份校验不通过：${detail}`,
      source: 'backup-fs',
      target: id,
      remedy: '请检查备份目录所在磁盘是否可写且空间充足，然后重试',
    });
  }

  return { fileCount: source.size, digest: summarize(source) };
}

/** 收集目录内全部普通文件的相对路径与内容摘要 */
function digestTree(
  root: string,
  base = '',
  collected = new Map<string, string>(),
): Map<string, string> {
  let entries;
  try {
    entries = readdirSync(join(root, base), { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      digestTree(root, rel, collected);
      continue;
    }
    if (!entry.isFile()) continue;
    const hash = createHash('sha256')
      .update(readFileSync(join(root, rel)))
      .digest('hex');
    collected.set(rel, hash);
  }
  return collected;
}

/** 载体摘要：把逐文件摘要按相对路径排序后聚合 */
function summarize(entries: Map<string, string>): string {
  const hash = createHash('sha256');
  for (const rel of [...entries.keys()].sort()) {
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(entries.get(rel)), 'utf8'));
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest('hex')}`;
}

/** 表达为相对工作区的可移植路径；不在工作区之内时原样返回，交由路径防护拒绝 */
function portableOf(workspaceRoot: string, target: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedTarget = target.replace(/\\/g, '/');
  if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) return target;
  return normalizedTarget.slice(normalizedRoot.length + 1);
}

function toBackupError(error: unknown, id: string): KernelError {
  if (error instanceof KernelError) return error;
  return new KernelError({
    code: CODES.BACKUP_FAILED,
    message: `备份失败：${error instanceof Error ? error.message : String(error)}`,
    source: 'backup-fs',
    target: id,
    remedy: '请检查备份目录是否可写且空间充足，然后重试',
    cause: error,
  });
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 判断一个字符串能否安全地作为单一路径段 */
function isSafeSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !/[\\/]/.test(segment);
}

/** 只在目录为空时移除它；非空或不存在时静默返回 */
function removeIfEmpty(target: string): void {
  try {
    rmdirSync(target);
  } catch {
    // 目录非空或已被移除，保持原状
  }
}
