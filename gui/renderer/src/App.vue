<script setup lang="ts">
/**
 * 应用外壳：侧边导航 + 顶部工具栏 + 主体 + 底部状态栏。
 *
 * 界面只做三件事：把用户操作翻译成一次内核调用、把内核结果如实呈现、把写操作交给
 * 「预览 → 确认 → 执行」的统一流程。这里不推导业务状态，也不读写工作区文件。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import SkillCard from './components/SkillCard.vue';
import DetailDialog from './components/DetailDialog.vue';
import InstallDialog from './components/InstallDialog.vue';
import ValidationDialog from './components/ValidationDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import UpdateCheckDialog from './components/UpdateCheckDialog.vue';
import PluginPanel from './components/PluginPanel.vue';
import PluginInstallDialog from './components/PluginInstallDialog.vue';
import PluginDetailDialog from './components/PluginDetailDialog.vue';
import { useKernel } from './composables/useKernel.ts';
import { runSequentialUpdates, type UpdateRunResult } from './update-runner.ts';
import { pluginInstallNotice } from './plugin-presentation.ts';
import {
  cardStateOf,
  type BackupRow,
  type KernelResult,
  type PluginCandidate,
  type PluginHosts,
  type PluginSummary,
  type SkillSummary,
  type UpdateCheckReport,
  type UpdateSettings,
} from './types.ts';

type View = 'dashboard' | 'validation' | 'backup' | 'plugins' | 'settings';

const kernel = useKernel();
const view = ref<View>('dashboard');
const filterState = ref('');
const selected = ref<SkillSummary | null>(null);
const detail = ref<KernelResult | null>(null);
const detailLoading = ref(false);
const showInstall = ref(false);
const report = ref<KernelResult | null>(null);
const exportPath = ref('backups/export.yaml');
const importPath = ref('backups/export.yaml');
const configResult = ref<KernelResult | null>(null);
const configKey = ref('default_target');
const configValue = ref('');
const backups = ref<BackupRow[]>([]);
const backupFilter = ref('');
const backupLoaded = ref(false);
const updateReport = ref<UpdateCheckReport | null>(null);
const showUpdates = ref(false);
const updateBusy = ref(false);
const updatingId = ref<string | null>(null);
const updateResults = ref<Record<string, UpdateRunResult>>({});
const updateBadge = ref(false);
const updateError = ref('');
const pluginRecords = ref<PluginSummary[]>([]);
const pluginCandidates = ref<PluginCandidate[]>([]);
const pluginHosts = ref<PluginHosts>({ builtin: [], third_party: [] });
const pluginLoading = ref(false);
const pluginMessage = ref('');
const pluginSelected = ref<PluginSummary | null>(null);
const pluginDetail = ref<KernelResult | null>(null);
const pluginDetailLoading = ref(false);
const showPluginInstall = ref(false);
const updateSettings = ref<UpdateSettings>({
  periodic_check_enabled: false,
  instant_check_enabled: false,
});
let unsubscribeUpdates: (() => void) | null = null;

const visibleRecords = computed(() =>
  filterState.value === ''
    ? kernel.records.value
    : kernel.records.value.filter((record) => cardStateOf(record) === filterState.value),
);
const states = computed(() => kernel.summarizeStates());

async function openDetail(record: SkillSummary): Promise<void> {
  selected.value = record;
  detail.value = null;
  detailLoading.value = true;
  detail.value = await kernel.run(['inspect', record.id]);
  detailLoading.value = false;
}

async function loadPlugins(): Promise<void> {
  pluginLoading.value = true;
  pluginMessage.value = '';
  try {
    const hostResponse = (await globalThis.window.skillManager.plugins.hosts()) as {
      result?: KernelResult;
      builtin?: PluginHosts['builtin'];
      third_party?: PluginHosts['third_party'];
    };
    const result = hostResponse.result;
    const data = result?.data ?? {};
    pluginRecords.value = (data['plugins'] ?? []) as PluginSummary[];
    pluginHosts.value = {
      builtin: hostResponse.builtin ?? [],
      third_party: hostResponse.third_party ?? [],
    };
    const scan = (await globalThis.window.skillManager.plugins.scan()) as KernelResult;
    pluginCandidates.value = (scan.data?.['unregistered'] ?? []) as PluginCandidate[];
    if (result !== undefined && !result.ok) {
      pluginMessage.value = result.findings
        .map((item) => `${item.code}：${item.message}`)
        .join('；');
    }
  } catch (error) {
    pluginMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    pluginLoading.value = false;
  }
}

function openPlugins(): void {
  view.value = 'plugins';
  void loadPlugins();
}

async function openPluginDetail(id: string): Promise<void> {
  pluginSelected.value = pluginRecords.value.find((item) => item.id === id) ?? null;
  pluginDetail.value = null;
  pluginDetailLoading.value = true;
  try {
    pluginDetail.value = (await globalThis.window.skillManager.plugins.inspect(id)) as KernelResult;
  } finally {
    pluginDetailLoading.value = false;
  }
}

async function installPlugin(source: string): Promise<void> {
  showPluginInstall.value = false;
  const result = await kernel.runWithConfirm(['install', source, '--kind', 'plugin'], '安装插件');
  if (result?.ok === true) {
    pluginMessage.value = pluginInstallNotice();
    await loadPlugins();
  } else if (result !== null) {
    pluginMessage.value = result.findings.map((item) => `${item.code}：${item.message}`).join('；');
  }
}

async function togglePlugin(action: 'enable' | 'disable', id: string): Promise<void> {
  const result = await kernel.runWithConfirm(
    [action, id, '--kind', 'plugin'],
    action === 'enable' ? `启用插件 ${id}` : `停用插件 ${id}`,
  );
  if (result !== null) await loadPlugins();
  if (result !== null && !result.ok) {
    pluginMessage.value = result.findings.map((item) => `${item.code}：${item.message}`).join('；');
  }
}

async function uninstallPlugin(id: string): Promise<void> {
  const result = await kernel.runWithConfirm(
    ['uninstall', id, '--kind', 'plugin'],
    `卸载插件 ${id}`,
  );
  if (result !== null) {
    pluginSelected.value = null;
    await loadPlugins();
    if (!result.ok) {
      pluginMessage.value = result.findings
        .map((item) => `${item.code}：${item.message}`)
        .join('；');
    }
  }
}

async function distributePlugin(hostId: string, skillId: string): Promise<void> {
  if (skillId === '') {
    pluginMessage.value = '请先选择要分发的 Skill';
    return;
  }
  const result = await kernel.runWithConfirm(
    ['update', skillId, '--host', hostId],
    `分发 ${skillId} 到 ${hostId}`,
  );
  if (result?.ok === true) {
    pluginMessage.value = `已将 ${skillId} 分发到 ${hostId}`;
    await loadPlugins();
  }
}

function usePluginConfigHint(hint: string): void {
  const parts = hint.match(/^config set (\S+) (.*)$/);
  view.value = 'settings';
  if (parts !== null) {
    configKey.value = parts[1] ?? '';
    configValue.value = '';
  }
}

/** 写操作的统一入口：预览 → 确认 → 执行，取消时不发写请求 */
async function act(argv: string[], title: string): Promise<void> {
  const result = await kernel.runWithConfirm(argv, title);
  if (result !== null) {
    selected.value = null;
    await kernel.refresh();
  }
}

