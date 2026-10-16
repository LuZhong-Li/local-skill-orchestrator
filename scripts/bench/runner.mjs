#!/usr/bin/env node
/**
 * M3 测量器命令行入口：夹具 → 工作区 → 逐场景 spawn 独立进程 → 采样 → 汇总 → 固定 JSON。
 *
 * 依据：`docs/design/m3-benchmark.md` §3（测量器）与 §4（场景矩阵）、`docs/plan/m3-benchmark.md` T1。
 *
 * 用法：
 *   npm run bench -- --n 100 --form source             # 源码线冒烟
 *   npm run bench -- --n 1000 --form both --runs 3     # 双线三档（T2 口径）
 *   npm run bench -- --n 100 --form sea --dry-run      # 只打印计划，不 spawn
 * 被测进程一律是**独立进程**（工程约定④），墙钟含真实启动开销；采样失败即报错，不用 0 兜底。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SEED, planFixture, writeFixture } from './fixture.mjs';
import { observeWrite } from './fs-watch.mjs';
import {
  FORMS,
  STARTUP_SCENARIO,
  buildMatrix,
  buildReport,
  exitCodeExpected,
  formatReportText,
  scenarioArgv,
  summarizeScenario,
} from './measure.mjs';
import { splitProfile } from './profile-split.mjs';
import { RSS_FAILURE_REASONS, SUPPORTED_PLATFORMS, createSamplerSession } from './rss.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const SOURCE_ENTRY = join(ROOT, 'kernel', 'entry', 'cli.ts');
const DEFAULT_KERNEL = join(ROOT, 'build', 'kernel', 'skill-manager.exe');
const DEFAULT_OUT_DIR = join(ROOT, 'build', 'bench');

/** 毫秒时钟（单调，避免系统时间调整影响墙钟） */
function monotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

export function parseArgs(argv) {
  const options = {
    sizes: [100],
    form: 'source',
    runs: null,
    seed: DEFAULT_SEED,
    kernel: null,
    outDir: DEFAULT_OUT_DIR,
    root: null,
    dryRun: false,
    profile: null,
    load: '本机空闲，开机后尽快跑',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`选项 ${token} 缺少取值`);
      return argv[i];
    };
    if (token === '--n') {
      options.sizes = next()
        .split(/[,\s]+/)
        .filter((part) => part !== '')
        .map((part) => Number(part));
    } else if (token === '--form') options.form = next();
    else if (token === '--runs') options.runs = Number(next());
    else if (token === '--seed') options.seed = Number(next());
    else if (token === '--kernel') options.kernel = next();
    else if (token === '--out') options.outDir = next();
    else if (token === '--root') options.root = next();
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--no-profile') options.profile = false;
    else if (token === '--profile') options.profile = true;
    else if (token === '--load') options.load = next();
    else throw new Error(`未知选项：${token}`);
  }
  if (!FORMS.includes(options.form) && options.form !== 'both') {
    throw new Error(`--form 只支持 ${FORMS.join(' / ')} / both：${options.form}`);
  }
  if (options.sizes.length === 0 || options.sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`--n 必须是正整数（可给多个）：${String(options.sizes)}`);
  }
  if (!Number.isInteger(options.seed))
    throw new Error(`--seed 必须是整数：${String(options.seed)}`);
  return options;
}

/** 跑一次被测命令：spawn → 存活期采样 → 退出码与墙钟（依赖可注入，便于单测） */
export async function runOnce(options) {
  const {
    command,
    args,
    cwd = ROOT,
    logBase,
    spawnChild = spawn,
    sampler,
    now = monotonicMs,
    watch = null,
    onChild = null,
  } = options;

  const startedAt = now();
  const child = spawnChild(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));

  const isAlive = () => child.exitCode === null && child.signalCode === null;
  const handle = sampler.begin(child.pid, { isAlive });
  if (onChild !== null) onChild(child);

  const watching =
    watch === null
      ? null
      : observeWrite({
          ...watch,
          isRunning: isAlive,
          now,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code === null ? -1 : code));
  });
  const wallMs = now() - startedAt;
  const rss = await handle.finish();
  const fsObservation = watching === null ? null : await watching;

  if (logBase !== undefined) {
    mkdirSync(join(logBase, '..'), { recursive: true });
    writeFileSync(`${logBase}.out`, Buffer.concat(stdoutChunks));
    writeFileSync(`${logBase}.err`, Buffer.concat(stderrChunks));
  }

  return {
    run: 0,
    wall_ms: wallMs,
    peak_rss_mb: rss.peakMb,
    rss_ok: rss.ok,
    rss_samples: rss.samples,
    rss_reason: rss.ok ? null : (rss.reason ?? RSS_FAILURE_REASONS.NO_SAMPLE),
    cpu_time_ms: rss.cpuMs,
    exit_code: exitCode,
    profile: null,
    fs_observation: fsObservation,
  };
}

