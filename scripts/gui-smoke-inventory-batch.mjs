/** T7 批量交互冒烟：多选、三区块、stale 失败与 item 边界取消。 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function cut(value, length) {
  return String(value).replace(/\s+/g, ' ').slice(0, length);
}

function writeBatchCandidate(hostHome, relativeDir, id) {
  const dir = join(hostHome, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id} smoke candidate\n---\n\n# ${id}\n`,
  );
  return dir;
}

async function selectInventoryCopy(context, path) {
  const selector = `input[type="checkbox"][data-path=${JSON.stringify(path)}]`;
  const ready = await context.waitFor(
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      return input instanceof HTMLInputElement && input.disabled === false;
    })()`,
    80,
  );
  if (!ready) throw new Error(`盘点副本不可选：${path}`);
  await context.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
}

async function dialogText(context) {
  return String(
    await context.evaluate(
      "document.querySelector('[data-testid=\"inventory-action-dialog\"]')?.innerText ?? ''",
    ),
  );
}

async function openBatchAction(context, action) {
  const ready = await context.waitFor(
    `document.querySelector('[data-testid="batch-action-${action}"]') !== null`,
    60,
  );
  if (!ready) throw new Error(`批量动作入口未出现：${action}`);
  await context.evaluate(
    `document.querySelector('[data-testid="batch-action-${action}"]')?.click()`,
  );
  await context.waitFor(
    `document.querySelector('[data-testid="inventory-action-dialog"]') !== null &&
      document.querySelector('[data-testid="inventory-action-loading"]') === null`,
    100,
  );
}

async function showCopiesTab(context) {
  await context.evaluate(
    'document.querySelector(\'[data-testid="inventory-tab-copies"]\')?.click()',
  );
  const ready = await context.waitFor(
    'document.querySelector(\'[data-testid="inventory-refresh"]\') !== null',
    60,
  );
  if (!ready) throw new Error('无法返回副本视图');
}

async function executeBatch(context, cancelImmediately = false) {
  const ready = await context.waitFor(
    '(() => { const b = document.querySelector(\'[data-testid="inventory-action-execute"]\'); return b !== null && b.disabled === false; })()',
    60,
  );
  if (!ready) throw new Error(`批量执行按钮未就绪：${await dialogText(context)}`);
  await context.evaluate(
    `(() => {
      document.querySelector('[data-testid="inventory-action-execute"]')?.click();
      ${
        cancelImmediately
          ? 'document.querySelector(\'[data-testid="inventory-action-cancel"]\')?.click();'
          : ''
      }
    })()`,
  );
  await context.waitFor(
    'document.querySelector(\'[data-testid="inventory-action-results"]\') !== null',
    160,
  );
  return String(
    await context.evaluate(
      "document.querySelector('[data-testid=\"inventory-action-results\"]')?.innerText ?? ''",
    ),
  );
}

async function closeDialog(context) {
  await context.evaluate(
    'document.querySelector(\'[data-testid="inventory-action-cancel"]\')?.click()',
  );
  await context.waitFor(
    'document.querySelector(\'[data-testid="inventory-action-dialog"]\') === null',
    60,
  );
}

export async function runInventoryBatchChecks(context) {
  const { check, hostHome, workspace, refreshInventory } = context;
  const staleOne = writeBatchCandidate(
    hostHome,
    join('.claude', 'skills', 'batch-stale-one'),
    'batch-stale-one',
  );
  const staleTwo = writeBatchCandidate(
    hostHome,
    join('.codex', 'skills', 'batch-stale-two'),
    'batch-stale-two',
  );
  const cancelCopies = [
    writeBatchCandidate(
      hostHome,
      join('.claude', 'skills', 'batch-cancel-one'),
      'batch-cancel-one',
    ),
    writeBatchCandidate(hostHome, join('.codex', 'skills', 'batch-cancel-two'), 'batch-cancel-two'),
    writeBatchCandidate(
      hostHome,
      join('.claude', 'skills', 'batch-cancel-three'),
      'batch-cancel-three',
    ),
  ];
  await refreshInventory();

  await selectInventoryCopy(context, staleOne);
  await selectInventoryCopy(context, staleTwo);
  const selectedBar = String(
    await context.evaluate(
      "document.querySelector('[data-testid=\"batch-action-bar\"]')?.innerText ?? ''",
    ),
  );
  check('多选复选框汇总到批量动作栏', selectedBar.includes('已选 2 项'), cut(selectedBar, 160));
  await openBatchAction(context, 'adopt');
  const previewText = await dialogText(context);
  const previewRows = Number(
    await context.evaluate(
      'document.querySelectorAll(\'[data-testid="adopt-preview-items"] .adopt-preview-item\').length',
    ),
  );
  const sections = await context.evaluate(
    `['writes', 'ledger', 'warnings'].map((name) =>
      document.querySelector('[data-testid="action-section-' + name + '"]') !== null
    )`,
  );
  check(
    '批量预览按写入项/账本变更/警告分组',
    Array.isArray(sections) && sections.every(Boolean),
    JSON.stringify(sections),
  );
  check(
    '采纳预览展示源路径/目标/frontmatter/冲突且只列选中项',
    previewRows === 2 &&
      ['源路径', '工作区目标', 'frontmatter', '冲突'].every((label) => previewText.includes(label)),
    `rows=${String(previewRows)} ${cut(previewText, 320)}`,
  );
  const protectedDisabled =
    (await context.evaluate(
      `(() => {
        const protectedCopies = [...document.querySelectorAll('input[type="checkbox"][data-path]')]
          .filter((item) => item.dataset.path.includes('.system'));
        return protectedCopies.length > 0 && protectedCopies.every((item) => item.disabled === true);
      })()`,
    )) === true;
  check('非 user 副本不进入批量写选择', protectedDisabled);
  writeFileSync(
    join(staleTwo, 'SKILL.md'),
    '---\nname: batch-stale-two\ndescription: changed after preview\n---\n\n# changed\n',
  );
  const staleSummary = await executeBatch(context);
  check(
    '批量失败项定位到 preview/stage/reason',
    staleSummary.includes('plan_stale') &&
      staleSummary.includes('preview') &&
      staleSummary.includes('失败 1'),
    cut(staleSummary, 260),
  );
  check(
    '批量采纳成功后自动切到审计视图',
    await context.waitFor(
      'document.querySelector(\'[data-testid="inventory-tab-audit"]\')?.getAttribute("aria-selected") === "true" && document.querySelector(\'[data-testid="audit-matrix"]\') !== null',
      120,
    ),
  );
  check(
    '新采纳 Skill 自动进入审计矩阵',
    await context.waitFor(
      "document.querySelector('[data-testid=\"audit-matrix\"]')?.innerText.includes('batch-stale-one') === true",
      120,
    ),
  );
  await closeDialog(context);

  await showCopiesTab(context);
  await refreshInventory();
  for (const path of cancelCopies) await selectInventoryCopy(context, path);
  await openBatchAction(context, 'adopt');
  const cancelSummary = await executeBatch(context, true);
  const resultRows = Number(
    await context.evaluate(
      'document.querySelectorAll(\'[data-testid="inventory-action-results"] .results li\').length',
    ),
  );
  check(
    '批量取消在当前 item 边界停止并保留汇总',
    cancelSummary.includes('取消') &&
      !cancelSummary.includes('取消 0') &&
      resultRows < cancelCopies.length,
    cut(cancelSummary, 260),
  );
  const adopted = cancelCopies.filter((path) =>
    existsSync(join(workspace, 'skills', path.split(/[\\/]/).pop())),
  ).length;
  check(
    '取消边界不会把剩余副本半执行',
    adopted < cancelCopies.length,
    `adopted=${adopted}/${cancelCopies.length}`,
  );
  await closeDialog(context);
}
