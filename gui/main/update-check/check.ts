import type { UpdateCheckItem } from './classify.ts';
import { classifyInspectItem, probeTargetOf } from './classify.ts';
import { UPDATE_CHECK_BACKUP_NOTICE } from './constants.ts';
import { runGitLsRemote, type ProbeOutcome } from './ls-remote.ts';

export interface CheckFinding {
  code: string;
  severity: 'error';
  source: 'update-check';
  target: string;
  message: string;
  remedy: string;
}

export interface InspectLikeResult {
  ok: boolean;
  findings?: Array<{
    code?: string;
    message?: string;
    remedy?: string;
  }>;
  data?: unknown;
}

export interface UpdateCheckReport {
  command: 'update-check';
  ok: boolean;
  findings: CheckFinding[];
  changes: [];
  exit_code: number;
  data: {
    checked_at: string;
    items: UpdateCheckItem[];
  };
}

export interface CheckUpdatesOptions {
  ids: string[];
  inspect: (id: string) => Promise<InspectLikeResult>;
  probe?: (url: string) => Promise<ProbeOutcome>;
  now?: () => string;
}

function inspectFailure(id: string, result: InspectLikeResult, checkedAt: string): UpdateCheckItem {
  const first = result.findings?.find((item) => item.code !== undefined);
  const code = first?.code ?? 'E-CHANNEL-001';
  return {
    id,
    state: 'failed',
    summary: `检查失败：${first?.message ?? 'inspect 未返回可用结果'}`,
    provenance: { url: null, ref: null, checked_at: checkedAt },
    backup_notice: UPDATE_CHECK_BACKUP_NOTICE,
    code,
    remedy: first?.remedy ?? '请确认工作区可读，或重新执行 scan 后再试',
  };
}

/**
 * 逐项检查；顺序执行避免未认证来源被并发请求打到限流。
 * 单条 inspect/probe 失败只影响该项，其余条目照常形成结论。
 */
export async function checkUpdates(options: CheckUpdatesOptions): Promise<UpdateCheckReport> {
  const checkedAt = (options.now ?? (() => new Date().toISOString()))();
  const probe = options.probe ?? ((url: string) => runGitLsRemote(url));
  const items: UpdateCheckItem[] = [];
  const findings: CheckFinding[] = [];

  for (const id of options.ids) {
    let result: InspectLikeResult;
    try {
      result = await options.inspect(id);
    } catch (error) {
      result = {
        ok: false,
        findings: [
          {
            code: 'E-CHANNEL-001',
            message: error instanceof Error ? error.message : String(error),
            remedy: '请确认内核可执行且工作区可读',
          },
        ],
      };
    }

    let item: UpdateCheckItem;
    if (!result.ok) {
      item = inspectFailure(id, result, checkedAt);
    } else {
      const target = probeTargetOf(result.data);
      if (target === null) {
        item = classifyInspectItem(id, result.data, { ok: true, tags: [] }, checkedAt);
      } else {
        let outcome: ProbeOutcome;
        try {
          outcome = await probe(target.url);
        } catch (error) {
          outcome = {
            ok: false,
            code: 'E-SRC-007',
            message: `git ls-remote 失败：${error instanceof Error ? error.message : String(error)}`,
            remedy: '请确认来源地址可达、引用存在且网络可用',
          };
        }
        item = classifyInspectItem(id, result.data, outcome, checkedAt);
      }
    }
    items.push(item);
    if (item.state === 'failed' && item.code !== undefined) {
      findings.push({
        code: item.code,
        severity: 'error',
        source: 'update-check',
        target: id,
        message: item.summary,
        remedy: item.remedy ?? '请重试该来源',
      });
    }
  }

  const exitCode = findings.some((item) => item.code.startsWith('E-SRC-')) ? 4 : 1;
  return {
    command: 'update-check',
    ok: findings.length === 0,
    findings,
    changes: [],
    exit_code: findings.length === 0 ? 0 : exitCode,
    data: { checked_at: checkedAt, items },
  };
}
