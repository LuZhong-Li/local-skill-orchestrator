/**
 * 内核访问与视图状态的唯一入口。
 *
 * 数据只有两个来源：内核的 list 载荷与各次调用的结果封装。
 * 本层不推导状态、不读写工作区文件；需要确认的写操作把预览结果交给界面，
 * 由界面弹窗展示真实影响范围后再决定是否执行。
 */
import { ref } from 'vue';
import { cardStateOf, type KernelResult, type LogEntry, type SkillSummary } from '../types.ts';

export interface ConfirmRequest {
  title: string;
  result: KernelResult;
  argv: string[];
}

export function useKernel() {
  const records = ref<SkillSummary[]>([]);
  const log = ref<LogEntry[]>([]);
  const workspace = ref('');
  const initialized = ref(true);
  const busy = ref(false);
  const pendingConfirm = ref<ConfirmRequest | null>(null);

  let resolveConfirm: ((answer: boolean) => void) | null = null;

  function record(text: string, ok: boolean): void {
    const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    log.value = [{ at, text, ok }, ...log.value].slice(0, 40);
  }

  function summarize(result: KernelResult): string {
    const errors = result.findings.filter((item) => item.severity === 'error');
    const head = `${result.command}：${result.ok ? '完成' : `失败（退出码 ${result.exit_code}）`}`;
    const detail = errors.map((item) => item.code).join('、');
    return detail === '' ? head : `${head}｜问题码 ${detail}`;
  }

  /** 直发一次调用；结果原样记录到状态栏，问题码不隐藏 */
  async function run(argv: string[]): Promise<KernelResult> {
    busy.value = true;
    try {
      const result = (await window.skillManager.invoke(argv)) as KernelResult;
      record(summarize(result), result.ok);
      return result;
    } finally {
      busy.value = false;
    }
  }

  /** 预览一次写操作：内核以预演方式给出真实影响范围 */
  async function preview(argv: string[]): Promise<KernelResult> {
    return (await window.skillManager.preview(argv)) as KernelResult;
  }

  /** 执行一次已确认的写操作 */
  async function execute(argv: string[]): Promise<KernelResult> {
    busy.value = true;
    try {
      const result = (await window.skillManager.execute(argv)) as KernelResult;
      record(summarize(result), result.ok);
      return result;
    } finally {
      busy.value = false;
    }
  }

  /**
   * 写操作的统一流程：预览 → 弹窗确认 → 执行。
   * 预览未通过时直接返回，不弹确认框；用户取消时不发写请求。
   */
  async function runWithConfirm(argv: string[], title: string): Promise<KernelResult | null> {
    const previewResult = await preview(argv);
    if (!previewResult.ok) {
      record(summarize(previewResult), false);
      return previewResult;
    }
    const approved = await askConfirm({ title, result: previewResult, argv });
    if (!approved) {
      record(`${title}：已取消，未做任何变更`, true);
      return null;
    }
    return execute(argv);
  }

  function askConfirm(request: ConfirmRequest): Promise<boolean> {
    pendingConfirm.value = request;
    return new Promise((resolve) => {
      resolveConfirm = resolve;
    });
  }

  function answerConfirm(answer: boolean): void {
    pendingConfirm.value = null;
    resolveConfirm?.(answer);
    resolveConfirm = null;
  }

  async function describe(): Promise<void> {
    const info = (await window.skillManager.describe()) as { workspace: string };
    workspace.value = info.workspace;
  }

  /** 读取列表：内核未初始化时返回引导性结果，界面据此显示引导 */
  async function refresh(): Promise<void> {
    const result = await run(['list']);
    if (result.data === undefined) return;
    const data = result.data as {
      initialized?: boolean;
      records?: SkillSummary[];
      total?: number;
    };
    initialized.value = data.initialized !== false;
    records.value = (data.records ?? []) as SkillSummary[];
  }

  function summarizeStates(): { enabled: number; disabled: number; invalid: number } {
    const counts = { enabled: 0, disabled: 0, invalid: 0 };
    for (const record of records.value) counts[cardStateOf(record)] += 1;
    return counts;
  }

  return {
    records,
    log,
    workspace,
    initialized,
    busy,
    pendingConfirm,
    describe,
    refresh,
    run,
    preview,
    execute,
    runWithConfirm,
    answerConfirm,
    summarizeStates,
    cardStateOf,
  };
}
