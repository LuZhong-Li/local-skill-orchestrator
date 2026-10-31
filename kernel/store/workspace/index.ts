/**
 * S-01 工作区布局。
 *
 * 布局定义见需求文档 4.3 节与架构文档 4.3 节：
 * 工作区根目录下放 Skill 索引与独立插件索引，另有 skills/、plugins/、
 * backups/、locks/、logs/ 五个目录。
 * 本模块只负责路径推导与目录创建，不涉及索引内容。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KernelError } from '../errors.ts';
import { CODES } from '@skill-manager/contract';

export const WORKSPACE_DIR_NAME = '.skill-manager';
export const INDEX_FILE_NAME = 'skill_index.yaml';
export const SKILLS_DIR_NAME = 'skills';
export const BACKUPS_DIR_NAME = 'backups';
export const LOCKS_DIR_NAME = 'locks';
export const LOGS_DIR_NAME = 'logs';
export const EXPERIENCES_DIR_NAME = 'experiences';
export const PLUGINS_DIR_NAME = 'plugins';
export const PLUGIN_INDEX_FILE_NAME = 'plugin_index.yaml';
export const HOST_LANDINGS_FILE_NAME = 'host_landings.yaml';

/** 环境变量用于覆盖工作区根目录，便于测试与多工作区场景 */
export const WORKSPACE_ENV = 'SKILL_MANAGER_HOME';

export interface WorkspaceLayout {
  root: string;
  indexFile: string;
  skillsDir: string;
  pluginsDir: string;
  backupsDir: string;
  locksDir: string;
  logsDir: string;
  experiencesDir: string;
  pluginIndexFile: string;
  hostLandingsFile: string;
}

/** 解析工作区根目录：优先取环境变量，其次取用户主目录下的约定目录 */
export function resolveWorkspaceRoot(explicit?: string): string {
  const fromEnv = process.env[WORKSPACE_ENV];
  if (explicit !== undefined && explicit !== '') return explicit;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), WORKSPACE_DIR_NAME);
}

/** 由工作区根目录推导标准布局 */
export function layoutOf(root: string): WorkspaceLayout {
  return {
    root,
    indexFile: join(root, INDEX_FILE_NAME),
    skillsDir: join(root, SKILLS_DIR_NAME),
    pluginsDir: join(root, PLUGINS_DIR_NAME),
    backupsDir: join(root, BACKUPS_DIR_NAME),
    locksDir: join(root, LOCKS_DIR_NAME),
    logsDir: join(root, LOGS_DIR_NAME),
    experiencesDir: join(root, EXPERIENCES_DIR_NAME),
    pluginIndexFile: join(root, PLUGIN_INDEX_FILE_NAME),
    hostLandingsFile: join(root, HOST_LANDINGS_FILE_NAME),
  };
}

/** 创建标准目录，已存在则跳过，天然幂等 */
export function ensureWorkspaceDirs(layout: WorkspaceLayout): void {
  try {
    mkdirSync(layout.root, { recursive: true });
    for (const dir of [
      layout.skillsDir,
      layout.pluginsDir,
      layout.backupsDir,
      layout.locksDir,
      layout.logsDir,
      layout.experiencesDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    throw new KernelError({
      code: CODES.IO_FAILED,
      message: `创建工作区目录失败：${error instanceof Error ? error.message : String(error)}`,
      source: 'workspace',
      target: layout.root,
      remedy: '请检查该路径是否可写',
      cause: error,
    });
  }
}
