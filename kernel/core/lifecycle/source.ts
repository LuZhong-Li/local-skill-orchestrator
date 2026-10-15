/**
 * K-04 生命周期编排：来源获取。
 *
 * 本文件只做一件事：把「来源声明」变成一棵可以直接复制的本地目录树。
 *   本地目录  → 目录本身就是内容根；
 *   本地仓库  → 用 git 读出该引用下的已提交内容（不含版本控制目录与未提交改动）；
 *   归档文件  → 解压到临时目录。
 *
 * 安全边界：
 *   归档条目逐条校验，拒绝绝对路径、上级目录跳转与符号链接条目；
 *   解压时逐级检查父目录必须是真实目录，堵住「先建符号链接、再借它写出去」的路径；
 *   来源标识按白名单校验，git 命令一律以可执行文件加参数数组调用，不经 shell，不存在注入面；
 *   远程地址在本批次不受支持，返回来源类错误而不是静默忽略。
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import StreamZip from 'node-stream-zip';
import { META_FILE_NAME, SOURCE_TYPE_VALUES } from '../metadata/constants.ts';
import { CODES } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { parseYaml } from '../../store/yaml/index.ts';

export type SourceType = (typeof SOURCE_TYPE_VALUES)[number];

export interface SourceSpec {
  type: SourceType;
  /** 本地位置：本地目录、本地仓库路径或归档文件路径 */
  location: string;
  /** 引用标识：分支、标签或提交，仅本地仓库使用 */
  ref?: string | undefined;
}

export interface AcquiredSource {
  /** 内容根目录，调用方可以直接复制它 */
  dir: string;
  /** 是否为临时目录；为真时调用方使用完毕需要释放 */
  temporary: boolean;
}

/** 来源标识白名单：允许分支名、标签与十六进制提交，禁止以短横线开头以免被当作命令选项 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** 判断一个位置是否为远程地址；本批次不接受远程来源 */
export function looksRemote(location: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(location) || /^[^/\\]+@[^/\\]+:/.test(location);
}

function sourceError(code: string, message: string, target: string, remedy: string): KernelError {
  return new KernelError({ code, message, source: 'source', target, remedy });
}

/** 校验来源标识 */
function assertRefUsable(ref: string | undefined): void {
  if (ref === undefined || ref === '') return;
  if (!REF_PATTERN.test(ref) || ref.includes('..')) {
    throw new KernelError({
      code: CODES.INPUT_INVALID_ARG,
      message: `来源引用标识非法：${ref}`,
      source: 'input',
      target: ref,
      remedy: '引用标识只能是分支名、标签或提交标识，且不得以短横线开头',
    });
  }
}

/** 校验归档条目名：拒绝绝对路径、上级目录跳转与空名 */
function assertEntrySafe(name: string, archive: string): void {
  const normalized = name.replace(/\\/g, '/');
  if (
    normalized === '' ||
    isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw sourceError(
      CODES.SRC_INSECURE_ARCHIVE,
      `归档条目路径不安全：${name}`,
      archive,
      '该归档含绝对路径或上级目录跳转，已拒绝解压；请重新打包后再试',
    );
  }
}

/** 拒绝链接类条目：归档与仓库内容都不接受符号链接与硬链接 */
function assertEntryTypeSafe(entry: unknown, path: string, target: string): void {
  const type = (entry as { type?: string }).type;
  if (type === 'SymbolicLink' || type === 'Link') {
    throw sourceError(
      CODES.SRC_INSECURE_ARCHIVE,
      `来源内容含链接条目：${path}`,
      target,
      '链接条目不受支持，已拒绝该来源',
    );
  }
}

/** 逐级确认父目录都是真实目录，避免借已存在的符号链接写到别处 */
function ensureRealPath(root: string, target: string): void {
  const resolved = join(root, target);
  const segments = relative(root, dirname(resolved))
    .split(/[\\/]/)
    .filter((segment) => segment !== '');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current);
      continue;
    }
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw sourceError(
        CODES.SRC_INSECURE_ARCHIVE,
        `归档解压路径的父级不是目录：${current}`,
        current,
        '该归档疑似借符号链接写出目标目录，已拒绝解压',
      );
    }
  }
}

