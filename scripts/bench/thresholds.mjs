/**
 * M3 性能与规模压测的阈值常量（唯一来源）。
 *
 * 依据：
 *   - `docs/requirements.md` 9.4.3（NFR-M3-01）的阈值表；
 *   - M3 前置裁决把 N = 1000 档收紧为 `scan` ≤ 30 秒、`validate` ≤ 30 秒、
 *     `export` ≤ 15 秒、内存峰值 ≤ 512 MB，并登记为「未测先收紧」
 *     （改前值 / 改后值 / 依据见需求 9.4.3 说明第 4 条）。
 *
 * 取值只有这一处来源：契约测试 `tests/contract/bench-thresholds.test.ts` 逐项比对
 * 需求文档 9.4.3 的表格与本文件的常量——**任一侧被放宽都会让该测试变红**
 * （需求 9.4.3 说明第 1 条：不得专为通过而放宽）。
 *
 * `gating` 表示该档是否参与硬阈值判定：
 *   - N = 1000：阈值档（硬判定）；
 *   - N = 100：烟测档（数据记录，CI 波动大，不作门禁）；
 *   - N = 5000：压力档（仍按 9.4.3 给出通过 / 失败结论，但超阈值只触发优化项登记）。
 */

/** 规模档位（与需求 9.3.3 的 M3-R1 一致） */
export const SCALE_SIZES = [100, 1000, 5000];

/** 时间阈值的单位：毫秒；内存阈值单位：MB */
export const THRESHOLDS = {
  100: { scan_ms: 5_000, validate_ms: 10_000, export_ms: 5_000, peak_rss_mb: 200, gating: false },
  1000: { scan_ms: 30_000, validate_ms: 30_000, export_ms: 15_000, peak_rss_mb: 512, gating: true },
  5000: {
    scan_ms: 360_000,
    validate_ms: 600_000,
    export_ms: 180_000,
    peak_rss_mb: 4096,
    gating: false,
  },
};

/** 阈值对应的指标名，供测量器与报告使用（键与 THRESHOLDS 的字段同名） */
export const THRESHOLD_METRICS = ['scan_ms', 'validate_ms', 'export_ms', 'peak_rss_mb'];

/** 取某档阈值；未知档位抛错而不是回落默认值（避免静默用错阈值判定） */
export function thresholdOf(n) {
  const entry = THRESHOLDS[n];
  if (entry === undefined) {
    throw new Error(`未登记的规模档位：${String(n)}；已登记档位为 ${SCALE_SIZES.join(' / ')}`);
  }
  return entry;
}

/** 单指标是否超阈值 */
export function exceedsThreshold(n, metric, value) {
  const entry = thresholdOf(n);
  const limit = entry[metric];
  if (typeof limit !== 'number') {
    throw new Error(`未登记的指标：${String(metric)}`);
  }
  return value > limit;
}
