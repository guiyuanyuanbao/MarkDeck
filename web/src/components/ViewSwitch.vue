<script setup lang="ts">
// List/grid view switch: the two-button segmented control used by the
// bookmarks and trash headers (previously the identical SVG pair was
// copy-pasted in both templates).
import type { ViewMode } from '@/composables/useViewMode'

const model = defineModel<ViewMode>({ required: true })
</script>

<template>
  <div class="view-switch" role="group" aria-label="视图切换">
    <button
      class="view-btn"
      :class="{ active: model === 'list' }"
      title="列表视图"
      aria-label="列表视图"
      @click="model = 'list'"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
    <button
      class="view-btn"
      :class="{ active: model === 'grid' }"
      title="图标视图"
      aria-label="图标视图"
      @click="model = 'grid'"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
    </button>
  </div>
</template>
