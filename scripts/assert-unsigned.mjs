#!/usr/bin/env node
/**
 * 未签名断言入口（macOS）：`node scripts/assert-unsigned.mjs <app 路径>`。
 *
 * 打包流程（`scripts/pack.mjs`）已在 mac 打包后自动执行同一断言；本入口用于
 * 事后复核与 T2 矩阵首跑，使「未签名」这条结论可以单独重放。
 */
import { assertUnsignedApp } from './unsigned-check.mjs';

const appPath = process.argv[2];
if (appPath === undefined || appPath.trim() === '') {
  console.error('用法：node scripts/assert-unsigned.mjs <app 路径>');
  process.exit(2);
}

try {
  const result = assertUnsignedApp({ appPath });
  console.log(`未签名断言通过：${result.appPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
