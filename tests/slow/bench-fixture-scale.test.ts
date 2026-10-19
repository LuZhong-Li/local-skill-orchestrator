import { makeTempDir } from '../helpers/temp.ts';
/**
 * 慢测试：N=5000 夹具的**真机落盘**规模验证（15000 文件 / 约 160 MiB / 约 10 s）。
 *
 * 为什么不进常规套件：单次落盘会把 `npm test` 从秒级拖到约 30 s。
 * 规模验证不删也不降级为纯计划级——T2 的三档跑测本就会真实生成 N=5000，两处互为印证；
 * 本用例由 `npm run test:slow` 显式执行（设计 §1.3「测试口径」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SEED, planFixture, writeFixture } from '../../scripts/bench/fixture.mjs';

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

test('T0 慢测试：N=5000 落盘规模与设计一致（15000 文件量级 / 约 160 MiB）', () => {
  const root = makeTempDir('bench-fixture-5000-');
  try {
    const started = process.hrtime.bigint();
    const plan = planFixture({ seed: DEFAULT_SEED, n: 5000 });
    const written = writeFixture(plan, root);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(plan.counts.files, 15000 - 2 * plan.counts.noContent);
    assert.equal(countFiles(join(root, 'skills')), written.files);
    assert.equal(written.bytes, plan.counts.bytes);
    const mib = plan.counts.bytes / 1024 / 1024;
    assert.ok(mib > 120 && mib < 220, `N=5000 占用应与设计同量级（实测 ${mib.toFixed(1)} MiB）`);
    // 设计 §1.3 的预判是「≤ 14 s」（Windows 最慢）；这里放宽到 60 s，避免把慢测试变成抖动测试
    assert.ok(
      elapsedMs < 60_000,
      `N=5000 落盘耗时应可接受（实测 ${(elapsedMs / 1000).toFixed(1)} s）`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
