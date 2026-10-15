<script setup lang="ts">
/**
 * 应用外壳：侧边导航 + 顶部工具栏 + 主体 + 底部状态栏。
 *
 * 界面只做三件事：把用户操作翻译成一次内核调用、把内核结果如实呈现、把写操作交给
 * 「预览 → 确认 → 执行」的统一流程。这里不推导业务状态，也不读写工作区文件。
 */
import { computed, onMounted, ref } from 'vue';
import SkillCard from './components/SkillCard.vue';
import DetailDialog from './components/DetailDialog.vue';
import InstallDialog from './components/InstallDialog.vue';
import ValidationDialog from './components/ValidationDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import { useKernel } from './composables/useKernel.ts';
import { cardStateOf, type KernelResult, type SkillSummary } from './types.ts';

type View = 'dashboard' | 'validation' | 'backup' | 'settings';

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

async function loadConfig(): Promise<void> {
  configResult.value = await kernel.run(['config', 'get']);
}

async function saveConfig(): Promise<void> {
  await act(['config', 'set', configKey.value, configValue.value], '写入配置');
  await loadConfig();
}

onMounted(async () => {
  await kernel.describe();
  await kernel.refresh();
});
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
        <p class="muted">
          提示：一期没有列出既有备份的指令，备份载体目录需要自行查看；该能力尚未在契约中定义。
        </p>
      </section>

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
            </select>
          </label>
          <label>
            <span class="muted">新的取值</span>
            <input v-model="configValue" />
          </label>
          <button class="primary" :disabled="kernel.busy.value" @click="saveConfig">写入</button>
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
    <ValidationDialog v-if="report && view !== 'backup'" :result="report" @close="report = null" />
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

.panel label {
  width: 100%;
  font-size: 13px;
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
</style>
