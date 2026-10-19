/**
 * S-05 路径解析与越界防护。
 *
 * 契约要求：所有路径必须落在工作区之内；拒绝上级目录穿越与绝对路径注入。
 * 判定基于解析后的绝对路径前缀比较，而不是字符串前缀，以避免
 * /workspace-evil 被误判为落在 /workspace 之内。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { KernelError } from '../errors.ts';
import { CODES } from '@skill-manager/contract';

/** 判断 target 解析后是否落在 root 之内（含 root 自身） */
export function isWithin(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, target);
  if (resolvedTarget === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 把 target 解析为工作区内的绝对路径。
 * 越界或非法输入时抛出 E-PATH-001，调用方负责转换为结果封装。
 */
export function resolveWithin(root: string, target: string, rootLabel = '工作区'): string {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new KernelError({
      code: CODES.PATH_INVALID,
      message: '路径为空',
      source: 'paths',
      target,
      remedy: '请提供非空路径',
    });
  }
  if (target.includes('\0')) {
    throw new KernelError({
      code: CODES.PATH_INVALID,
      message: '路径包含空字节',
      source: 'paths',
      target,
      remedy: '请检查输入路径',
    });
  }
  if (!isWithin(root, target)) {
    throw new KernelError({
      code: CODES.PATH_INVALID,
      message: `路径越出${rootLabel}：${target}`,
      source: 'paths',
      target,
      remedy: `请把路径限定在${rootLabel}之内，禁止使用上级目录穿越或工作区之外的绝对路径`,
    });
  }
  return resolve(resolve(root), target);
}

/** 把绝对路径表达为相对于工作区的可移植路径，统一使用正斜杠 */
export function toPortablePath(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  return rel.split(sep).join('/');
}
