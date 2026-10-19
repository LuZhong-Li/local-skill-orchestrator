/** CLI e2e 共享夹具：临时工作区、输出捕获、交互通道与场景构造。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../kernel/entry/cli.ts';
import type { Interaction } from '../../kernel/dispatch/policy/index.ts';
import { makeTempDir } from './temp.ts';
import { validMeta } from './skill.ts';

const repoRoot = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export function packageVersionOf(path: string): string {
  return (JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as { version: string }).version;
}

export function kernelPackageVersion(): string {
  return packageVersionOf('kernel/package.json');
}

export function rootPackageVersion(): string {
  return packageVersionOf('package.json');
}

export function workspace(): string {
  const root = makeTempDir('sm-cli-');
  mkdirSync(join(root, 'skills'), { recursive: true });
  return root;
}

export function indexPath(root: string): string {
  return join(root, 'skill_index.yaml');
}

export async function capture(
  argv: string[],
  interaction?: Interaction,
): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  const patched = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = patched as typeof process.stdout.write;
  try {
    const code = interaction === undefined ? await run(argv) : await run(argv, interaction);
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

export function interactionOf(answer: string, interactive = true) {
  const written: string[] = [];
  const channel: Interaction = {
    interactive,
    write: (text: string): void => {
      written.push(text);
    },
    read: (): Promise<string> => Promise.resolve(answer),
  };
  return { written, channel };
}

const CLI_ENTRY = join(repoRoot, 'kernel', 'entry', 'cli.ts');

export function runCli(
  argv: string[],
  env?: Record<string, string>,
): { code: number; out: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    encoding: 'utf8',
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function skill(root: string, dir: string, meta: string, content = '# skill'): void {
  const target = join(root, 'skills', dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), content);
  writeFileSync(join(target, 'skill_meta.yaml'), meta);
}

export function sourceSkill(id: string): string {
  const dir = makeTempDir('sm-cli-src-');
  writeFileSync(join(dir, 'SKILL.md'), '# skill');
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      `    path: .claude/skills/${id}`,
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );
  return dir;
}

export async function readonlyWorkspace(): Promise<string> {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', validMeta('alpha'));
  skill(root, 'beta', `${validMeta('beta')}dependencies:\n  skills:\n    - ghost\n`);
  await run(['scan', '--workspace', root]);
  return root;
}

export async function importScenario(): Promise<string> {
  const root = workspace();
  await run(['init', '--workspace', root]);
  skill(root, 'alpha', validMeta('alpha'));
  skill(root, 'beta', validMeta('beta'));
  await run(['scan', '--workspace', root]);
  await run(['export', 'backups/snapshot.yaml', '--workspace', root]);
  await run(['uninstall', 'alpha', '--hard', '--workspace', root, '--yes']);
  return root;
}

export async function restoreScenario(options: { hard?: boolean } = {}): Promise<string> {
  const root = workspace();
  await run(['init', '--workspace', root]);
  await run(['install', sourceSkill('code-review'), '--workspace', root, '--yes']);
  const argv = ['uninstall', 'code-review', '--workspace', root, '--yes'];
  if (options.hard === true) argv.push('--hard');
  assert.equal(await run(argv), 0);
  return root;
}

export function backupDirOf(root: string, id: string): string {
  const stamps = readdirSync(join(root, 'backups', id));
  assert.equal(stamps.length, 1, '前置：应恰好有一份备份');
  return join(root, 'backups', id, stamps[0]!);
}