async function runValidate(): Promise<void> {
  report.value = await kernel.run(['validate']);
}

async function runExport(): Promise<void> {
  const result = await kernel.run(['export', exportPath.value.trim()]);
  if (result.ok) report.value = null;
}

async function runImport(): Promise<void> {
  await act(['import', importPath.value.trim()], '导入备份');
}

/** 读取可用备份列表：数据来自内核的 restore --list，界面不直读备份目录 */
async function loadBackups(): Promise<void> {
  const id = backupFilter.value.trim();
  const result = await kernel.run(['restore', ...(id === '' ? [] : [id]), '--list']);
  backups.value = (result.data?.['backups'] as BackupRow[] | undefined) ?? [];
  backupLoaded.value = true;
}

/** 恢复一份备份：预览 → 确认 → 带 --yes 执行，取消时不发写请求 */
async function restoreBackup(row: BackupRow): Promise<void> {
  await act(['restore', row.id, '--timestamp', row.timestamp], `恢复 ${row.id}`);
  await loadBackups();
}

async function loadConfig(): Promise<void> {
  configResult.value = await kernel.run(['config', 'get']);
}

async function saveConfig(): Promise<void> {
  await act(['config', 'set', configKey.value, configValue.value], '写入配置');
  await loadConfig();
}

function hasAvailable(report: UpdateCheckReport): boolean {
  return report.data.items.some((item) => item.state === 'update-available');
}

