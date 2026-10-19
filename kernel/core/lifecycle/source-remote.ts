/** 远端仓库与归档获取。 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CODES } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { META_FILE_NAME } from '../metadata/constants.ts';
import {
  assertEntrySafeRoot,
  assertNoSymlinks,
  classifyArchiveError,
  extractGit,
  extractTar,
  extractZip,
} from './source-archive.ts';
import {
  REMOTE_MAX_BYTES,
  REMOTE_TIMEOUT_MS,
  archiveNameOf,
  sourceError,
  tempDir,
  type AcquiredSource,
} from './source-shared.ts';

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

export async function acquireRemoteGit(
  url: string,
  ref: string | undefined,
  rootFile: string = META_FILE_NAME,
): Promise<AcquiredSource> {
  const scratch = tempDir();
  const cloneDir = join(scratch, 'repo');
  const outDir = join(scratch, 'content');
  try {
    await cloneRemoteRepo(url, ref, cloneDir);
    mkdirSync(outDir, { recursive: true });
    await extractGit(cloneDir, undefined, outDir);
    const root = assertEntrySafeRoot(outDir, url, rootFile);
    assertNoSymlinks(root);
    return { dir: root, temporary: true, scratch };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/** 远端归档：下载到临时文件后复用本地归档解压路径 */
export async function acquireRemoteArchive(
  url: string,
  rootFile: string = META_FILE_NAME,
): Promise<AcquiredSource> {
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
    const root = assertEntrySafeRoot(outDir, url, rootFile);
    assertNoSymlinks(root);
    return { dir: root, temporary: true, scratch };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw classifyArchiveError(error, url);
  }
}

/** 释放临时目录 */
