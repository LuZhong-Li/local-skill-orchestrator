import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCALE_SIZES, THRESHOLDS } from '../../scripts/bench/thresholds.mjs';
import { DEFAULT_SEED, DISTRIBUTION, INVALID_KIND_CODES } from '../../scripts/bench/fixture.mjs';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 取某个小节（到下一个同级标题为止）的正文 */
function sectionOf(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `文档应包含小节 ${heading}`);
  const rest = doc.slice(start);
  const next = rest.indexOf('\n#### ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 表格行 → 单元格 */
function cellsOf(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** 「≤ 30 秒」/「**≤ 512 MB**」→ 以毫秒或 MB 表示的数值 */
function limitOf(cell: string): number {
  const text = cell.replaceAll('**', '').replaceAll(' ', '');
  const match = /≤(\d+)(秒|MB|GB)/.exec(text);
  assert.ok(match !== null, `无法解析阈值单元格：${cell}`);
  const value = Number(match[1]);
  if (match[2] === '秒') return value * 1000;
  if (match[2] === 'GB') return value * 1024;
  return value;
}

const METRIC_LABELS: Array<[string, keyof (typeof THRESHOLDS)[100]]> = [
  ['scan', 'scan_ms'],
  ['validate', 'validate_ms'],
  ['export', 'export_ms'],
  ['内存峰值', 'peak_rss_mb'],
];

test('契约：需求 9.4.3 的阈值表与 scripts/bench/thresholds.mjs 逐项一致（放宽即红）', () => {
  const doc = readFileSync(join(root, 'docs', 'requirements.md'), 'utf8');
  const section = sectionOf(doc, '#### 9.4.3');
  const rows = section.split('\n').filter((line) => line.startsWith('|') && line.includes('≤'));

  assert.deepEqual(SCALE_SIZES, [100, 1000, 5000], '档位取值来自需求 M3-R1');
  assert.equal(rows.length >= METRIC_LABELS.length, true, '阈值表应含四项指标行');

  for (const [label, metric] of METRIC_LABELS) {
    const row = rows.find((line) => cellsOf(line)[0].includes(label));
    assert.ok(row !== undefined, `需求阈值表应含「${label}」行`);
    const cells = cellsOf(row);
    assert.equal(cells.length, 4, `「${label}」行应为 指标 + 三档 四列`);
    SCALE_SIZES.forEach((n, position) => {
      assert.equal(
        limitOf(cells[position + 1]),
        THRESHOLDS[n][metric],
        `N=${String(n)} 的 ${label} 阈值必须与 thresholds.mjs 一致（改一侧而不改另一侧即红）`,
      );
    });
  }
});

test('契约：N=1000 的收紧按「改前值 / 改后值 / 依据」登记，且写明未测先收紧', () => {
  const doc = readFileSync(join(root, 'docs', 'requirements.md'), 'utf8');
  const section = sectionOf(doc, '#### 9.4.3');
  for (const marker of ['未测先收紧', '改前值', '改后值', '依据', '不得', '沿革']) {
    assert.ok(section.includes(marker), `9.4.3 应写明「${marker}」相关口径`);
  }
  // 改前值必须留档：收紧不是无痕覆盖
  for (const before of ['≤ 60 秒', '≤ 120 秒', '≤ 1.5 GB']) {
    assert.ok(section.includes(before), `改前值 ${before} 必须留在登记表中`);
  }
  // 收紧值不能与常量分叉
  for (const after of ['≤ 30 秒', '≤ 15 秒', '≤ 512 MB']) {
    assert.ok(section.includes(after), `改后值 ${after} 必须留在登记表中`);
  }
});

test('契约：夹具的冻结分布与设计文档 2.1 一致（种子 / 占比 / 无效五类 / 资产权重）', () => {
  const design = readFileSync(join(root, 'docs', 'design', 'm3-benchmark.md'), 'utf8');
  assert.equal(DEFAULT_SEED, 23063, '默认种子为 0x5A17 = 23063');
  assert.ok(design.includes('0x5A17'), '设计文档应写明默认种子');
  for (const [name, ratio] of Object.entries(DISTRIBUTION.categories)) {
    assert.ok(
      design.includes(`${String(ratio * 100)}%`),
      `设计文档应写明 ${name} 占比 ${String(ratio * 100)}%`,
    );
  }
  assert.deepEqual(
    DISTRIBUTION.invalidKinds,
    Object.keys(INVALID_KIND_CODES),
    '五类无效与问题码映射同源',
  );
  for (const code of Object.values(INVALID_KIND_CODES)) {
    assert.ok(design.includes(code), `设计文档应写明无效类对应的问题码 ${code}`);
  }
  assert.ok(
    design.includes(DISTRIBUTION.assetCountWeights.join(' / ')),
    '设计文档应写明资产数配额权重',
  );
  for (const marker of ['不动点', '级联']) {
    assert.ok(design.includes(marker), `设计文档应登记依赖可用性的「${marker}」行为`);
  }
});

test('契约：夹具生成物不入库（.gitignore 覆盖 + 仓库内无夹具残留）', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.includes('build/'), '.gitignore 应覆盖 build/');

  const ignored = spawnSync(
    'git',
    ['check-ignore', '-v', 'build/bench/fixture/skills/x/skill_meta.yaml'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(ignored.status, 0, `夹具默认落点应被忽略：${String(ignored.stderr ?? '')}`);

  const tracked = spawnSync('git', ['check-ignore', 'docs/requirements.md'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(tracked.status, 0, '反例：入库文档不应被判为忽略');

  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(
    String(status.stdout)
      .split('\n')
      .some((line) => line.trimEnd().endsWith('build/') || line.includes(' build/')),
    false,
    '夹具生成物不得出现在仓库改动里（build/ 之外的改动属实现批次本身，不在本断言范围）',
  );
});
