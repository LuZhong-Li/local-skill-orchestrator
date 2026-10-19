/**
 * M4c-6 界面冒烟：全机盘点视图的空工作区入口、计数口径、分组呈现与只读断言。
 * 本模块只做 Electron 调试通道上的断言，不读写业务代码或真实用户目录。
 */
import { join } from 'node:path';
import { fileSnapshot, treeHash } from './gui-smoke-fixtures.mjs';

function cut(value, length) {
  return String(value).replace(/\s+/g, ' ').slice(0, length);
}

async function checkPrimaryCount(context) {
  const { evaluate, check } = context;
  const counts = await evaluate(
    '[...document.querySelectorAll(\'[data-testid="inventory-main-count"] strong\')].map((item) => item.textContent.trim())',
  );
  const values = Array.isArray(counts) ? counts : [];
  check(
    '未初始化盘点主计数只算用户副本',
    values.length === 2 && values[0] === '2' && values[1] === '2',
    `主计数 ${JSON.stringify(counts)}`,
  );
}

async function checkRoleFolding(context) {
  const { evaluate, check } = context;
  const system = String(
    await evaluate("document.querySelector('[data-role=\"system\"]')?.innerText ?? ''"),
  );
  const platform = String(
    await evaluate("document.querySelector('[data-role=\"platform\"]')?.innerText ?? ''"),
  );
  const collapsed =
    (await evaluate(
      '(() => { const item = document.querySelector(\'[data-role="system"]\'); return item instanceof HTMLDetailsElement && item.open === false; })()',
    )) === true;
  const conditions = [
    system.includes('系统内置'),
    system.includes('201 副本'),
    platform.includes('平台内置'),
    platform.includes('1 副本'),
    collapsed,
  ];
  check(
    '系统与平台分组折叠且不污染主计数',
    conditions.every(Boolean),
    `系统 ${cut(system, 80)}｜平台 ${cut(platform, 60)}`,
  );
}

async function checkEvidenceAndPlaceholders(context) {
  const { evaluate, check } = context;
  const shared = String(
    await evaluate(
      "document.querySelector('[data-root-id=\"codex/agents-user\"]')?.innerText ?? ''",
    ),
  );
  check(
    '共享根标注全部消费宿主',
    ['.agents', 'skills', 'codex', 'cursor', 'dsh'].every((label) => shared.includes(label)),
    cut(shared, 200),
  );
  const corrupt = String(
    await evaluate(
      "document.querySelector('[data-testid=\"inventory-corrupt\"]')?.innerText ?? ''",
    ),
  );
  check('损坏副本可读展示且不计入主计数', corrupt.includes('broken-skill'), cut(corrupt, 160));
  const untracked = String(
    await evaluate(
      "document.querySelector('[data-testid=\"inventory-untracked\"]')?.innerText ?? ''",
    ),
  );
  const untrackedOk = [
    untracked.includes('未纳管清单'),
    untracked.includes('导入到工作区（二期）'),
    untracked.includes('一期严格只读'),
  ].every(Boolean);
  check('未纳管清单可见并保留二期只读占位', untrackedOk, cut(untracked, 180));
}

async function checkNoWriteActions(context) {
  const { evaluate, check } = context;
  const buttons = await evaluate(
    '[...document.querySelectorAll(\'[data-testid="host-inventory"] button\')].map((item) => ({ text: item.textContent.trim(), disabled: item.disabled }))',
  );
  const rows = Array.isArray(buttons) ? buttons : [];
  const writeLabels = ['安装', '卸载', '启用', '停用', '更新', '导入', '修复'];
  const enabledWrites = rows.filter(
    (item) => writeLabels.some((label) => item.text.includes(label)) && item.disabled !== true,
  );
  const updateHidden =
    (await evaluate("document.querySelector('.update-check') === null")) === true;
  check(
    '盘点视图无启用的写动作且隐藏更新检查',
    enabledWrites.length === 0 && updateHidden,
    JSON.stringify(rows),
  );
}

