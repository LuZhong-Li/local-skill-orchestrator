/** 宿主分发通道的公共入口。 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CODES, type Change, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import { META_FILE_NAME } from '../../core/metadata/constants.ts';
import { readMetaFile } from '../../core/metadata/read.ts';
import { TOOL_VERSION } from '../../core/index/index.ts';
import { loadHostRegistry } from '../../core/hosts/index.ts';
import { loadPluginCatalog } from '../../core/plugins/host.ts';
import type { RenderSource } from '../../core/render/types.ts';
import { buildHostChannel, type HostChannel } from './channel.ts';
import { hostLandingResult } from './landing-result.ts';

export * from './channel.ts';
export * from './landing-result.ts';

/** 读取中心库副本的 SKILL.md 正文（去掉元数据块），作为渲染产物的指令正文 */
function skillBodyOf(skillDir: string): string | undefined {
  const file = join(skillDir, 'SKILL.md');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/** 由元文件字段与指令正文组装渲染输入 */
export function renderSourceOf(skillDir: string, raw: Record<string, unknown>): RenderSource {
  const source: RenderSource = { id: String(raw['id']) };
  for (const key of ['description', 'license', 'version', 'author'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') source[key] = value;
  }
  addKeywords(source, raw);
  addDependencies(source, raw);
  const body = skillBodyOf(skillDir);
  if (body !== undefined) source.body = body;
  return source;
}

function addKeywords(source: RenderSource, raw: Record<string, unknown>): void {
  const keywords = raw['trigger_keywords'];
  if (!Array.isArray(keywords)) return;
  source.trigger_keywords = keywords.filter((item): item is string => typeof item === 'string');
}

function addDependencies(source: RenderSource, raw: Record<string, unknown>): void {
  const dependencies = raw['dependencies'];
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return;
  }
  const record = dependencies as Record<string, unknown>;
  addSkillDependencies(source, record['skills']);
  addRuntimeDependencies(source, record['runtime']);
}

function addSkillDependencies(source: RenderSource, value: unknown): void {
  if (!Array.isArray(value)) return;
  source.skill_dependencies = value.filter((item): item is string => typeof item === 'string');
}

function addRuntimeDependencies(source: RenderSource, value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const map: Record<string, string> = {};
  for (const [name, constraint] of Object.entries(value as Record<string, unknown>)) {
    if (typeof constraint === 'string') map[name] = constraint;
  }
  source.runtime_dependencies = map;
}

/** 元文件所在目录：安装来源既可以是目录，也可以直接指向元文件 */
export function metaDirOf(sourcePath: string): string {
  return sourcePath.endsWith(META_FILE_NAME) ? dirname(sourcePath) : sourcePath;
}

function missingRequiredCopy(input: {
  hostValue: string;
  channel: HostChannel;
  requireExisting?: boolean;
}): { findings: Finding[]; changes: Change[]; data: Record<string, unknown> } | undefined {
  if (input.requireExisting !== true) return undefined;
  const entry = input.channel.plan.entries.find((item) => item.landable);
  const targetPath =
    entry === undefined
      ? undefined
      : input.channel.form === 'rules'
        ? entry.target_path
        : entry.root_path;
  if (targetPath !== undefined && existsSync(targetPath)) return undefined;
  return {
    findings: [
      finding(CODES.PATH_INVALID, {
        source: 'host',
        target: targetPath ?? input.hostValue,
        message: `update --host 要求宿主副本已存在：${input.hostValue}`,
        remedy: `请先执行 skill-manager reconcile --action repair --id <标识> --host ${input.hostValue}`,
      }),
    ],
    changes: [],
    data: {
      host: input.channel.hostId,
      host_root: input.channel.resolution?.path ?? '',
      rejected: 'host_copy_missing',
    },
  };
}

/**
 * 安装与刷新的宿主分发：把中心库原件按落位计划分发到宿主真实根。
 *
 * 调用时机在中心库就位之后（安装完成、刷新完成）；调用前该指令自身的确认门已通过，
 * 因此这里不再重复确认（指令契约规范 2.4 节：一次调用一次确认）。
 */
export function runHostLanding(input: {
  command: 'install' | 'update';
  hostValue: string;
  layout: WorkspaceLayout;
  index: SkillIndex;
  /** 读取元文件与指令正文的位置：安装完成后的中心库副本，预演时为来源目录 */
  skillDir: string;
  now: string;
  dryRun: boolean;
  /** update 只刷新既有副本；缺失时由 reconcile repair 创建。 */
  requireExisting?: boolean;
}): { findings: Finding[]; changes: Change[]; data: Record<string, unknown> } {
  const metaRead = readMetaFile(input.skillDir, input.skillDir);
  if (metaRead.raw === null) {
    return { findings: metaRead.findings, changes: [], data: {} };
  }
  const pluginCatalog = input.hostValue.startsWith('x-')
    ? loadPluginCatalog({
        layout: input.layout,
        builtins: loadHostRegistry().hosts,
        toolVersion: TOOL_VERSION,
      })
    : undefined;
  const built = buildHostChannel({
    value: input.hostValue,
    layout: input.layout,
    index: input.index,
    source: renderSourceOf(input.skillDir, metaRead.raw),
    ...(pluginCatalog === undefined ? {} : { pluginCatalog }),
  });
  if (
    built.channel === undefined ||
    (built.channel.plugin !== undefined && built.findings.some((item) => item.severity === 'error'))
  ) {
    return { findings: built.findings, changes: [], data: {} };
  }
  const missing = missingRequiredCopy({
    hostValue: input.hostValue,
    channel: built.channel,
    ...(input.requireExisting === undefined ? {} : { requireExisting: input.requireExisting }),
  });
  if (missing !== undefined) return missing;
  const landed = hostLandingResult({
    command: input.command,
    channel: built.channel,
    layout: input.layout,
    now: input.now,
    skillId: String(metaRead.raw['id']),
    sourceMeta: metaRead.raw,
    sourceDir: input.skillDir,
    dryRun: input.dryRun,
  });
  return {
    findings: landed.findings,
    changes: landed.changes,
    data: (landed.data ?? {}) as Record<string, unknown>,
  };
}
