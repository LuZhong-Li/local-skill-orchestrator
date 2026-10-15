/**
 * K-09 完整性指纹。
 *
 * 规则见元数据规范 2.3 节：
 *   算法 SHA-256，表示形式为 `sha256:` 加 64 位小写十六进制；
 *   参与范围为技能目录内的全部普通文件，但排除元文件自身、版本控制目录与临时文件；
 *   不跟随符号链接；空目录不参与；
 *   按相对路径的字节序升序，逐文件以「相对路径、一个空字节、文件字节流」累加。
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { META_FILE_NAME } from '../metadata/constants.ts';
import { CODES } from '../../store/contract.ts';
import { KernelError } from '../../store/errors.ts';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const EXCLUDED_FILE = /(^\.|\.tmp$|\.bak$|~$)/;

/** 收集参与指纹计算的相对路径，按字节序升序 */
export function collectHashEntries(
  skillDir: string,
  base: string = '',
  collected: string[] = [],
): string[] {
  let entries;
  try {
    entries = readdirSync(join(skillDir, base), { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectHashEntries(skillDir, rel, collected);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === META_FILE_NAME) continue;
    if (EXCLUDED_FILE.test(entry.name)) continue;
    collected.push(rel);
  }
  return collected.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

/**
 * 计算技能目录的内容指纹。
 *
 * 目标不存在时**抛错**，绝不返回空内容哈希：空内容哈希是空文件与空目录的合法指纹，
 * 用它表达「目录不存在」会让调用方拿到一个看似正常、实则无意义的取值。
 * 目录存在但确实不含参与计算的文件时照常计算，该情形由内容缺失判定（V-08）负责报告。
 */
export function computeChecksum(skillDir: string): string {
  assertDirectory(skillDir);
  const hash = createHash('sha256');
  for (const rel of collectHashEntries(skillDir)) {
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(join(skillDir, rel)));
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * 计算技能目录内每个文件的内容摘要，键为相对路径（正斜杠分隔），与聚合指纹共用同一套参与范围。
 *
 * 逐文件摘要只对**文件字节流**取哈希，不拼接路径——它回答「这个文件本身是否变了」，
 * 聚合指纹回答「整个目录是否变了」，两者不互相派生（元数据规范 2.3）。
 * 与 computeChecksum 一样，目标不存在时抛错，不返回空映射。
 */
export function computeDigests(skillDir: string): Record<string, string> {
  assertDirectory(skillDir);
  const digests: Record<string, string> = {};
  for (const rel of collectHashEntries(skillDir)) {
    digests[rel] = `sha256:${createHash('sha256')
      .update(readFileSync(join(skillDir, rel)))
      .digest('hex')}`;
  }
  return digests;
}

/** 逐文件摘要的取值是否合规 */
export function isDigestMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, digest]) => key !== '' && typeof digest === 'string' && isChecksumFormat(digest),
  );
}

/** 校验指纹的表示形式是否合规 */
export function isChecksumFormat(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** 判断目录下是否存在参与指纹的文件；全部缺失时按内容缺失处理 */
export function hasHashableContent(skillDir: string): boolean {
  try {
    return lstatSync(skillDir).isDirectory() && collectHashEntries(skillDir).length > 0;
  } catch {
    return false;
  }
}

/** 目标必须存在且是目录：不存在时抛错，禁止以空内容哈希代指 */
function assertDirectory(skillDir: string): void {
  let stats;
  try {
    stats = lstatSync(skillDir);
  } catch (error) {
    throw new KernelError({
      code: CODES.PATH_INVALID,
      message: `指纹计算目标不存在：${skillDir}`,
      source: 'integrity',
      target: skillDir,
      remedy: '请确认该 Skill 目录是否存在；目录不存在时不应计算指纹',
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw new KernelError({
      code: CODES.PATH_INVALID,
      message: `指纹计算目标不是目录：${skillDir}`,
      source: 'integrity',
      target: skillDir,
      remedy: '请指向一个 Skill 目录',
    });
  }
}
