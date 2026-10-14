/**
 * 内核对外接口。
 *
 * 只暴露指令调度层的入口与结果类型，界面与命令行都经由这里调用内核；
 * 内部模块（元数据服务、存储层实现）不对外暴露，避免被越层引用。
 */
export { dispatch, register, REGISTERED_COMMANDS } from './dispatch/registry/index.ts';
export { buildResult, exitCodeFor } from './dispatch/result/index.ts';
export { parseArgs, flag, option, optionList } from './dispatch/parsers/index.ts';
export { render } from './dispatch/render/index.ts';

export type { CommandContext, CommandHandler } from './dispatch/registry/index.ts';
export type { ParsedArgs } from './dispatch/parsers/index.ts';
export type { Result, Finding, Change } from './store/contract.ts';
export type { SkillIndex, IndexRecord, SkillMeta } from './core/metadata/types.ts';