/** 解压后复核：内容根内不得存在符号链接 */
function assertNoSymlinks(root: string, base = ''): void {
  const entries = readdirSync(join(root, base), { withFileTypes: true });
  for (const entry of entries) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw sourceError(
        CODES.SRC_INSECURE_ARCHIVE,
        `归档解出符号链接：${rel}`,
        root,
        '归档中的符号链接不受支持，已拒绝该来源',
      );
    }
    if (entry.isDirectory()) assertNoSymlinks(root, rel);
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sm-source-'));
}

/**
 * 先整表校验 tar 的所有条目，再解压。
 * 理由：解压器把回调里抛出的异常包装成普通错误，直接依赖它上报会丢掉「不安全」这个分类。
 * 因此回调里只记录、不抛，等整表读完再由本函数抛出，问题码才准确。
 */
async function assertTarSafe(file: string, target: string): Promise<void> {
  let failure: unknown = null;
  await tar.t({
    file,
    onReadEntry: (entry) => {
      if (failure !== null) return;
      try {
        assertEntrySafe(entry.path, target);
        assertEntryTypeSafe(entry, entry.path, target);
      } catch (error) {
        failure = error;
      }
    },
  });
  if (failure !== null) throw failure;
}

/** 解压 tar 归档；条目在过滤器里逐条校验 */
async function extractTar(archive: string, dest: string): Promise<void> {
  await assertTarSafe(archive, archive);
  await tar.x({
    file: archive,
    cwd: dest,
    preservePaths: false,
    filter: (path, entry) => {
      assertEntrySafe(path, archive);
      assertEntryTypeSafe(entry, path, archive);
      ensureRealPath(dest, path);
      return true;
    },
  });
}

/**
 * 把解压过程中的异常归类成来源类问题。
 * 解压库自身也会拦下恶意条目，且它抛出的异常可能被包装或替换，
 * 因此两层 catch 都走这一个分类函数，保证同一个原因永远得到同一个问题码。
 */
function classifyArchiveError(error: unknown, archive: string): KernelError {
  if (error instanceof KernelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/malicious entry/i.test(message)) {
    return sourceError(
      CODES.SRC_INSECURE_ARCHIVE,
      `归档条目路径不安全：${message.replace(/^.*malicious entry:\s*/i, '')}`,
      archive,
      '该归档含绝对路径或上级目录跳转条目，已拒绝解压；请重新打包后再试',
    );
  }
  return sourceError(
    CODES.SRC_FETCH_FAILED,
    `归档无法解析：${message}`,
    archive,
    '请确认该文件是完整的归档，或改为使用本地目录来源',
  );
}

/** 解压 zip 归档：逐条目校验后用节点流写出，不调用库的批量解压 */
async function extractZip(archive: string, dest: string): Promise<void> {
  const zip = new StreamZip.async({ file: archive });
  try {
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      assertEntrySafe(entry.name, archive);
    }
    for (const entry of Object.values(entries)) {
      const target = entry.name.replace(/\\/g, '/');
      if (entry.isDirectory) {
        ensureRealPath(dest, `${target}/x`);
        continue;
      }
      ensureRealPath(dest, target);
      const data = await zip.entryData(entry.name);
      writeFileSync(join(dest, ...target.split('/')), data);
    }
  } catch (error) {
    throw classifyArchiveError(error, archive);
  } finally {
    await zip.close();
  }
}

