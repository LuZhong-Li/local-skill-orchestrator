#!/usr/bin/env node
/**
 * 缩减冒烟：内核侧可执行性检查（M1 的远端冒烟口径）。
 *
 * 只检查**不依赖真实窗口**的部分——构建产物（内核单文件可执行）能否启动、能否跑通
 * 最小指令闭环。界面冒烟（三种启动方式）留在本地执行：远端不启动 Electron
 * （设计 docs/design/m1-ci.md 第 5.4 条、第 11 章 DP-B）。
 *
 * 三条检查各自可失败、失败即非零退出并给出可定位信息：
 *   一、构建产物存在；
 *   二、`--version` 可运行且输出版本号；
 *   三、`init` → `scan` → `list --json` 最小闭环成功，且索引文件落地。
 *
 * 工作区一律用系统临时目录，且不触碰任何真实宿主目录（M5 的宿主分发通道在本脚本中完全不涉及）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_EXECUTABLE = join(ROOT, 'build', 'kernel', 'skill-manager.exe');

function fail(message) {
  console.error(`内核冒烟失败：${message}`);
  process.exit(1);
}

function runKernel(args) {
  const result = spawnSync(KERNEL_EXECUTABLE, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// 一、构建产物存在（构建步骤的产物名由 scripts/build-kernel.mjs 决定）
if (!existsSync(KERNEL_EXECUTABLE)) {
  fail(`未找到内核可执行文件：${KERNEL_EXECUTABLE}；请先运行 npm run build`);
}

// 二、可运行且输出版本号
const version = runKernel(['--version']);
if (version.status !== 0) {
  fail(`内核 --version 退出码 ${String(version.status)}：${version.stderr.trim()}`);
}
const reported = version.stdout.trim();
if (!/^\d+\.\d+\.\d+/.test(reported)) {
  fail(`内核 --version 未输出版本号：${JSON.stringify(reported)}`);
}
console.log(`内核可执行文件可运行，版本 ${reported}`);

// 三、最小闭环：init → scan → list
const workspace = mkdtempSync(join(tmpdir(), 'smoke-kernel-'));
try {
  const init = runKernel(['init', '--workspace', workspace]);
  if (init.status !== 0) {
    fail(`init 退出码 ${String(init.status)}：${init.stderr.trim()}${init.stdout.trim()}`);
  }
  const indexFile = join(workspace, 'skill_index.yaml');
  if (!existsSync(indexFile)) {
    fail(`init 未生成索引：${indexFile}`);
  }

  const scan = runKernel(['scan', '--workspace', workspace]);
  if (scan.status !== 0) {
    fail(`scan 退出码 ${String(scan.status)}：${scan.stderr.trim()}${scan.stdout.trim()}`);
  }

  const list = runKernel(['list', '--workspace', workspace, '--json']);
  if (list.status !== 0) {
    fail(`list 退出码 ${String(list.status)}：${list.stderr.trim()}`);
  }
  let payload;
  try {
    payload = JSON.parse(list.stdout);
  } catch (error) {
    fail(`list 输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (payload?.ok !== true) {
    fail(`list 结果封装 ok 不为真：${list.stdout.trim()}`);
  }
  console.log(`最小闭环通过：init → scan → list（工作区 ${workspace}）`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log('内核冒烟通过（缩减口径：不含界面三启动方式，后者在本地执行）');
