/**
 * 内置示范 Skill 自动安装。
 *
 * 首次运行时把 kernel/builtin-skills/ 下的示范 Skill 复制到中心库 skills/ 目录。
 * 已存在的不覆盖（用户删除后不会重新出现）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILTIN_DIR = resolve(fileURLToPath(new URL('../../../builtin-skills/', import.meta.url)));

/** 逐文件递归复制（绕过 Windows Node v24 cpSync 中文路径崩溃 bug）。 */
function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) copyFileSync(s, d);
  }
}

/** 确保内置 Skill 已安装到中心库。返回新安装的 Skill id 列表。 */
export function ensureBuiltinSkills(skillsDir: string): string[] {
  if (!existsSync(BUILTIN_DIR)) return [];
  mkdirSync(skillsDir, { recursive: true });

  const installed: string[] = [];
  const entries = readdirSync(BUILTIN_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = join(skillsDir, entry.name);
    if (existsSync(target)) continue;
    copyDirRecursive(join(BUILTIN_DIR, entry.name), target);
    installed.push(entry.name);
  }
  return installed;
}
