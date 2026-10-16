/**
 * M3 三平台峰值内存（与 CPU 时间）采样器。
 *
 * 依据：`docs/design/m3-benchmark.md` §1.1（口径与同量纲实测）与 §3.2（采样器与握手）。
 *
 * 三条不可让步的规则（调研踩过的两个坑都出自这里）：
 *   一、**只在存活期采样**：子进程退出后不读、不补零（否则 Linux 读 /proc 直接 ENOENT、
 *       macOS/Windows 空读被静默记成 0 MB）；
 *   二、**READY = 首次成功取到合法值**（值 > 0）：首次成功之前一律不记样本；
 *   三、**采样失败即报错**：直到退出都没取到合法值 → `ok: false` + 原因，峰值记 `null`。
 *
 * 会话与握手（实测校正：逐次启动采样器会把短进程整段漏掉——Windows 上 PowerShell 冷启动约
 * 300 ms，而 N=100 的 `scan` 只有约 200 ms）：每个测量会话只启动**一个长驻采样助手**，会话
 * 开始时先用父进程自身 pid 做一次**预热采样**；此后被测进程一 spawn 就能立刻采样。
 */
import { spawn as spawnProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 已实现的平台（其余平台明确报错，不回落默认口径） */
export const SUPPORTED_PLATFORMS = ['linux', 'darwin', 'win32'];

/** 抽样间隔（毫秒）：按平台的代价与精度平衡，见设计 §3.2 表 */
export const SAMPLE_INTERVAL_MS = { linux: 10, darwin: 25, win32: 50 };

/** 采样失败的原因取值（进入报告，便于归档比对） */
export const RSS_FAILURE_REASONS = {
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
  NO_SAMPLE: 'no-sample-before-exit',
  HELPER_UNAVAILABLE: 'sampler-helper-unavailable',
};

/** 单次采样交给助手的迭代上限（目标进程消失时助手提前结束，这里只是兜底） */
export const MAX_SAMPLE_ITERATIONS = 12000;

/** 目标进程退出后，等助手回报 END 的宽限（毫秒） */
export const SESSION_GRACE_MS = 2000;

/** 等待助手的绝对上限（毫秒）：目标进程卡死时的兜底，避免把测量挂住 */
export const MAX_SESSION_WAIT_MS = 600_000;

/** 千字节 → 兆字节（保留一位小数，避免报告里出现浮点长尾） */
function kbToMb(kb) {
  return Math.round((kb / 1024) * 10) / 10;
}

/** 解析 /proc/<pid>/status 的 VmHWM（单位 kB）→ MB；无该行或非正值返回 null */
export function parseVmHwm(statusText) {
  const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(String(statusText));
  if (match === null) return null;
  const kb = Number(match[1]);
  return kb > 0 ? kbToMb(kb) : null;
}

/** 解析 /proc/<pid>/stat 的 utime+stime（第 14/15 字段，单位 clock tick）→ 毫秒 */
export function parseProcStatCpuMs(statText, clockTicksPerSecond = 100) {
  const text = String(statText);
  // comm 字段可能含空格与括号，按最后一个右括号之后的字段切分
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return Math.round(((utime + stime) / clockTicksPerSecond) * 1000);
}

/** 解析 ps -o rss=,time= -p <pid> 的输出行（rss 为 kB，time 为 MM:SS.ss 或 HH:MM:SS） */
export function parsePsSample(line) {
  const text = String(line).trim();
  if (text === '') return null;
  const match = /^(\d+)\s+(\d+:)?(\d{1,2}:\d{2}(?:\.\d+)?)$/.exec(text);
  if (match === null) return null;
  const kb = Number(match[1]);
  if (!(kb > 0)) return null;
  const parts = match[3].split(':');
  const seconds = Number(parts.at(-1));
  const minutes = parts.length === 2 ? Number(parts[0]) : 0;
  const hours = match[2] === undefined ? 0 : Number(match[2].slice(0, -1));
  return { peakMb: kbToMb(kb), cpuMs: Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000) };
}

