/** 指令注册与路由的稳定类型。 */
import type { ParsedArgs } from '../parsers/index.ts';
import type { Interaction } from '../policy/index.ts';
import type { Result } from '../result/index.ts';

export interface CommandContext {
  args: ParsedArgs;
  /** 当前时间戳，由入口注入以便测试确定化 */
  now: string;
  /** 交互通道，由入口注入；无终端环境下禁止等待输入 */
  interaction: Interaction;
}

export type CommandHandler = (context: CommandContext) => Promise<Result<unknown>>;

export interface CommandSpec {
  name: string;
  handler: CommandHandler;
}
