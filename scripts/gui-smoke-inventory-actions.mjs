/** T5 盘点动作冒烟：预览 → 确认 → 执行 → 刷新，不触碰真实宿主目录。 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { treeHash } from './gui-smoke-fixtures.mjs';

function cut(value, length) {
  return String(value).replace(/\s+/g, ' ').slice(0, length);
}

async function openInventory(context) {
  const { evaluate, waitFor } = context;
  await evaluate('document.querySelector(\'[data-nav="inventory"]\')?.click()');
  await waitFor('document.querySelector(\'[data-testid="host-inventory"]\') !== null', 60);
  await waitFor('document.querySelector(\'[data-testid="inventory-main-count"]\') !== null', 80);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function refresh(context) {
  const { evaluate, waitFor } = context;
  await evaluate('document.querySelector(\'[data-testid="inventory-refresh"]\')?.click()');
  await new Promise((resolve) => setTimeout(resolve, 600));
  await waitFor(
    "document.querySelector('[data-testid=\"inventory-refresh\"]')?.textContent.includes('重新盘点') === true && document.querySelector('[data-testid=\"inventory-refresh\"]')?.disabled === false",
    80,
  );
}

async function clickAction(context, action, path) {
  return (
    (await context.evaluate(
      `(() => {
        const path = ${JSON.stringify(path)};
        const button = [...document.querySelectorAll('[data-testid="inventory-action-${action}"]')]
          .find((item) => item.dataset.path === path);
        button?.click();
        return button !== undefined;
      })()`,
    )) === true
  );
}

async function preview(context, action, path) {
  const clicked = await clickAction(context, action, path);
  if (!clicked) throw new Error(`未找到盘点动作入口：${action} ${path}`);
  await context.waitFor(
    'document.querySelector(\'[data-testid="inventory-action-dialog"]\') !== null',
    60,
  );
  await context.waitFor(
    "document.querySelector('[data-testid=\"inventory-action-loading\"]') === null && document.querySelector('[data-testid=\"inventory-action-dialog\"]')?.innerText.includes('动作计划（') === true",
    100,
  );
  return true;
}

async function dialogText(context) {
  return String(
    await context.evaluate(
      "document.querySelector('[data-testid=\"inventory-action-dialog\"]')?.innerText ?? ''",
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

async function execute(context, destructive = false) {
  if (destructive) {
    await context.evaluate(
      'document.querySelector(\'[data-testid="confirm-destructive"]\')?.click()',
    );
  }
  const ready = await context.waitFor(
    '(() => { const b = document.querySelector(\'[data-testid="inventory-action-execute"]\'); return b !== null && b.disabled === false; })()',
    60,
  );
  if (!ready) {
    throw new Error(`执行按钮未就绪：${await dialogText(context)}`);
  }
  await context.evaluate(
    'document.querySelector(\'[data-testid="inventory-action-execute"]\')?.click()',
  );
  await context.waitFor(
    'document.querySelector(\'[data-testid="inventory-action-results"]\') !== null',
    100,
  );
  const text = String(
    await context.evaluate(
      "document.querySelector('[data-testid=\"inventory-action-results\"]')?.innerText ?? ''",
    ),
  );
  return text;
}

export async function runInventoryActionChecks(context) {
  const { check, workspace, hostHome } = context;
  const history = join(hostHome, '.claude', 'skills', 'history-skill');
  const shared = join(hostHome, '.agents', 'skills', 'shared-skill');
  const broken = join(hostHome, '.claude', 'skills', 'broken-skill');

  await openInventory(context);
  await refresh(context);
  await preview(context, 'adopt', history);
  const adoptPreview = await dialogText(context);
  check(
    '盘点动作入口按副本呈现',
    adoptPreview.includes('history-skill') && adoptPreview.includes('采纳到工作区'),
    cut(adoptPreview, 180),
  );
  check(
    '采纳动作先展示只读预览',
    adoptPreview.includes('尚未写入') && adoptPreview.includes('动作计划'),
    cut(adoptPreview, 180),
  );
  const adopted = await execute(context);
  if (!adopted.includes('succeeded')) {
    throw new Error(`采纳动作未成功：${adopted} / ${await dialogText(context)}`);
  }
  check('采纳动作执行后返回 succeeded', adopted.includes('succeeded'), cut(adopted, 180));
  await closeDialog(context);
  await refresh(context);
  const untrackedAfterAdopt = String(
    await context.evaluate(
      "document.querySelector('[data-testid=\"inventory-untracked\"]')?.innerText ?? ''",
    ),
  );
  check('采纳后未纳管清单移除该副本', !untrackedAfterAdopt.includes('history-skill'));

  const sharedBytes = treeHash(workspace);
  await preview(context, 'adopt', shared);
  const sharedText = await dialogText(context);
  check(
    '共享根动作预览提示全部消费宿主',
    ['共享根', 'codex', 'cursor', 'dsh'].every((label) => sharedText.includes(label)),
    cut(sharedText, 240),
  );
  await closeDialog(context);
  check('取消共享根预览不删除副本', existsSync(shared));
  check('取消共享根预览不写工作区', treeHash(workspace) === sharedBytes);

  rmSync(history, { recursive: true, force: true });
  await refresh(context);
  await preview(context, 'repair', history);
  const repaired = await execute(context);
  check('修复动作执行后恢复宿主副本', repaired.includes('succeeded') && existsSync(history));
  await closeDialog(context);

  writeFileSync(
    join(history, 'SKILL.md'),
    '---\nname: history-skill\ndescription: accepted by smoke\n---\n\n# accepted\n',
  );
  await refresh(context);
  await preview(context, 'accept', history);
  const destructiveText = await dialogText(context);
  const executeDisabled =
    (await context.evaluate(
      'document.querySelector(\'[data-testid="inventory-action-execute"]\')?.disabled === true',
    )) === true;
  check(
    '接受本地改动需要破坏性二次确认',
    destructiveText.includes('覆盖性操作') && executeDisabled,
    cut(destructiveText, 200),
  );
  const accepted = await execute(context, true);
  check('接受动作执行后返回 succeeded', accepted.includes('succeeded'), cut(accepted, 180));
  await closeDialog(context);

  rmSync(history, { recursive: true, force: true });
  await refresh(context);
  await preview(context, 'forget', history);
  const forgotten = await execute(context);
  check('forget 动作执行后返回 succeeded', forgotten.includes('succeeded'), cut(forgotten, 180));
  await closeDialog(context);
  check(
    'forget 不改物理副本，账本转 orphaned',
    !existsSync(history) &&
      readFileSync(join(workspace, 'host_landings.yaml'), 'utf8').includes('orphaned'),
  );

  await refresh(context);
  await preview(context, 'clean', broken);
  const cleanText = await dialogText(context);
  check('损坏副本清理提供破坏性确认', cleanText.includes('破坏性操作'), cut(cleanText, 180));
  await execute(context, true);
  await closeDialog(context);
  check('损坏副本清理删除物理目录', !existsSync(broken));
}

async function expandThirdParty(context, hostId) {
  await context.evaluate(
    `document.querySelector('[data-inventory-host-id="${hostId}"] details.copy-fold summary')?.click()`,
  );
}

/** 插件宿主动作受限：adopt/accept 禁用，repair 只写插件账本。 */
export async function runPluginInventoryActionChecks(context) {
  const { check, workspace } = context;
  const pluginRule = join(workspace, '.zed', 'rules', 'plugin-smoke-skill.md');
  const extraRule = join(workspace, '.zed', 'rules', 'plugin-untracked.md');
  writeFileSync(
    extraRule,
    '---\nname: plugin-untracked\ndescription: extra plugin rule\n---\n\n# extra\n',
  );
  await openInventory(context);
  await refresh(context);
  await expandThirdParty(context, 'x-smoke-tools-zed');
  const pluginAdoptDisabled =
    (await context.evaluate(
      `(() => {
        const path = ${JSON.stringify(extraRule)};
        const item = [...document.querySelectorAll('[data-testid="inventory-action-adopt"]')]
          .find((button) => button.dataset.path === path);
        return item?.disabled === true;
      })()`,
    )) === true;
  check('插件副本禁用采纳动作', pluginAdoptDisabled && existsSync(extraRule));
  rmSync(extraRule, { force: true });

  writeFileSync(
    pluginRule,
    '---\nname: plugin-smoke-skill\ndescription: locally edited\n---\n\n# local edit\n',
  );
  await refresh(context);
  await expandThirdParty(context, 'x-smoke-tools-zed');
  const pluginDriftActions =
    (await context.evaluate(
      `(() => {
        const path = ${JSON.stringify(pluginRule)};
        const pick = (action) => [...document.querySelectorAll('[data-testid="inventory-action-' + action + '"]')]
          .find((button) => button.dataset.path === path);
        return { acceptDisabled: pick('accept')?.disabled === true, repair: pick('repair') !== undefined };
      })()`,
    )) ?? {};
  check(
    '插件漂移副本禁用接受动作且保留修复',
    pluginDriftActions.acceptDisabled === true && pluginDriftActions.repair === true,
    JSON.stringify(pluginDriftActions),
  );
  await preview(context, 'repair', pluginRule);
  const pluginPreview = await dialogText(context);
  check(
    '插件修复预览只涉及插件账本',
    pluginPreview.includes('plugin_index') && pluginPreview.includes('plugin-smoke-skill'),
    cut(pluginPreview, 220),
  );
  const pluginRepaired = await execute(context);
  check(
    '插件修复执行后返回 succeeded',
    pluginRepaired.includes('succeeded'),
    cut(pluginRepaired, 180),
  );
  await closeDialog(context);
  check(
    '插件修复重渲染宿主副本',
    existsSync(pluginRule) && !readFileSync(pluginRule, 'utf8').includes('locally edited'),
  );
  await context.evaluate('document.querySelector(\'[data-nav="plugins"]\')?.click()');
  await context.waitFor('document.querySelector(\'[data-plugin-id="smoke-tools"]\') !== null', 80);
}