async function checkReadonlyAndScroll(context) {
  const { evaluate, waitFor, check, workspace, userData } = context;
  const workspaceBefore = treeHash(workspace);
  const settingsPath = join(userData, 'settings.json');
  const settingsBefore = fileSnapshot(settingsPath);
  await evaluate('document.querySelector(\'[data-testid="inventory-refresh"]\')?.click()');
  await waitFor(
    "document.querySelector('[data-testid=\"inventory-refresh\"]')?.textContent.includes('重新盘点') === true",
    80,
  );
  const workspaceAfter = treeHash(workspace);
  const settingsAfter = fileSnapshot(settingsPath);
  check(
    '盘点前后工作区与设置字节一致',
    workspaceAfter === workspaceBefore && settingsAfter === settingsBefore,
    `工作区 ${workspaceBefore.slice(0, 12)} → ${workspaceAfter.slice(0, 12)}`,
  );
  await evaluate(
    '(() => { const host = document.querySelector(\'[data-inventory-host-id="codex"]\'); host?.querySelector(\'[data-root-id="codex/system"] details.copy-fold summary\')?.click(); })()',
  );
  const scrollable =
    (await evaluate(
      '(() => { const item = document.querySelector(\'[data-root-id="codex/system"] .table-scroll\'); return item ? item.scrollHeight > item.clientHeight : false; })()',
    )) === true;
  const interactive =
    (await evaluate(
      'document.querySelector(\'[data-testid="inventory-refresh"]\')?.disabled === false',
    )) === true;
  check(
    '数百副本明细可折叠滚动且界面仍可交互',
    scrollable && interactive,
    `可滚动 ${String(scrollable)}｜可交互 ${String(interactive)}`,
  );
}

export async function runEmptyWorkspaceInventoryChecks(context) {
  const { evaluate, waitFor, check } = context;
  check(
    '空工作区提供全机盘点入口',
    (await evaluate('document.querySelector(\'[data-testid="open-inventory"]\') !== null')) ===
      true,
  );
  await evaluate('document.querySelector(\'[data-testid="open-inventory"]\')?.click()');
  check(
    '盘点视图可从空工作区进入',
    await waitFor('document.querySelector(\'[data-testid="host-inventory"]\') !== null', 60),
  );
  await waitFor('document.querySelector(\'[data-testid="inventory-main-count"]\') !== null', 80);
  await checkPrimaryCount(context);
  await checkRoleFolding(context);
  await checkEvidenceAndPlaceholders(context);
  await checkNoWriteActions(context);
  await checkReadonlyAndScroll(context);
  await evaluate(
    "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '仪表盘')?.click()",
  );
  await waitFor("document.body.innerText.includes('工作区尚未初始化')");
}

export async function runThirdPartyInventoryCheck(context) {
  const { evaluate, waitFor, check } = context;
  await evaluate('document.querySelector(\'[data-nav="inventory"]\')?.click()');
  await waitFor('document.querySelector(\'[data-testid="host-inventory"]\') !== null', 60);
  await waitFor('document.querySelector(\'[data-testid="inventory-main-count"]\') !== null', 80);
  await evaluate(
    "(() => { const host = document.querySelector('[data-inventory-host-id=\"x-smoke-tools-zed\"]'); host?.querySelector('details.copy-fold summary')?.click(); })()",
  );
  const text = String(
    await evaluate(
      "document.querySelector('[data-testid=\"inventory-third-party-hosts\"]')?.innerText ?? ''",
    ),
  );
  check(
    '盘点视图分区显示已启用第三方 x- 宿主',
    ['x-smoke-tools-zed', 'smoke-skill', '项目级'].every((label) => text.includes(label)),
    cut(text, 240),
  );
  const untracked = String(
    await evaluate(
      "document.querySelector('[data-testid=\"inventory-untracked\"]')?.innerText ?? ''",
    ),
  );
  check(
    '初始化后未纳管清单可分开展示历史副本',
    ['未纳管清单', 'history-skill', 'shared-skill'].every((label) => untracked.includes(label)),
    cut(untracked, 240),
  );
  await evaluate('document.querySelector(\'[data-nav="plugins"]\')?.click()');
  await waitFor('document.querySelector(\'[data-plugin-id="smoke-tools"]\') !== null', 80);
}