/** 解析 Windows 采样器输出行 peakBytes cpuSeconds（两值均可为空） */
export function parsePowerShellSample(line) {
  const text = String(line).trim();
  if (text === '') return null;
  const parts = text.split(/\s+/);
  const bytes = Number(parts[0]);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const seconds = parts[1] === undefined ? Number.NaN : Number(parts[1]);
  return {
    peakMb: Math.round((bytes / 1024 / 1024) * 10) / 10,
    cpuMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
  };
}

/** 解析助手输出行 SAMPLE <pid> <值…>；pid 不符或值非法则返回 null */
export function parseHelperSample(platform, line, pid) {
  const parts = String(line).trim().split(/\s+/);
  if (parts[0] !== 'SAMPLE' || Number(parts[1]) !== pid) return null;
  const payload = parts.slice(2).join(' ');
  return platform === 'darwin' ? parsePsSample(payload) : parsePowerShellSample(payload);
}

/** 汇总一批已解析采样值：峰值取最大、CPU 取末次、计数为合法样本数 */
export function collectSamples(samples) {
  let peakMb = null;
  let cpuMs = null;
  for (const sample of samples) {
    peakMb = peakMb === null ? sample.peakMb : Math.max(peakMb, sample.peakMb);
    if (sample.cpuMs !== null) cpuMs = sample.cpuMs;
  }
  return { peakMb, cpuMs, samples: samples.length };
}

/** 长驻采样助手命令：stdin 逐行收 pid 与迭代数，采样后回报 END pid */
export function samplerSessionScript(platform, intervalMs = SAMPLE_INTERVAL_MS[platform]) {
  if (platform === 'darwin') {
    return {
      command: 'sh',
      args: [
        '-c',
        [
          'while read -r target count; do',
          '  [ -z "$target" ] && continue',
          '  i=0',
          '  while [ "$i" -lt "$count" ] && kill -0 "$target" 2>/dev/null; do',
          '    sample=$(ps -o rss=,time= -p "$target" 2>/dev/null)',
          '    [ -n "$sample" ] && echo "SAMPLE $target $sample"',
          `    sleep ${String(intervalMs / 1000)}`,
          '    i=$((i+1))',
          '  done',
          '  echo "END $target"',
          'done',
        ].join('\n'),
      ],
    };
  }
  if (platform === 'win32') {
    const script = [
      'while ($true) {',
      '  $line = [Console]::In.ReadLine()',
      '  if ($null -eq $line) { break }',
      "  $parts = $line.Trim().Split(' ')",
      '  $targetPid = [int]$parts[0]',
      '  $iterations = [int]$parts[1]',
      '  for ($i = 0; $i -lt $iterations; $i++) {',
      '    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue',
      '    if ($null -eq $p) { break }',
      '    $p.Refresh()',
      '    try { $cpu = $p.TotalProcessorTime.TotalSeconds } catch { $cpu = $null }',
      '    [Console]::Out.WriteLine("SAMPLE $targetPid $($p.PeakWorkingSet64) $cpu")',
      '    [Console]::Out.Flush()',
      `    Start-Sleep -Milliseconds ${String(intervalMs)}`,
      '  }',
      '  [Console]::Out.WriteLine("END $targetPid")',
      '  [Console]::Out.Flush()',
      '}',
    ].join('\n');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
    };
  }
  throw new Error(`未实现的采样平台：${String(platform)}`);
}

/**
 * 建立采样会话（每个测量会话一个、长期复用；依赖可注入便于单测）。
 *
 *   - `warmup()`：用父进程自身 pid 做一次短采样，确认助手已就绪（不预热就会漏掉 N=100 这类短场景）；
 *   - `begin(pid, { isAlive, iterations })`：目标进程 spawn 后**立刻**调用，开始存活期采样；
 *   - `close()`：会话结束，关掉助手。
 */
