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
    untracked.includes('动作按副本逐条提供'),
    untracked.includes('默认预览'),
  ].every(Boolean);
  check('未纳管清单可见并提供逐条动作入口', untrackedOk, cut(untracked, 180));
}

async function checkPresentationHierarchy(context) {
  const { evaluate, check } = context;
  const roles = await evaluate(
    `[...document.querySelectorAll('[data-testid="root-role-tag"]')].map((item) => ({
      text: item.textContent.trim(),
      className: item.className,
      background: getComputedStyle(item).backgroundColor,
    }))`,
  );
  const roleRows = Array.isArray(roles) ? roles : [];
  const roleClasses = new Set(
    roleRows.flatMap((item) =>
      String(item.className)
        .split(/\s+/)
        .filter((name) => /^role-(user|system|platform|project)$/.test(name)),
    ),
  );
  const roleBackgrounds = new Set(roleRows.map((item) => String(item.background)));
  check(
    '盘点根节点按角色提供一致视觉区分',
    roleClasses.size >= 3 && roleBackgrounds.size >= 3,
    JSON.stringify(roleRows),
  );

  const states = await evaluate(
    `[...document.querySelectorAll('[data-testid="root-state-tag"]')].map((item) => ({
      text: item.textContent.trim(),
      className: item.className,
    }))`,
  );
  const stateRows = Array.isArray(states) ? states : [];
  const stateClasses = new Set(
    stateRows.flatMap((item) =>
      String(item.className)
        .split(/\s+/)
        .filter((name) => name.startsWith('root-state-')),
    ),
  );
  check(
    '根状态使用统一状态标签样式',
    stateRows.length > 0 &&
      stateRows.every((item) => item.text && item.className.includes('root-state-')),
    JSON.stringify(stateRows.slice(0, 8)),
  );
  check('根状态标签覆盖多种真实状态', stateClasses.size >= 3, JSON.stringify([...stateClasses]));

  const emptyStates = await evaluate(
    `[...document.querySelectorAll('[data-testid="root-empty-state"]')].map((item) =>
      item.textContent.trim()
    )`,
  );
  const emptyTexts = Array.isArray(emptyStates) ? emptyStates : [];
  check(
    '空根缺失根与不可读根有明确空状态文案',
    emptyTexts.length > 0 && emptyTexts.every((text) => text.length > 0),
    JSON.stringify(emptyTexts.slice(0, 4)),
  );

  const truncation = await evaluate(
    `(() => {
      const rootPath = document.querySelector('.root-path');
      const tablePath = [...document.querySelectorAll('.path-text')]
        .sort((left, right) => right.textContent.length - left.textContent.length)[0];
      const skill = document.querySelector('.skill-id');
      const host = document.querySelector('.host');
      const inspect = (item) => item ? {
        overflow: getComputedStyle(item).overflow,
        textOverflow: getComputedStyle(item).textOverflow,
        whiteSpace: getComputedStyle(item).whiteSpace,
        title: item.getAttribute('title') ?? '',
      } : null;
      return {
        rootPath: inspect(rootPath),
        tablePath: inspect(tablePath),
        skill: inspect(skill),
        host: inspect(host),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`,
  );
  const values = truncation && typeof truncation === 'object' ? truncation : {};
  const truncated = ['rootPath', 'tablePath', 'skill', 'host'].every((key) => {
    const value = values[key];
    return (
      value &&
      value.overflow === 'hidden' &&
      value.textOverflow === 'ellipsis' &&
      value.whiteSpace === 'nowrap' &&
      value.title.length > 0
    );
  });
  check(
    '长路径宿主与 Skill 标识省略显示且保留 tooltip',
    truncated && values.horizontalOverflow === false,
    JSON.stringify(values),
  );
}

async function checkNoWriteActions(context) {
  const { evaluate, check } = context;
  const buttons = await evaluate(
    '[...document.querySelectorAll(\'[data-testid="host-inventory"] button\')].map((item) => ({ text: item.textContent.trim(), disabled: item.disabled }))',
  );
  const rows = Array.isArray(buttons) ? buttons : [];
  const batchWrites = rows.filter(
    (item) => /全部|一键|批量修复|批量清理/.test(item.text) && item.disabled !== true,
  );
  const updateHidden =
    (await evaluate("document.querySelector('.update-check') === null")) === true;
  check(
    '盘点视图无批量写动作且隐藏更新检查',
    batchWrites.length === 0 && updateHidden,
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
  await waitFor(
    'document.querySelector(\'[data-testid="inventory-refresh"]\')?.disabled === false',
    60,
  );
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
  await checkPresentationHierarchy(context);
  await context.captureScreenshot?.('t8-inventory');
  await checkNoWriteActions(context);
  await checkReadonlyAndScroll(context);
  const workspaceBeforeAction = treeHash(context.workspace);
  const actionCount = Number(
    await evaluate('document.querySelectorAll(\'[data-testid^="inventory-action-"]\').length'),
  );
  check('无工作区基线时不提供盲采纳动作', actionCount === 0, `动作按钮 ${String(actionCount)}`);
  check('空工作区盘点不写工作区', treeHash(context.workspace) === workspaceBeforeAction);
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
    ['x-smoke-tools-zed', 'plugin-smoke-skill', '用户安装'].every((label) => text.includes(label)),
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
