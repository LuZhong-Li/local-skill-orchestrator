#!/usr/bin/env node
/**
 * 把内核构建为独立可执行文件（AD-09 的分发形态）。
 *
 * 三步：
 *   一、用 esbuild 把内核入口连同依赖打成单个 CommonJS 文件；
 *   二、用 Node 的单文件可执行配置生成代码块；
 *   三、把代码块注入当前 Node 运行时的副本，得到 `build/kernel/skill-manager.exe`。
 *
 * macOS 上的签名处理（Node 官方流程）：注入前后各一次 codesign——注入前
 * `--remove-signature`，注入后 `--sign -`（ad-hoc）。缺这一步时注入会破坏签名，
 * arm64 会在打包期签名校验失败（EX-07 根因）；Linux 与 Windows 不涉及。
 *
 * 产物被 electron-builder 复制到 `resources/kernel/`，主进程按该路径调用。
 * 中间文件放在 intermediate/ 子目录，成功后清理，避免随包分发。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { adHocSignMac, removeMacSignature } from './sea-signing.mjs';
import { postjectArgs } from './sea-postject.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build', 'kernel');
const WORK_DIR = join(OUT_DIR, 'intermediate');
const BUNDLE = join(WORK_DIR, 'kernel.cjs');
const BLOB = join(WORK_DIR, 'kernel.blob');
const SEA_CONFIG = join(WORK_DIR, 'sea-config.json');
const EXECUTABLE = join(OUT_DIR, 'skill-manager.exe');

function fail(message) {
  console.error(`内核构建失败：${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.quiet === true ? 'pipe' : 'inherit',
    // 全部以可执行文件加参数数组调用，不经 shell，避免参数拼接带来的注入面
    shell: false,
    ...(options.quiet === true ? { encoding: 'utf8' } : {}),
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} 退出码 ${String(result.status)}`);
  }
  return result;
}

mkdirSync(WORK_DIR, { recursive: true });

// 一、打包：内核只依赖 yaml，一并打进产物，运行期不需要额外的 node_modules
await build({
  entryPoints: [join(ROOT, 'kernel', 'entry', 'exe.ts')],
  outfile: BUNDLE,
  bundle: true,
  platform: 'node',
  target: 'node22',
  // 单文件可执行只支持 CommonJS，因此内核的两个入口都不使用顶层 await
  format: 'cjs',
  logLevel: 'info',
  banner: { js: '/* 由 scripts/build-kernel.mjs 生成，请勿手工修改 */' },
});

// 二、生成代码块
writeFileSync(
  SEA_CONFIG,
  JSON.stringify(
    {
      main: BUNDLE,
      output: BLOB,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);
if (!existsSync(BLOB)) fail('未生成代码块');

// 三、注入到 Node 运行时的副本
copyFileSync(process.execPath, EXECUTABLE);

// 注入前移除原有签名（仅 macOS 生效；其他平台为空操作，不调用外部命令）
const removed = removeMacSignature({ executable: EXECUTABLE });
if (removed.applied) console.log(`已移除 Node 副本签名：${removed.args.join(' ')}`);

// 注入参数由 scripts/sea-postject.mjs 唯一提供：macOS 必须带 --macho-segment-name（EX-13）
run(
  process.execPath,
  [
    join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    ...postjectArgs({ executable: EXECUTABLE, blob: BLOB }),
  ],
  { quiet: true },
);

// 注入后 ad-hoc 重签（仅 macOS 生效），使产物在 arm64 打包期通过签名校验
const signed = adHocSignMac({ executable: EXECUTABLE });
if (signed.applied) console.log(`已对内核可执行文件 ad-hoc 重签：${signed.args.join(' ')}`);

rmSync(WORK_DIR, { recursive: true, force: true });
console.log(`内核可执行文件已生成：${EXECUTABLE}`);
