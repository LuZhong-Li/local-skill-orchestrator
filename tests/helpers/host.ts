import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp.ts';

export interface HostSkillOptions {
  disabled?: boolean;
  description?: string;
}

export function makeHostRoot(prefix = 'sm-host-'): string {
  return makeTempDir(prefix);
}

/** 多宿主共享根：返回同一个物理目录，供消费宿主集合测试复用。 */
export function makeSharedHostRoot(prefix = 'sm-shared-host-'): string {
  return makeTempDir(prefix);
}

/** root 是技能根（其下直接放 <id>/SKILL.md），不是工作区根。 */
export function writeHostSkill(root: string, id: string, options: HostSkillOptions = {}): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const marker = options.disabled === true ? 'SKILL.md.disabled' : 'SKILL.md';
  writeFileSync(
    join(dir, marker),
    `---\nname: ${id}\ndescription: ${options.description ?? `${id} fixture`}\n---\n\n# ${id}\n`,
  );
  return dir;
}

export function makeHostSkill(root: string, id: string, options: HostSkillOptions = {}): string {
  return writeHostSkill(root, id, options);
}

export type CorruptHostKind = 'missing' | 'bad-yaml' | 'missing-name';

/** 损坏 / 不可读 / 不合格宿主样本；目录存在但 SKILL.md 不符合识别条件。 */
export function writeCorruptHostSkill(
  root: string,
  id: string,
  kind: CorruptHostKind = 'missing',
): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  if (kind === 'missing') return dir;
  const content =
    kind === 'bad-yaml' ? '---\nname: [unterminated\n---\n' : '---\ndescription: 缺少 name\n---\n';
  writeFileSync(join(dir, 'SKILL.md'), content);
  return dir;
}
