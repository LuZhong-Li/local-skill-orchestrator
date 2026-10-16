/**
 * macOS `.icns` 拼装：封装系统 `iconutil` 调用。
 *
 * 设计边界（M2 设计 5.3）：
 *   一、`.icns` 只在 macOS 上生成（`iconutil` 是 macOS 自带工具），其他平台**明确报错**，
 *       不静默跳过、也不写盘；
 *   二、执行器可注入（`run`），使参数拼装与失败口径可在任意平台单测，不依赖 macOS 实测；
 *   三、产出必须存在且非空，否则视为失败（避免产出缺图标的包）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

/** 非 macOS 平台的拒绝说明（命令行入口与测试共用同一文案） */
export const ICNS_PLATFORM_MESSAGE =
  'icns 仅 macOS 构建期生成：iconutil 是 macOS 自带工具；其他平台请使用已生成的 .icns（本仓库不入库，由 macOS 打包 job 产出）';

/** iconutil 的参数拼装（独立导出，便于单测断言命令与参数） */
export function iconutilArgs(iconsetDir, outPath) {
  return ['-c', 'icns', iconsetDir, '-o', outPath];
}

/** 平台准入：非 darwin 直接抛出带说明的错误 */
export function assertIcnsPlatform(platform = process.platform) {
  if (platform !== 'darwin') throw new Error(ICNS_PLATFORM_MESSAGE);
}

/**
 * 由 iconset 目录拼装 `.icns`。
 *
 * @param {{ iconsetDir: string, outPath: string, platform?: NodeJS.Platform, run?: typeof spawnSync }} input
 * @returns {{ command: string, args: string[], bytes: number }}
 */
export function assembleIcns({
  iconsetDir,
  outPath,
  platform = process.platform,
  run = spawnSync,
}) {
  // 平台准入先于任何检查与写盘：非 macOS 下不产生副作用
  assertIcnsPlatform(platform);
  if (!existsSync(iconsetDir) || !statSync(iconsetDir).isDirectory()) {
    throw new Error(`iconset 目录不存在：${iconsetDir}（先运行 npm run build:icon）`);
  }
  const args = iconutilArgs(iconsetDir, outPath);
  const result = run('iconutil', args, { encoding: 'utf8' });
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`iconutil 调用失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `iconutil 退出码 ${String(result.status)}：${String(result.stderr ?? '').trim()}`,
    );
  }
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    throw new Error(`iconutil 未产出有效的 .icns：${outPath}`);
  }
  return { command: 'iconutil', args, bytes: statSync(outPath).size };
}
