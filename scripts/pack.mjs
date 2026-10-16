#!/usr/bin/env node
/**
 * 跨平台打包入口（macOS / Linux）。Windows 沿用既有 `pack:win`，不经过本入口。
 *
 * 流程由 `scripts/pack-plan.mjs` 规划（纯函数、可单测），本文件只负责执行：
 *   图标生成 → （mac 且宿主为 macOS）icns → 界面构建 → electron-builder → （mac）未签名断言。
 *
 * 签名预留（仅注释，不实现）：证书就位后由「secrets 存在才运行」的签名 job 接管，
 * 涉及的官方 secrets 见 `gui/packaging/electron-builder.yml` 内注释。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackPlan } from './pack-plan.mjs';
import { assertUnsignedApp } from './unsigned-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, 'build', 'desktop');

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === '--platform' && value !== undefined) {
      parsed.platform = value;
      index += 1;
      continue;
    }
    if (key === '--arch' && value !== undefined) {
      parsed.arch = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${String(key)}（用法：--platform mac|linux [--arch arm64|x64]）`);
  }
  if (parsed.platform === undefined) throw new Error('缺少 --platform（mac|linux）');
  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`命令失败（退出码 ${String(result.status)}）：${command} ${args.join(' ')}`);
  }
}

/** 在产物目录下找到第一个 .app（mac 打包后的未签名断言目标） */
function findAppBundle(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name.endsWith('.app')) return path;
      stack.push(path);
    }
  }
  return undefined;
}

try {
  const plan = buildPackPlan(parseArgs(process.argv.slice(2)));
  console.log(`打包计划：${plan.platform}/${plan.arch}`);
  if (plan.icnsSkipped) console.log(`提示：${String(plan.icnsSkipReason)}`);

  for (const step of plan.steps) {
    if (step.kind === 'npm') {
      const args = ['run', step.script];
      if (step.workspace !== undefined) args.push('-w', step.workspace);
      console.log(`→ npm ${args.join(' ')}`);
      run('npm', args, { cwd: ROOT });
      continue;
    }
    console.log(`→ npx ${step.bin} ${step.args.join(' ')}`);
    run('npx', [step.bin, ...step.args], {
      cwd: join(ROOT, step.cwd),
      env: { ...process.env, ...step.env },
    });
  }

  if (plan.unsignedAssertion) {
    if (!existsSync(OUTPUT_DIR)) {
      throw new Error(`产物目录不存在：${OUTPUT_DIR}（打包未产出任何内容）`);
    }
    const app = findAppBundle(OUTPUT_DIR);
    if (app === undefined) {
      throw new Error(`未在 ${OUTPUT_DIR} 下找到 .app 产物，无法执行未签名断言`);
    }
    const result = assertUnsignedApp({ appPath: app });
    console.log(`未签名断言通过：${result.appPath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
