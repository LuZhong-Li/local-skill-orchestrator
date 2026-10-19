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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_TYPE_VALUES } from '../metadata/constants.ts';
import { CODES } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';
import { SOURCE_MAX_OUTPUT_BYTES, SOURCE_TIMEOUT_MS } from '@skill-manager/contract';

export type SourceType = (typeof SOURCE_TYPE_VALUES)[number];

export interface SourceSpec {
  type: SourceType;
  /** 本地位置：本地目录、本地仓库路径或归档文件路径 */
  location: string;
  /** 引用标识：分支、标签或提交，仅本地仓库使用 */
  ref?: string | undefined;
  /** 内容根识别文件；Skill 默认 skill_meta.yaml，插件传 plugin.json */
  root_file?: string | undefined;
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
export const REMOTE_TIMEOUT_MS =
  Number(process.env['SKILL_MANAGER_SOURCE_TIMEOUT_MS'] ?? '') || SOURCE_TIMEOUT_MS;
export const REMOTE_MAX_BYTES =
  Number(process.env['SKILL_MANAGER_SOURCE_MAX_BYTES'] ?? '') || SOURCE_MAX_OUTPUT_BYTES;

/** 协议白名单：https 与 git 用于远端；http 仅允许指向本机回环地址（本地测试与自建镜像） */
export function assertProtocolAllowed(location: string): void {
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
export function remoteKindOf(location: string): 'git' | 'archive' {
  const path = location.split(/[?#]/)[0]?.toLowerCase() ?? '';
  return /\.(zip|tar|tar\.gz|tgz)$/.test(path) ? 'archive' : 'git';
}

/** 从 URL 推断下载文件的扩展名，供归档类型识别使用 */
export function archiveNameOf(location: string, scratch: string): string {
  const path = (location.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  const name = path.replace(/[^A-Za-z0-9._-]/g, '') || 'archive';
  return join(scratch, name);
}

/** 把远端地址下载到本地文件；带超时与体积上限，失败路径清理半截文件 */
export function sourceError(
  code: string,
  message: string,
  target: string,
  remedy: string,
): KernelError {
  return new KernelError({ code, message, source: 'source', target, remedy });
}

/** 校验来源标识 */
export function assertRefUsable(ref: string | undefined): void {
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
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sm-source-'));
}

/**
 * 先整表校验 tar 的所有条目，再解压。
 * 理由：解压器把回调里抛出的异常包装成普通错误，直接依赖它上报会丢掉「不安全」这个分类。
 * 因此回调里只记录、不抛，等整表读完再由本函数抛出，问题码才准确。
 */
