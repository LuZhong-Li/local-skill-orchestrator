#!/usr/bin/env node
/**
 * 桌面外壳的构建与打包。
 *
 * 现状：界面源码与 Electron 依赖已引入，本脚本调用 electron-vite 构建三端产物。
 * 打包为安装包与免安装单文件由 gui/package.json 的 pack:win 负责，需要 electron-builder 下载对应平台运行时。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npm', ['run', 'build', '-w', '@skill-manager/gui'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
