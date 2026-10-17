/**
 * K-17 插件宿主视图与落位计划。
 *
 * 插件宿主只在启用并校验通过后进入合并视图；渲染复用共用渲染核心的
 * skill / rules / entry 三种形态，不写 FORM_BY_HOST，不执行第三方代码。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { isWithin } from '../../store/paths/index.ts';
import { stringifyYaml } from '../../store/yaml/index.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import type { HostEntry } from '../hosts/types.ts';
import type { ArtifactFile, RenderSource } from '../render/types.ts';
import { renderWithPolicy } from '../render/index.ts';
import { buildHostCatalog } from './catalog.ts';
import { canonicalHostId, validatePluginManifest } from './manifest.ts';
import type {
  HostCatalogView,
  PluginCatalogEntry,
  PluginIndex,
  PluginLanding,
  PluginManifest,
  PluginRecord,
} from './types.ts';
import { loadPluginIndex } from '../../store/plugin-registry/index.ts';

export interface LoadedPluginCatalog {
  index: PluginIndex;
  entries: PluginCatalogEntry[];
  view: HostCatalogView;
  findings: Finding[];
}

export interface PluginHostPlan {
  hostId: string;
  hostKey: string;
  pluginId: string;
  record: PluginRecord;
  catalog: LoadedPluginCatalog;
  form: 'skill' | 'rules' | 'entry';
  plan: import('../adapters/types.ts').PlacementPlan;
  resolution: import('../adapters/roots.ts').HostRootResolution;
}

function add(
  findings: Finding[],
  code: string,
  target: string,
  message: string,
  remedy: string,
): void {
  findings.push(finding(code, { source: 'plugin-host', target, message, remedy }));
}

function readManifestForRecord(
  layout: WorkspaceLayout,
  record: PluginRecord,
  toolVersion: string | undefined,
): { manifest: PluginManifest | null; findings: Finding[] } {
  const findings: Finding[] = [];
  const path = resolve(layout.root, record.manifest_path);
  if (!isWithin(layout.root, path)) {
    add(
      findings,
      CODES.PATH_INVALID,
      record.manifest_path,
      '插件 manifest 越出工作区',
      '重新安装插件并修正 manifest_path',
    );
    return { manifest: null, findings };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    add(
      findings,
      CODES.ENV_INCOMPLETE,
      path,
      `插件包缺失或不可读：${error instanceof Error ? error.message : String(error)}`,
      '执行 scan --kind plugin 检查，或重新安装插件',
    );
    return { manifest: null, findings };
  }
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (hash !== record.manifest_hash) {
    add(
      findings,
      CODES.HASH_FORMAT,
      record.id,
      `插件 manifest 哈希与登记不一致：${hash}`,
      '重新扫描并确认插件包未被修改；必要时重新安装',
    );
    return { manifest: null, findings };
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    const validated = validatePluginManifest(
      parsed,
      toolVersion === undefined ? {} : { toolVersion },
    );
    findings.push(...validated.findings);
    if (validated.manifest !== null && validated.manifest.plugin_id !== record.id) {
      add(
        findings,
        CODES.ID_PLUGIN_INVALID,
        record.id,
        `plugin_id ${validated.manifest.plugin_id} 与登记标识不一致`,
        '重新安装插件并修正标识',
      );
      return { manifest: null, findings };
    }
    return validated.manifest === null
      ? { manifest: null, findings }
      : { manifest: validated.manifest, findings };
  } catch (error) {
    add(
      findings,
      CODES.FIELD_TYPE,
      record.manifest_path,
      `插件 manifest 无法解析：${error instanceof Error ? error.message : String(error)}`,
      '提供合法 JSON 对象',
    );
    return { manifest: null, findings };
  }
}

/** 读取插件索引与 manifest，产出可合并视图；不写盘。 */
export function loadPluginCatalog(input: {
  layout: WorkspaceLayout;
  builtins: readonly HostEntry[];
  toolVersion?: string;
}): LoadedPluginCatalog {
  const loaded = loadPluginIndex(input.layout.pluginIndexFile);
  const findings = [...loaded.findings];
  const index =
    loaded.index ??
    ({
      schema_version: '1',
      tool_version: input.toolVersion ?? '0.0.0',
      generated_at: '',
      config: {},
      plugins: [],
      landings: [],
    } satisfies PluginIndex);
  const entries: PluginCatalogEntry[] = [];
  for (const record of index.plugins) {
    const read = readManifestForRecord(input.layout, record, input.toolVersion);
    entries.push({ record, manifest: read.manifest, findings: read.findings });
    findings.push(...read.findings);
  }
  const view = buildHostCatalog({ builtins: input.builtins, entries });
  findings.push(...view.findings);
  return { index, entries, view, findings };
}

