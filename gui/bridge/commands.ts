/**
 * G-02 内核桥接器的指令门面。
 *
 * 十五条指令在此各有一个具名方法，参数以数组形式原样转发给内核。
 * 写操作的统一流程由 invokeWithConfirmation 表达：
 *   预览（内核 --dry-run，非交互通道下不会被拦截）→ 调用方决定是否继续 → 带 --yes 执行。
 *   「哪些指令需要确认」由内核的策略层判定，本层不复制该规则：
 *   需要确认的指令在未给出确认回调时，会把内核的拒绝结果原样返回，由调用方展示问题码。
 */
import {
  callKernel,
  isConfirmationRefusal,
  type KernelOptions,
  type KernelResult,
} from './kernel.ts';

export interface InvokeOutcome {
  kind: 'result' | 'cancelled';
  /** 内核结果；取消时为预览结果，供界面说明「未做任何变更」 */
  result: KernelResult;
  /** 取消时携带的预览结果 */
  preview?: KernelResult;
}

export class KernelBridge {
  // 显式声明并赋值：内核侧的测试用 Node 直接加载本文件，参数属性属于需要转译的语法
  private readonly options: KernelOptions;

  constructor(options: KernelOptions) {
    this.options = options;
  }

  /** 直发：只读指令与已确认的写操作都走这里 */
  async run(argv: string[]): Promise<KernelResult> {
    const { result } = await callKernel(this.options, argv);
    return result;
  }

  /** 预览：写操作的影响范围由内核按 --dry-run 如实给出，界面不得自行编造 */
  async preview(argv: string[]): Promise<KernelResult> {
    return this.run([...argv, '--dry-run']);
  }

  /** 执行：带跳过确认选项，仅用于用户已在界面上确认过的写操作 */
  async execute(argv: string[]): Promise<KernelResult> {
    return this.run([...argv, '--yes']);
  }

  /**
   * 需要确认的写操作：先预览再执行。
   * confirm 返回假时不发写请求，只回报「已取消」。
   */
  async invokeWithConfirmation(
    argv: string[],
    confirm: (preview: KernelResult) => Promise<boolean>,
  ): Promise<InvokeOutcome> {
    const preview = await this.preview(argv);
    if (!preview.ok) return { kind: 'result', result: preview };
    const approved = await confirm(preview);
    if (!approved) return { kind: 'cancelled', result: preview, preview };
    return { kind: 'result', result: await this.execute(argv) };
  }

  /**
   * 自适应调用：不预设哪些指令需要确认。
   * 内核若因缺少跳过选项而拒绝，则转入预览与确认流程。
   */
  async invoke(
    argv: string[],
    confirm?: (preview: KernelResult) => Promise<boolean>,
  ): Promise<InvokeOutcome> {
    if (confirm !== undefined) return this.invokeWithConfirmation(argv, confirm);
    const result = await this.run(argv);
    if (!isConfirmationRefusal(result)) return { kind: 'result', result };
    return { kind: 'result', result };
  }

  // ── 十五条指令的具名门面：参数与指令契约的语法一一对应 ──

  init(scope?: string): Promise<KernelResult> {
    return this.run(['init', ...(scope !== undefined ? ['--scope', scope] : [])]);
  }

  configGet(): Promise<KernelResult> {
    return this.run(['config', 'get']);
  }

  configSet(key: string, value: string): Promise<KernelResult> {
    return this.run(['config', 'set', key, value]);
  }

  scan(roots: string[] = []): Promise<KernelResult> {
    return this.run(['scan', ...roots.flatMap((root) => ['--root', root])]);
  }

  list(filter: { state?: string; source?: string; target?: string } = {}): Promise<KernelResult> {
    const argv = ['list'];
    if (filter.state !== undefined) argv.push('--state', filter.state);
    if (filter.source !== undefined) argv.push('--source', filter.source);
    if (filter.target !== undefined) argv.push('--target', filter.target);
    return this.run(argv);
  }

  inspect(id: string): Promise<KernelResult> {
    return this.run(['inspect', id]);
  }

  validate(subject?: string, strict = false): Promise<KernelResult> {
    const argv = ['validate'];
    if (subject !== undefined && subject !== '') argv.push(subject);
    if (strict) argv.push('--strict');
    return this.run(argv);
  }

  deps(id: string, tree = false): Promise<KernelResult> {
    return this.run(['deps', id, ...(tree ? ['--tree'] : [])]);
  }

  export(target: string, noConfig = false): Promise<KernelResult> {
    return this.run(['export', target, ...(noConfig ? ['--no-config'] : [])]);
  }

  install(source: string, options: { libraryOnly?: boolean } = {}): Promise<KernelResult> {
    return this.run(['install', source, ...(options.libraryOnly ? ['--library-only'] : [])]);
  }

  uninstall(id: string, options: { hard?: boolean } = {}): Promise<KernelResult> {
    return this.run(['uninstall', id, ...(options.hard ? ['--hard'] : [])]);
  }

  enable(id: string): Promise<KernelResult> {
    return this.run(['enable', id]);
  }

  disable(id: string): Promise<KernelResult> {
    return this.run(['disable', id]);
  }

  update(id: string, check = false): Promise<KernelResult> {
    return this.run(['update', id, ...(check ? ['--check'] : [])]);
  }

  import(target: string): Promise<KernelResult> {
    return this.run(['import', target]);
  }
}
