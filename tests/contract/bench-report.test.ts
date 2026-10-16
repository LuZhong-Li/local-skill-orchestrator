import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_SCHEMA, buildReport, summarizeScenario } from '../../scripts/bench/measure.mjs';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 取设计文档 3.6 节里的 JSON 示例（契约的文档侧来源） */
function designReportExample(): Record<string, unknown> {
  const doc = readFileSync(join(root, 'docs', 'design', 'm3-benchmark.md'), 'utf8');
  const start = doc.indexOf('### 3.6 输出 JSON');
  assert.notEqual(start, -1, '设计文档应含「3.6 输出 JSON」小节');
  const block = doc.slice(start);
  const json = /```json\n([\s\S]*?)\n```/.exec(block);
  assert.ok(json !== null, '设计 3.6 应含 json 代码块');
  return JSON.parse(json[1]) as Record<string, unknown>;
}

/** 报告侧：构造一条「字段全给」的样本，用于与文档示例逐层比对键集合 */
function writerReport() {
  const entry = { scenario: 'scan-cold', state: 'cold', n: 1000, form: 'sea', runs: 1 };
  const run = {
    run: 1,
    wall_ms: 1,
    peak_rss_mb: 1,
    rss_ok: true,
    rss_samples: 1,
    rss_reason: null,
    cpu_time_ms: null,
    exit_code: 0,
    profile: null,
    fs_observation: null,
  };
  return buildReport({
    environment: {
      platform: 'win32',
      arch: 'x64',
      node: 'v24.14.1',
      os_release: 'x',
      cpu_model: 'x',
      cpu_count: 1,
      total_mem_mb: 1,
      kernel: '0.1.0',
      kernel_form: 'sea',
      kernel_path: 'x',
      kernel_sha256: null,
      load_condition: 'x',
    },
    fixture: { seed: 1, n: 1000, files: 1, bytes: 1, generation_ms: 1 },
    samples: [summarizeScenario(entry, [run], {})],
    generatedAt: '2026-10-17T00:00:00.000Z',
  });
}

test('契约：报告 JSON 的字段集合与设计 3.6 示例逐层一致（文档与产物不得分叉）', () => {
  const design = designReportExample();
  const report = writerReport() as unknown as Record<string, unknown>;

  const keysOf = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
  assert.deepEqual(keysOf(report), keysOf(design));
  assert.deepEqual(keysOf(report.environment), keysOf(design.environment));
  assert.deepEqual(keysOf(report.fixture), keysOf(design.fixture));

  const designSample = (design.samples as Array<Record<string, unknown>>)[0];
  const reportSample = (report.samples as Array<Record<string, unknown>>)[0];
  assert.deepEqual(keysOf(reportSample), keysOf(designSample));
  assert.deepEqual(keysOf(reportSample.wall_ms), keysOf(designSample.wall_ms));
  assert.deepEqual(keysOf(reportSample.peak_rss_mb), keysOf(designSample.peak_rss_mb));
  assert.deepEqual(keysOf(reportSample.cpu_time_ms), keysOf(designSample.cpu_time_ms));
  assert.deepEqual(
    keysOf((reportSample.run_details as Array<Record<string, unknown>>)[0]),
    keysOf((designSample.run_details as Array<Record<string, unknown>>)[0]),
  );
});

test('契约：schema 标识一致，且场景 / 线 / 冷热取值域与设计口径一致', () => {
  const design = designReportExample();
  assert.equal(REPORT_SCHEMA, 'bench/1');
  assert.equal(design.schema, REPORT_SCHEMA, '设计示例的 schema 必须与实现常量一致');

  const doc = readFileSync(join(root, 'docs', 'design', 'm3-benchmark.md'), 'utf8');
  for (const value of ['scan-cold', 'scan-hot', 'validate', 'export', 'startup', 'source', 'sea']) {
    assert.ok(doc.includes(value), `设计文档应写明取值域 ${value}`);
  }
  const sample = (design.samples as Array<Record<string, unknown>>)[0];
  assert.equal(sample.state, 'cold');
  assert.equal(sample.form, 'sea');
});