function acceptUpdateReport(report: UpdateCheckReport, open: boolean): void {
  updateReport.value = report;
  updateError.value = '';
  if (open) {
    showUpdates.value = true;
    updateBadge.value = false;
  } else {
    updateBadge.value = !showUpdates.value && hasAvailable(report);
  }
}

async function loadUpdateState(): Promise<void> {
  try {
    const [settings, latest] = await Promise.all([
      globalThis.window.skillManager.updates.getSettings(),
      globalThis.window.skillManager.updates.latest(),
    ]);
    updateSettings.value = settings as UpdateSettings;
    if (latest !== null) {
      const report = latest as UpdateCheckReport;
      updateReport.value = report;
      updateBadge.value = hasAvailable(report);
    }
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : String(error);
  }
}

async function runUpdateCheck(open = true): Promise<void> {
  updateBusy.value = true;
  try {
    const report = (await globalThis.window.skillManager.updates.check()) as UpdateCheckReport;
    acceptUpdateReport(report, open);
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : String(error);
  } finally {
    updateBusy.value = false;
  }
}

async function openUpdates(): Promise<void> {
  if (updateBadge.value && updateReport.value !== null) {
    updateBadge.value = false;
    showUpdates.value = true;
    return;
  }
  await runUpdateCheck(true);
}

async function toggleUpdateSetting(key: keyof UpdateSettings, enabled: boolean): Promise<void> {
  const previous = updateSettings.value;
  updateSettings.value = { ...previous, [key]: enabled };
  try {
    updateSettings.value = (await globalThis.window.skillManager.updates.setSettings({
      [key]: enabled,
    })) as UpdateSettings;
    updateError.value = '';
  } catch (error) {
    updateSettings.value = previous;
    updateError.value = error instanceof Error ? error.message : String(error);
  }
}

function checkedOf(event: globalThis.Event): boolean {
  return (event.target as globalThis.HTMLInputElement | null)?.checked === true;
}

function togglePeriodic(event: globalThis.Event): void {
  void toggleUpdateSetting('periodic_check_enabled', checkedOf(event));
}

function toggleInstant(event: globalThis.Event): void {
  void toggleUpdateSetting('instant_check_enabled', checkedOf(event));
}

async function performUpdate(id: string, ref: string | undefined) {
  updatingId.value = id;
  try {
    const result = await kernel.runWithConfirm(
      ['update', id, ...(ref === undefined ? [] : ['--ref', ref])],
      `更新 ${id}`,
    );
    return { cancelled: result === null, result };
  } finally {
    updatingId.value = null;
  }
}

function mergeResults(results: UpdateRunResult[]): void {
  const next = { ...updateResults.value };
  for (const result of results) next[result.id] = result;
  updateResults.value = next;
}

async function refreshAfterUpdates(): Promise<void> {
  await kernel.refresh();
  await runUpdateCheck(false);
}

async function updateOne(id: string): Promise<void> {
  const target = updateReport.value?.data.items.find((item) => item.id === id)?.available?.ref;
  if (target === undefined) return;
  updateBusy.value = true;
  try {
    mergeResults(await runSequentialUpdates([id], (itemId) => performUpdate(itemId, target)));
    await refreshAfterUpdates();
  } finally {
    updateBusy.value = false;
  }
}

async function updateAll(): Promise<void> {
  const report = updateReport.value;
  if (report === null) return;
  const ids =
    report.data.items.filter((item) => item.state === 'update-available').map((item) => item.id) ??
    [];
  if (ids.length === 0) return;
  const targets = new Map(
    report.data.items
      .filter((item) => item.state === 'update-available')
      .map((item) => [item.id, item.available?.ref]),
  );
  updateBusy.value = true;
  try {
    updateResults.value = {};
    mergeResults(await runSequentialUpdates(ids, (id) => performUpdate(id, targets.get(id))));
    await refreshAfterUpdates();
  } finally {
    updateBusy.value = false;
  }
}

onMounted(async () => {
  unsubscribeUpdates = globalThis.window.skillManager.updates.onReport((report) => {
    acceptUpdateReport(report as UpdateCheckReport, false);
  });
  await kernel.describe();
  await kernel.refresh();
  await loadUpdateState();
});

onBeforeUnmount(() => unsubscribeUpdates?.());
</script>

