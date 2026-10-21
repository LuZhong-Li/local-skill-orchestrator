import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runI18nSmoke({ evaluate, waitFor, check, userData, reload }) {
  await evaluate(
    "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '设置')?.click()",
  );
  await waitFor('document.querySelector(\'select[data-setting="language"]\') !== null');
  await evaluate(
    "(() => { const select = document.querySelector('select[data-setting=\"language\"]'); select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); })()",
  );
  check(
    '切换到英语后关键导航与设置文案变化',
    await waitFor(
      "document.body.innerText.includes('Dashboard') && document.body.innerText.includes('Settings') && document.body.innerText.includes('Language')",
    ),
    String(await evaluate('document.body.innerText')).slice(0, 260),
  );

  let settingsText = '';
  for (let index = 0; index < 30; index += 1) {
    try {
      settingsText = readFileSync(join(userData, 'settings.json'), 'utf8');
      if (JSON.parse(settingsText).language?.mode === 'manual') break;
    } catch {
      // 等待用户触发设置写入。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(
    '语言选择持久化到 settings.json',
    JSON.stringify(JSON.parse(settingsText).language) ===
      JSON.stringify({ mode: 'manual', value: 'en' }),
    settingsText,
  );

  await reload();
  check(
    '重载后恢复持久化的英语界面',
    await waitFor(
      "document.body.innerText.includes('Dashboard') && document.body.innerText.includes('Settings')",
      80,
    ),
  );

  await evaluate('document.querySelector(\'[data-nav="inventory"]\')?.click()');
  await waitFor('document.querySelector(\'[data-testid="host-inventory"]\') !== null', 60);
  await waitFor(
    '[...document.querySelectorAll(\'input[type="checkbox"][data-path]:not(:disabled)\')].length > 0',
    80,
  );
  await evaluate(
    '[...document.querySelectorAll(\'input[type="checkbox"][data-path]:not(:disabled)\')][0]?.click()',
  );
  await waitFor(
    "document.querySelector('[data-testid=\"batch-selected-count\"]')?.textContent?.includes('selected') === true",
    60,
  );
  const batchBar = String(
    await evaluate("document.querySelector('[data-testid=\"batch-action-bar\"]')?.innerText ?? ''"),
  );
  await evaluate(
    '[...document.querySelectorAll(\'[data-testid^="batch-action-"]\')].find((item) => item.disabled === false)?.click()',
  );
  await waitFor(
    'document.querySelector(\'[data-testid="inventory-action-dialog"]\') !== null && document.querySelector(\'[data-testid="inventory-action-loading"]\') === null',
    100,
  );
  const batchDialog = String(
    await evaluate(
      "document.querySelector('[data-testid=\"inventory-action-dialog\"]')?.innerText ?? ''",
    ),
  );
  check(
    '切换英语后批量选择与预览文案保持英语',
    /^\d+ selected/m.test(batchBar) &&
      /(Adopt into workspace|Record in ledger|Repair host copy|Accept local changes|Clean copy|Stop tracking)/.test(
        batchBar,
      ) &&
      /copies selected for/.test(batchDialog) &&
      batchDialog.includes('Files to write') &&
      batchDialog.includes('Ledger changes') &&
      batchDialog.includes('Warnings'),
    `${batchBar.slice(0, 120)}｜${batchDialog.slice(0, 220)}`,
  );
  await evaluate('document.querySelector(\'[data-testid="inventory-action-cancel"]\')?.click()');
  await waitFor('document.querySelector(\'[data-testid="inventory-action-dialog"]\') === null', 60);

  await evaluate(
    "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Settings')?.click()",
  );
  await waitFor("document.querySelector('.settings-view') !== null");
  await evaluate(
    "(() => { const panels = document.querySelectorAll('.settings-view .panel'); const select = panels[1]?.querySelector('select'); const input = panels[1]?.querySelector('input'); if (!select || !input) return false; select.value = 'default_mode'; select.dispatchEvent(new Event('change', { bubbles: true })); input.value = 'invalid-mode'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
  );
  await waitFor(
    "[...document.querySelectorAll('.settings-view button')].some((b) => b.textContent.trim() === 'Write' && b.disabled === false)",
    80,
  );
  await evaluate(
    "[...document.querySelectorAll('.settings-view button')].find((b) => b.textContent.trim() === 'Write')?.click()",
  );
  check(
    '本地化错误解释仍保留问题码',
    await waitFor(
      "document.querySelector('[data-testid=\"settings-error\"]')?.textContent.includes('E-INPUT-002') && document.querySelector('[data-testid=\"settings-error\"]')?.textContent.includes('An option or value is invalid.')",
      80,
    ),
    String(
      await evaluate(
        "document.querySelector('[data-testid=\"settings-error\"]')?.textContent ?? ''",
      ),
    ),
  );
}
