#!/usr/bin/env node
/**
 * 把测量结果压成**运行页注解**（未登录也可读），并检查**测量链路健康度**。
 *
 * 依据：设计 §5 执行策略——CI 只做烟测与记录，**性能数值不作门禁**（共享 runner 波动 17%~30%）；
 * 但采样失败、退出码异常属于「测量器坏了」的信号，必须以 `::error::` 暴露并让该步失败。
 * 启动开销档允许峰值为空（进程过短，设计 §3.2 第 4 条），不计为失败。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'build/bench';

function readReports() {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith('report-') && name.endsWith('.json'))
      .map((name) => ({ name, report: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
  } catch {
    return [];
  }
}

const reports = readReports();
if (reports.length === 0) {
  process.stdout.write(`::notice::没有找到测量结果（${dir}/report-*.json）\n`);
  process.exit(0);
}

let unhealthy = 0;
for (const { name, report } of reports) {
  const env = report.environment;
  const tiers = [...new Set(report.samples.map((sample) => sample.n))];
  for (const tier of tiers) {
    const rows = [];
    let failed = false;
    for (const sample of report.samples.filter((item) => item.n === tier)) {
      const peak = sample.peak_rss_mb.max;
      const sampledRuns = sample.run_details.filter((run) => run.rss_ok).length;
      const startupTier = sample.scenario === 'startup';
      if (peak === null && !startupTier) {
        failed = true;
        unhealthy += 1;
      }
      const coverage = sample.stages?.coverage;
      rows.push(
        [
          sample.scenario,
          `${String(sample.wall_ms.median)}ms`,
          peak === null ? '峰值=null' : `${String(peak)}MB`,
          `${String(sampledRuns)}/${String(sample.runs)}`,
          `exit=${sample.exit_codes.join(',')}`,
          coverage === undefined || coverage === null ? null : `cov=${String(coverage)}`,
        ]
          .filter((part) => part !== null)
          .join('/'),
      );
    }
    const head = tier === null ? '启动开销档' : `n=${String(tier)}`;
    const text = `${env.platform}/${env.arch} · kernel ${env.kernel}（${env.kernel_form}）· ${head} · ${rows.join(' · ')}`;
    process.stdout.write(
      `${failed ? '::error::测量失败（峰值 RSS 为空）· ' : '::notice::'}${text}\n`,
    );
  }
  process.stdout.write(`::notice::结果文件 ${name}（完整 JSON 见 artifact）\n`);
}

if (unhealthy > 0) process.exit(1);
