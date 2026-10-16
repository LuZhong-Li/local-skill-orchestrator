/**
 * 发布资产归位、校验清单与 GitHub Release 发布（可注入、可 dry-run、幂等）。
 *
 * 依据 M2 设计 6.2 / 6.3 与 T3 裁决 2、4、5、6：
 *   - 交付资产固定为 5 个（Windows nsis + portable、Linux AppImage、macOS dmg ×2）＋ SHA256SUMS.txt；
 *   - 只接受 `refs/tags/v*` 触发的运行，写权限由工作流的 release job 声明（脚本不自提权）；
 *   - 幂等且**收敛**：Release 不存在则创建，存在则复用；无论哪条路径，都显式发布（`--draft=false
 *     --prerelease=false`）后再改标题 / notes 并标记 `--latest`，最后以 `upload --clobber` 覆盖同名资产；
 *   - 不打 prerelease 标记，标记为最新正式 Release。
 *
 * 两条实测得来的硬约束（首跑与干跑各命中一次，均已加回归断言）：
 *   一、gh 在仓库根目录运行，上传资产必须给「汇总目录 + 文件名」的路径，裸文件名会 `no matches found`；
 *   二、新建的 Release 可能处于 draft，此时 `--latest` 会被 GitHub 拒绝（HTTP 422），必须先发布。
 *
 * gh 参数已按官方手册核对（EX-04 关闭）：`create` 支持 `--title/--notes-file/--verify-tag`，
 * `edit` 支持 `--title/--notes-file/--latest/--draft/--prerelease`，`upload` 支持 `--clobber`。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 交付资产的文件名模板（与 electron-builder 的 artifactName 口径一致） */
export function expectedAssets(version) {
  return [
    `skill-manager-${version}-x64.exe`,
    `skill-manager-${version}-portable.exe`,
    // Linux 上 electron-builder 的 ${arch} 取 x86_64（不是 x64）——T3 干跑实测确认
    `skill-manager-${version}-x86_64.AppImage`,
    `skill-manager-${version}-arm64.dmg`,
    `skill-manager-${version}-x64.dmg`,
  ];
}

/** 校验清单文件名 */
export const CHECKSUM_FILE = 'SHA256SUMS.txt';

/**
 * 归位检查：交付目录里必须**恰好**出现全部预期资产（缺失即失败；诊断包等非交付物不得混入）。
 * 返回按预期顺序排列的文件名。
 */
export function stageReleaseAssets({ present, version }) {
  const expected = expectedAssets(version);
  const missing = expected.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `发布资产缺失：${missing.join('、')}（实际存在：${present.join('、') || '无'}）`,
    );
  }
  const unexpected = present.filter((name) => !expected.includes(name) && name !== CHECKSUM_FILE);
  if (unexpected.length > 0) {
    throw new Error(`发布目录出现非交付物：${unexpected.join('、')}`);
  }
  return expected;
}

/** 生成校验清单内容：`<sha256>  <文件名>`（每行一项，文件名按预期顺序） */
export function buildChecksumManifest({ dir, files, readFile = readFileSync }) {
  return files
    .map((name) => {
      const hash = createHash('sha256')
        .update(readFile(join(dir, name)))
        .digest('hex');
      return `${hash}  ${name}`;
    })
    .join('\n');
}

/**
 * gh 参数拼装（纯函数，便于核对与单测）。返回按序执行的命令列表：
 *   1. create（仅当 Release 不存在）
 *   2. publish（收敛发布态：draft / prerelease 一律置否）
 *   3. edit（标题 / notes / latest）
 *   4. upload（`--clobber` 覆盖同名资产）
 *
 * `assets` 与 `checksumFile` 必须是**相对当前工作目录可用**的路径（见文件头说明）。
 */
export function ghArgs({ exists, tag, title, notesFile, assets, checksumFile }) {
  const steps = [];
  if (!exists) {
    steps.push({
      step: 'create',
      command: 'gh',
      args: ['release', 'create', tag, '--title', title, '--notes-file', notesFile, '--verify-tag'],
    });
  }
  steps.push({
    step: 'publish',
    command: 'gh',
    args: ['release', 'edit', tag, '--draft=false', '--prerelease=false'],
  });
  steps.push({
    step: 'edit',
    command: 'gh',
    args: ['release', 'edit', tag, '--title', title, '--notes-file', notesFile, '--latest'],
  });
  steps.push({
    step: 'upload',
    command: 'gh',
    args: ['release', 'upload', tag, '--clobber', checksumFile, ...assets],
  });
  return steps;
}

/** Release 是否已存在（只读判断，dry-run 也会执行） */
export function releaseExists({ tag, run = spawnSync }) {
  const result = run('gh', ['release', 'view', tag, '--json', 'tagName'], { encoding: 'utf8' });
  return result.status === 0;
}

/** 执行（或 dry-run 打印）发布动作 */
export function publishRelease({
  tag,
  title,
  notesFile,
  assets,
  checksumFile,
  exists,
  dryRun = false,
  run = spawnSync,
}) {
  const commands = ghArgs({ exists, tag, title, notesFile, assets, checksumFile });
  if (dryRun) {
    for (const command of commands) {
      console.log(`[dry-run] ${command.command} ${command.args.join(' ')}`);
    }
    return { dryRun: true, commands };
  }
  for (const command of commands) {
    console.log(`→ ${command.command} ${command.args.join(' ')}`);
    const result = run(command.command, command.args, { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(
        `${command.step} 失败（退出码 ${String(result.status)}）：gh ${command.args.join(' ')}`,
      );
    }
  }
  return { dryRun: false, commands };
}

/** 命令行入口 */
function parseArgs(args) {
  const parsed = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (['--dir', '--version', '--tag', '--title', '--notes'].includes(key)) {
      if (value === undefined) throw new Error(`参数 ${key} 缺少取值`);
      parsed[key.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${String(key)}`);
  }
  for (const required of ['dir', 'version', 'tag', 'notes']) {
    if (parsed[required] === undefined) throw new Error(`缺少参数 --${required}`);
  }
  return parsed;
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
const isEntrypoint = invokedPath !== '' && invokedPath === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const present = readdirSync(args.dir);
    const assets = stageReleaseAssets({ present, version: args.version });

    const manifest = buildChecksumManifest({ dir: args.dir, files: assets });
    const checksumPath = join(args.dir, CHECKSUM_FILE);
    writeFileSync(checksumPath, `${manifest}\n`, 'utf8');
    console.log(`校验清单已生成：${checksumPath}`);
    // 资产清单与校验清单进运行页注解：未登录会话也能核对（T3 的公开证据）
    console.log(`::notice title=发布资产清单::${assets.join('、')}`);
    console.log(`::notice title=SHA256SUMS::${manifest.replace(/\n/g, ' | ')}`);

    const exists = releaseExists({ tag: args.tag });
    console.log(`Release 已存在：${exists ? '是（复用 + 覆盖资产）' : '否（创建）'}`);
    publishRelease({
      tag: args.tag,
      title: args.title ?? args.tag,
      notesFile: args.notes,
      // gh 在仓库根目录运行：资产与清单都按「汇总目录 + 文件名」给出
      assets: assets.map((name) => join(args.dir, name)),
      checksumFile: checksumPath,
      exists,
      dryRun: args.dryRun,
    });
    console.log(
      args.dryRun ? '发布预演完成（未创建任何 Release）' : `发布完成：${args.title ?? args.tag}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