/** `--host` 的插件候选值（仅启用且可用的 canonical 宿主）。 */
export function pluginHostIds(catalog: LoadedPluginCatalog): string[] {
  return catalog.view.pluginHosts.map((host) => host.host_id);
}

function renderRule(source: RenderSource): { artifact: ArtifactFile; findings: Finding[] } {
  const findings: Finding[] = [];
  const description = source.description?.trim() ?? '';
  if (description === '') {
    findings.push(
      finding(CODES.FIELD_REQUIRED, {
        source: 'plugin-host',
        target: `${source.id}:description`,
        message: '规则形态需要 description',
        remedy: '在 Skill 元数据中补齐 description',
      }),
    );
  }
  const front: Record<string, unknown> = { alwaysApply: false };
  if (description !== '') front['description'] = description;
  const body = (source.body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return {
    artifact: {
      kind: 'rule_file',
      path: `${source.id}.md`,
      content: `---\n${stringifyYaml(front)}---\n\n${body === '' ? '' : `${body}\n`}`,
    },
    findings,
  };
}

/**
 * 构造插件 host profile 的落位计划。
 * 这里只解析路径与渲染内容，不写盘；写盘统一由 landPlan 执行。
 */
export function buildPluginHostPlan(input: {
  layout: WorkspaceLayout;
  catalog: LoadedPluginCatalog;
  hostId: string;
  source: RenderSource;
}): { plan?: PluginHostPlan; findings: Finding[] } {
  const findings: Finding[] = [];
  const host = input.catalog.view.pluginHosts.find((item) => item.host_id === input.hostId);
  if (host === undefined) {
    add(
      findings,
      CODES.INPUT_INVALID_ARG,
      '--host',
      `插件宿主不可用：${input.hostId}`,
      '确认插件已安装并处于 enabled 状态；可用 list --kind plugin 查看',
    );
    return { findings };
  }
  // 必须找到真正贡献该 host 的插件；不能按第一个启用插件猜测。
  const owner = input.catalog.entries.find(
    (item) =>
      item.record.state === 'enabled' &&
      item.manifest !== null &&
      item.manifest.hosts.some(
        (profile) => canonicalHostId(item.record.id, profile.host_key) === input.hostId,
      ),
  );
  const profile = owner?.manifest?.hosts.find(
    (item) => canonicalHostId(owner.record.id, item.host_key) === input.hostId,
  );
  if (owner === undefined || owner.manifest === null || profile === undefined) {
    add(
      findings,
      CODES.INPUT_INVALID_ARG,
      '--host',
      `没有可用的插件宿主定义：${input.hostId}`,
      '重新启用提供该宿主的插件',
    );
    return { findings };
  }
  const root = profile.roots.find((item) =>
    profile.form === 'skill' ? item.kind === 'skill' : item.kind === 'rules',
  );
  if (root === undefined) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${owner.record.id}:${profile.host_key}`,
      '插件 profile 没有与形态匹配的落位根',
      '修正 manifest 的 roots 与 form',
    );
    return { findings };
  }

  const template = root.path_template.split('<skill_id>').join(input.source.id);
  let rootPath: string;
  let external = false;
  if (root.scope === 'project') {
    rootPath = resolve(input.layout.root, template);
  } else {
    const key = `plugin.${owner.record.id}.${profile.host_key}.${
      root.kind === 'rules' ? 'rules_root' : 'root'
    }`;
    const configured = input.catalog.index.config[key];
    if (typeof configured !== 'string' || configured.trim() === '') {
      add(
        findings,
        CODES.INPUT_INVALID_ARG,
        key,
        `插件宿主缺少显式 global 根配置：${key}`,
        `执行 config set ${key} <路径>`,
      );
      return { findings };
    }
    const base = isAbsolute(configured) ? configured : resolve(input.layout.root, configured);
    rootPath = resolve(base, template);
    external = !isWithin(input.layout.root, rootPath);
  }

  const policy = profile.render_policy;
  const renderPolicy = { host_id: input.hostId, ...policy };
  let artifact: ArtifactFile | undefined;
  if (profile.form === 'skill') {
    const rendered = renderWithPolicy('skill', renderPolicy, input.source);
    findings.push(...rendered.findings);
    artifact = rendered.files.find((file) => file.kind === 'skill_md');
  } else if (profile.form === 'entry') {
    const rendered = renderWithPolicy('entry', renderPolicy, input.source);
    findings.push(...rendered.findings);
    artifact = rendered.files.find((file) => file.kind === 'agents_md_fragment');
  } else {
    const rendered = renderRule(input.source);
    findings.push(...rendered.findings);
    artifact = rendered.artifact;
  }
  if (artifact === undefined) {
    add(
      findings,
      CODES.FIELD_INVALID_VALUE,
      `${owner.record.id}:${profile.host_key}`,
      '渲染未产生可用于该形态的产物',
      '检查 Skill 元数据与插件 profile',
    );
    return { findings };
  }

  const targetPath =
    profile.form === 'rules' || profile.form === 'entry' ? rootPath : join(rootPath, artifact.path);
  const landable = profile.form !== 'entry';
  const placement: import('../adapters/types.ts').PlacementEntry = {
    artifact_kind: artifact.kind,
    root_path: profile.form === 'rules' ? dirname(targetPath) : rootPath,
    target_path: targetPath,
    file_name: profile.form === 'rules' ? artifact.path : artifact.path,
    root_kind: profile.form === 'skill' ? 'skill' : 'rules',
    external,
    landable,
    consumed_by: [input.hostId],
    content: artifact.content,
    ...(landable ? {} : { hold_reason: '插件指令文件形态只产出片段，不落盘' }),
  };
  const plan: import('../adapters/types.ts').PlacementPlan = {
    host_id: input.hostId,
    target_id: input.hostId,
    skill_id: input.source.id,
    form: profile.form,
    degraded: false,
    capability_gaps:
      profile.form === 'skill' ? [] : ['auto_discovery', 'progressive_loading', 'tool_preapproval'],
    entries: [placement],
    overlaps: [],
    findings,
  };
  return {
    plan: {
      hostId: input.hostId,
      hostKey: profile.host_key,
      pluginId: owner.record.id,
      record: owner.record,
      catalog: input.catalog,
      form: profile.form,
      plan,
      resolution: {
        host_id: input.hostId,
        root_kind: profile.form === 'skill' ? 'skill' : 'rules',
        path: rootPath,
        source: 'config',
        external,
        exists: existsSync(rootPath),
        findings: [],
      },
    },
    findings,
  };
}

/** 把一次成功落位写入插件账本；保留首次创建时间，重复落位更新时间与路径。 */
export function upsertPluginLanding(
  index: PluginIndex,
  input: {
    pluginId: string;
    skillId: string;
    hostId: string;
    hostKey: string;
    targetPath: string;
    now: string;
  },
): PluginIndex {
  const landings = [...index.landings];
  const existing = landings.findIndex(
    (item) =>
      item.plugin_id === input.pluginId &&
      item.skill_id === input.skillId &&
      item.host_id === input.hostId,
  );
  const value: PluginLanding = {
    plugin_id: input.pluginId,
    skill_id: input.skillId,
    host_id: input.hostId,
    host_key: input.hostKey,
    target_path: input.targetPath,
    state: 'active',
    created_at: existing >= 0 ? (landings[existing] as PluginLanding).created_at : input.now,
    updated_at: input.now,
  };
  if (existing >= 0) landings[existing] = value;
  else landings.push(value);
  return { ...index, landings };
}

/** 插件卸载时保留账本并把该插件的副本标为 orphaned。 */
export function orphanPluginLandings(
  index: PluginIndex,
  pluginId: string,
  now: string,
): { index: PluginIndex; orphaned: PluginLanding[] } {
  const orphaned: PluginLanding[] = [];
  const landings = index.landings.map((item) => {
    if (item.plugin_id !== pluginId) return item;
    const value = { ...item, state: 'orphaned' as const, updated_at: now };
    orphaned.push(value);
    return value;
  });
  return { index: { ...index, landings }, orphaned };
}
