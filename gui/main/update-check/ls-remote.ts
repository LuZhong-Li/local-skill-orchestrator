/**
 * 标签型 git 来源的只读探测。
 *
 * 唯一允许的命令是 `git ls-remote --tags --refs`；检查阶段不 clone、不 fetch、不 push，
 * 也不把来源中的内嵌凭据传给子进程。执行器可注入，单测不依赖真实网络。
 */
import { spawn } from 'node:child_process';
import {
  SOURCE_ERROR_CODES,
  UPDATE_CHECK_MAX_OUTPUT_BYTES,
  UPDATE_CHECK_TIMEOUT_MS,
} from './constants.ts';
import { isNewerFormalVersion, normalizeFormalVersion, type FormalVersion } from './semver.ts';

export interface RemoteTag {
  tag: string;
  commit: string;
  peeled: boolean;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
  errorCode?: string;
  tooLarge?: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  env: Record<string, string>,
) => Promise<CommandResult>;

export type ProbeOutcome =
  { ok: true; tags: RemoteTag[] } | { ok: false; code: string; message: string; remedy: string };

export interface LatestFormalTag {
  tag: RemoteTag;
  version: FormalVersion;
}

const TAG_PREFIX = 'refs/tags/';
const PEELED_SUFFIX = '^{}';
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i;

/**
 * 解析 `git ls-remote` 的 `sha<TAB>refs/tags/<tag>` 输出。
 * annotated tag 同时出现 `refs/tags/x` 与 `refs/tags/x^{}` 时，保留 peeled 目标 commit。
 */
export function parseLsRemote(text: string): RemoteTag[] {
  const byTag = new Map<string, RemoteTag>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const commit = parts[0]!;
    const ref = parts[1]!;
    if (!COMMIT_PATTERN.test(commit) || !ref.startsWith(TAG_PREFIX)) continue;

    const peeled = ref.endsWith(PEELED_SUFFIX);
    const tag = ref.slice(TAG_PREFIX.length, peeled ? -PEELED_SUFFIX.length : undefined);
    if (tag === '' || tag.includes(PEELED_SUFFIX)) continue;

    const existing = byTag.get(tag);
    if (existing === undefined || (peeled && !existing.peeled)) {
      byTag.set(tag, { tag, commit, peeled });
    }
  }
  return [...byTag.values()];
}

/** 从远端标签中选出最高的 semver 正式版；pre-release 与非 semver 标签不参与。 */
export function selectLatestFormalTag(tags: RemoteTag[]): LatestFormalTag | null {
  let latest: LatestFormalTag | null = null;
  for (const tag of tags) {
    const version = normalizeFormalVersion(tag.tag);
    if (version === null) continue;
    if (latest === null || isNewerFormalVersion(version, latest.version)) {
      latest = { tag, version };
    }
  }
  return latest;
}

/** 远端来源判定与内核 `looksRemote` 同口径；本地路径不会被探测。 */
export function looksRemoteLocation(location: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(location) || /^[^/\\]+@[^/\\]+:/.test(location);
}

function hasEmbeddedCredentials(location: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@]+@/.test(location);
}

function isAllowedProtocol(location: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(location)?.[1]?.toLowerCase() ?? '';
  if (scheme === 'https' || scheme === 'git') return true;
  if (scheme !== 'http') return false;
  const host = /^https?:\/\/([^/?#]+)/i.exec(location)?.[1]?.toLowerCase() ?? '';
  const bare = host.replace(/:\d+$/, '');
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || bare === '::1';
}

export function buildLsRemoteArgs(url: string): string[] {
  return ['ls-remote', '--tags', '--refs', url];
}

function authFailure(detail: string): boolean {
  return /\b401\b|\b403\b|authentication failed|could not read username|permission denied|terminal prompts disabled|access denied|repository not found/i.test(
    detail,
  );
}

/** 把命令失败按内核既有来源码归位；诊断原文保留在消息中。 */
export function probeFailureOf(result: CommandResult, url: string): ProbeOutcome {
  const detail = result.stderr.trim() || result.error?.trim() || '';
  if (result.tooLarge === true) {
    return {
      ok: false,
      code: SOURCE_ERROR_CODES.tooLarge,
      message: `git ls-remote 输出超过 128 MiB：${url}`,
      remedy: '该仓库的标签数量异常，请改用更小的镜像或联系来源维护者',
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      code: SOURCE_ERROR_CODES.timeout,
      message: `git ls-remote 超时（上限 60 秒）：${url}`,
      remedy: '请检查网络连通性后重试；该失败不阻断其他条目的检查',
    };
  }
  if (result.errorCode === 'ENOENT') {
    return {
      ok: false,
      code: SOURCE_ERROR_CODES.commandUnavailable,
      message: '未找到 git 命令',
      remedy: '请先安装 git 并确保它在 PATH 中，或改用本地来源',
    };
  }
  if (authFailure(detail) || authFailure(url)) {
    return {
      ok: false,
      code: SOURCE_ERROR_CODES.authRequired,
      message: `远端需要认证或已限流：${detail || url}`,
      remedy: '请稍后重试；检查阶段只访问公开来源，不会提示或保存凭据',
    };
  }
  return {
    ok: false,
    code: SOURCE_ERROR_CODES.remoteFailed,
    message: `git ls-remote 失败：${detail || `退出码 ${String(result.code)}`}`,
    remedy: '请确认来源地址可达、引用存在且网络可用',
  };
}

/** 默认执行器：只启动 git 子进程，超时后强杀并明确标记。 */
export const defaultCommandRunner: CommandRunner = (command, args, env) =>
  new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let tooLarge = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
    });

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const collect = (chunk: string, target: 'stdout' | 'stderr'): void => {
      if (tooLarge) return;
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > UPDATE_CHECK_MAX_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill('SIGKILL');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: string) => collect(chunk, 'stderr'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr,
        timedOut,
        error: error.message,
        tooLarge,
        ...(error.code === undefined ? {} : { errorCode: error.code }),
      });
    });
    child.on('close', (code: number | null) => {
      finish({ code, stdout, stderr, timedOut, tooLarge });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, UPDATE_CHECK_TIMEOUT_MS);
  });

/** 执行只读探测；含内嵌凭据的地址在启动子进程前拒绝。 */
export async function runGitLsRemote(
  url: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<ProbeOutcome> {
  if (!isAllowedProtocol(url)) {
    return {
      ok: false,
      code: SOURCE_ERROR_CODES.protocolRejected,
      message: `来源协议不被接受：${url}`,
      remedy: '检查阶段只允许 https、git，以及指向本机回环地址的 http',
    };
  }
  if (hasEmbeddedCredentials(url)) {
    return {
      ok: false,
      code: SOURCE_ERROR_CODES.authRequired,
      message: '来源地址内含凭据，检查已拒绝发起请求',
      remedy: '请移除 URL 中的用户名或口令；检查阶段不会提示、保存或发送凭据',
    };
  }
  const result = await runner('git', buildLsRemoteArgs(url), {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  });
  if (result.code !== 0 || result.timedOut || result.tooLarge || result.errorCode !== undefined) {
    return probeFailureOf(result, url);
  }
  return { ok: true, tags: parseLsRemote(result.stdout) };
}
