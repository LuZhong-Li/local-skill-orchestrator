/** init 指令处理器。 */
import { existsSync } from 'node:fs';
import { createInitialIndex, saveIndex, TOOL_VERSION } from '../../../core/index/index.ts';
import { createInitialPluginIndex, savePluginIndex } from '../../../store/plugin-registry/index.ts';
import { createInitialHostLandings, saveHostLandings } from '../../../store/host-landings/index.ts';
import { ensureWorkspaceDirs, layoutOf } from '../../../store/workspace/index.ts';
import { withLock } from '../../../store/locking/index.ts';
import { toKernelError } from '../../../store/errors.ts';
import { CODES, finding } from '../../../store/contract.ts';
import { buildResult, type Change } from '../../result/index.ts';
import { workspaceRootOf } from '../../shared/options.ts';
import type { CommandHandler } from '../types.ts';
export const initHandler: CommandHandler = async ({ args, now }) => {
  const layout = layoutOf(workspaceRootOf(args));
  const changes: Change[] = [];
  try {
    const existed = existsSync(layout.indexFile);
    ensureWorkspaceDirs(layout);
    let pluginIndexCreated = false;
    if (!existsSync(layout.pluginIndexFile)) {
      savePluginIndex(layout.pluginIndexFile, createInitialPluginIndex(now, TOOL_VERSION));
      pluginIndexCreated = true;
      changes.push({ action: 'add', kind: 'plugin_index', path: layout.pluginIndexFile });
    }
    let hostLandingsCreated = false;
    if (!existsSync(layout.hostLandingsFile)) {
      saveHostLandings(layout.hostLandingsFile, createInitialHostLandings(now, TOOL_VERSION));
      hostLandingsCreated = true;
      changes.push({ action: 'add', kind: 'host_landings', path: layout.hostLandingsFile });
    }
    if (existed) {
      // 幂等：工作区已存在时不覆盖既有索引与配置
      return buildResult('init', [], changes, {
        data: {
          root: layout.root,
          index: layout.indexFile,
          plugin_index: layout.pluginIndexFile,
          host_landings: layout.hostLandingsFile,
          created: false,
          plugin_index_created: pluginIndexCreated,
          host_landings_created: hostLandingsCreated,
          tool_version: TOOL_VERSION,
        },
      });
    }
    const index = createInitialIndex(now);
    await withLock(layout.indexFile, () => {
      saveIndex(layout.indexFile, index);
    });
    changes.push({ action: 'add', kind: 'index', path: layout.indexFile });
    return buildResult('init', [], changes, {
      data: {
        root: layout.root,
        index: layout.indexFile,
        plugin_index: layout.pluginIndexFile,
        host_landings: layout.hostLandingsFile,
        created: true,
        plugin_index_created: pluginIndexCreated,
        host_landings_created: hostLandingsCreated,
        tool_version: TOOL_VERSION,
      },
    });
  } catch (error) {
    const kernelError = toKernelError(error, CODES.IO_FAILED);
    return buildResult('init', [
      finding(kernelError.code, {
        source: kernelError.source,
        target: kernelError.target,
        message: kernelError.message,
        remedy: kernelError.remedy,
      }),
    ]);
  }
};
