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

/** codesign 对未签名产物的判定文本 */
export const UNSIGNED_MARKER = 'code object is not signed at all';

/**
 * 把 codesign 的执行结果归类：
 *   `unsigned` —— 输出里出现「未签名」标记；
 *   `signed`   —— 退出码为 0 且没有该标记；
 *   `unknown`  —— 其余（含无输出），视为无法确认，断言按失败处理。
 */
export function classifyCodeSignature({ status, stdout = '', stderr = '' }) {
  const text = `${String(stdout)}\n${String(stderr)}`.toLowerCase();
  if (text.includes(UNSIGNED_MARKER)) return 'unsigned';
  if (status === 0) return 'signed';
  return 'unknown';
}

/**
 * 断言 macOS 产物未签名；不满足即抛错（含原始输出片段，便于定位）。
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
  if (kind !== 'unsigned') {
    throw new Error(
      `macOS 产物应为未签名，实际判定为 ${kind}：${output === '' ? '(codesign 无输出)' : output.slice(0, 400)}`,
    );
  }
  return { appPath, kind, output };
}
