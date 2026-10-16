/**
 * 发布版本守卫：tag 号 = CHANGELOG 顶部版本段 = package.json 的 version，三者一致才允许发布。
 *
 * 依据 M2 设计 6.1 与 T3 裁决 7：版本口径必须是**可失败检查**，不一致时中止且不创建 Release。
 * 解析逻辑为纯函数（可单测）；命令行入口同时支持 `--write-notes`（把该版本段写成
 * Release notes 文件）与 `--allow-mismatch`（仅探测分支自测用：降级为警告，不中止）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 从 tag 解析版本号：接受 `v0.1.0`；不接受缺 v 前缀、非法字符或空值 */
export function parseTagVersion(tag) {
  const matched = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag).trim());
  if (matched === null) {
    throw new Error(`tag 不是合法的发布版本号：${String(tag)}（应形如 v0.1.0）`);
  }
  return matched[1];
}

/**
 * 取 CHANGELOG 顶部**已定版**的版本段（跳过「未发布」这类占位段）。
 * 返回 `{ version, body }`；没有版本段时返回 undefined。
 */
export function topVersionSection(changelogText) {
  const lines = String(changelogText).split('\n');
  let version;
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const matched = /^##\s+(\d+\.\d+\.\d+)\s*$/.exec(line);
    if (matched !== null) {
      version = matched[1];
      start = index + 1;
      break;
    }
  }
  if (version === undefined) return undefined;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { version, body: lines.slice(start, end).join('\n').trim() };
}

/**
 * 三方比对。`packageVersions` 是「来源名 → 版本」的映射（根 package.json 与 gui/package.json）。
 * 返回 `{ ok, version?, reasons }`；`reasons` 为空即通过。
 */
export function checkReleaseConsistency({ tag, changelogText, packageVersions }) {
  const reasons = [];
  let version;
  try {
    version = parseTagVersion(tag);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
    return { ok: false, reasons };
  }

  const section = topVersionSection(changelogText);
  if (section === undefined) {
    reasons.push('CHANGELOG 顶部没有已定版的版本段（形如 `## 0.1.0`）');
  } else if (section.version !== version) {
    reasons.push(`CHANGELOG 顶部版本段为 ${section.version}，与 tag 的 ${version} 不一致`);
  }

  for (const [name, value] of Object.entries(packageVersions)) {
    if (value !== version) {
      reasons.push(`${name} 的 version 为 ${String(value)}，与 tag 的 ${version} 不一致`);
    }
  }

  return { ok: reasons.length === 0, version, reasons };
}

/** 命令行入口 */
function parseArgs(args) {
  const parsed = { allowMismatch: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === '--allow-mismatch') {
      parsed.allowMismatch = true;
      continue;
    }
    if (['--tag', '--changelog', '--package', '--gui-package', '--write-notes'].includes(key)) {
      if (value === undefined) throw new Error(`参数 ${key} 缺少取值`);
      parsed[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${String(key)}`);
  }
  if (parsed.tag === undefined || parsed.changelog === undefined || parsed.package === undefined) {
    throw new Error(
      '用法：--tag v0.1.0 --changelog CHANGELOG.md --package package.json [--gui-package gui/package.json] [--write-notes <路径>] [--allow-mismatch]',
    );
  }
  return parsed;
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
const isEntrypoint = invokedPath !== '' && invokedPath === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const changelogText = readFileSync(args.changelog, 'utf8');
    const packageVersions = {
      [args.package]: JSON.parse(readFileSync(args.package, 'utf8')).version,
    };
    if (args.guiPackage !== undefined) {
      packageVersions[args.guiPackage] = JSON.parse(readFileSync(args.guiPackage, 'utf8')).version;
    }
    const result = checkReleaseConsistency({ tag: args.tag, changelogText, packageVersions });

    if (!result.ok) {
      const detail = result.reasons.join('；');
      if (!args.allowMismatch) {
        console.error(`::error title=版本守卫未通过::${detail}`);
        process.exit(1);
      }
      console.error(`::warning title=版本守卫降级（仅自测）::${detail}`);
    } else {
      console.log(
        `版本守卫通过：tag / CHANGELOG / package.json 三方一致（${String(result.version)}）`,
      );
    }

    if (args.writeNotes !== undefined && result.version !== undefined) {
      const section = topVersionSection(changelogText);
      const body = section === undefined ? '' : section.body;
      writeFileSync(args.writeNotes, `${body}\n`, 'utf8');
      console.log(
        `Release notes 已写出：${args.writeNotes}（版本段 ${section?.version ?? '(无)'}；请求版本 ${result.version}）`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
