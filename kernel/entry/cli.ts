#!/usr/bin/env node
/**
 * 命令行宿主入口。
 *
 * 职责只有四步：解析参数、组装上下文、调用调度层、渲染输出并按退出码结束。
 * 异常一律在调度层内被转换为结果封装，本文件不再捕获业务异常。
 */
import { dispatch } from '../dispatch/registry/index.ts';
import { parseArgs, flag, option, optionList } from '../dispatch/parsers/index.ts';
import { render } from '../dispatch/render/index.ts';
import { buildResult, exitCodeFor } from '../dispatch/result/index.ts';
import { CODES, finding } from '../store/contract.ts';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import type { Interaction } from '../dispatch/policy/index.ts';

/** 协调世界时秒级时间戳 */
function utcNow(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/**
 * 基于标准输入输出的交互通道。
 * 只有标准输入与标准输出都是终端时才视为可交互；否则禁止等待输入，
 * 由策略层拒绝执行并要求显式给出跳过确认选项，避免脚本挂起。
 */
export function createStdioInteraction(): Interaction {
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    write: (text: string): void => {
      process.stdout.write(text);
    },
    read: (): Promise<string> =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.once('line', (line) => {
          rl.close();
          resolve(line);
        });
      }),
  };
}

export async function run(
  argv: string[],
  interaction: Interaction = createStdioInteraction(),
): Promise<number> {
  const { args, findings } = parseArgs(argv);
  const json = flag(args, 'json');
  const machine = flag(args, 'machine');
  const color = !flag(args, 'no-color');

  if (flag(args, 'version')) {
    process.stdout.write('0.1.0\n');
    return 0;
  }
  if (flag(args, 'help') || args.command === '') {
    process.stdout.write(helpText());
    return findings.length > 0 ? exitCodeFor(findings) : 0;
  }

  if (findings.length > 0) {
    const result = buildResult(args.command, findings);
    process.stdout.write(`${render(result, { json, machine, color })}\n`);
    return result.exit_code;
  }

  const result = await dispatch({ args, now: utcNow(), interaction });
  process.stdout.write(`${render(result, { json, machine, color })}\n`);
  return result.exit_code;
}

function helpText(): string {
  return [
    'skill-manager 0.1.0',
    '',
    '用法：skill-manager <指令> [选项]',
    '',
    '一期可用指令：',
    '  init                    在工作区建立索引与标准目录，重复执行幂等',
    '  config get              读取当前配置区的全部内容，不做推导也不补默认值',
    '  scan                    扫描 Skill 根目录并生成或更新索引',
    '  list                    列出已管理的 Skill，可按状态、来源与目标过滤',
    '  inspect <标识>          查看单个 Skill 的完整元信息与内容指纹比对结论',
    '  install <来源>          从本地目录或元文件安装 Skill，写入中心库并登记索引',
    '  uninstall <标识>        卸载 Skill；默认保留中心库原件，--hard 时一并删除',
    '  validate [路径或标识]   只读校验元数据、配置与索引；省略对象时校验整个环境',
    '  deps <标识>             检查该 Skill 的依赖是否满足，并给出受影响的对象',
    '  export <路径>           把索引状态导出为一份备份文件，路径相对工作区根',
    '',
    '通用选项：',
    '  --workspace <路径>      指定工作区根目录，覆盖环境变量',
    '  --root <路径>           覆盖索引中声明的 Skill 根目录，可重复',
    '  --dry-run               预演，返回将要发生的变更，不写入任何文件',
    '  --hard                  卸载时连同中心库原件一并删除',
    '  --keep-library          卸载时保留中心库原件（默认行为，供显式声明）',
    '  --library-only          安装时只写入中心库与登记记录，不分发到目标位置',
    '  --strict                校验时把警告级问题也视为失败',
    '  --yes                   跳过确认；非交互环境下需要确认的指令必须显式给出',
    '  --json                  输出机器可读结构',
    '  --machine               输出制表符分隔的扁平结构',
    '  --no-color              关闭人类可读输出的着色',
    '  --version               输出版本',
    '  --help                  输出本帮助',
  ].join('\n');
}

/**
 * 是否作为入口被直接执行。
 * 必须与 argv[1] 的实际路径比较：只判断模块名会被「被其他模块导入」误判为入口。
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  try {
    return pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}

export { CODES, finding, option, optionList };
