/**
 * K-04 生命周期编排：来源获取。
 *
 * 本文件只做一件事：把「来源声明」变成一棵可以直接复制的本地目录树。
 *   本地目录  → 目录本身就是内容根；
 *   仓库      → 用 git 读出该引用下的已提交内容（不含版本控制目录与未提交改动）；远端先克隆到临时目录；
 *   归档文件  → 解压到临时目录；远端先下载到临时文件。
 *
 * 安全边界：
 *   归档条目逐条校验，拒绝绝对路径、上级目录跳转与符号链接条目；
 *   解压时逐级检查父目录必须是真实目录，堵住「先建符号链接、再借它写出去」的路径；
 *   来源标识按白名单校验，git 命令一律以可执行文件加参数数组调用，不经 shell，不存在注入面；
 *   远端地址受协议白名单约束，克隆与下载都有超时上限、下载另有体积上限，且都在临时目录内完成；
 *   认证只支持公开来源，克隆时禁用交互提示以免挂起等待输入。
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
  closeSync,
  openSync,
  writeSync,
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
  /** 解压或克隆出的临时目录；内容根可能是它的下一层，释放时要整体清理 */
  scratch?: string;
}

/** 来源标识白名单：允许分支名、标签与十六进制提交，禁止以短横线开头以免被当作命令选项 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** 判断一个位置是否为远程地址（远端来源自 M4a 起与本地来源共用同一套获取路径） */
export function looksRemote(location: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(location) || /^[^/\\]+@[^/\\]+:/.test(location);
}

/** 远端获取的时间与体积上限：超时防挂起，体积上限防无限下载；两者都可用环境变量调整 */
const REMOTE_TIMEOUT_MS = Number(process.env['SKILL_MANAGER_SOURCE_TIMEOUT_MS'] ?? '') || 60_000;
const REMOTE_MAX_BYTES =
  Number(process.env['SKILL_MANAGER_SOURCE_MAX_BYTES'] ?? '') || 128 * 1024 * 1024;

