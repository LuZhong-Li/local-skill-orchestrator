/**
 * macOS 产物的「未签名」断言（M2 决策点 2）。
 *
 * 交付选择是未签名包（无 Apple 开发者证书），因此「未签名」必须是被检查的事实，
 * 而不是默认结果：打包后运行 `codesign -dv`，只有判定为未签名才算通过。
 *
 * 可测性：命令输出解析与执行器均独立可注入，三口径（已签名 / 未签名 / 无输出）
 * 都能在任意平台单测；真机验证登记为 T2 矩阵首跑项。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** codesign 对完全未签名产物的判定文本 */
export const UNSIGNED_MARKER = 'code object is not signed at all';

/**
 * ad-hoc 签名标志。
 *
 * 为什么必须接受：Apple Silicon（arm64）上可执行文件**必须**至少带 ad-hoc 签名才能运行，
 * 因此 arm64 产物带 ad-hoc 签名是平台要求，而不是「被签名交付」。本项目的交付口径是
 * 「未使用开发者证书签名与公证」（无 Developer ID / 不公证），ad-hoc 属于其允许形态——
 * 真机实测：mac-x64 的产物完全未签名，mac-arm64 的产物为 ad-hoc（两端都通过本断言）。
 * 带 Developer ID 的产物仍会被判定为 `signed` 并拒绝。
 */
export const ADHOC_MARKERS = ['signature=adhoc', 'flags=0x2(adhoc)', 'adhoc'];

/** 允许通过的判定：完全未签名，或仅 ad-hoc 签名 */
export const ACCEPTED_KINDS = ['unsigned', 'adhoc'];

/**
 * 把 codesign 的执行结果归类：
 *   `unsigned` —— 输出里出现「未签名」标记；
 *   `signed`   —— 退出码为 0 且没有该标记；
 *   `unknown`  —— 其余（含无输出），视为无法确认，断言按失败处理。
 */
export function classifyCodeSignature({ status, stdout = '', stderr = '' }) {
  const text = `${String(stdout)}\n${String(stderr)}`.toLowerCase();
  if (text.includes(UNSIGNED_MARKER)) return 'unsigned';
  if (ADHOC_MARKERS.some((marker) => text.includes(marker))) return 'adhoc';
  if (status === 0) return 'signed';
  return 'unknown';
}

/**
 * 断言 macOS 产物**未使用开发者证书签名**（完全未签名或仅 ad-hoc）；不满足即抛错
 * （含判定与原始输出片段，便于定位）。
 *
 * @param {{ appPath: string, platform?: NodeJS.Platform, run?: typeof spawnSync }} input
 */
export function assertUnsignedApp({ appPath, platform = process.platform, run = spawnSync }) {
  if (platform !== 'darwin') {
    throw new Error('未签名断言仅适用于 macOS 产物：codesign 是 macOS 自带工具');
  }
  if (!existsSync(appPath)) {
    throw new Error(`待断言的产物不存在：${appPath}`);
  }
  const result = run('codesign', ['-dv', appPath], { encoding: 'utf8' });
  const kind = classifyCodeSignature(result);
  const output = `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.trim();
  if (!ACCEPTED_KINDS.includes(kind)) {
    throw new Error(
      `macOS 产物应为「未签名或仅 ad-hoc」，实际判定为 ${kind}：${output === '' ? '(codesign 无输出)' : output.slice(0, 400)}`,
    );
  }
  return { appPath, kind, output };
}
