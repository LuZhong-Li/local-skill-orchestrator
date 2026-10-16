#!/usr/bin/env node
/**
 * `linux.maintainer` 消费实测入口（需要 Linux 与 electron-builder，真机执行登记为 T2 首跑）：
 *
 *   node scripts/check-maintainer.mjs --with <含 maintainer 的解包目录> \
 *     --without <移除 maintainer 后的解包目录> [--needle "skill-manager <3338004299@qq.com>"]
 *
 * 结论（consumed / not-consumed / ambiguous）与命中证据一并打印；判定逻辑在
 * `scripts/maintainer-probe.mjs`（纯函数、可单测），本文件只做参数解析与输出。
 */
import { findNeedleInTree, maintainerConsumptionVerdict } from './maintainer-probe.mjs';

/** 与配置中的 linux.maintainer 保持一致 */
export const DEFAULT_NEEDLE = 'skill-manager <3338004299@qq.com>';

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if ((key === '--with' || key === '--without' || key === '--needle') && value !== undefined) {
      parsed[key.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(
      `未知参数：${String(key)}（用法：--with <目录> --without <目录> [--needle <文本>]）`,
    );
  }
  if (parsed.with === undefined || parsed.without === undefined) {
    throw new Error('需要同时给出 --with 与 --without 两个解包目录');
  }
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const needle = args.needle ?? DEFAULT_NEEDLE;
  const withResult = findNeedleInTree({ root: args.with, needle });
  const withoutResult = findNeedleInTree({ root: args.without, needle });
  const verdict = maintainerConsumptionVerdict({
    withHits: withResult.hits,
    withoutHits: withoutResult.hits,
  });

  console.log(`maintainer 命中（含该字段的产物）：${String(withResult.hits.length)} 处`);
  for (const hit of withResult.hits.slice(0, 5))
    console.log(`  ${hit.path} :: ${hit.lines.join(' | ')}`);
  console.log(`maintainer 命中（移除该字段的产物）：${String(withoutResult.hits.length)} 处`);
  for (const hit of withoutResult.hits.slice(0, 5))
    console.log(`  ${hit.path} :: ${hit.lines.join(' | ')}`);
  console.log(`结论：${verdict}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
