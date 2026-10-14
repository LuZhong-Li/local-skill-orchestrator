/**
 * 内核通用错误类型。
 *
 * 放在存储层是因为它位于依赖方向的最底层：指令调度层与内核层都可以依赖存储层，
 * 而存储层不反向依赖任何上层模块，因此这里是最合适的公共位置。
 *
 * 约定：内核内部可以抛出本类型，但指令调度层必须捕获并转换为标准结果封装，
 * 不得让异常穿透到调用方。
 */
export interface KernelErrorInit {
  code: string;
  message: string;
  source?: string;
  target?: string;
  remedy?: string;
  cause?: unknown;
}

export class KernelError extends Error {
  readonly code: string;
  readonly source: string;
  readonly target: string;
  readonly remedy: string;

  constructor(init: KernelErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'KernelError';
    this.code = init.code;
    this.source = init.source ?? 'system';
    this.target = init.target ?? '';
    this.remedy = init.remedy ?? '';
  }
}

/** 断言式失败：用于不可恢复的内部前置条件 */
export function fail(init: KernelErrorInit): never {
  throw new KernelError(init);
}

/** 把任意抛出物规范化为 KernelError */
export function toKernelError(error: unknown, fallbackCode: string): KernelError {
  if (error instanceof KernelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new KernelError({ code: fallbackCode, message, cause: error });
}
