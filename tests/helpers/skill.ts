import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp.ts';

export interface SkillFixtureOptions {
  content?: string;
  description?: string;
  location?: string;
  target?: string;
  meta?: string | null;
  fileMap?: boolean;
}

/** 生成与现有测试一致的元文件；target 默认 claude。 */
export function makeSkillMeta(id: string, options: SkillFixtureOptions = {}): string {
  const target = options.target ?? 'claude';
  const lines = [`id: ${id}`, `name: ${id}`];
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  lines.push('status: enabled', `path: ./skills/${id}`, 'source:', '  type: local');
  if (options.location !== undefined) lines.push(`  location: ${options.location}`);
  lines.push(
    'targets:',
    `  - target: ${target}`,
    '    scope: global',
    `    path: .${target}/skills/${id}`,
    '    mode: copy',
    '    enabled: true',
  );
  if (options.fileMap !== false) {
    lines.push('    file_map:', '      SKILL.md: SKILL.md');
  }
  lines.push('');
  return lines.join('\n');
}

/** 在指定目录写 SKILL.md / skill_meta.yaml；meta: null 表示只写正文。 */
export function writeSkillDir(dir: string, id: string, options: SkillFixtureOptions = {}): string {
  mkdirSync(dir, { recursive: true });
  const content = options.content ?? `# ${id}`;
  if (content !== '') writeFileSync(join(dir, 'SKILL.md'), content);
  const meta = options.meta === undefined ? makeSkillMeta(id, options) : options.meta;
  if (meta !== null) writeFileSync(join(dir, 'skill_meta.yaml'), meta);
  return dir;
}

export function makeWorkspaceSkill(
  root: string,
  id: string,
  options: SkillFixtureOptions = {},
): string {
  return writeSkillDir(join(root, 'skills', id), id, options);
}

/** 临时来源目录：默认带 location 与标准 frontmatter，便于 install --host 夹具复用。 */
export function makeSkillSource(id: string, options: SkillFixtureOptions = {}): string {
  const dir = makeTempDir(`sm-src-${id}-`);
  const location = options.location ?? dir;
  const withSourceDefaults = { ...options, fileMap: options.fileMap ?? false };
  const meta =
    options.meta === undefined
      ? makeSkillMeta(id, { ...withSourceDefaults, location })
      : options.meta;
  return writeSkillDir(dir, id, {
    ...options,
    content: options.content ?? `---\nname: ${id}\n---\n\n# ${id}\n\n正文。\n`,
    meta,
  });
}

/** 兼容旧测试命名。 */
export const validMeta = makeSkillMeta;