/** 用 git 读出仓库在给定引用下的内容：不含版本控制目录，也不含未提交改动 */
async function extractGit(repo: string, ref: string | undefined, dest: string): Promise<void> {
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw sourceError(
      CODES.SRC_UNRESOLVED,
      `本地仓库路径不可用：${repo}`,
      repo,
      '请确认该路径存在且是一个目录',
    );
  }
  const child = spawn('git', ['-C', repo, 'archive', '--format=tar', ref ?? 'HEAD'], {
    shell: false,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const failed = new Promise<never>((_resolve, reject) => {
    child.on('error', (error: Error) => {
      const missing = (error as { code?: string }).code === 'ENOENT';
      reject(
        sourceError(
          missing ? CODES.SRC_COMMAND_UNAVAILABLE : CODES.SRC_FETCH_FAILED,
          missing ? '未找到 git 命令' : `无法启动 git：${error.message}`,
          repo,
          missing ? '请先安装 git 并确保它在 PATH 中，或改用本地目录与归档来源' : '请检查运行环境',
        ),
      );
    });
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(
          sourceError(
            CODES.SRC_FETCH_FAILED,
            `git archive 退出码 ${String(code)}：${stderr.trim() || '无诊断输出'}`,
            repo,
            '请确认该路径是一个 git 仓库，且引用标识存在',
          ),
        );
      }
    });
  });

  try {
    await Promise.race([
      pipeline(
        child.stdout,
        tar.x({
          cwd: dest,
          preservePaths: false,
          filter: (path, entry) => {
            assertEntrySafe(path, repo);
            assertEntryTypeSafe(entry, path, repo);
            ensureRealPath(dest, path);
            return true;
          },
        }),
      ),
      failed,
    ]);
  } catch (error) {
    if (error instanceof KernelError) throw error;
    throw sourceError(
      CODES.SRC_FETCH_FAILED,
      `仓库内容无法读取：${error instanceof Error ? error.message : String(error)}`,
      repo,
      '请确认该路径是一个 git 仓库，且引用标识存在',
    );
  }
}

/** 取出来源内容；调用方负责在完成后调用 releaseSource */
export async function acquireSource(spec: SourceSpec): Promise<AcquiredSource> {
  const { type, location, ref } = spec;
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
    throw sourceError(
      CODES.SRC_UNRESOLVED,
      `远程来源在本批次不受支持：${location}`,
      location,
      '远程地址（Git 或下载链接）属下一批次；当前可先用本地目录、本地仓库或归档文件',
    );
  }

  if (type === 'git') {
    const dir = tempDir();
    try {
      await extractGit(location, ref, dir);
      assertEntrySafeRoot(dir, location);
      assertNoSymlinks(dir);
      return { dir, temporary: true };
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
      assertEntrySafeRoot(dir, location);
      assertNoSymlinks(dir);
      return { dir, temporary: true };
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
  assertEntrySafeRoot(location, location);
  return { dir: location, temporary: false };
}

/** 内容根必须直接含元文件：归档不支持外层再套一层目录 */
function assertEntrySafeRoot(dir: string, target: string): void {
  if (!existsSync(join(dir, META_FILE_NAME))) {
    throw sourceError(
      CODES.SRC_FETCH_FAILED,
      `来源内容根目录下没有 ${META_FILE_NAME}`,
      target,
      '请让归档或仓库的内容根直接包含元文件；本批次不支持外层再套一层目录',
    );
  }
}

/**
 * 按命令行给出的位置取出来源：文件按归档处理，目录先看元文件声明的来源类型，
 * 声明为本地仓库时按仓库读取（读的是已提交内容，不含版本控制目录与未提交改动）。
 */
export async function acquireFromPath(sourcePath: string): Promise<AcquiredSource> {
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
    return acquireSource({ type: 'archive', location: absolute });
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
  // 本地位置优先，其次来源地址：远程地址会在 acquireSource 里被拒绝并给出明确提示
  const location = typeof block['location'] === 'string' ? block['location'] : block['url'];
  if (typeof location === 'string' && location !== '') result.location = location;
  if (typeof block['ref'] === 'string' && block['ref'] !== '') result.ref = block['ref'];
  return result;
}

/** 释放临时目录 */
export function releaseSource(acquired: AcquiredSource): void {
  if (acquired.temporary) rmSync(acquired.dir, { recursive: true, force: true });
}
