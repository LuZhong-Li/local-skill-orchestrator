/**
 * M3 fs 观测：轮询索引文件，记录「写入被观测到」与「尺寸稳定」两个时刻，
 * 用于与 `--cpu-prof` 的阶段归集交叉验证（设计 §3.5）。
 *
 * 判定依据是**尺寸或修改时间发生变化**，而不是「尺寸与前一次相同」——两个实测反例决定了这一点：
 *   一、冷态下工作区已有一个空索引（`init` 的产物，170 字节），它在 t=0 就「存在且非空」，
 *       按「首次出现」判定会立刻误报；
 *   二、热态重写的索引与旧文件**逐字节相同**，尺寸不变，只看尺寸会完全观测不到这次写入。
 * 观测结果**只作交叉验证**，不替代阶段归集；未观测到则记 `null` 与原因（不猜、不补）。
 */

/** 单个观测点的取值：`null` 表示此刻读不到（尚未创建或已被重命名取代） */
function sameStat(a, b) {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** 初始观测状态：`baseline` 为开始观测时的现场（可能是空索引，也可能不存在） */
export function initialObservation(baseline = null) {
  return {
    baseline,
    baseline_size: baseline?.size ?? null,
    current: baseline,
    changed_ms: null,
    stable_ms: null,
    polls: 0,
  };
}

/**
 * 一次轮询的状态迁移（纯函数）。
 *
 * 返回 `done: true` 表示「已观测到写入，且之后连续两次读数一致」——可以停止轮询。
 */
export function stepWatcher(state, { atMs, stat }) {
  const next = { ...state, polls: state.polls + 1 };
  if (state.changed_ms === null) {
    if (!sameStat(stat, state.baseline)) {
      return { state: { ...next, current: stat, changed_ms: atMs }, done: false };
    }
    return { state: next, done: false };
  }
  if (sameStat(stat, state.current)) {
    return { state: { ...next, stable_ms: state.stable_ms ?? atMs }, done: true };
  }
  return { state: { ...next, current: stat }, done: false };
}

/**
 * 轮询直到「观测到写入并稳定」、进程结束或超时；返回观测状态与 `reason`。
 *
 * `readStat` 由调用方注入（返回 `{ size, mtimeMs }` 或 `null`），时钟与 sleep 同样可注入。
 */
export async function observeWrite(options) {
  const { readStat, now, sleep, pollMs = 5, deadlineMs = 120_000, isRunning } = options;
  const startedAt = now();
  let state = initialObservation(readStat());
  let reason = null;
  for (;;) {
    const atMs = now() - startedAt;
    const stepped = stepWatcher(state, { atMs, stat: readStat() });
    state = stepped.state;
    if (stepped.done) break;
    if (!isRunning()) {
      reason = state.changed_ms === null ? 'not-observed' : 'not-stable-before-exit';
      break;
    }
    if (atMs > deadlineMs) {
      reason = 'deadline-exceeded';
      break;
    }
    await sleep(pollMs);
  }
  return {
    baseline_size: state.baseline_size,
    changed_ms: state.changed_ms,
    stable_ms: state.stable_ms,
    size: state.current?.size ?? null,
    polls: state.polls,
    reason,
  };
}
