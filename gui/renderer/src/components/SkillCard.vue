<script setup lang="ts">
/** Skill 卡片：状态标签按 失效 > 禁用 > 启用 的优先级呈现 */
import { computed } from 'vue';
import { cardStateOf, type SkillSummary } from '../types.ts';

const props = defineProps<{ record: SkillSummary }>();
defineEmits<{ open: [] }>();

const state = computed(() => cardStateOf(props.record));
const stateLabel = computed(
  () => ({ enabled: '已启用', disabled: '已禁用', invalid: '失效' })[state.value],
);
const targets = computed(
  () => props.record.targets.map((item) => item.target).join('、') || '未声明',
);
</script>

<template>
  <article class="card" :class="{ dimmed: state !== 'enabled' }" @click="$emit('open')">
    <header>
      <span class="tag" :class="state">{{ stateLabel }}</span>
      <span class="version muted">{{ record.version ?? '未声明版本' }}</span>
    </header>
    <h3>{{ record.name }}</h3>
    <p class="id muted">{{ record.id }}</p>
    <dl>
      <div>
        <dt>来源</dt>
        <dd>{{ record.source_type }}</dd>
      </div>
      <div>
        <dt>落位目标</dt>
        <dd>{{ targets }}</dd>
      </div>
    </dl>
    <p v-if="state === 'invalid'" class="codes">
      问题码：{{ record.validation.errors.join('、') || '（无明细）' }}
    </p>
    <footer class="muted">
      最近变更 {{ record.updated_at }}
      <span v-if="record.validation.last_scan_at"
        >｜最近扫描 {{ record.validation.last_scan_at }}</span
      >
    </footer>
  </article>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  padding: calc(var(--space) * 5);
  display: flex;
  flex-direction: column;
  gap: calc(var(--space) * 2);
  cursor: pointer;
  transition:
    transform 120ms ease,
    border-color 120ms ease;
}

.card:hover {
  transform: translateY(-1px);
  border-color: var(--accent);
}

.card.dimmed {
  opacity: 0.72;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.version,
.id,
footer {
  font-size: 12px;
}

h3 {
  font-size: 15px;
}

p {
  margin: 0;
}

dl {
  margin: 0;
  display: grid;
  gap: calc(var(--space) / 2);
  font-size: 13px;
}

dl div {
  display: flex;
  gap: calc(var(--space) * 2);
}

dt {
  color: var(--text-muted);
  min-width: 60px;
}

dd {
  margin: 0;
}

.codes {
  font-size: 12px;
  color: var(--danger);
}
</style>
