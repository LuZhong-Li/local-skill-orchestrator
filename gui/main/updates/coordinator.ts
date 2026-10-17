import type { KernelResult } from '../../bridge/kernel.ts';
import { checkUpdates, type ProbeOutcome, type UpdateCheckReport } from '../update-check/index.ts';
import type { UpdateSettings, UpdateSettingsStore } from './settings.ts';

export const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateBridge {
  list: () => Promise<KernelResult>;
  inspect: (id: string) => Promise<KernelResult>;
  execute: (argv: string[]) => Promise<KernelResult>;
}

export interface UpdateTimers {
  setInterval: (callback: () => void, delay: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export type UpdateCheckReason = 'manual' | 'periodic' | 'instant';

export interface UpdateCoordinatorOptions {
  bridge: UpdateBridge;
  settings: UpdateSettingsStore;
  now: () => number;
  notify: (report: UpdateCheckReport) => void;
  timers?: UpdateTimers;
  probe?: (url: string) => Promise<ProbeOutcome>;
}

function failedReport(
  message: string,
  checkedAt: string,
  code = 'E-CHANNEL-001',
): UpdateCheckReport {
  return {
    command: 'update-check',
    ok: false,
    findings: [
      {
        code,
        severity: 'error',
        source: 'update-check',
        target: 'workspace',
        message,
        remedy: '请确认工作区可读；该失败不会阻断应用其他功能',
      },
    ],
    changes: [],
    exit_code: code.startsWith('E-SRC-') ? 4 : 1,
    data: { checked_at: checkedAt, items: [] },
  };
}

function hasUpdate(report: UpdateCheckReport): boolean {
  return report.data.items.some((item) => item.state === 'update-available');
}

/**
 * 更新检查的主进程协调器。
 *
 * - 手动检查由 IPC 显式触发；
 * - 定期/即时检查仅在应用运行期间存在，且只发提示事件，绝不执行 update；
 * - 更新的执行只走既有的 `update <id> --yes` 通道，确认由渲染层完成；
 * - lastCheckAt 是会话状态：检查本身零写入，启动时以当前时刻为基线，
 *   保证不会在启动后 6 小时内提前发起定期网络请求。
 */
export class UpdateCoordinator {
  private readonly bridge: UpdateBridge;
  private readonly store: UpdateSettingsStore;
  private readonly now: () => number;
  private readonly notify: (report: UpdateCheckReport) => void;
  private readonly timers: UpdateTimers;
  private readonly probe: ((url: string) => Promise<ProbeOutcome>) | undefined;

  private started = false;
  private timer: unknown = null;
  private lastCheckAtMs = 0;
  private inFlight: Promise<UpdateCheckReport> | null = null;
  private latest: UpdateCheckReport | null = null;

  constructor(options: UpdateCoordinatorOptions) {
    this.bridge = options.bridge;
    this.store = options.settings;
    this.now = options.now;
    this.notify = options.notify;
    this.probe = options.probe;
    this.timers = options.timers ?? {
      setInterval: (callback, delay) => setInterval(callback, delay),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  getSettings(): UpdateSettings {
    return this.store.read();
  }

  getLatestReport(): UpdateCheckReport | null {
    return this.latest;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const settings = this.store.read();
    this.lastCheckAtMs = this.now();
    if (settings.periodic_check_enabled) this.armTimer();
    if (settings.instant_check_enabled) void this.checkNow('instant');
  }

  stop(): void {
    this.started = false;
    this.disarmTimer();
  }

  async setSettings(patch: Partial<UpdateSettings>): Promise<UpdateSettings> {
    const current = this.store.read();
    const next: UpdateSettings = {
      periodic_check_enabled: patch.periodic_check_enabled ?? current.periodic_check_enabled,
      instant_check_enabled: patch.instant_check_enabled ?? current.instant_check_enabled,
    };
    if (
      next.periodic_check_enabled === current.periodic_check_enabled &&
      next.instant_check_enabled === current.instant_check_enabled
    ) {
      return current;
    }
    const saved = this.store.set(next);
    if (this.started) {
      if (saved.periodic_check_enabled !== current.periodic_check_enabled) {
        if (saved.periodic_check_enabled) {
          this.lastCheckAtMs = this.now();
          this.armTimer();
        } else {
          this.disarmTimer();
        }
      }
      if (saved.instant_check_enabled && !current.instant_check_enabled) {
        void this.checkNow('instant');
      }
    }
    return saved;
  }

  checkNow(reason: UpdateCheckReason = 'manual'): Promise<UpdateCheckReport> {
    if (this.inFlight !== null) return this.inFlight;
    const task = this.performCheck(reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = task;
    return task;
  }

  executeConfirmed(id: string, ref?: string): Promise<KernelResult> {
    return this.bridge.execute([
      'update',
      id,
      ...(ref === undefined || ref === '' ? [] : ['--ref', ref]),
    ]);
  }

  private async performCheck(reason: UpdateCheckReason): Promise<UpdateCheckReport> {
    const checkedAt = new Date(this.now()).toISOString();
    let report: UpdateCheckReport;
    try {
      const listed = await this.bridge.list();
      if (!listed.ok) {
        const first = listed.findings[0];
        report = failedReport(first?.message ?? 'list 未返回可用结果', checkedAt, first?.code);
      } else {
        const records = Array.isArray(listed.data?.['records'])
          ? (listed.data['records'] as Array<{ id?: unknown }>)
          : [];
        const ids = records
          .map((item) => item.id)
          .filter((id): id is string => typeof id === 'string' && id !== '');
        report = await checkUpdates({
          ids,
          now: () => checkedAt,
          inspect: (id) => this.bridge.inspect(id),
          ...(this.probe === undefined ? {} : { probe: this.probe }),
        });
      }
    } catch (error) {
      report = failedReport(error instanceof Error ? error.message : String(error), checkedAt);
    }

    this.latest = report;
    this.lastCheckAtMs = this.now();
    if (reason !== 'manual' && hasUpdate(report)) {
      try {
        this.notify(report);
      } catch {
        // 提示通道失败不能反过来影响检查结果或主应用。
      }
    }
    return report;
  }

  private armTimer(): void {
    this.disarmTimer();
    this.timer = this.timers.setInterval(() => {
      if (!this.started) return;
      if (this.now() - this.lastCheckAtMs < PERIODIC_CHECK_INTERVAL_MS) return;
      void this.checkNow('periodic');
    }, PERIODIC_CHECK_INTERVAL_MS);
  }

  private disarmTimer(): void {
    if (this.timer === null) return;
    this.timers.clearInterval(this.timer);
    this.timer = null;
  }
}
