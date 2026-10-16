import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialObservation, observeWrite, stepWatcher } from '../../scripts/bench/fs-watch.mjs';

const stat = (size: number, mtimeMs: number) => ({ size, mtimeMs });

test('T1 fs 观测：先有写入再稳定才算观测完成（同尺寸不同 mtime 也算写入）', () => {
  let state = initialObservation(stat(170, 1000));
  const polls = [stat(170, 1000), stat(170, 1005), stat(170, 1005)];
  const steps = polls.map((value, index) => {
    const stepped = stepWatcher(state, { atMs: index * 5, stat: value });
    state = stepped.state;
    return stepped;
  });
  assert.equal(steps[0].done, false, '与基线一致：尚未观测到写入');
  assert.equal(steps[0].state.changed_ms, null);
  assert.equal(steps[1].state.changed_ms, 5, 'mtime 变化即视为写入被观测到');
  assert.equal(steps[1].done, false);
  assert.equal(steps[2].done, true, '写入后连续两次读数一致即判稳定');
  assert.deepEqual(
    {
      baseline_size: state.baseline_size,
      changed_ms: state.changed_ms,
      stable_ms: state.stable_ms,
    },
    { baseline_size: 170, changed_ms: 5, stable_ms: 10 },
  );
});

test('T1 fs 观测：空索引先存在的冷态不会误报（基线非空但未变化 ⇒ 未观测到）', () => {
  const state = initialObservation(stat(170, 1000));
  const { state: next, done } = stepWatcher(state, { atMs: 5, stat: stat(170, 1000) });
  assert.equal(done, false);
  assert.equal(next.changed_ms, null, '「文件已存在且非空」不等于「观测到写入」');
});

test('T1 fs 观测：文件首次出现（基线为 null）也计为写入', () => {
  const first = stepWatcher(initialObservation(null), { atMs: 3, stat: stat(40213, 2000) });
  assert.equal(first.state.changed_ms, 3);
  const second = stepWatcher(first.state, { atMs: 8, stat: stat(40213, 2000) });
  assert.equal(second.done, true);
  assert.equal(second.state.stable_ms, 8);
});

test('T1 fs 观测：三种未达成都写明原因（未观测到写入 / 未稳定 / 超时）', async () => {
  const clock = { ms: 0 };
  const options = (
    readStat: () => { size: number; mtimeMs: number } | null,
    exitAfterPolls: number,
  ) => {
    let polls = 0;
    return {
      readStat,
      now: () => clock.ms,
      sleep: async () => {
        polls += 1;
        clock.ms += 5;
      },
      pollMs: 5,
      deadlineMs: 20,
      isRunning: () => polls < exitAfterPolls,
    };
  };

  const unchanged = await observeWrite(options(() => stat(170, 1000), 2));
  assert.equal(unchanged.reason, 'not-observed');
  assert.equal(unchanged.changed_ms, null);

  let mtime = 1000;
  const neverStable = await observeWrite(
    options(() => {
      mtime += 1;
      return stat(170, mtime);
    }, 4),
  );
  assert.equal(neverStable.reason, 'not-stable-before-exit');
  assert.ok(neverStable.changed_ms !== null);
  assert.equal(neverStable.stable_ms, null);

  clock.ms = 0;
  const overflowed = await observeWrite(options(() => stat(170, 1000), 100));
  assert.equal(overflowed.reason, 'deadline-exceeded');
});
