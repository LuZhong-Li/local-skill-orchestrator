/**
 * macOS 上 SEA 注入前后的签名处理（Node 官方单文件可执行流程要求）。
 *
 * 为什么需要：`postject` 注入会改动 Node 运行时副本的 Mach-O 内容，原有签名随之失效。
 * Node 官方文档要求在 macOS 上「注入前 `codesign --remove-signature`、注入后 ad-hoc 重签
 * （`codesign --sign -`）」。缺这一步时 x64 可能宽容通过，而 arm64 会在打包期签名校验失败
 * （EX-07 的根因）。
 *
 * 可测性（沿用本项目惯例）：命令与参数拼装是纯函数；执行器可注入；非 macOS 平台
 * **不调用任何外部命令**（返回 applied: false），因此单测在任意平台都能覆盖全部分支。
 */
import { spawnSync } from 'node:child_process';

/** 支持的动作：注入前移除签名、注入后 ad-hoc 重签 */
export const CODESIGN_ACTIONS = ['remove', 'sign'];

/** codesign 参数拼装（纯函数）：remove → `--remove-signature`；sign → `--sign -`（ad-hoc） */
export function codesignArgs(action, executable) {
  if (action === 'remove') return ['--remove-signature', executable];
  if (action === 'sign') return ['--sign', '-', executable];
  throw new Error(
    `未知的 codesign 动作：${String(action)}（允许：${CODESIGN_ACTIONS.join('、')}）`,
  );
}

/**
 * 执行一次 codesign 动作。
 *
 * @param {{ action: 'remove' | 'sign', executable: string, platform?: NodeJS.Platform, run?: typeof spawnSync }} input
 * @returns {{ applied: boolean, command: string, args: string[], output?: string }}
 */
export function runCodesignAction({
  action,
  executable,
  platform = process.platform,
  run = spawnSync,
}) {
  const args = codesignArgs(action, executable);
  // 非 macOS：不调用外部命令（Linux 与 Windows 的产物无需该步骤）
  if (platform !== 'darwin') return { applied: false, command: 'codesign', args };

  const result = run('codesign', args, { encoding: 'utf8' });
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`codesign ${action} 调用失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    const code = result.status === null || result.status === undefined ? '(未知)' : result.status;
    throw new Error(
      `codesign ${action} 退出码 ${String(code)}：${detail === '' ? '(无输出)' : detail}`,
    );
  }
  return {
    applied: true,
    command: 'codesign',
    args,
    output: `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.trim(),
  };
}

/** 注入前：移除 Node 副本上的原有签名（仅 macOS 生效） */
export function removeMacSignature(input) {
  return runCodesignAction({ ...input, action: 'remove' });
}

/** 注入后：ad-hoc 重签（仅 macOS 生效） */
export function adHocSignMac(input) {
  return runCodesignAction({ ...input, action: 'sign' });
}
