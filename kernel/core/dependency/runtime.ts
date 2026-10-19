/**
 * K-06 的运行时维度：外部运行时的可用性探测与版本比较。
 *
 * 边界（本模块最重要的约束）：
 *   探测结果是**环境相关数据**，不写入索引、不写入运行期结论——索引保持环境无关，
 *   同一份索引在不同机器上读取时含义一致（元数据规范 3.3 与 5.3）。
 *   因此「运行时缺失」不会把一条内容完好的 Skill 判为校验不通过：本模块只服务
 *   依赖检查指令的实时呈现，不参与 scan 与 validate 的记录结论。
 *
 * 探测方式：按平台解析可执行文件（POSIX 用 `command -v`，Windows 用 `where`），
 * 再执行其 `--version` 并把输出解析为语义化版本，按声明的范围表达式判定。
 * 命令一律以参数数组调用、不经 shell，运行时名称只作为参数传递，不作为命令文本拼接。
 * PATH 可注入，便于在测试中完全脱离真实外部运行时。
 */
import { spawn } from 'node:child_process';
import semver from 'semver';
import { CODES, type Finding } from '@skill-manager/contract';
import { finding } from '../../store/findings.ts';
import type { SkillRuntimeDependency } from '../metadata/types.ts';

/** 探测结论：可用性、版本判定与各类失败 */
export const RUNTIME_STATUS_VALUES = [
  'ok',
  'missing',
  'version_unsatisfied',
  'version_unparsable',
  'invalid_constraint',
  'probe_failed',
] as const;

export type RuntimeStatus = (typeof RUNTIME_STATUS_VALUES)[number];

/** 元文件声明的一条运行时依赖；类型定义在 K-01，避免依赖方向倒置 */
export type RuntimeDeclaration = SkillRuntimeDependency;

export interface RuntimeProbe {
  /** 运行时名称，取自元文件声明区的键 */
  name: string;
  /** 元文件里声明的约束原文，原样呈现 */
  constraint: string;
  status: RuntimeStatus;
  /** 探测到的语义化版本；未解析成功时为 null */
  version: string | null;
  /** 命中命令的可执行文件路径；未命中时为 null */
  command: string | null;
  /** 面向调用方的结论文案 */
  conclusion: string;
}

export interface ProbeCommandResult {
  /** 退出码；无法启动或超时被杀时为 null */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 子进程执行器：可注入，测试用它完全替代真实探测 */
export type ProbeRunner = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<ProbeCommandResult>;

export interface ProbeOptions {
  /** 注入的 PATH；省略时沿用进程环境。测试用它注入假命令目录 */
  pathEnv?: string | undefined;
  /** 注入的平台；默认取 process.platform，用于选择探测命令 */
  platform?: NodeJS.Platform | undefined;
  /** 单次探测的超时上限，默认 5 秒 */
  timeoutMs?: number | undefined;
  /** 注入的执行器；默认是真子进程 */
  runner?: ProbeRunner | undefined;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** 默认执行器：spawn，不经 shell，超时即杀 */
function makeRunner(timeoutMs: number): ProbeRunner {
  return (command, args, env) =>
    new Promise<ProbeCommandResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawn(command, args, { shell: false, env: env as NodeJS.ProcessEnv });
      } catch {
        // 参数本身无法启动进程时也按「探测失败」上报，不向上抛异常
        resolve({ code: null, stdout, stderr, timedOut: false });
        return;
      }
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedOut: false });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut: child.killed });
      });
    });
}

/**
 * 探测一条运行时声明。
 *
 * 判定顺序即失败优先级：约束是否可解析 → 命令是否存在 → `--version` 是否可解析 → 版本是否满足。
 * 约束非法时不再探测：拿一个非法约束去比版本没有意义，也不该把结论说成「版本不满足」。
 */
