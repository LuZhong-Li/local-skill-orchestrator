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
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackPlan } from './pack-plan.mjs';
import { assertUnsignedApp } from './unsigned-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, 'build', 'desktop');
/** 阶段标记与打包器完整输出：失败时随诊断产物一起上传，使失败点无需登录即可定位 */
const STAGE_FILE = join(OUTPUT_DIR, 'pack-stage.txt');
const DEBUG_LOG = join(OUTPUT_DIR, 'pack-debug.log');

/** 记录阶段（开始/结束各一条），同时打到标准输出便于 CI 日志阅读 */
function markStage(phase) {
  const line = `${new Date().toISOString()} ${phase}`;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  appendFileSync(STAGE_FILE, `${line}\n`, 'utf8');
  console.log(`[stage] ${line}`);
}

/** 运行命令并把完整输出 tee 到诊断日志（失败时注解可从日志取末行） */
function runWithTee(command, args, options = {}, logPath = DEBUG_LOG) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  const combined = `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  appendFileSync(logPath, combined, 'utf8');
  process.stdout.write(combined);
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`命令调用失败：${command} ${args.join(' ')}：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `命令失败（退出码 ${String(result.status)}）：${command} ${args.join(' ')}（详见 build/desktop/pack-debug.log）`,
    );
  }
  return result;
}

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
  // 每次运行重开阶段文件：失败时它必须描述的是本次运行
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(STAGE_FILE, '', 'utf8');

  for (const step of plan.steps) {
    if (step.kind === 'npm') {
      const args = ['run', step.script];
      if (step.workspace !== undefined) args.push('-w', step.workspace);
      console.log(`→ npm ${args.join(' ')}`);
      markStage(`开始 npm ${args.join(' ')}`);
      run('npm', args, { cwd: ROOT });
      markStage(`完成 npm ${args.join(' ')}`);
      continue;
    }
    console.log(`→ npx ${step.bin} ${step.args.join(' ')}`);
    markStage(`开始 npx ${step.bin} ${step.args.join(' ')}`);
    runWithTee(
      'npx',
      [step.bin, ...step.args],
      {
        cwd: join(ROOT, step.cwd),
        env: { ...process.env, ...step.env },
        shell: process.platform === 'win32',
      },
      DEBUG_LOG,
    );
    markStage(`完成 npx ${step.bin} ${step.args.join(' ')}`);
  }

  if (plan.unsignedAssertion) {
    markStage('开始 macOS 未签名断言');
    if (!existsSync(OUTPUT_DIR)) {
      throw new Error(`产物目录不存在：${OUTPUT_DIR}（打包未产出任何内容）`);
    }
    const app = findAppBundle(OUTPUT_DIR);
    if (app === undefined) {
      throw new Error(`未在 ${OUTPUT_DIR} 下找到 .app 产物，无法执行未签名断言`);
    }
    const result = assertUnsignedApp({ appPath: app });
    console.log(`未签名断言通过：${result.appPath}`);
    markStage(`完成 macOS 未签名断言（${result.appPath}）`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