/** 协议白名单：https 与 git 用于远端；http 仅允许指向本机回环地址（本地测试与自建镜像） */
function assertProtocolAllowed(location: string): void {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(location)?.[1]?.toLowerCase() ?? '';
  if (scheme === 'https' || scheme === 'git') return;
  if (scheme === 'http') {
    const host = /^https?:\/\/([^/?#]+)/i.exec(location)?.[1]?.toLowerCase() ?? '';
    const bare = host.replace(/:\d+$/, '');
    if (bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || bare === '::1') return;
  }
  throw sourceError(
    CODES.SRC_PROTOCOL_REJECTED,
    `远端来源的协议不被接受：${location}`,
    location,
    '远端来源只允许 https 与 git 协议；指向本机回环地址的 http 也允许。file 协议请改用本地路径来源',
  );
}

/** 依据地址形态判断远端来源是仓库还是归档 */
function remoteKindOf(location: string): 'git' | 'archive' {
  const path = location.split(/[?#]/)[0]?.toLowerCase() ?? '';
  return /\.(zip|tar|tar\.gz|tgz)$/.test(path) ? 'archive' : 'git';
}

/** 从 URL 推断下载文件的扩展名，供归档类型识别使用 */
function archiveNameOf(location: string, scratch: string): string {
  const path = (location.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  const name = path.replace(/[^A-Za-z0-9._-]/g, '') || 'archive';
  return join(scratch, name);
}

/** 把远端地址下载到本地文件；带超时与体积上限，失败路径清理半截文件 */
async function fetchRemoteFile(url: string, destFile: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw sourceError(
        CODES.SRC_TIMEOUT,
        `下载超时（上限 ${REMOTE_TIMEOUT_MS / 1000} 秒）：${url}`,
        url,
        '请检查网络连通性，或改用本地归档来源',
      );
    }
    throw sourceError(
      CODES.SRC_DOWNLOAD_FAILED,
      `下载失败：${error instanceof Error ? error.message : String(error)}`,
      url,
      '请确认该地址可达；网络受限时可先手动下载，再用本地归档来源安装',
    );
  }
  if (!response.ok) {
    throw sourceError(
      response.status === 401 || response.status === 403
        ? CODES.SRC_AUTH_REQUIRED
        : CODES.SRC_DOWNLOAD_FAILED,
      `远端返回 ${response.status}：${url}`,
      url,
      response.status === 401 || response.status === 403
        ? '该来源需要认证；一期只支持公开来源，可先手动下载后再用本地归档来源'
        : '请确认该地址指向一个可下载的归档文件',
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > REMOTE_MAX_BYTES) {
    throw sourceError(
      CODES.SRC_TOO_LARGE,
      `远端来源体积超过上限：${declared} 字节`,
      url,
      `上限为 ${Math.round(REMOTE_MAX_BYTES / 1024 / 1024)} MB；请拆分来源或改用本地归档`,
    );
  }

  const handle = openSync(destFile, 'w');
  let received = 0;
  try {
    const body = response.body;
    if (body === null) throw new Error('响应没有内容体');
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      received += buffer.length;
      if (received > REMOTE_MAX_BYTES) {
        throw sourceError(
          CODES.SRC_TOO_LARGE,
          `远端来源体积超过上限：已接收 ${received} 字节`,
          url,
          `上限为 ${Math.round(REMOTE_MAX_BYTES / 1024 / 1024)} MB；请拆分来源或改用本地归档`,
        );
      }
      writeSync(handle, buffer);
    }
  } catch (error) {
    closeSync(handle);
    rmSync(destFile, { force: true });
    if (error instanceof KernelError) throw error;
    throw sourceError(
      CODES.SRC_DOWNLOAD_FAILED,
      `下载中断：${error instanceof Error ? error.message : String(error)}`,
      url,
      '请重试；持续失败时可手动下载后再用本地归档来源',
    );
  }
  closeSync(handle);
}

/** 克隆远端仓库到临时目录；认证失败与超时各归明确问题码 */
async function cloneRemoteRepo(
  url: string,
  ref: string | undefined,
  destDir: string,
): Promise<void> {
  // 不用 --depth 1：浅克隆在 dumb HTTP 上不被支持，而自建镜像常用 dumb 协议。
  // 代价是克隆体积更大，由超时上限兜底。
  const args = ['clone', '--quiet'];
  if (ref !== undefined && ref !== '') args.push('--branch', ref);
  args.push(url, destDir);
  const child = spawn('git', args, {
    shell: false,
    // 关掉交互提示：私有仓库会立刻失败并归入认证类问题，而不是挂起等输入
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => {
    child.kill();
  }, REMOTE_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', (value) => resolve(value));
  });
  clearTimeout(timer);
  if (code === 0) return;

  const detail = stderr.trim();
  if (code === null && detail === '') {
    throw sourceError(
      CODES.SRC_COMMAND_UNAVAILABLE,
      '未找到 git 命令',
      url,
      '请先安装 git 并确保它在 PATH 中，或改用本地来源',
    );
  }
  if (child.killed) {
    throw sourceError(
      CODES.SRC_TIMEOUT,
      `克隆超时（上限 ${REMOTE_TIMEOUT_MS / 1000} 秒）：${url}`,
      url,
      '请检查网络连通性，或改用本地仓库来源',
    );
  }
  if (
    /authentication failed|could not read username|permission denied|terminal prompts disabled|repository not found/i.test(
      detail,
    )
  ) {
    throw sourceError(
      CODES.SRC_AUTH_REQUIRED,
      `远端仓库需要认证或不可访问：${detail || url}`,
      url,
      '一期只支持公开来源；私有仓库请先在本机克隆，再用本地 git 仓库路径安装',
    );
  }
  throw sourceError(
    CODES.SRC_DOWNLOAD_FAILED,
    `克隆失败：${detail || `git 退出码 ${String(code)}`}`,
    url,
    '请确认该地址是一个公开的 git 仓库，且引用标识存在',
  );
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
    assertProtocolAllowed(location);
    if (type === 'git') return acquireRemoteGit(location, ref);
    if (type === 'archive') return acquireRemoteArchive(location);
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
      const root = assertEntrySafeRoot(dir, location);
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
      const root = assertEntrySafeRoot(dir, location);
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
  assertEntrySafeRoot(location, location);
  return { dir: location, temporary: false };
}

/**
 * 确定内容根：根目录直接含元文件时用它本身；
 * 否则若根下恰好存在一个子目录且该子目录内直接含元文件，则下钻一层。
 * 只下钻一层，多个候选或下钻后仍缺失都按获取失败上报。
 */
function assertEntrySafeRoot(dir: string, target: string): string {
  if (existsSync(join(dir, META_FILE_NAME))) return dir;
  const children = readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
  );
  if (children.length === 1) {
    const inner = join(dir, children[0]!.name);
    if (existsSync(join(inner, META_FILE_NAME))) return inner;
  }
  throw sourceError(
    CODES.SRC_FETCH_FAILED,
    `无法确定唯一内容目录：内容根下没有 ${META_FILE_NAME}`,
    target,
    children.length === 1
      ? `请让 ${children[0]!.name}/ 目录内直接包含元文件`
      : '请让归档的内容根直接包含元文件，或只在外层保留一个目录',
  );
}

/**
 * 按命令行给出的位置取出来源：文件按归档处理，目录先看元文件声明的来源类型，
 * 声明为本地仓库时按仓库读取（读的是已提交内容，不含版本控制目录与未提交改动）。
 */
export async function acquireFromPath(sourcePath: string): Promise<AcquiredSource> {
  // 远端地址：按地址形态推断是仓库还是归档——元文件还在远端，此时只能靠地址判断
  if (looksRemote(sourcePath)) {
    assertProtocolAllowed(sourcePath);
    const kind = remoteKindOf(sourcePath);
    return kind === 'archive'
      ? acquireRemoteArchive(sourcePath)
      : acquireRemoteGit(sourcePath, undefined);
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
  // 本地位置优先，其次来源地址：远端地址由 acquireSource 按 looksRemote() 走克隆/下载分支
  const location = typeof block['location'] === 'string' ? block['location'] : block['url'];
  if (typeof location === 'string' && location !== '') result.location = location;
  if (typeof block['ref'] === 'string' && block['ref'] !== '') result.ref = block['ref'];
  return result;
}

/** 远端仓库：克隆到临时目录后复用本地仓库的读取路径 */
async function acquireRemoteGit(url: string, ref: string | undefined): Promise<AcquiredSource> {
  const scratch = tempDir();
  const cloneDir = join(scratch, 'repo');
  const outDir = join(scratch, 'content');
  try {
    await cloneRemoteRepo(url, ref, cloneDir);
    mkdirSync(outDir, { recursive: true });
    await extractGit(cloneDir, undefined, outDir);
    const root = assertEntrySafeRoot(outDir, url);
    assertNoSymlinks(root);
    return { dir: root, temporary: true, scratch };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/** 远端归档：下载到临时文件后复用本地归档解压路径 */
async function acquireRemoteArchive(url: string): Promise<AcquiredSource> {
  const lower = (url.split(/[?#]/)[0] ?? '').toLowerCase();
  if (!/\.(zip|tar|tar\.gz|tgz)$/.test(lower)) {
    throw sourceError(
      CODES.SRC_UNRESOLVED,
      `无法从地址判断归档类型：${url}`,
      url,
      '地址需以 .zip、.tar 或 .tar.gz 结尾',
    );
  }
  const scratch = tempDir();
  const file = archiveNameOf(url, scratch);
  const outDir = join(scratch, 'content');
  try {
    await fetchRemoteFile(url, file);
    mkdirSync(outDir, { recursive: true });
    if (file.toLowerCase().endsWith('.zip')) await extractZip(file, outDir);
    else await extractTar(file, outDir);
    const root = assertEntrySafeRoot(outDir, url);
    assertNoSymlinks(root);
    return { dir: root, temporary: true, scratch };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw classifyArchiveError(error, url);
  }
}

/** 释放临时目录 */
export function releaseSource(acquired: AcquiredSource): void {
  if (!acquired.temporary) return;
  // 内容根可能是临时目录本身，也可能是它下钻一层的子目录；按临时目录整体清理
  rmSync(acquired.scratch ?? acquired.dir, { recursive: true, force: true });
}
