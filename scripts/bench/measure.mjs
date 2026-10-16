/**
 * M3 测量器的纯逻辑层：场景矩阵、命令拼装、样本汇总与报告格式。
 *
 * 依据：`docs/design/m3-benchmark.md` §3.3（冷热两态与命令固定）与 §3.6（输出 JSON 契约）。
 * 本模块不做 IO、不 spawn：执行编排在 `runner.mjs`（可注入 `spawn` / 时钟 / 采样器）。
 */

/** 报告 schema 标识（与设计 §3.6 一致，契约测试逐项比对） */
export const REPORT_SCHEMA = 'bench/1';

/** 支持的两条线：源码 `node` 与发布单文件（SEA） */
export const FORMS = ['source', 'sea'];

/** 需要计时的四类被测场景（启动开销另算，见 `STARTUP_SCENARIO`） */
export const MEASURED_SCENARIOS = ['scan-cold', 'scan-hot', 'validate', 'export'];

/** 启动开销场景：与档位无关，每形态一次 */
export const STARTUP_SCENARIO = 'startup';

/** 场景 → 冷热态（启动开销无状态） */
export const SCENARIO_STATE = {
  'scan-cold': 'cold',
  'scan-hot': 'hot',
  validate: 'hot',
  export: 'hot',
  [STARTUP_SCENARIO]: null,
};

/**
 * 每个场景**允许的退出码**。
 *
 * 夹具刻意含不合格项（8% 无效样本 + 5% 悬空依赖），因此 `scan` / `validate` 返回非 0 是
 * **预期语义**（「扫描 / 校验完成，但环境中存在不合格项」），不是测量失败：
 *   - `scan`：派生规则口径，实测 1（FIELD 类）或 3（含 `E-YAML-001` 时的 YAML 类档位）；
 *   - `validate`：指令契约 4.12 的专属口径，存在错误级问题即 1；
 *   - `export`：导出属只读动作，实测码见 T1 执行状态（预期 0 或 1）；
 *   - `startup`：`--version` 必须 0。
 * 超出该表取值即为**失败样本**（参数 / 文件系统 / 远端 / 依赖类档位说明测量链路出了问题）。
 */
export const EXPECTED_EXIT_CODES = {
  'scan-cold': [0, 1, 3],
  'scan-hot': [0, 1, 3],
  validate: [0, 1],
  export: [0, 1],
  [STARTUP_SCENARIO]: [0],
};

/** 判断一次运行的退出码是否在预期码表内 */
export function exitCodeExpected(scenario, code) {
  const allowed = EXPECTED_EXIT_CODES[scenario];
  if (allowed === undefined) throw new Error(`未登记的场景：${String(scenario)}`);
  return allowed.includes(code);
}

/**
 * 重复次数口径：默认 3（中位 + 极值）；Windows 上 N=5000 默认 1（BX-03 显式例外）。
 * `requested` 由命令行 `--runs` 给出时一律优先。
 */
export function defaultRuns({ platform, n, requested }) {
  if (Number.isInteger(requested) && requested > 0) return requested;
  return platform === 'win32' && n >= 5000 ? 1 : 3;
}

/** 场景矩阵：档位 × 四场景 + 每形态一次启动开销 */
export function buildMatrix({ form, sizes, platform, runs }) {
  if (!FORMS.includes(form)) throw new Error(`未登记的报告线：${String(form)}`);
  const matrix = [];
  for (const n of sizes) {
    for (const scenario of MEASURED_SCENARIOS) {
      matrix.push({
        scenario,
        state: SCENARIO_STATE[scenario],
        n,
        form,
        runs: defaultRuns({ platform, n, requested: runs }),
      });
    }
  }
  matrix.push({
    scenario: STARTUP_SCENARIO,
    state: SCENARIO_STATE[STARTUP_SCENARIO],
    n: null,
    form,
    runs: defaultRuns({ platform, n: 0, requested: runs }),
  });
  return matrix;
}

