/**
 * G-02 内核桥接器的传输层。
 *
 * 职责：以子进程方式调用内核的指令入口，按标准输入输出协议读取结构化结果。
 * 边界：本层不认识任何界面框架，也不直接读写工作区文件——GUI 的数据源只有内核输出。
 *
 * 调用形态（AD-09 的独立子进程形态）：
 *   spawn(内核命令, [...内核入口, <指令>, ...参数, '--workspace', <工作区>, '--json'])
 * 参数以数组传递、不经 shell，因此不存在命令注入面；内核自身负责参数与领域校验。
 */
import { spawn } from 'node:child_process';
import { CODES, type Change, type Finding, type Result } from '@skill-manager/contract';

/** 结果封装：与结果规范 2.1 节一致；单一来源在 contract/。 */
export type KernelResult = Result<Record<string, unknown>>;
export type { Change, Finding };

export interface KernelOptions {
  /** 内核启动命令，开发模式为 node，打包后为随包分发的可执行文件 */
  command: string;
  /** 内核入口参数，例如仓库内的 kernel/entry/cli.ts */
  entry: string[];
  /** 工作区根目录，每次调用都以 --workspace 显式给出 */
  workspace: string;
  /** 子进程工作目录 */
  cwd: string;
}

/** 合成一条问题条目，供传输层自身的失败路径使用 */
function channelFinding(message: string, remedy: string): Finding {
  return {
    code: CODES.CHANNEL_FAILED,
    severity: 'error',
    source: 'bridge',
    target: 'kernel',
    message,
    remedy,
  };
}

/**
 * 传输层失败时的合成结果：通道异常问题码 + 通用失败退出码。
 * 内核自身的失败一律以标准结果封装返回，本函数只处理「根本没能拿到结果」的情形。
 */
function channelFailure(command: string, message: string, remedy: string): KernelResult {
  return {
    ok: false,
    command,
    findings: [channelFinding(message, remedy)],
    changes: [],
    exit_code: 1,
  };
}

/**
 * 调用一次内核指令。
 * 内核以非零退出码表达失败，那是正常的业务结果而不是异常，因此照常解析并返回。
 */
export function callKernel(
  options: KernelOptions,
  argv: string[],
): Promise<{ result: KernelResult; stderr: string }> {
  const args = [...options.entry, ...argv, '--workspace', options.workspace, '--json'];
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(options.command, args, { cwd: options.cwd, shell: false });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      resolve({
        result: channelFailure(
          argv[0] ?? '',
          `无法启动内核子进程：${error.message}`,
          '请确认内核入口路径可执行，或检查运行环境是否完整',
        ),
        stderr,
      });
    });
    child.on('close', (code: number | null) => {
      const text = stdout.trim();
      if (text === '') {
        resolve({
          result: channelFailure(
            argv[0] ?? '',
            `内核未返回结构化结果（退出码 ${String(code)}）：${stderr.trim() || '无输出'}`,
            '请检查工作区路径与内核运行环境；该错误不吞掉原始诊断信息',
          ),
          stderr,
        });
        return;
      }
      try {
        resolve({ result: JSON.parse(text) as KernelResult, stderr });
      } catch (error) {
        resolve({
          result: channelFailure(
            argv[0] ?? '',
            `内核输出无法解析：${error instanceof Error ? error.message : String(error)}`,
            '请确认内核版本与界面版本一致；原始输出见诊断日志',
          ),
          stderr: `${stderr}\n${text}`,
        });
      }
    });
  });
}

/** 判断一条结果是否为「需要确认但未给出跳过选项」的拒绝 */
export function isConfirmationRefusal(result: KernelResult): boolean {
  return result.findings.some((item) => item.code === 'E-INPUT-001' && item.target === '--yes');
}

/** 把结果压成一行可读摘要，供视图层与日志使用 */
export function summarize(result: KernelResult): string {
  if (result.ok && result.findings.length === 0 && result.changes.length === 0) {
    return `${result.command}：完成，无变更`;
  }
  const parts: string[] = [
    `${result.command}：${result.ok ? '完成' : `失败（退出码 ${result.exit_code}）`}`,
  ];
  if (result.changes.length > 0) parts.push(`变更 ${result.changes.length} 项`);
  const errors = result.findings.filter((item) => item.severity === 'error');
  const warnings = result.findings.filter((item) => item.severity === 'warning');
  if (errors.length > 0)
    parts.push(`错误 ${errors.length} 项：${errors.map((item) => item.code).join('、')}`);
  if (warnings.length > 0) parts.push(`警告 ${warnings.length} 项`);
  return parts.join('，');
}