<template>
  <div class="shell">
    <aside>
      <h1>skill-manager</h1>
      <p class="muted workspace" :title="kernel.workspace.value">{{ kernel.workspace.value }}</p>
      <nav>
        <button :class="{ active: view === 'dashboard' }" @click="view = 'dashboard'">
          仪表盘
        </button>
        <button :class="{ active: view === 'validation' }" @click="view = 'validation'">
          校验报告
        </button>
        <button :class="{ active: view === 'backup' }" @click="view = 'backup'">备份管理</button>
        <button data-nav="plugins" :class="{ active: view === 'plugins' }" @click="openPlugins">
          插件（扩展）
        </button>
        <button :class="{ active: view === 'settings' }" @click="view = 'settings'">设置</button>
      </nav>
      <dl class="counts">
        <div>
          <dt>已启用</dt>
          <dd>{{ states.enabled }}</dd>
        </div>
        <div>
          <dt>已禁用</dt>
          <dd>{{ states.disabled }}</dd>
        </div>
        <div>
          <dt>失效</dt>
          <dd>{{ states.invalid }}</dd>
        </div>
      </dl>
    </aside>

    <main>
      <header class="toolbar">
        <button class="primary" :disabled="kernel.busy.value" @click="showInstall = true">
          安装 Skill
        </button>
        <button :disabled="kernel.busy.value" @click="kernel.run(['scan']).then(kernel.refresh)">
          重新扫描
        </button>
        <button :disabled="kernel.busy.value" @click="runValidate">批量校验</button>
        <button :disabled="kernel.busy.value" @click="runExport">导出备份</button>
        <button :disabled="kernel.busy.value" @click="runImport">导入备份</button>
        <button
          v-if="view !== 'plugins'"
          class="update-check"
          :disabled="kernel.busy.value || updateBusy"
          @click="openUpdates"
        >
          检查更新
          <span v-if="updateBadge" class="update-dot" aria-label="有可更新项" />
        </button>
        <span class="spacer" />
        <select v-model="filterState" class="filter" aria-label="按状态过滤">
          <option value="">全部状态</option>
          <option value="enabled">仅已启用</option>
          <option value="disabled">仅已禁用</option>
          <option value="invalid">仅失效</option>
        </select>
      </header>

      <section v-if="view === 'dashboard'" class="content">
        <div v-if="!kernel.initialized.value" class="empty">
          <h2>工作区尚未初始化</h2>
          <p class="muted">先在当前工作区建立索引与标准目录，然后扫描已有的 Skill。</p>
          <button class="primary" @click="kernel.run(['init']).then(kernel.refresh)">
            初始化工作区
          </button>
        </div>
        <div v-else-if="visibleRecords.length === 0" class="empty">
          <h2>还没有已管理的 Skill</h2>
          <p class="muted">执行一次扫描，把工作区里已有的 Skill 登记进来。</p>
          <button class="primary" @click="kernel.run(['scan']).then(kernel.refresh)">
            立即扫描
          </button>
        </div>
        <div v-else class="grid">
          <SkillCard
            v-for="record in visibleRecords"
            :key="record.id"
            :record="record"
            @open="openDetail(record)"
          />
        </div>
      </section>

      <section v-else-if="view === 'validation'" class="content">
        <p class="muted">
          校验是只读动作：它只报告，不刷新索引中的运行期结论。结论过期时请重新扫描。
        </p>
        <button class="primary" :disabled="kernel.busy.value" @click="runValidate">
          执行全量校验
        </button>
        <div v-if="report" class="panel">
          <p>
            退出码 {{ report.exit_code }}｜通过
            {{ (report.data?.['passed'] as number) ?? 0 }}｜不通过
            {{ (report.data?.['invalid'] as number) ?? 0 }}｜问题
            {{ report.findings.length }}
          </p>
          <p class="muted">报告详情已在弹窗中打开；关闭弹窗后仍可重复执行校验。</p>
        </div>
      </section>

      <section v-else-if="view === 'backup'" class="content">
        <div class="panel wide">
          <h2>可用备份（恢复）</h2>
          <div class="row">
            <label>
              <span class="muted">只看某个 Skill（留空表示全部）</span>
              <input v-model="backupFilter" placeholder="例如 code-review" />
            </label>
            <button :disabled="kernel.busy.value" @click="loadBackups">读取备份列表</button>
          </div>
          <p class="muted">
            列表由内核读取备份清单给出，只读不校验内容；恢复时会逐份校验载体，再把内容写回中心库并重分发副本。
          </p>
          <table v-if="backups.length > 0" class="backups">
            <thead>
              <tr>
                <th>Skill</th>
                <th>时间戳</th>
                <th>载体</th>
                <th>文件数</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in backups" :key="`${row.id}@${row.timestamp}`">
                <td>
                  <code>{{ row.id }}</code>
                </td>
                <td>
                  <code>{{ row.timestamp }}</code>
                </td>
                <td class="muted">{{ row.type }}</td>
                <td class="muted">{{ row.file_count }}</td>
                <td>
                  <button :disabled="kernel.busy.value" @click="restoreBackup(row)">恢复</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else-if="backupLoaded" class="muted">
            没有可用备份。卸载一个 Skill
            时会自动生成备份；也可以先在下方导出记录，或从别处导入清单。
          </p>
          <p v-else class="muted">
            还没有读取备份列表：点击「读取备份列表」查看当前工作区里的备份。
          </p>
        </div>
        <div class="panel">
          <h2>导出备份</h2>
          <label>
            <span class="muted">目标文件（相对工作区根目录）</span>
            <input v-model="exportPath" />
          </label>
          <button class="primary" :disabled="kernel.busy.value" @click="runExport">导出</button>
        </div>
        <div class="panel">
          <h2>导入备份</h2>
          <label>
            <span class="muted">备份文件（相对工作区根目录）</span>
            <input v-model="importPath" />
          </label>
          <p class="muted">
            已存在的标识一律跳过、不覆盖；导入只恢复索引记录，运行期结论请在导入后扫描刷新。
          </p>
          <button :disabled="kernel.busy.value" @click="runImport">导入</button>
        </div>
      </section>

      <PluginPanel
        v-else-if="view === 'plugins'"
        :plugins="pluginRecords"
        :candidates="pluginCandidates"
        :hosts="pluginHosts"
        :skills="kernel.records.value"
        :loading="pluginLoading"
        :message="pluginMessage"
        @refresh="loadPlugins"
        @install="showPluginInstall = true"
        @install-candidate="installPlugin"
        @open="openPluginDetail"
        @enable="(id) => togglePlugin('enable', id)"
        @disable="(id) => togglePlugin('disable', id)"
        @uninstall="uninstallPlugin"
        @distribute="distributePlugin"
        @config-hint="usePluginConfigHint"
      />
      <section v-else class="content">
        <div class="panel">
          <h2>当前配置</h2>
          <button :disabled="kernel.busy.value" @click="loadConfig">读取配置</button>
          <pre v-if="configResult">{{ JSON.stringify(configResult.data, null, 2) }}</pre>
        </div>
        <div class="panel">
          <h2>修改配置</h2>
          <label>
            <span class="muted">配置键</span>
            <select v-model="configKey">
              <option value="default_target">default_target</option>
              <option value="default_mode">default_mode</option>
              <option value="skill_roots">skill_roots</option>
              <option
                v-if="!['default_target', 'default_mode', 'skill_roots'].includes(configKey)"
                :value="configKey"
              >
                {{ configKey }}
              </option>
            </select>
          </label>
          <label>
            <span class="muted">新的取值</span>
            <input v-model="configValue" />
          </label>
          <button class="primary" :disabled="kernel.busy.value" @click="saveConfig">写入</button>
        </div>
        <div class="panel">
          <h2>更新检查</h2>
          <p class="muted">
            手动检查始终可用。定期与即时检查默认关闭；定期检查固定至少 6
            小时，只在应用运行期间生效，且只提示、不执行更新。
          </p>
          <label class="toggle">
            <input
              type="checkbox"
              data-setting="periodic"
              :checked="updateSettings.periodic_check_enabled"
              @change="togglePeriodic"
            />
            <span>定期检查（6 小时，仅应用运行期间，只提示）</span>
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              data-setting="instant"
              :checked="updateSettings.instant_check_enabled"
              @change="toggleInstant"
            />
            <span>立即检查（启动后执行一次只读检查）</span>
          </label>
          <p v-if="updateError" class="bad">更新设置或检查失败：{{ updateError }}</p>
        </div>
      </section>
    </main>

    <footer class="statusbar">
      <span v-if="kernel.log.value.length === 0" class="muted">暂无操作记录</span>
      <span
        v-for="entry in kernel.log.value.slice(0, 3)"
        :key="entry.at + entry.text"
        :class="{ bad: !entry.ok }"
      >
        {{ entry.at }} {{ entry.text }}
      </span>
    </footer>

    <DetailDialog
      v-if="selected"
      :record="selected"
      :detail="detail"
      :loading="detailLoading"
      @close="selected = null"
      @action="(argv) => act(argv, '执行该操作')"
      @deps="
        async () => {
          if (selected) detail = await kernel.run(['deps', selected.id, '--tree']);
        }
      "
      @validate="runValidate"
    />
    <InstallDialog
      v-if="showInstall"
      @close="showInstall = false"
      @submit="
        (argv) => {
          showInstall = false;
          void act(argv, '安装 Skill');
        }
      "
    />
    <PluginInstallDialog
      v-if="showPluginInstall"
      @close="showPluginInstall = false"
      @submit="installPlugin"
    />
    <PluginDetailDialog
      v-if="pluginSelected"
      :plugin="pluginSelected"
      :detail="pluginDetail"
      :loading="pluginDetailLoading"
      @close="pluginSelected = null"
      @enable="(id) => togglePlugin('enable', id)"
      @disable="(id) => togglePlugin('disable', id)"
      @uninstall="uninstallPlugin"
    />
    <ValidationDialog v-if="report && view !== 'backup'" :result="report" @close="report = null" />
    <UpdateCheckDialog
      v-if="showUpdates && updateReport"
      :report="updateReport"
      :busy="updateBusy"
      :updating-id="updatingId"
      :results="updateResults"
      @close="showUpdates = false"
      @retry="runUpdateCheck(true)"
      @update="updateOne"
      @update-all="updateAll"
    />
    <ConfirmDialog
      v-if="kernel.pendingConfirm.value"
      :request="kernel.pendingConfirm.value"
      @answer="kernel.answerConfirm"
    />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 208px 1fr;
  grid-template-rows: 1fr auto;
  grid-template-areas:
    'side main'
    'status status';
  height: 100vh;
}

