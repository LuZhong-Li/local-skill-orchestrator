/**
 * S-07 插件索引持久化。
 *
 * 只负责 plugin_index.yaml 的原始读写与基础结构归一；插件语义校验在
 * kernel/core/plugins 中完成。未识别字段原样保留，插件索引与 Skill 索引
 * 使用独立的文件、锁与原子写路径。
 */
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../atomic/index.ts';
import { parseYaml, stringifyYaml } from '../yaml/index.ts';
import { CODES, finding, type Finding } from '../contract.ts';
import { KernelError } from '../errors.ts';
import type { PluginIndex, PluginLanding, PluginRecord } from '@skill-manager/contract';

export interface LoadedPluginIndex {
  exists: boolean;
  index: PluginIndex | null;
  findings: Finding[];
}

/** 新建空插件索引；toolVersion 由调用方传入以避免存储层反向依赖内核层。 */
export function createInitialPluginIndex(generatedAt: string, toolVersion = '0.2.0'): PluginIndex {
  return {
    schema_version: '1',
    tool_version: toolVersion,
    generated_at: generatedAt,
    config: {},
    plugins: [],
    landings: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 读取原始 YAML；文件不存在时返回 exists=false。 */
export function readRawPluginIndex(pluginIndexFile: string): {
  exists: boolean;
  raw: Record<string, unknown> | null;
} {
  let text: string;
  try {
    text = readFileSync(pluginIndexFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { exists: false, raw: null };
    throw new KernelError({
      code: CODES.IO_FAILED,
      message: `读取插件索引失败：${error instanceof Error ? error.message : String(error)}`,
      source: 'plugin-registry',
      target: pluginIndexFile,
      remedy: '请检查 plugin_index.yaml 是否可读',
      cause: error,
    });
  }
  return {
    exists: true,
    raw: parseYaml(text, { source: 'plugin-registry', target: pluginIndexFile }),
  };
}

/** 载入插件索引；YAML 损坏与版本不兼容返回问题而不是抛出。 */
export function loadPluginIndex(pluginIndexFile: string): LoadedPluginIndex {
  let rawResult: { exists: boolean; raw: Record<string, unknown> | null };
  try {
    rawResult = readRawPluginIndex(pluginIndexFile);
  } catch (error) {
    if (error instanceof KernelError) {
      return {
        exists: true,
        index: null,
        findings: [
          finding(error.code, {
            source: error.source,
            target: error.target,
            message: error.message,
            remedy: error.remedy,
          }),
        ],
      };
    }
    throw error;
  }
  const { exists, raw } = rawResult;
  if (!exists || raw === null) return { exists: false, index: null, findings: [] };

  const findings: Finding[] = [];
  if (raw['schema_version'] !== '1') {
    findings.push(
      finding(CODES.VERSION_UNSUPPORTED, {
        source: 'plugin-registry',
        target: pluginIndexFile,
        message: `插件索引格式版本不受支持：${String(raw['schema_version'])}`,
        remedy: '请使用支持该索引版本的工具，或重新生成 plugin_index.yaml',
      }),
    );
    return { exists: true, index: null, findings };
  }
  const plugins: PluginRecord[] = [];
  const landings: PluginLanding[] = [];
  if (!Array.isArray(raw['plugins'])) {
    findings.push(
      finding(CODES.FIELD_TYPE, {
        source: 'plugin-registry',
        target: 'plugins',
        message: 'plugins 必须是数组',
        remedy: '修复 plugin_index.yaml 的 plugins 区，或重新生成该索引',
      }),
    );
  } else {
    raw['plugins'].forEach((item, index) => {
      if (!isRecord(item)) {
        findings.push(
          finding(CODES.FIELD_TYPE, {
            source: 'plugin-registry',
            target: `plugins[${index}]`,
            message: '插件记录必须是对象',
            remedy: '删除非法条目，或从插件目录重新登记',
          }),
        );
        return;
      }
      plugins.push({ ...item } as unknown as PluginRecord);
    });
  }
  const config: Record<string, string> = {};
  if (raw['config'] !== undefined && !isRecord(raw['config'])) {
    findings.push(
      finding(CODES.FIELD_TYPE, {
        source: 'plugin-registry',
        target: 'config',
        message: 'config 必须是对象',
        remedy: '把插件根配置改为键值对象',
      }),
    );
  } else if (isRecord(raw['config'])) {
    for (const [key, value] of Object.entries(raw['config'])) {
      if (typeof value !== 'string') {
        findings.push(
          finding(CODES.FIELD_TYPE, {
            source: 'plugin-registry',
            target: `config.${key}`,
            message: '插件配置值必须是字符串',
            remedy: '提供绝对或相对路径字符串',
          }),
        );
      } else {
        config[key] = value;
      }
    }
  }
  if (raw['landings'] !== undefined && !Array.isArray(raw['landings'])) {
    findings.push(
      finding(CODES.FIELD_TYPE, {
        source: 'plugin-registry',
        target: 'landings',
        message: 'landings 必须是数组',
        remedy: '修复插件落位账本；不要手工写入非数组值',
      }),
    );
  } else if (Array.isArray(raw['landings'])) {
    raw['landings'].forEach((item, index) => {
      if (!isRecord(item)) {
        findings.push(
          finding(CODES.FIELD_TYPE, {
            source: 'plugin-registry',
            target: `landings[${index}]`,
            message: '落位账本条目必须是对象',
            remedy: '删除非法条目，或重新分发对应 Skill',
          }),
        );
        return;
      }
      landings.push({ ...item } as unknown as PluginLanding);
    });
  }
  const index: PluginIndex = {
    ...raw,
    schema_version: '1',
    tool_version: String(raw['tool_version'] ?? '0.0.0'),
    generated_at: String(raw['generated_at'] ?? ''),
    config,
    plugins,
    landings,
  };
  return { exists: true, index, findings };
}

/** 原子写回插件索引；固定顶层顺序，未知字段原样保留。 */
export function savePluginIndex(pluginIndexFile: string, index: PluginIndex): void {
  const { config, plugins, landings, ...rest } = index;
  const ordered: Record<string, unknown> = {
    schema_version: index.schema_version,
    tool_version: index.tool_version,
    generated_at: index.generated_at,
    config,
    plugins,
    landings,
  };
  for (const [key, value] of Object.entries(rest)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  atomicWriteFile(pluginIndexFile, stringifyYaml(ordered));
}
