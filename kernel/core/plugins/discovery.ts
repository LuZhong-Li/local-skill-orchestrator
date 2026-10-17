/**
 * K-16 插件目录发现。
 *
 * 只扫描 <workspace>/plugins/ 的一级子目录，读取 plugin.json、计算哈希，
 * 检查代码扩展名、符号链接与路径边界。发现不等于登记：本模块不写插件索引。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { isWithin } from '../../store/paths/index.ts';
import { validatePluginManifest } from './manifest.ts';
import type { PluginManifest } from './types.ts';

export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGIN_MANIFEST_MAX_BYTES = 256 * 1024;

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.node', '.exe', '.dll', '.dylib', '.so']);

export interface PluginCandidate {
  dir: string;
  plugin_id: string;
  manifest_path: string;
  manifest_hash: string;
  manifest: PluginManifest | null;
  findings: Finding[];
}

export interface DiscoveryOutcome {
  candidates: PluginCandidate[];
  findings: Finding[];
}

export interface PluginPackageInspection {
  dir: string;
  manifest_path: string;
  manifest_hash: string;
  manifest: PluginManifest | null;
  findings: Finding[];
}

function add(
  findings: Finding[],
  code: string,
  target: string,
  message: string,
  remedy: string,
): void {
  findings.push(finding(code, { source: 'plugin-discovery', target, message, remedy }));
}

/** 递归检查插件目录中的代码文件与符号链接；返回插件内相对路径的问题。 */
function inspectFiles(root: string, dir: string, findings: Finding[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const relative = absolute
      .slice(root.length + 1)
      .split('\\')
      .join('/');
    let info;
    try {
      info = lstatSync(absolute);
    } catch (error) {
      add(
        findings,
        CODES.IO_FAILED,
        relative,
        `无法读取插件文件：${error instanceof Error ? error.message : String(error)}`,
        '检查插件目录权限',
      );
      continue;
    }
    if (info.isSymbolicLink()) {
      add(
        findings,
        CODES.PATH_INVALID,
        relative,
        '插件目录不得包含符号链接',
        '移除符号链接，把静态资源直接放入插件目录',
      );
      continue;
    }
    if (info.isDirectory()) {
      inspectFiles(root, absolute, findings);
      continue;
    }
    if (CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      add(
        findings,
        CODES.FIELD_INVALID_VALUE,
        relative,
        `插件目录不得包含代码文件：${entry.name}`,
        '插件仅允许 manifest 与静态资源；删除所有 JS、原生库与可执行文件',
      );
    }
  }
}

/** 检查任意来源目录中的插件包；不要求目录名等于 plugin_id（安装时从 manifest 取名）。 */
export function inspectPluginPackage(
  pluginDir: string,
  toolVersion?: string,
): PluginPackageInspection {
  const findings: Finding[] = [];
  const manifestPath = join(pluginDir, PLUGIN_MANIFEST_FILE);
  let manifest: PluginManifest | null = null;
  let manifestHash = '';
  let info;
  try {
    info = lstatSync(pluginDir);
  } catch (error) {
    add(
      findings,
      CODES.PATH_INVALID,
      pluginDir,
      `插件来源目录不可用：${error instanceof Error ? error.message : String(error)}`,
      '提供包含 plugin.json 的目录或归档',
    );
    return {
      dir: pluginDir,
      manifest_path: manifestPath,
      manifest_hash: '',
      manifest: null,
      findings,
    };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    add(
      findings,
      CODES.PATH_INVALID,
      pluginDir,
      '插件来源必须是真实目录，不得为符号链接',
      '使用普通目录来源',
    );
    return {
      dir: pluginDir,
      manifest_path: manifestPath,
      manifest_hash: '',
      manifest: null,
      findings,
    };
  }
  inspectFiles(pluginDir, pluginDir, findings);
  if (!existsSync(manifestPath)) {
    add(
      findings,
      CODES.FIELD_REQUIRED,
      manifestPath,
      '插件来源缺少 plugin.json',
      '在来源根放置 plugin.json',
    );
    return {
      dir: pluginDir,
      manifest_path: manifestPath,
      manifest_hash: '',
      manifest: null,
      findings,
    };
  }
  try {
    const bytes = readFileSync(manifestPath);
    manifestHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.byteLength > PLUGIN_MANIFEST_MAX_BYTES) {
      add(
        findings,
        CODES.FIELD_LENGTH,
        manifestPath,
        `manifest 超过 ${PLUGIN_MANIFEST_MAX_BYTES} 字节上限`,
        '缩小 manifest',
      );
    } else {
      const validation = validatePluginManifest(
        JSON.parse(bytes.toString('utf8')) as unknown,
        toolVersion === undefined ? {} : { toolVersion },
      );
      findings.push(...validation.findings);
      manifest = validation.manifest;
    }
  } catch (error) {
    add(
      findings,
      CODES.FIELD_TYPE,
      manifestPath,
      `plugin.json 无法解析：${error instanceof Error ? error.message : String(error)}`,
      '提供合法 JSON 对象',
    );
  }
  if (findings.some((item) => item.severity === 'error')) manifest = null;
  return {
    dir: pluginDir,
    manifest_path: manifestPath,
    manifest_hash: manifestHash,
    manifest,
    findings,
  };
}

/**
 * 扫描插件根目录。每个目录仍形成一个候选，即使 manifest 缺失/非法，
 * 以便调用方报告不合格项而不是静默丢弃。
 */
