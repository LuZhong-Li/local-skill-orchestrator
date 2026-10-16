#!/usr/bin/env node
/**
 * 生成应用图标（构建期）。
 *
 * 渲染与编码的实现在 `scripts/icon-render.mjs`（纯函数模块），本文件只是命令行入口：
 * 把产物写到 `gui/packaging/` 下，供 electron-builder 的 `win.icon` / `linux.icon` /
 * `mac.icon` 引用。
 *
 * 入库策略（M2 设计 5.3）：`icon.ico` 与 `icon.png` 维持入库；`icons/`、`icon.iconset/`
 * 与 `icon.icns` 由构建期生成、不入库——图标的唯一来源是本脚本链，避免二进制副本漂移。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIconArtifacts } from './icon-render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'gui', 'packaging');

const written = writeIconArtifacts(OUT_DIR);

console.log(
  `图标已生成（${String(written.length)} 个文件）：packaging/icon.ico、packaging/icon.png、` +
    'packaging/icons/*.png、packaging/icon.iconset/*.png',
);
