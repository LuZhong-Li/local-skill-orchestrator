<script setup lang="ts">
/** 弹窗外壳：统一标题、内容区与底部操作区的版式 */
defineProps<{ title: string; subtitle?: string; wide?: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="mask" @click.self="$emit('close')">
    <section class="dialog" :class="{ wide }" role="dialog" aria-modal="true">
      <header>
        <div>
          <h2>{{ title }}</h2>
          <p v-if="subtitle" class="muted">{{ subtitle }}</p>
        </div>
        <button aria-label="关闭" @click="$emit('close')">✕</button>
      </header>
      <div class="body">
        <slot />
      </div>
      <footer v-if="$slots.footer">
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgb(38 36 31 / 32%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--space) * 8);
  z-index: 20;
}

.dialog {
  background: var(--surface);
  border-radius: var(--radius-dialog);
  box-shadow: var(--shadow-dialog);
  width: min(620px, 100%);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
}

.dialog.wide {
  width: min(880px, 100%);
}

header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: calc(var(--space) * 4);
  padding: calc(var(--space) * 5);
  border-bottom: 1px solid var(--border);
}

header h2 {
  font-size: 16px;
}

header p {
  margin: calc(var(--space) / 2) 0 0;
  font-size: 12px;
}

.body {
  padding: calc(var(--space) * 5);
  overflow: auto;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: calc(var(--space) * 2);
  padding: calc(var(--space) * 4) calc(var(--space) * 5);
  border-top: 1px solid var(--border);
}
</style>
