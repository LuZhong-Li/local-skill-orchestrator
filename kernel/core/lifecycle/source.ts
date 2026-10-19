/** K-04 来源获取入口：本地、仓库、归档。 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CODES } from '@skill-manager/contract';
import { META_FILE_NAME, SOURCE_TYPE_VALUES } from '../metadata/constants.ts';
import { parseYaml } from '../../store/yaml/index.ts';
import {
  assertEntrySafeRoot,
  assertNoSymlinks,
  classifyArchiveError,
  extractGit,
  extractTar,
  extractZip,
} from './source-archive.ts';
import { acquireRemoteArchive, acquireRemoteGit } from './source-remote.ts';
import {
  assertProtocolAllowed,
  assertRefUsable,
  looksRemote,
  remoteKindOf,
  sourceError,
  tempDir,
  type AcquiredSource,
  type SourceSpec,
  type SourceType,
} from './source-shared.ts';

export { looksRemote };
export type { AcquiredSource, SourceSpec, SourceType } from './source-shared.ts';

export async function acquireSource(spec: SourceSpec): Promise<AcquiredSource> {
  const { type, location, ref, root_file: rootFile = META_FILE_NAME } = spec;
  assertRefUsable(ref);
  if (location.trim() === '') {
    throw sourceError(
      CODES.SRC_UNRESOLVED,
      '来源位置为空',
      type,
      '请在元文件中给出 source.location',
    );
  }
  if (looksRemote(location)) {
    assertProtocolAllowed(location);
    if (type === 'git') return acquireRemoteGit(location, ref, rootFile);
    if (type === 'archive') return acquireRemoteArchive(location, rootFile);
    throw sourceError(
      CODES.SRC_UNRESOLVED,
      `来源类型与地址形态不匹配：${type} / ${location}`,
      location,
      '远端来源的类型应为 git 或 archive',
    );
  }

  if (type === 'git') {
    const dir = tempDir();
    try {
      await extractGit(location, ref, dir);
      const root = assertEntrySafeRoot(dir, location, rootFile);
      assertNoSymlinks(root);
      return { dir: root, temporary: true, scratch: dir };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  if (type === 'archive') {
    if (!existsSync(location) || !statSync(location).isFile()) {
      throw sourceError(
        CODES.SRC_UNRESOLVED,
        `归档文件不可用：${location}`,
        location,
        '请确认该文件存在且是一个归档文件',
      );
    }
    const lower = location.toLowerCase();
    const dir = tempDir();
    try {
      if (lower.endsWith('.zip')) await extractZip(location, dir);
      else if (/\.(tar\.gz|tgz|tar)$/.test(lower)) await extractTar(location, dir);
      else {
        throw sourceError(
          CODES.SRC_UNRESOLVED,
          `无法识别的归档类型：${location}`,
          location,
          '仅支持 zip、tar 与 tar.gz 归档',
        );
      }
      const root = assertEntrySafeRoot(dir, location, rootFile);
      assertNoSymlinks(root);
      return { dir: root, temporary: true, scratch: dir };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      // 解压失败的原因可能是路径不安全，也可能是归档损坏；统一交给分类函数判断
      throw classifyArchiveError(error, location);
    }
  }

  // 本地目录与来源未知：内容根就是该目录本身
  if (!existsSync(location) || !statSync(location).isDirectory()) {
    throw sourceError(
      CODES.SRC_UNRESOLVED,
      `本地来源目录不可用：${location}`,
      location,
      '请确认该路径存在且是一个目录',
    );
  }
  assertEntrySafeRoot(location, location, rootFile);
  return { dir: location, temporary: false };
}

/**
 * 确定内容根：根目录直接含元文件时用它本身；
 * 否则若根下恰好存在一个子目录且该子目录内直接含元文件，则下钻一层。
 * 只下钻一层，多个候选或下钻后仍缺失都按获取失败上报。
 */
export async function acquireFromPath(
  sourcePath: string,
  rootFile: string = META_FILE_NAME,
): Promise<AcquiredSource> {
  // 远端地址：按地址形态推断是仓库还是归档——元文件还在远端，此时只能靠地址判断
  if (looksRemote(sourcePath)) {
    assertProtocolAllowed(sourcePath);
    const kind = remoteKindOf(sourcePath);
    return kind === 'archive'
      ? acquireRemoteArchive(sourcePath, rootFile)
      : acquireRemoteGit(sourcePath, undefined, rootFile);
  }
  const absolute = resolve(sourcePath);
  if (!existsSync(absolute)) {
    throw sourceError(
      CODES.PATH_INVALID,
      `来源路径不存在：${sourcePath}`,
      sourcePath,
      '请确认来源路径是否正确',
    );
  }
  const stats = statSync(absolute);
  if (stats.isFile()) {
    return acquireSource({ type: 'archive', location: absolute, root_file: rootFile });
  }
  if (!stats.isDirectory()) {
    throw sourceError(
      CODES.PATH_INVALID,
      `来源既不是目录也不是文件：${sourcePath}`,
      sourcePath,
      '来源应为包含元文件的目录，或一个 zip / tar / tar.gz 归档文件',
    );
  }
  const declared = readDeclaredSource(join(absolute, META_FILE_NAME));
  if (declared !== null && declared.type === 'git' && (declared.location ?? '') !== '') {
    return acquireSource({
      type: 'git',
      location: declared.location as string,
      ref: declared.ref,
      root_file: rootFile,
    });
  }
  return { dir: absolute, temporary: false };
}

/** 读元文件中声明的来源信息；不可读或未声明时返回 null */
export function readDeclaredSource(
  metaFile: string,
): { type: SourceType; location?: string; ref?: string } | null {
  let text: string;
  try {
    text = readFileSync(metaFile, 'utf8');
  } catch {
    return null;
  }
  try {
    return normalizeSource(parseYaml(text, { source: 'meta', target: metaFile }));
  } catch {
    return null;
  }
}

/** 从解析出的元数据对象里取出规范化后的来源声明 */
export function normalizeSource(
  raw: Record<string, unknown> | null,
): { type: SourceType; location?: string; ref?: string } | null {
  if (raw === null) return null;
  const source = raw['source'];
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;
  const block = source as Record<string, unknown>;
  const type = block['type'];
  if (typeof type !== 'string' || !SOURCE_TYPE_VALUES.includes(type as SourceType)) return null;
  const result: { type: SourceType; location?: string; ref?: string } = {
    type: type as SourceType,
  };
  // 本地位置优先，其次来源地址：远端地址由 acquireSource 按 looksRemote() 走克隆/下载分支
  const location = typeof block['location'] === 'string' ? block['location'] : block['url'];
  if (typeof location === 'string' && location !== '') result.location = location;
  if (typeof block['ref'] === 'string' && block['ref'] !== '') result.ref = block['ref'];
  return result;
}

/** 远端仓库：克隆到临时目录后复用本地仓库的读取路径 */
export function releaseSource(acquired: AcquiredSource): void {
  if (!acquired.temporary) return;
  // 内容根可能是临时目录本身，也可能是它下钻一层的子目录；按临时目录整体清理
  rmSync(acquired.scratch ?? acquired.dir, { recursive: true, force: true });
}