aside {
  grid-area: side;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: calc(var(--space) * 5) calc(var(--space) * 4);
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 4);
}

h1 {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.workspace {
  font-size: 11px;
  word-break: break-all;
}

nav {
  display: grid;
  gap: calc(var(--space) * 1);
}

nav button {
  text-align: left;
  border-color: transparent;
  background: transparent;
}

nav button.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  font-weight: 600;
}

.counts {
  margin: auto 0 0;
  font-size: 12px;
  display: grid;
  gap: calc(var(--space));
}

.counts div {
  display: flex;
  justify-content: space-between;
}

dt,
.muted {
  color: var(--text-muted);
}

dd {
  margin: 0;
}

main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.toolbar {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: center;
  padding: calc(var(--space) * 4) calc(var(--space) * 5);
  border-bottom: 1px solid var(--border);
  background: var(--surface-muted);
}

.spacer {
  flex: 1;
}

.filter {
  width: 148px;
}

.update-check {
  position: relative;
}

.update-dot {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 0 2px var(--surface);
}

.content {
  flex: 1;
  overflow: auto;
  padding: calc(var(--space) * 5);
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 4);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
  gap: calc(var(--space) * 4);
}

.empty {
  margin: auto;
  text-align: center;
  display: grid;
  gap: calc(var(--space) * 3);
  justify-items: center;
  max-width: 420px;
}

