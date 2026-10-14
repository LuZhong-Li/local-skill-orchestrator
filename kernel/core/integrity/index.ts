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

/** 计算技能目录的内容指纹 */
export function computeChecksum(skillDir: string): string {
  const hash = createHash('sha256');
  for (const rel of collectHashEntries(skillDir)) {
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(join(skillDir, rel)));
  }
  return `sha256:${hash.digest('hex')}`;
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
