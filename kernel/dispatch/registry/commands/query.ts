/** list / inspect / config get / deps / export 处理器。 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectSkill, listSkills, readConfig, toListEntry } from '../../../core/index/query.ts';
import { analyzeDependencies, splitDeclaration } from '../../../core/dependency/index.ts';
import { probeRuntimes } from '../../../core/dependency/runtime.ts';
import { exportIndex } from '../../../core/backup/index.ts';
import { loadPluginIndex } from '../../../store/plugin-registry/index.ts';
import { declaredRuntimeOf, declaredSkillsOf, readMetaFile } from '../../../core/metadata/read.ts';
import { layoutOf } from '../../../store/workspace/index.ts';
import { CODES } from '@skill-manager/contract';
import { finding } from '../../../store/findings.ts';
import { buildResult } from '../../result/index.ts';
import { flag, option } from '../../parsers/index.ts';
import { pluginKind, workspaceRootOf } from '../../shared/options.ts';
import type { CommandHandler } from '../types.ts';
import { loadForRead } from '../shared.ts';
import { pluginInspectCommand, pluginListCommand } from './plugin-query.ts';
export const listHandler: CommandHandler = async ({ args }) => {
  if (pluginKind(args)) {
    return pluginListCommand({ args });
  }
  const layout = layoutOf(workspaceRootOf(args));
  const { index, findings, initialized } = loadForRead(layout);
  const state = option(args, 'state');
  const source = option(args, 'source');
  const target = option(args, 'target');
  const outcome = listSkills({
    index,
    filter: {
      ...(state !== undefined ? { state } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(target !== undefined ? { target } : {}),
    },
  });
  const merged = [...findings, ...outcome.findings];
  // 契约 4.5 前置条件：索引不存在时返回引导性结果而非错误
  if (outcome.summary === null) {
    const guide =
      merged.length > 0
        ? '索引无法读取，请先修复或重建索引'
        : '工作区尚未初始化，请先执行 init 建立工作区';
    return buildResult('list', merged, [], {
      data: { initialized, total: 0, filtered: 0, records: [], guide },
    });
  }
  return buildResult('list', merged, [], {
    data: {
      initialized,
      total: outcome.summary.total,
      filtered: outcome.summary.filtered,
      by_state: outcome.summary.by_state,
      by_validation: outcome.summary.by_validation,
      records: outcome.summary.records.map(toListEntry),
    },
  });
};
export const inspectHandler: CommandHandler = async ({ args }) => {
  if (pluginKind(args)) {
    return pluginInspectCommand({ args });
  }
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('inspect', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'inspect 需要给出 Skill 标识',
        remedy: '请提供要查看的 Skill 标识',
      }),
    ]);
  }
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('inspect', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }
  const outcome = inspectSkill({ layout, index, id });
  return buildResult('inspect', [...findings, ...outcome.findings], [], { data: outcome.data });
};
export const configGetHandler: CommandHandler = async ({ args }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('config get', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取，读不到配置区',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }
  const pluginLoaded = existsSync(layout.pluginIndexFile)
    ? loadPluginIndex(layout.pluginIndexFile)
    : { index: null, findings: [] };
  return buildResult('config get', [...findings, ...pluginLoaded.findings], [], {
    data: {
      ...readConfig(index),
      plugin_config: pluginLoaded.index?.config ?? {},
    },
  });
};
export const depsHandler: CommandHandler = async ({ args }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const id = args.positionals[0];
  if (id === undefined || id === '') {
    return buildResult('deps', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'id',
        message: 'deps 需要给出 Skill 标识',
        remedy: '请提供要检查依赖的 Skill 标识',
      }),
    ]);
  }
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('deps', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }
  const record = index.skills.find((item) => item.id === id);
  if (record === undefined) {
    return buildResult('deps', [
      ...findings,
      finding(CODES.INPUT_INVALID_ARG, {
        source: 'input',
        target: id,
        message: `标识 ${id} 不在索引中`,
        remedy: '请先用列表指令确认该 Skill 是否已登记',
      }),
    ]);
  }
  // 依赖声明以元文件为准，读取失败时退回索引内的依赖摘要
  const metaRead = readMetaFile(join(layout.skillsDir, id), id);
  const declaredFromMeta = declaredSkillsOf(metaRead.raw);
  const declared = declaredFromMeta ?? record.dependencies ?? [];
  const availability = new Map(
    index.skills.map((item) => [item.id, item.validation.status === 'ok']),
  );
  const edges = new Map(
    index.skills.map((item) => [
      item.id,
      (item.dependencies ?? []).map((text) => splitDeclaration(text).name),
    ]),
  );
  const report = analyzeDependencies({ id, declared, availability, edges });
  // 运行时维度：实时探测环境，结果只入载荷与报告，不写入索引与运行期结论
  const runtime = await probeRuntimes(declaredRuntimeOf(metaRead.raw));
  const all = [...findings, ...metaRead.findings, ...report.findings, ...runtime.findings];
  const result = buildResult('deps', all, [], {
    data: {
      id,
      declared_from: declaredFromMeta === null ? 'index' : 'meta',
      entries: report.entries,
      runtime: runtime.entries,
      runtime_probed: runtime.entries.length > 0,
      affected: report.affected,
      cycles: report.cycles,
      ...(flag(args, 'tree') ? { tree: dependencyTreeOf(id, edges, availability) } : {}),
    },
  });
  /**
   * 契约 4.13 规定「存在未满足的依赖时返回 6」，这是本指令的专属规定，
   * 按结果规范 5.2 的专属优先条款覆盖通用派生——通用派生只把 DEP 类别映射到 6，
   * 而「被依赖对象校验不通过」按 4.4 的对照表是校验类问题码，需要在这里一并归入未满足。
   * 运行时类（`E-RUN-*`）已由通用派生归入依赖档，无需在此重复列出。
   */
  const unmet = all.some(
    (item) =>
      item.severity === 'error' &&
      ['E-DEP-001', 'E-DEP-002', 'E-DEP-003', CODES.VALIDATION_DEPENDENCY].includes(item.code),
  );
  if (unmet && result.exit_code !== 2) {
    result.exit_code = 6;
    result.ok = false;
  }
  return result;
};
export const exportHandler: CommandHandler = async ({ args, now }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const target = args.positionals[0];
  if (target === undefined || target === '') {
    return buildResult('export', [
      finding(CODES.INPUT_MISSING_ARG, {
        source: 'input',
        target: 'path',
        message: 'export 需要给出目标文件路径',
        remedy: '请提供工作区之内的相对路径，例如 backups/export.yaml',
      }),
    ]);
  }
  const { index, findings } = loadForRead(layout);
  if (index === null) {
    return buildResult('export', [
      ...findings,
      finding(CODES.ENV_NOT_INITIALIZED, {
        source: 'workspace',
        target: layout.root,
        message: '工作区尚未初始化或索引无法读取，没有可导出的内容',
        remedy: '请先执行 init 建立工作区，或修复索引文件',
      }),
    ]);
  }
  const outcome = exportIndex({
    layout,
    index,
    target,
    now,
    noConfig: flag(args, 'no-config'),
    noSecrets: flag(args, 'no-secrets'),
  });
  return buildResult('export', [...findings, ...outcome.findings], [], { data: outcome.data });
};
/**
 * 依赖树：按 `--tree` 展开该标识的依赖层级。
 * 只呈现已登记的依赖关系，遇到环或已展开的节点即止，避免无限递归。
 */
function dependencyTreeOf(
  id: string,
  edges: Map<string, string[]>,
  availability: Map<string, boolean>,
): Record<string, unknown> {
  const expand = (name: string, seen: string[]): Record<string, unknown> => {
    const verdict = !availability.has(name) ? 'missing' : availability.get(name) ? 'ok' : 'invalid';
    const children = seen.includes(name)
      ? []
      : (edges.get(name) ?? []).map((child) => expand(child, [...seen, name]));
    return { name, status: verdict, children };
  };
  return expand(id, []);
}