export function createSamplerSession(options = {}) {
  const {
    platform = process.platform,
    spawn = spawnProcess,
    readFile = readFileSync,
    now = () => Number(process.hrtime.bigint() / 1000000n),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = SAMPLE_INTERVAL_MS[platform],
    graceMs = SESSION_GRACE_MS,
    maxWaitMs = MAX_SESSION_WAIT_MS,
  } = options;

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    const failure = {
      ok: false,
      peakMb: null,
      cpuMs: null,
      samples: 0,
      reason: RSS_FAILURE_REASONS.UNSUPPORTED_PLATFORM,
    };
    return {
      warmup: async () => failure,
      begin: () => ({ finish: async () => failure }),
      close: async () => undefined,
    };
  }

  let helper = null;
  let helperBroken = false;
  const lines = [];

  const ensureHelper = () => {
    if (helper !== null || helperBroken) return helper;
    const { command, args } = samplerSessionScript(platform, intervalMs);
    try {
      helper = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      helper.stdout.setEncoding('utf8');
      let buffer = '';
      helper.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          lines.push(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      });
      helper.on('error', () => {
        helperBroken = true;
      });
    } catch {
      helperBroken = true;
    }
    return helper;
  };

  const sampleLinux = async (pid, isAlive) => {
    const samples = [];
    while (isAlive()) {
      try {
        const mb = parseVmHwm(readFile(`/proc/${String(pid)}/status`, 'utf8'));
        if (mb !== null) {
          let cpuMs = null;
          try {
            cpuMs = parseProcStatCpuMs(readFile(`/proc/${String(pid)}/stat`, 'utf8'));
          } catch {
            cpuMs = null;
          }
          samples.push({ peakMb: mb, cpuMs });
        }
      } catch {
        // 进程已退出时 /proc 条目消失：这不等于「0 内存」，只是不再可采样
      }
      await sleep(intervalMs);
    }
    return samples;
  };

  const failureOf = (reason, startedAt) => ({
    ok: false,
    peakMb: null,
    cpuMs: null,
    samples: 0,
    reason,
    elapsed_ms: now() - startedAt,
  });

  const begin = (pid, { isAlive, iterations = MAX_SAMPLE_ITERATIONS }) => {
    const startedAt = now();
    const from = lines.length;
    const writePromise = (() => {
      if (platform === 'linux') return null;
      const handle = ensureHelper();
      if (handle === null || helperBroken) return null;
      try {
        handle.stdin.write(`${String(pid)} ${String(iterations)}\n`);
      } catch {
        helperBroken = true;
      }
      return null;
    })();
    const linuxPromise = platform === 'linux' ? sampleLinux(pid, isAlive) : writePromise;

    return {
      async finish() {
        if (platform === 'linux') {
          const samples = (await linuxPromise) ?? [];
          return samples.length === 0
            ? failureOf(RSS_FAILURE_REASONS.NO_SAMPLE, startedAt)
            : { ok: true, ...collectSamples(samples), reason: null, elapsed_ms: now() - startedAt };
        }
        if (helperBroken || helper === null) {
          return failureOf(RSS_FAILURE_REASONS.HELPER_UNAVAILABLE, startedAt);
        }
        // 助手在目标进程消失后立刻回报 END。等待规则：进程存活时一直等；退出后只再等宽限期；
        // 另设绝对上限，避免目标进程卡死时把测量挂住（这是实测踩到的挂起坑）。
        const absoluteDeadline = graceMs + maxWaitMs;
        let exitedAt = null;
        for (;;) {
          if (lines.slice(from).some((line) => line.trim() === `END ${String(pid)}`)) break;
          if (!isAlive()) exitedAt = exitedAt ?? now();
          if (exitedAt !== null && now() - exitedAt > graceMs) break;
          if (now() - startedAt > absoluteDeadline) break;
          await sleep(10);
        }
        const samples = lines
          .slice(from)
          .map((line) => parseHelperSample(platform, line, pid))
          .filter((sample) => sample !== null);
        return samples.length === 0
          ? failureOf(RSS_FAILURE_REASONS.NO_SAMPLE, startedAt)
          : { ok: true, ...collectSamples(samples), reason: null, elapsed_ms: now() - startedAt };
      },
    };
  };

  return {
    async warmup(iterations = 3) {
      if (platform === 'linux') return { ok: true, reason: null };
      const handle = begin(process.pid, { isAlive: () => true, iterations });
      return handle.finish();
    },
    begin,
    async close() {
      if (helper !== null) {
        try {
          helper.stdin.end();
          helper.kill();
        } catch {
          // 会话收尾失败不影响测量结论
        }
      }
    },
  };
}
