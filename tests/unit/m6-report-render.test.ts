import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type {
  AuditReportFormat,
  InventoryAuditData,
  AuditReportMeta,
} from '@skill-manager/contract';
import { renderAuditReport } from '../../kernel/audit/report-render.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sample = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/audit-report/sample.json'), 'utf8'),
) as {
  audit: InventoryAuditData;
  meta: AuditReportMeta;
};

function expectedPath(format: Exclude<AuditReportFormat, 'json'>): string {
  const extension = format === 'markdown' ? 'md' : format;
  return join(root, `tests/fixtures/audit-report/expected.${extension}`);
}

for (const format of ['markdown', 'html', 'sarif'] as const) {
  test(`M6 report：${format} golden output`, () => {
    const actual = renderAuditReport(format, sample.audit, sample.meta).content;
    assert.equal(actual, readFileSync(expectedPath(format), 'utf8'));
  });
}

test('M6 report：SARIF 输出通过 2.1.0 JSON Schema', () => {
  const schema = JSON.parse(
    readFileSync(join(root, 'tests/fixtures/sarif/sarif-2.1.0.schema.json'), 'utf8'),
  );
  const sarif = JSON.parse(renderAuditReport('sarif', sample.audit, sample.meta).content);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(sarif), true, JSON.stringify(validate.errors, null, 2));
});

test('M6 report：HTML 自包含且没有脚本或外部资源', () => {
  const html = renderAuditReport('html', sample.audit, sample.meta).content;
  assert.doesNotMatch(html, /<script|<link|@import|https?:\/\//i);
});

test('M6 report：报告固定英文并对 workspace 做 PII 脱敏', () => {
  const markdown = renderAuditReport('markdown', sample.audit, sample.meta).content;
  assert.match(markdown, /# Skill audit report/);
  assert.match(markdown, /Workspace: <workspace>/);
  assert.doesNotMatch(markdown, /alice/i);
});
