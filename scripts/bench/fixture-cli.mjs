#!/usr/bin/env node
/**
 * 夹具生成器的命令行入口：`npm run bench:fixture -- --n 1000 [--seed 23063] [--root <目录>] [--quiet]`。
 *
 * 默认落在系统临时目录下的 `skill-manager-bench-<N>-<种子>`（不入库）；
 * 打印生成结果的 JSON 摘要（技能数、文件数、字节数、生成耗时），供 T0 的规模实测登记。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SEED, planFixture, writeFixture } from './fixture.mjs';

function parseArgs(argv) {
  const options = { n: 1000, seed: DEFAULT_SEED, root: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`选项 ${token} 缺少取值`);
      return argv[i];
    };
    if (token === '--n') options.n = Number(next());
    else if (token === '--seed') options.seed = Number(next());
    else if (token === '--root') options.root = next();
    else if (token === '--quiet') options.quiet = true;
    else throw new Error(`未知选项：${token}`);
  }
  if (!Number.isInteger(options.n) || options.n <= 0) {
    throw new Error(`--n 必须是正整数：${String(options.n)}`);
  }
  if (!Number.isInteger(options.seed)) {
    throw new Error(`--seed 必须是整数：${String(options.seed)}`);
  }
  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`夹具生成失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const ownsRoot = options.root === null;
const root =
  options.root ?? mkdtempSync(join(tmpdir(), `skill-manager-bench-${options.n}-${options.seed}-`));

try {
  if (!ownsRoot) mkdirSync(root, { recursive: true });
  const started = process.hrtime.bigint();
  const plan = planFixture({ seed: options.seed, n: options.n });
  const plannedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const written = writeFixture(plan, root);
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (written.files !== plan.counts.files || written.bytes !== plan.counts.bytes) {
    throw new Error(
      `落盘结果与计划不一致：文件 ${String(written.files)}/${String(plan.counts.files)}、字节 ${String(
        written.bytes,
      )}/${String(plan.counts.bytes)}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        root,
        n: options.n,
        seed: options.seed,
        counts: plan.counts,
        plan_ms: Math.round(plannedMs),
        write_ms: Math.round(totalMs - plannedMs),
        total_ms: Math.round(totalMs),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(`夹具生成失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (options.quiet && ownsRoot) rmSync(root, { recursive: true, force: true });
}
