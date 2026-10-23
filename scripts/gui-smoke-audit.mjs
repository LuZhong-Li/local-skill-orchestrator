/** GUI 审计矩阵与导出菜单冒烟；不触发保存对话框或文件写入。 */
export async function runAuditMatrixSmoke(context) {
  const { evaluate, waitFor, check } = context;
  await evaluate(
    "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '全机盘点')?.click()",
  );
  await waitFor('document.querySelector(\'[data-testid="host-inventory"]\') !== null', 60);
  await evaluate('document.querySelector(\'[data-testid="inventory-tab-audit"]\')?.click()');
  await waitFor('document.querySelector(\'[data-testid="audit-matrix"]\') !== null', 60);
  await waitFor('document.querySelector(\'[data-testid^="audit-cell-"]\') !== null', 100);

  const matrixText = String(
    await evaluate(
      "document.querySelector('[data-testid=\"audit-matrix\"]')?.innerText.replace(/\\s+/g, ' ') ?? ''",
    ),
  );
  check(
    '审计矩阵按宿主渲染目标状态',
    matrixText.includes('跨宿主一致性审计') &&
      matrixText.includes('声明目标') &&
      matrixText.includes('缺失'),
    matrixText.slice(0, 260),
  );

  await evaluate('document.querySelector(\'[data-testid="audit-export-toggle"]\')?.click()');
  await waitFor('document.querySelector(\'[data-testid="audit-export-sarif"]\') !== null');
  const formats = await evaluate(
    "['markdown','html','sarif'].every((format) => document.querySelector(`[data-testid=\"audit-export-${format}\"]`) !== null)",
  );
  check('审计导出菜单展示 Markdown / HTML / SARIF', formats === true);
  await evaluate('document.querySelector(\'[data-testid="audit-export-toggle"]\')?.click()');
  console.log('[smoke] audit matrix checks complete');
}