/** 单次运行不带采样器的「准备型」命令（init 等） */
function runQuiet(command, args, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true });
    child.on('close', (code) => resolve(code === null ? -1 : code));
  });
}

/** 读内核版本号（启动开销场景复用同一路径） */
async function kernelVersion(command, argsPrefix, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(command, [...argsPrefix, '--version'], { cwd, windowsHide: true });
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('close', (code) => resolve(code === 0 ? out.trim() : 'unknown'));
  });
}

function sha256OfFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function environmentInfo({ form, kernelPath, kernelVersionText, load }) {
  const cpuList = cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    os_release: release(),
    cpu_model: cpuList[0]?.model ?? 'unknown',
    cpu_count: cpuList.length,
    total_mem_mb: Math.round(totalmem() / 1048576),
    kernel: kernelVersionText,
    kernel_form: form,
    kernel_path: form === 'sea' ? kernelPath : SOURCE_ENTRY,
    kernel_sha256: form === 'sea' ? sha256OfFile(kernelPath) : null,
    load_condition: load,
  };
}

/** 跑一个场景的若干次重复 */
async function measureScenario(context, entry) {
  const { kernelPath, workspace, exportFile, profileDir, logDir, sampler, resetCold } = context;
  const runs = [];
  for (let run = 1; run <= entry.runs; run += 1) {
    if (entry.scenario === 'scan-cold') {
      // 冷态 = 内核视角的「首次扫描」：删掉索引后重新 init，得到与全新工作区等价的状态。
      // 不能只删索引文件：init 是工作区已初始化的标记，缺索引会被判 E-ENV-001。
      await resetCold();
    }
    const profileName =
      entry.form === 'source' && profileDir !== null
        ? `${entry.scenario}-n${String(entry.n ?? 0)}-run${String(run)}.cpuprofile`
        : null;
    const argv = scenarioArgv({
      scenario: entry.scenario,
      workspace,
      exportFile,
      kernelPath: entry.form === 'sea' ? kernelPath : null,
      sourceEntry: SOURCE_ENTRY,
      profileDir,
      profileName,
    });
    const watchIndex =
      entry.scenario === 'scan-cold' || entry.scenario === 'scan-hot'
        ? {
            // 观测索引被重写：尺寸或修改时间变化（热态重写可能是同尺寸，见 fs-watch 注释）
            readStat: () => {
              try {
                const stats = statSync(join(workspace, 'skill_index.yaml'));
                return { size: stats.size, mtimeMs: stats.mtimeMs };
              } catch {
                return null;
              }
            },
            pollMs: 5,
          }
        : null;
    const result = await runOnce({
      ...argv,
      sampler,
      logBase: join(
        logDir,
        `${entry.form}-n${String(entry.n ?? 0)}-${entry.scenario}-run${String(run)}`,
      ),
      watch: watchIndex,
    });
    const profilePath = profileName === null ? null : join(profileDir, profileName);
    const profile =
      profilePath !== null && existsSync(profilePath)
        ? { path: profilePath, ...splitProfile(JSON.parse(readFileSync(profilePath, 'utf8'))) }
        : null;
    runs.push({ ...result, run, profile });
  }

  const indexFile = join(workspace, 'skill_index.yaml');
  const stages = representativeStages(runs);
  const extras = {
    index_bytes: existsSync(indexFile) ? statSync(indexFile).size : null,
    export_bytes:
      entry.scenario === 'export' && existsSync(exportFile) ? statSync(exportFile).size : null,
    startup_ms: context.startupMs,
    fs_observation: runs[0]?.fs_observation ?? null,
    stages,
    index_write_ms: stages?.index_write_ms ?? null,
  };
  return summarizeScenario(entry, runs, extras);
}

/** 取「墙钟中位」那一次的剖面归集（代表性样本；口径写在计划 T1 执行状态里） */
function representativeStages(runs) {
  const profiled = runs.filter((run) => run.profile !== null);
  if (profiled.length === 0) return null;
  const sorted = [...profiled].sort((a, b) => a.wall_ms - b.wall_ms);
  return sorted[Math.floor(sorted.length / 2)].profile;
}