export function discoverPluginPackages(pluginsDir: string): DiscoveryOutcome {
  const candidates: PluginCandidate[] = [];
  const findings: Finding[] = [];
  if (!existsSync(pluginsDir)) return { candidates, findings };

  let rootReal: string;
  try {
    rootReal = realpathSync(pluginsDir);
    if (!statSync(rootReal).isDirectory()) {
      add(
        findings,
        CODES.PATH_INVALID,
        pluginsDir,
        '插件根不是目录',
        '提供 <workspace>/plugins 目录',
      );
      return { candidates, findings };
    }
  } catch (error) {
    add(
      findings,
      CODES.IO_FAILED,
      pluginsDir,
      `无法访问插件根：${error instanceof Error ? error.message : String(error)}`,
      '检查工作区 plugins 目录权限',
    );
    return { candidates, findings };
  }

  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    const pluginDir = join(pluginsDir, entry.name);
    const candidateFindings: Finding[] = [];
    let info;
    try {
      info = lstatSync(pluginDir);
    } catch (error) {
      add(
        findings,
        CODES.IO_FAILED,
        entry.name,
        `无法读取插件目录：${error instanceof Error ? error.message : String(error)}`,
        '检查插件目录权限',
      );
      continue;
    }
    if (info.isSymbolicLink()) {
      add(
        findings,
        CODES.PATH_INVALID,
        entry.name,
        '插件目录不得是符号链接',
        '使用工作区内真实目录',
      );
      continue;
    }
    if (!info.isDirectory()) continue;

    let pluginReal: string;
    try {
      pluginReal = realpathSync(pluginDir);
    } catch (error) {
      add(
        candidateFindings,
        CODES.IO_FAILED,
        entry.name,
        `无法解析插件目录：${error instanceof Error ? error.message : String(error)}`,
        '检查目录权限与路径',
      );
      candidates.push({
        dir: pluginDir,
        plugin_id: entry.name,
        manifest_path: join(pluginDir, PLUGIN_MANIFEST_FILE),
        manifest_hash: '',
        manifest: null,
        findings: candidateFindings,
      });
      continue;
    }
    if (!isWithin(rootReal, pluginReal)) {
      add(
        candidateFindings,
        CODES.PATH_INVALID,
        entry.name,
        '插件目录越出插件根',
        '把插件目录放在 <workspace>/plugins/ 下',
      );
    }
    inspectFiles(pluginReal, pluginReal, candidateFindings);

    const manifestPath = join(pluginDir, PLUGIN_MANIFEST_FILE);
    let manifestHash = '';
    let manifest: PluginManifest | null = null;
    if (!existsSync(manifestPath)) {
      add(
        candidateFindings,
        CODES.FIELD_REQUIRED,
        `${entry.name}/${PLUGIN_MANIFEST_FILE}`,
        '插件目录缺少 plugin.json',
        '在插件目录根放置 plugin.json',
      );
    } else {
      let manifestInfo;
      try {
        manifestInfo = lstatSync(manifestPath);
      } catch (error) {
        add(
          candidateFindings,
          CODES.IO_FAILED,
          `${entry.name}/${PLUGIN_MANIFEST_FILE}`,
          `无法读取 manifest：${error instanceof Error ? error.message : String(error)}`,
          '检查文件权限',
        );
        manifestInfo = undefined;
      }
      if (manifestInfo?.isSymbolicLink()) {
        add(
          candidateFindings,
          CODES.PATH_INVALID,
          `${entry.name}/${PLUGIN_MANIFEST_FILE}`,
          'plugin.json 不得是符号链接',
          '使用插件目录内的真实文件',
        );
      } else {
        try {
          const bytes = readFileSync(manifestPath);
          manifestHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          if (bytes.byteLength > PLUGIN_MANIFEST_MAX_BYTES) {
            add(
              candidateFindings,
              CODES.FIELD_LENGTH,
              `${entry.name}/${PLUGIN_MANIFEST_FILE}`,
              `manifest 超过 ${PLUGIN_MANIFEST_MAX_BYTES} 字节上限`,
              '缩小 manifest；资源文件不要写入 manifest',
            );
          } else {
            const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
            const validation = validatePluginManifest(parsed);
            candidateFindings.push(...validation.findings);
            manifest = validation.manifest;
            if (manifest !== null && manifest.plugin_id !== entry.name) {
              add(
                candidateFindings,
                CODES.ID_PLUGIN_INVALID,
                `${entry.name}/plugin_id`,
                `plugin_id ${manifest.plugin_id} 与目录名 ${entry.name} 不一致`,
                '让 plugin.json 的 plugin_id 与目录名一致',
              );
              manifest = null;
            }
          }
        } catch (error) {
          add(
            candidateFindings,
            CODES.FIELD_TYPE,
            `${entry.name}/${PLUGIN_MANIFEST_FILE}`,
            `plugin.json 无法解析：${error instanceof Error ? error.message : String(error)}`,
            '提供合法 JSON 对象',
          );
        }
      }
    }

    if (candidateFindings.some((item) => item.severity === 'error')) manifest = null;
    candidates.push({
      dir: pluginDir,
      plugin_id: entry.name,
      manifest_path: manifestPath,
      manifest_hash: manifestHash,
      manifest,
      findings: candidateFindings,
    });
  }

  return { candidates, findings };
}
