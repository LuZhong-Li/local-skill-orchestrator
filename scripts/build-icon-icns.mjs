#!/usr/bin/env node
/**
 * 由 iconset 拼装 macOS `icon.icns`（构建期，仅 macOS）。
 *
 * 调用顺序按 M2 设计 5.3：先 `npm run build:icon` 生成 iconset，再跑本入口。
 * 非 macOS 平台在**任何写盘之前**就以明确错误退出（不静默跳过）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleIcns } from './icon-icns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'gui', 'packaging');

const result = assembleIcns({
  iconsetDir: join(OUT_DIR, 'icon.iconset'),
  outPath: join(OUT_DIR, 'icon.icns'),
});

console.log(
  `icon.icns 已生成（${String(result.bytes)} 字节）：${result.command} ${result.args.join(' ')}`,
);