export async function probeRuntime(
  declaration: RuntimeDeclaration,
  options: ProbeOptions = {},
): Promise<{ probe: RuntimeProbe; findings: Finding[] }> {
  const { name, constraint } = declaration;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? makeRunner(timeoutMs);
  const env: Record<string, string | undefined> = { ...process.env };
  if (options.pathEnv !== undefined) env['PATH'] = options.pathEnv;

  if (semver.validRange(constraint) === null) {
    return {
      probe: {
        name,
        constraint,
        status: 'invalid_constraint',
        version: null,
        command: null,
        conclusion: `版本约束不是合法的语义化版本范围：${constraint}`,
      },
      findings: [
        finding(CODES.RUN_CONSTRAINT_INVALID, {
          source: 'dependency',
          target: name,
          message: `运行时 ${name} 的版本约束不是合法的语义化版本范围：${constraint}`,
          remedy: '请改用语义化版本范围写法，例如 >=1.2.3、^1.2.3、~1.2.3 或 1.2.x',
        }),
      ],
    };
  }

  const resolved = await resolveCommand(name, platform, runner, env);
  if (resolved.timedOut) {
    return probeFailed(
      name,
      constraint,
      `${probeCommandOf(platform)} 超时（上限 ${timeoutMs} 毫秒）`,
    );
  }
  if (resolved.code === null) {
    return probeFailed(name, constraint, `无法执行探测命令：${probeCommandOf(platform)}`);
  }
  const command = resolved.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (resolved.code !== 0 || command === undefined) {
    return {
      probe: {
        name,
        constraint,
        status: 'missing',
        version: null,
        command: null,
        conclusion: `运行环境中未找到该运行时（按 ${probeCommandOf(platform)} 解析）`,
      },
      findings: [
        finding(CODES.RUN_MISSING, {
          source: 'dependency',
          target: name,
          message: `声明的外部运行时不可用：${name}`,
          remedy: `请先安装 ${name} 并确保它在 PATH 中；或用 --tree 查看该 Skill 的完整依赖关系`,
        }),
      ],
    };
  }

  const versionOutput = await runner(command, ['--version'], env);
  if (versionOutput.timedOut) {
    return probeFailed(
      name,
      constraint,
      `${name} --version 超时（上限 ${timeoutMs} 毫秒）`,
      command,
    );
  }
  if (versionOutput.code === null) {
    return probeFailed(name, constraint, `无法执行 ${name} --version`, command);
  }

  const version = parseVersionOutput(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (version === null) {
    return {
      probe: {
        name,
        constraint,
        status: 'version_unparsable',
        version: null,
        command,
        conclusion: `${name} 的 --version 输出中解析不出语义化版本`,
      },
      findings: [
        finding(CODES.RUN_VERSION_UNPARSABLE, {
          source: 'dependency',
          target: name,
          message: `无法从运行时 ${name} 的 --version 输出中解析出版本号：${describeOutput(versionOutput)}`,
          remedy:
            '请确认该命令是否支持 --version；若输出了自定义格式，请把版本约束改为与实际情况一致的写法',
        }),
      ],
    };
  }

  if (!semver.satisfies(version, constraint, { includePrerelease: true })) {
    return {
      probe: {
        name,
        constraint,
        status: 'version_unsatisfied',
        version,
        command,
        conclusion: `版本不满足：实际 ${version}，要求 ${constraint}`,
      },
      findings: [
        finding(CODES.RUN_VERSION_UNSATISFIED, {
          source: 'dependency',
          target: name,
          message: `外部运行时 ${name} 的版本不满足约束：实际 ${version}，要求 ${constraint}`,
          remedy: `请升级 ${name} 至满足 ${constraint} 的版本，或放宽元文件中的约束`,
        }),
      ],
    };
  }

  return {
    probe: {
      name,
      constraint,
      status: 'ok',
      version,
      command,
      conclusion: `版本满足：实际 ${version}，要求 ${constraint}`,
    },
    findings: [],
  };
}

/** 依次探测多条运行时声明，顺序与声明顺序一致 */
export async function probeRuntimes(
  declarations: RuntimeDeclaration[],
  options: ProbeOptions = {},
): Promise<{ entries: RuntimeProbe[]; findings: Finding[] }> {
  const entries: RuntimeProbe[] = [];
  const findings: Finding[] = [];
  for (const declaration of declarations) {
    const outcome = await probeRuntime(declaration, options);
    entries.push(outcome.probe);
    findings.push(...outcome.findings);
  }
  return { entries, findings };
}

/**
 * 从 `--version` 的输出中解析语义化版本。
 *
 * 各运行时的写法五花八门（`v22.1.0`、`git version 2.43.0`、`Python 3.12.1`），
 * 因此取输出中第一个形如版本号的片段；解析不出时返回 null，由调用方按
 * 「版本无法解析」报错——绝不猜测、绝不把 0.0.0 当作真实版本。
 */
export function parseVersionOutput(output: string): string | null {
  const coerced = semver.coerce(output, { includePrerelease: true });
  if (coerced === null) return null;
  const version = coerced.version;
  return semver.valid(version) === null ? null : version;
}

/** 按平台选择命令解析方式；PATH 通过环境注入，名称只作为参数传递 */
async function resolveCommand(
  name: string,
  platform: NodeJS.Platform,
  runner: ProbeRunner,
  env: Record<string, string | undefined>,
): Promise<ProbeCommandResult> {
  if (platform === 'win32') return runner('where', [name], env);
  // `command -v` 是 shell 内建命令，必须经 shell 执行；名称以位置参数传入，不做文本拼接
  return runner('sh', ['-c', 'command -v "$1"', 'sh', name], env);
}

function probeCommandOf(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'where' : 'command -v';
}

function probeFailed(
  name: string,
  constraint: string,
  detail: string,
  command: string | null = null,
): { probe: RuntimeProbe; findings: Finding[] } {
  return {
    probe: { name, constraint, status: 'probe_failed', version: null, command, conclusion: detail },
    findings: [
      finding(CODES.RUN_PROBE_FAILED, {
        source: 'dependency',
        target: name,
        message: `运行时 ${name} 的探测失败：${detail}`,
        remedy: '请确认该运行时可执行且能在 PATH 中解析；探测只读，不会改动任何文件',
      }),
    ],
  };
}

function describeOutput(result: ProbeCommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).join(' ').trim();
  if (text === '') return `（退出码 ${String(result.code)}，无输出）`;
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
