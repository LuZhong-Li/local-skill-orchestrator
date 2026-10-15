#!/usr/bin/env node
/**
 * Node 版本守卫：把「矩阵取值与版本声明同源」这条结构性约束变成可失败的检查。
 *
 * 用法：
 *   node scripts/check-node-version.mjs              # 本地：检查是否满足 engines 下界，并与 .nvmrc 比对（不一致只警告）
 *   node scripts/check-node-version.mjs --expect 22  # 流水线：额外断言期望版本与 .nvmrc 一致（不一致即失败）
 *
 * 依据：设计 docs/design/m1-ci.md 第 4 章（矩阵 Node 取值以 .nvmrc 为单一来源）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NVMRC = join(ROOT, '.nvmrc');
const ENGINES_LOWER_BOUND = 22;

const declared = readFileSync(NVMRC, 'utf8').trim();
const currentMajor = Number(process.versions.node.split('.')[0]);

function fail(message) {
  console.error(`Node 版本守卫失败：${message}`);
  process.exit(1);
}

if (!/^\d+$/.test(declared)) {
  fail(`.nvmrc 内容不是单个主版本号：${JSON.stringify(declared)}`);
}
const declaredMajor = Number(declared);

if (currentMajor < ENGINES_LOWER_BOUND) {
  fail(`当前 Node 主版本 ${currentMajor} 低于 engines 声明的最低支持版本 ${ENGINES_LOWER_BOUND}`);
}

const expectedIndex = process.argv.indexOf('--expect');
if (expectedIndex >= 0) {
  const expected = (process.argv[expectedIndex + 1] ?? '').trim();
  if (expected !== declared) {
    fail(
      `矩阵期望版本 ${JSON.stringify(expected)} 与 .nvmrc 声明 ${JSON.stringify(declared)} 不一致`,
    );
  }
  console.log(`矩阵 Node 版本与 .nvmrc 一致：${declared}`);
  process.exit(0);
}

if (currentMajor !== declaredMajor) {
  console.warn(
    `提示：当前 Node 主版本 ${currentMajor} 与 .nvmrc 声明 ${declaredMajor} 不同；按 engines（>=${ENGINES_LOWER_BOUND}）仍合法，本地开发建议使用 .nvmrc 的版本`,
  );
}
console.log(`Node 版本检查通过：当前 ${process.versions.node}（.nvmrc 声明 ${declared}）`);
