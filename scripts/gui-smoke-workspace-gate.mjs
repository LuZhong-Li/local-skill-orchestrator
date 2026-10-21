/** 等待 GUI init 真正建立工作区索引；失败时保留可用于定位的原始证据。 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REQUIRED_WORKSPACE_FILES = ['skill_index.yaml', 'plugin_index.yaml', 'host_landings.yaml'];
const WORKSPACE_GATE_INTERVAL_MS = 2_000;
const WORKSPACE_GATE_TIMEOUT_MS = 90_000;

export async function installBrowserProblemCapture(evaluate) {
  await evaluate(`(() => {
    globalThis.__skillManagerSmokeProblems = [];
    const record = (kind, values) => {
      globalThis.__skillManagerSmokeProblems.push({
        kind,
        values: values.map((value) => {
          if (value instanceof Error) return value.stack ?? value.message;
          if (typeof value === 'string') return value;
          try { return JSON.stringify(value); } catch { return String(value); }
        }),
      });
    };
    addEventListener('error', (event) => {
      record('exception', [event.error ?? event.message]);
    });
    addEventListener('unhandledrejection', (event) => {
      record('unhandledrejection', [event.reason]);
    });
    const originalError = console.error.bind(console);
    console.error = (...values) => {
      record('console.error', values);
      originalError(...values);
    };
  })()`);
}

function workspaceListing(root) {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length === 0) return '(空目录)';
    return entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort()
      .join('\n');
  } catch (error) {
    return `<无法读取：${error instanceof Error ? error.message : String(error)}>`;
  }
}

export async function waitForWorkspaceInit({ workspace, evaluate, stderr }) {
  const deadline = Date.now() + WORKSPACE_GATE_TIMEOUT_MS;
  while (!REQUIRED_WORKSPACE_FILES.every((name) => existsSync(join(workspace, name)))) {
    if (Date.now() >= deadline) {
      let browserProblems = '(无法读取)';
      try {
        browserProblems = await evaluate(
          'JSON.stringify(globalThis.__skillManagerSmokeProblems ?? [])',
        );
      } catch (error) {
        browserProblems = `<读取失败：${error instanceof Error ? error.message : String(error)}>`;
      }
      throw new Error(
        [
          'GUI init 未在时限内建立工作区索引',
          `workspace: ${resolve(workspace)}`,
          `需要文件: ${REQUIRED_WORKSPACE_FILES.join(', ')}`,
          '实际目录:',
          workspaceListing(workspace),
          `console/exception: ${String(browserProblems)}`,
          `kernel stderr: ${stderr.trim() || '(无)'}`,
        ].join('\n'),
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, WORKSPACE_GATE_INTERVAL_MS));
  }
}
