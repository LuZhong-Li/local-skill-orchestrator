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
 * 时间戳还是该份备份的对外标识（`restore --timestamp` 按它寻址），因此必须唯一：
 * 同一 Skill 同秒产出多份备份时，从第二份起把时间戳按毫秒精度扩展，清单与目录名同步，
 * 读取侧按唯一取值匹配，不再出现「一个取值对应多份载体」。
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
import { parseYaml, stringifyYaml } from '../yaml/index.ts';

export const BACKUP_META_FILE_NAME = 'backup_meta.yaml';
export const BACKUP_CONTENT_DIR_NAME = 'content';

/** 备份载体类型：本批次只定义完整文件载体，其余取值留给二期 */
export const BACKUP_TYPE_VALUES = ['full'] as const;
export type BackupType = (typeof BACKUP_TYPE_VALUES)[number];

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
  let timestamp: string;
  try {
    parentDir = resolveWithin(
      workspaceRoot,
      join(portableOf(workspaceRoot, backupsDir), id),
      '工作区',
    );
    // 同一秒内重复备份时把时间戳按毫秒精度扩展，绝不覆盖或清空已有的备份
    timestamp = uniqueTimestamp(parentDir, now);
    backupDir = join(parentDir, timestampToDirName(timestamp));
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
        type: 'full',
        timestamp,
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
      timestamp,
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

/**
 * 取一个在该 Skill 的备份集合内唯一的时间戳。
 *
 * 首个取值就是调用方给的时间戳；被占用时按毫秒精度逐个试探（001 至 999），
 * 时间戳与目录名一一对应，因此「唯一时间戳」同时意味着「唯一目录」。
 * 毫秒形式只出现在这一处，其余时间字段仍为契约规定的秒级精度（元数据规范 2.2）。
 */
function uniqueTimestamp(parentDir: string, base: string): string {
  if (!existsSync(join(parentDir, timestampToDirName(base)))) return base;
  const head = base.endsWith('Z') ? base.slice(0, -1) : base;
  for (let ms = 1; ms < 1000; ms += 1) {
    const candidate = `${head}.${String(ms).padStart(3, '0')}Z`;
    if (!existsSync(join(parentDir, timestampToDirName(candidate)))) return candidate;
  }
  throw new KernelError({
    code: CODES.BACKUP_UNAVAILABLE,
    message: `同一秒内的备份数量超出上限：${base}`,
    source: 'backup-fs',
    target: parentDir,
    remedy: '请稍后重试；单个 Skill 在同一秒内最多保留 1000 份备份',
  });
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

export interface BackupEntry {
  /** 该载体所属的 Skill 标识 */
  id: string;
  /** 备份目录绝对路径 */
  dir: string;
  /** 备份目录相对工作区的可移植路径 */
  portableDir: string;
  /** 清单里记录的契约格式时间戳 */
  timestamp: string;
  /** 载体类型 */
  type: string;
  /** 副本内的文件数 */
  fileCount: number;
}

/**
 * 枚举某个 Skill 的备份载体，按时间戳升序。
 * 只读取清单，不校验内容——校验在恢复前单独做，避免枚举就被损坏载体拖垮。
 */
export function listBackups(workspaceRoot: string, backupsDir: string, id: string): BackupEntry[] {
  // 标识要参与路径拼接：不是单一路径段时一律视为「没有备份」，不越出备份根目录
  if (!isSafeSegment(id)) return [];
  const root = backupRootOf(backupsDir, id);
  let stampDirs: string[];
  try {
    stampDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const entries: BackupEntry[] = [];
  for (const stamp of stampDirs) {
    const dir = join(root, stamp);
    const metaFile = join(dir, BACKUP_META_FILE_NAME);
    let raw: Record<string, unknown> | null = null;
    try {
      raw = parseYaml(readFileSync(metaFile, 'utf8'), { source: 'backup', target: metaFile });
    } catch {
      raw = null;
    }
    entries.push({
      id,
      dir,
      portableDir: portableOf(workspaceRoot, dir),
      timestamp: typeof raw?.['timestamp'] === 'string' ? String(raw['timestamp']) : stamp,
      type: typeof raw?.['type'] === 'string' ? String(raw['type']) : 'unknown',
      fileCount: typeof raw?.['file_count'] === 'number' ? Number(raw['file_count']) : 0,
    });
  }
  return entries.sort((left, right) => {
    const a = sortKeyOf(left.timestamp);
    const b = sortKeyOf(right.timestamp);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * 枚举工作区内全部 Skill 的备份载体，按「标识升序、时间戳升序」返回。
 *
 * 供备份管理界面使用：界面不直接读工作区文件，列表由本函数（存储层）产出，
 * 再经指令载荷交给调用方。层级内遇到非目录项或非法路径段一律跳过，不报错——
 * 备份目录被外部塞进杂物时，列表应照常可用。
 */
export function listAllBackups(workspaceRoot: string, backupsDir: string): BackupEntry[] {
  let ids: string[];
  try {
    ids = readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeSegment(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const entries: BackupEntry[] = [];
  for (const id of ids) entries.push(...listBackups(workspaceRoot, backupsDir, id));
  return entries;
}

/**
 * 排序键：把纯秒级取值补成毫秒形式再比较，使同一秒内的多份备份按真实先后排列。
 * 直接比较字符串会把 `…T12:00:00.001Z` 排在 `…T12:00:00Z` 之前（`.` 的编码小于 `Z`），
 * 而后者才是这一秒里更早的一份。
 */
function sortKeyOf(timestamp: string): string {
  return timestamp.endsWith('Z') && !timestamp.includes('.')
    ? `${timestamp.slice(0, -1)}.000Z`
    : timestamp;
}

/**
 * 校验一个备份载体自身是否完整：载体摘要与文件数须与清单一致，
 * 清单里记有内容指纹时一并重算比对。恢复只读消费载体，因此校验的是载体而不是磁盘现状。
 */
export function verifyBackup(entry: BackupEntry): { ok: boolean; problem: string } {
  if (!BACKUP_TYPE_VALUES.includes(entry.type as BackupType)) {
    return { ok: false, problem: `载体类型不受支持：${entry.type}` };
  }
  const contentDir = join(entry.dir, BACKUP_CONTENT_DIR_NAME);
  if (!isDirectory(contentDir)) {
    return { ok: false, problem: '备份载体缺少内容目录' };
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(readFileSync(join(entry.dir, BACKUP_META_FILE_NAME), 'utf8'), {
      source: 'backup',
      target: entry.portableDir,
    });
  } catch {
    return { ok: false, problem: '备份清单无法读取或格式不合规' };
  }

  const content = digestTree(contentDir);
  const actualCount = content.size;
  const declaredCount = typeof raw['file_count'] === 'number' ? Number(raw['file_count']) : -1;
  if (declaredCount >= 0 && declaredCount !== actualCount) {
    return {
      ok: false,
      problem: `载体文件数与清单不一致：清单记 ${declaredCount}，实际 ${actualCount}`,
    };
  }
  const actualDigest = summarize(content);
  const declaredDigest =
    typeof raw['backup_digest'] === 'string' ? String(raw['backup_digest']) : '';
  if (declaredDigest !== '' && declaredDigest !== actualDigest) {
    return {
      ok: false,
      problem: `载体摘要与清单不一致：清单 ${declaredDigest}，重算 ${actualDigest}`,
    };
  }
  return { ok: true, problem: '' };
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