async function measureForm(options, form) {
  const kernelPath = options.kernel ?? DEFAULT_KERNEL;
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'skill-manager-bench-'));
  const outDir = options.outDir;
  const logDir = join(outDir, 'logs');
  const profileDir =
    form === 'source' && options.profile !== false ? join(outDir, 'profile') : null;
  mkdirSync(logDir, { recursive: true });
  if (profileDir !== null) mkdirSync(profileDir, { recursive: true });

  const prefix = (args) =>
    form === 'sea'
      ? { command: kernelPath, args }
      : { command: process.execPath, args: [SOURCE_ENTRY, ...args] };
  const version = await kernelVersion(
    form === 'sea' ? kernelPath : process.execPath,
    form === 'sea' ? [] : [SOURCE_ENTRY],
  );

  const samples = [];
  const failures = [];
  let startupMs = null;
  const sampler = createSamplerSession({ platform: process.platform });
  const warmup = await sampler.warmup();
  if (!process.env.BENCH_QUIET) {
    process.stdout.write(
      `采样会话就绪（${process.platform}）：${warmup.ok ? '预热采样成功' : `预热失败（${String(warmup.reason)}）`}\n`,
    );
  }
  /** 冷态重置：删索引后重新 init（等价于全新工作区，见 measureScenario 注释） */
  const resetCold = async (workspace) => {
    rmSync(join(workspace, 'skill_index.yaml'), { force: true });
    const initPlan = prefix(['init', '--workspace', workspace]);
    if ((await runQuiet(initPlan.command, initPlan.args)) !== 0) {
      throw new Error(`冷态重置失败：${workspace}`);
    }
  };

  const startupEntry = buildMatrix({
    form,
    sizes: [],
    platform: process.platform,
    runs: options.runs,
  }).at(-1);
  if (startupEntry !== undefined) {
    const startup = await measureScenario(
      {
        form,
        kernelPath,
        workspace: root,
        exportFile: join(root, 'bench-export.yaml'),
        profileDir,
        logDir,
        sampler,
        resetCold: () => resetCold(root),
        startupMs: null,
      },
      startupEntry,
    );
    startupMs = startup.wall_ms.median;
    samples.push(startup);
  }

  for (const n of options.sizes) {
    const workspace = join(root, `n${String(n)}`);
    mkdirSync(workspace, { recursive: true });
    const fixtureStarted = monotonicMs();
    const plan = planFixture({ seed: options.seed, n });
    const written = writeFixture(plan, workspace);
    const generationMs = monotonicMs() - fixtureStarted;

    const initPlan = prefix(['init', '--workspace', workspace]);
    if ((await runQuiet(initPlan.command, initPlan.args)) !== 0) {
      throw new Error(`工作区初始化失败：${workspace}`);
    }

    for (const entry of buildMatrix({
      form,
      sizes: [n],
      platform: process.platform,
      runs: options.runs,
    }).filter((item) => item.scenario !== STARTUP_SCENARIO)) {
      const sample = await measureScenario(
        {
          form,
          kernelPath,
          workspace,
          // 导出目标必须在工作区之内（E-PATH-001 会拒绝越界路径），且落在 skills/ 之外不进扫描范围
          exportFile: join(workspace, 'bench-export.yaml'),
          profileDir,
          logDir,
          sampler,
          resetCold: () => resetCold(workspace),
          startupMs,
        },
        entry,
      );
      samples.push(sample);
      const unexpected = sample.exit_codes.filter(
        (code) => !exitCodeExpected(sample.scenario, code),
      );
      if (unexpected.length > 0) {
        failures.push(
          `${sample.scenario}@N=${String(n)}：退出码超出预期码表（${unexpected.join(',')}）`,
        );
      }
      if (sample.peak_rss_mb.max === null) {
        failures.push(
          `${sample.scenario}@N=${String(n)}：峰值 RSS 测量失败（${String(sample.run_details.map((run) => run.rss_reason).join('/'))}）`,
        );
      }
    }

    const report = buildReport({
      environment: environmentInfo({
        form,
        kernelPath,
        kernelVersionText: version,
        load: options.load,
      }),
      fixture: {
        seed: options.seed,
        n,
        files: written.files,
        bytes: written.bytes,
        generation_ms: generationMs,
      },
      samples: samples.filter((sample) => sample.n === n || sample.scenario === STARTUP_SCENARIO),
      generatedAt: new Date().toISOString(),
    });
    const outFile = join(
      outDir,
      `report-${form}-${process.platform}-${process.arch}-n${String(n)}.json`,
    );
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(formatReportText(report));
  }

  await sampler.close();
  return { samples, failures, root };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `测量器参数错误：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    process.stderr.write(
      `暂不支持在 ${process.platform} 上采样峰值 RSS（已实现：${SUPPORTED_PLATFORMS.join(' / ')}）\n`,
    );
    process.exit(1);
  }

  const forms = options.form === 'both' ? FORMS : [options.form];
  if (options.dryRun) {
    for (const form of forms) {
      const matrix = buildMatrix({
        form,
        sizes: options.sizes,
        platform: process.platform,
        runs: options.runs,
      });
      process.stdout.write(
        `${form} 线：${matrix.map((entry) => `${entry.scenario}${entry.n === null ? '' : `@${String(entry.n)}`}×${String(entry.runs)}`).join(' ')}\n`,
      );
    }
    return;
  }

  const failures = [];
  for (const form of forms) {
    const result = await measureForm(options, form);
    failures.push(...result.failures);
  }
  if (failures.length > 0) {
    process.stderr.write(`测量失败项（${String(failures.length)}）：\n${failures.join('\n')}\n`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}

export { measureForm };