/** 被测命令的 argv（源码线可挂 `--cpu-prof`，SEA 线不加） */
export function scenarioArgv(options) {
  const {
    scenario,
    workspace,
    exportFile = null,
    kernelPath = null,
    sourceEntry = null,
    nodePath = process.execPath,
    profileDir = null,
    profileName = null,
  } = options;

  const kernelArgs = (() => {
    if (scenario === STARTUP_SCENARIO) return ['--version'];
    if (scenario === 'validate') return ['validate', '--workspace', workspace];
    if (scenario === 'export') {
      if (exportFile === null) throw new Error('export 场景必须给出导出文件路径');
      return ['export', exportFile, '--workspace', workspace];
    }
    if (scenario === 'scan-cold' || scenario === 'scan-hot') {
      return ['scan', '--workspace', workspace];
    }
    throw new Error(`未登记的场景：${String(scenario)}`);
  })();

  if (kernelPath !== null) return { command: kernelPath, args: kernelArgs };
  if (sourceEntry === null) throw new Error('源码线必须给出内核入口路径');
  const profilerArgs =
    profileDir === null
      ? []
      : [
          '--cpu-prof',
          '--cpu-prof-dir',
          profileDir,
          ...(profileName === null ? [] : ['--cpu-prof-name', profileName]),
        ];
  return { command: nodePath, args: [...profilerArgs, sourceEntry, ...kernelArgs] };
}

/**
 * SEA 线的剖面开关：单文件可执行**不接受** Node 命令行参数（实测 `--cpu-prof` 会被 CLI 参数校验
 * 判 `E-INPUT-002`），但 `NODE_OPTIONS` 仍生效（实测能产出含内核帧的剖面）→ BX-01 以该方式关闭。
 */
export function seaProfileEnv(profileDir, profileName) {
  if (profileDir === null) return {};
  if (/\s/.test(profileDir)) {
    throw new Error(`SEA 线的 NODE_OPTIONS 不支持含空白的剖面目录：${profileDir}`);
  }
  const name = profileName === null ? '' : ` --cpu-prof-name=${profileName}`;
  return { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${profileDir}${name}` };
}

/** 汇总：返回 min / median / max（过滤 null 与非有限值；全空则三项皆 null） */
export function summarize(values) {
  const numeric = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (numeric.length === 0) return { min: null, median: null, max: null };
  const middle = Math.floor(numeric.length / 2);
  const median =
    numeric.length % 2 === 1 ? numeric[middle] : (numeric[middle - 1] + numeric[middle]) / 2;
  return { min: numeric[0], median: Math.round(median * 10) / 10, max: numeric.at(-1) };
}

/** 由逐次样本汇总出报告里的一个场景条目 */
export function summarizeScenario(entry, runs, extras = {}) {
  const wall = runs.map((run) => run.wall_ms);
  const rss = runs.map((run) => (run.rss_ok ? run.peak_rss_mb : null));
  const cpu = runs.map((run) => run.cpu_time_ms);
  return {
    scenario: entry.scenario,
    state: entry.state,
    n: entry.n,
    form: entry.form,
    runs: runs.length,
    wall_ms: summarize(wall),
    peak_rss_mb: summarize(rss),
    cpu_time_ms: summarize(cpu),
    index_bytes: extras.index_bytes ?? null,
    export_bytes: extras.export_bytes ?? null,
    index_write_ms: extras.index_write_ms ?? null,
    stages: extras.stages ?? null,
    fs_observation: extras.fs_observation ?? null,
    startup_ms: extras.startup_ms ?? null,
    exit_codes: runs.map((run) => run.exit_code),
    run_details: runs,
  };
}

/** 组装完整报告（字段顺序即契约顺序，与设计 §3.6 对齐） */
export function buildReport({ environment, fixture, samples, generatedAt }) {
  return {
    schema: REPORT_SCHEMA,
    generated_at: generatedAt,
    environment,
    fixture,
    samples,
  };
}

/** 人类可读摘要（命令行输出用；不改 JSON 契约） */
export function formatReportText(report) {
  const lines = [
    `环境：${report.environment.platform}/${report.environment.arch} · Node ${report.environment.node} · 内核 ${report.environment.kernel}（${report.environment.kernel_form}）`,
    '场景'.padEnd(14) + 'N'.padStart(6) + 'runs'.padStart(6) + ' 墙钟中位(ms)  峰值RSS(MB)  退出码',
  ];
  for (const sample of report.samples) {
    lines.push(
      String(sample.scenario).padEnd(14) +
        String(sample.n ?? '-').padStart(6) +
        String(sample.runs).padStart(6) +
        `  ${String(sample.wall_ms.median ?? '-').padStart(12)}  ${String(sample.peak_rss_mb.max ?? '-').padStart(11)}  ${sample.exit_codes.join(',')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
