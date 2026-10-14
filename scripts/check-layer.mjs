#!/usr/bin/env node
/**
 * 构建期强制检查：分层不越界。
 *
 * 依据：架构文档 6.4 节「构建期强制检查」第 4 条与第 5 条，以及 2.3 节的越权规则。
 * 断言三件事：
 *   1. 内核包不依赖任何界面框架；
 *   2. 桌面外壳不直接引用内核的内部模块，只能使用内核的对外入口；
 *   3. 内核不反向引用桌面外壳。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 界面框架及其运行时：内核包中出现即为越界 */
const GUI_FRAMEWORK_PATTERN =
  /^(electron|electron-vite|electron-builder|electron-updater|@electron\/|tauri|@tauri-apps\/|react|react-dom|preact|vue|@vue\/|svelte|@sveltejs\/|@angular\/)/;

/** 内核的内部模块路径：界面不得直接引用 */
const KERNEL_INTERNAL_PATTERN = /kernel\/(dispatch|core|store|entry)\//;

const failures = [];

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
  } catch (error) {
    failures.push(`无法读取 ${relativePath}：${error.message}`);
    return null;
  }
}

function collectSourceFiles(relativeDir) {
  const absolute = join(ROOT, relativeDir);
  const collected = [];
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const child = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collected.push(...collectSourceFiles(child));
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      collected.push(child);
    }
  }
  return collected;
}

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

// 1. 根清单必须声明两个工作区
const rootManifest = readJson('package.json');
if (rootManifest) {
  const workspaces = rootManifest.workspaces ?? [];
  for (const expected of ['kernel', 'gui']) {
    if (!workspaces.includes(expected)) {
      failures.push(`根清单的 workspaces 未声明 ${expected}/`);
    }
  }
}

// 2. 内核包不得依赖界面框架
const kernelManifest = readJson('kernel/package.json');
if (kernelManifest) {
  const declared = [
    ...Object.keys(kernelManifest.dependencies ?? {}),
    ...Object.keys(kernelManifest.devDependencies ?? {}),
    ...Object.keys(kernelManifest.peerDependencies ?? {}),
  ];
  const offenders = declared.filter((name) => GUI_FRAMEWORK_PATTERN.test(name));
  if (offenders.length) {
    failures.push(`内核包声明了界面框架依赖：${offenders.join('、')}`);
  }
}

// 3. 桌面外壳不得直接引用内核内部模块
for (const file of collectSourceFiles('gui')) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  for (const specifier of importSpecifiers(source)) {
    if (KERNEL_INTERNAL_PATTERN.test(specifier)) {
      failures.push(`${file} 直接引用了内核内部模块：${specifier}`);
    }
  }
}

// 4. 内核不得反向引用桌面外壳
for (const file of collectSourceFiles('kernel')) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  for (const specifier of importSpecifiers(source)) {
    if (/(^|\/)gui\//.test(specifier) || GUI_FRAMEWORK_PATTERN.test(specifier)) {
      failures.push(`${file} 反向引用了界面侧：${specifier}`);
    }
  }
}

// 5. 两个工作区各自必须有清单与编译配置
for (const pkg of ['kernel', 'gui']) {
  for (const file of ['package.json', 'tsconfig.json']) {
    const path = join(pkg, file);
    try {
      statSync(join(ROOT, path));
    } catch {
      failures.push(`缺少工作区文件：${relative(ROOT, join(ROOT, path))}`);
    }
  }
}

if (failures.length) {
  console.error('分层校验失败：');
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}

console.log('分层校验通过：内核零界面依赖，界面未越层引用内核内部模块。');
