<script setup lang="ts">
/** Skill 卡片：状态标签按 失效 > 禁用 > 启用 的优先级呈现 */
import { computed } from 'vue';
import { cardStateOf, type SkillSummary } from '../types.ts';
import { formatDateTime, t } from '../i18n/index.ts';

const props = defineProps<{ record: SkillSummary }>();
defineEmits<{ open: [] }>();

const state = computed(() => cardStateOf(props.record));
const stateLabel = computed(
  () =>
    ({
      enabled: t('common.enabled'),
      disabled: t('common.disabled'),
      invalid: t('common.invalid'),
    })[state.value],
);
const targets = computed(
  () => props.record.targets.map((item) => item.target).join(', ') || t('common.notDeclared'),
);
</script>

<template>
  <article class="card" :class="{ dimmed: state !== 'enabled' }" @click="$emit('open')">
    <header>
      <span class="tag" :class="state">{{ stateLabel }}</span>
      <span class="version muted">{{ record.version ?? $t('skill.unknownVersion') }}</span>
    </header>
    <h3>{{ record.name }}</h3>
    <p class="id muted">{{ record.id }}</p>
    <dl>
      <div>
        <dt>{{ $t('skill.source') }}</dt>
        <dd>{{ record.source_type }}</dd>
      </div>
      <div>
        <dt>{{ $t('skill.targets') }}</dt>
        <dd>{{ targets }}</dd>
      </div>
    </dl>
    <p v-if="state === 'invalid'" class="codes">
      {{ $t('skill.validationErrors') }}:
      {{ record.validation.errors.join(', ') || $t('common.noDetail') }}
    </p>
    <footer class="muted">
      {{ $t('skill.updated') }} {{ formatDateTime(record.updated_at) }}
      <span v-if="record.validation.last_scan_at"
        >| {{ $t('skill.scanned') }} {{ formatDateTime(record.validation.last_scan_at) }}</span
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