.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: calc(var(--space) * 5);
  display: grid;
  gap: calc(var(--space) * 3);
  justify-items: start;
}

.panel h2 {
  font-size: 14px;
}

.panel.wide {
  justify-self: stretch;
  width: 100%;
}

.row {
  display: flex;
  gap: calc(var(--space) * 3);
  align-items: flex-end;
  width: 100%;
  flex-wrap: wrap;
}

.row label {
  flex: 1;
  min-width: 220px;
}

.backups {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.backups th,
.backups td {
  text-align: left;
  padding: calc(var(--space) * 2) calc(var(--space) * 2);
  border-bottom: 1px solid var(--border);
  word-break: break-all;
}

.backups th {
  color: var(--text-muted);
  font-weight: 500;
}

.panel label {
  width: 100%;
  font-size: 13px;
}

.panel label.toggle {
  display: flex;
  align-items: center;
  gap: calc(var(--space) * 2);
}

.panel label.toggle input {
  width: auto;
}

pre {
  margin: 0;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: calc(var(--space) * 3);
  font-size: 12px;
  max-width: 100%;
  overflow: auto;
}

.statusbar {
  grid-area: status;
  display: flex;
  gap: calc(var(--space) * 5);
  padding: calc(var(--space) * 2) calc(var(--space) * 5);
  border-top: 1px solid var(--border);
  background: var(--surface);
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
}

.statusbar .bad {
  color: var(--danger);
}

.bad {
  color: var(--danger);
}
</style>
