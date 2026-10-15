<script setup lang="ts">
/**
 * 详情弹窗：数据全部来自 inspect 载荷。
 * 操作按钮只发出意图，是否确认由外面的统一流程决定。
 */
import { computed } from 'vue';
import DialogShell from './DialogShell.vue';
import type { Finding, KernelResult, SkillSummary } from '../types.ts';

const props = defineProps<{
  record: SkillSummary;
  detail: KernelResult | null;
  loading: boolean;
}>();
defineEmits<{ close: []; action: [argv: string[]]; deps: []; validate: [] }>();

const data = computed(() => (props.detail?.data ?? {}) as Record<string, unknown>);
const meta = computed(() => (data.value['meta'] ?? null) as Record<string, unknown> | null);
const checksum = computed(
  () =>
    (data.value['checksum'] ?? {}) as {
      recorded?: string;
      recomputed?: string;
      match?: boolean | null;
    },
);
const dependencies = computed(
  () => (data.value['dependencies'] ?? null) as Record<string, unknown> | null,
);
const targets = computed(() => (data.value['targets'] ?? []) as Array<Record<string, unknown>>);
const findings = computed<Finding[]>(() => props.detail?.findings ?? []);
</script>

<template>
  <DialogShell :title="record.name" :subtitle="record.id" wide @close="$emit('close')">
    <p v-if="loading" class="muted">正在读取内核输出…</p>
    <template v-else>
      <section>
        <h3>基础元信息</h3>
        <dl class="grid">
          <div>
            <dt>版本</dt>
            <dd>{{ record.version ?? '未声明' }}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{{ record.status === 'enabled' ? '已启用' : '已禁用' }}</dd>
          </div>
          <div>
            <dt>来源类型</dt>
            <dd>{{ record.source_type }}</dd>
          </div>
          <div>
            <dt>落位路径</dt>
            <dd>{{ String(meta?.['path'] ?? '未声明') }}</dd>
          </div>
          <div>
            <dt>内容指纹</dt>
            <dd>
              <code>{{ checksum.recorded ?? '无' }}</code>
              <span v-if="checksum.match === true" class="ok">与磁盘一致</span>
              <span v-else-if="checksum.match === false" class="bad">与磁盘不一致</span>
              <span v-else class="muted">无法比对</span>
            </dd>
          </div>
          <div>
            <dt>最近扫描</dt>
            <dd>{{ record.validation.last_scan_at ?? '尚未扫描' }}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>校验状态</h3>
        <p v-if="record.validation.status === 'ok'" class="ok">运行期结论：校验通过</p>
        <template v-else>
          <p class="bad">运行期结论：校验不通过（与「已禁用」不是一回事）</p>
          <ul>
            <li v-for="code in record.validation.errors" :key="code">
              <code>{{ code }}</code>
            </li>
          </ul>
        </template>
      </section>

      <section>
        <h3>依赖声明</h3>
        <ul v-if="Array.isArray(dependencies?.['skills'])">
          <li v-for="item in dependencies?.['skills'] as string[]" :key="item">{{ item }}</li>
        </ul>
        <p v-else class="muted">未声明依赖</p>
        <button @click="$emit('deps')">检查依赖</button>
      </section>

      <section>
        <h3>落位目标与逐文件映射</h3>
        <ul>
          <li v-for="(target, index) in targets" :key="index">
            <strong>{{ String(target['target']) }}</strong>
            <span class="muted"
              >（{{ String(target['scope']) }}｜{{ String(target['path']) }}）</span
            >
            <ul>
              <li
                v-for="(dest, source) in target['file_map'] as Record<string, string>"
                :key="source"
              >
                <code>{{ source }} → {{ dest }}</code>
              </li>
            </ul>
          </li>
        </ul>
        <p v-if="targets.length === 0" class="muted">元文件中没有落位目标</p>
      </section>

      <section v-if="findings.length > 0">
        <h3>内核报告的问题</h3>
        <ul>
          <li v-for="finding in findings" :key="finding.code + finding.target">
            [{{ finding.severity === 'error' ? '错误' : '警告' }}] <code>{{ finding.code }}</code>
            {{ finding.message }}
            <span class="muted">{{ finding.remedy }}</span>
          </li>
        </ul>
      </section>
    </template>

    <template #footer>
      <button @click="$emit('validate')">校验该 Skill</button>
      <button @click="$emit('action', ['enable', record.id])">启用</button>
      <button @click="$emit('action', ['disable', record.id])">禁用</button>
      <button @click="$emit('action', ['update', record.id])">刷新</button>
      <button class="danger" @click="$emit('action', ['uninstall', record.id, '--hard'])">
        卸载并删除原件
      </button>
      <button class="danger" @click="$emit('action', ['uninstall', record.id])">卸载</button>
    </template>
  </DialogShell>
</template>

<style scoped>
section + section {
  margin-top: calc(var(--space) * 5);
}

h3 {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: calc(var(--space) * 2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  margin: 0;
  font-size: 13px;
}

.grid div {
  display: flex;
  gap: calc(var(--space) * 2);
}

dt {
  color: var(--text-muted);
  min-width: 72px;
}

dd {
  margin: 0;
  word-break: break-all;
}

ul {
  margin: 0;
  padding-left: calc(var(--space) * 5);
  font-size: 13px;
}

code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
}

.ok {
  color: var(--success);
  margin-left: calc(var(--space) * 2);
}

.bad {
  color: var(--danger);
  margin-left: calc(var(--space) * 2);
}
</style>
