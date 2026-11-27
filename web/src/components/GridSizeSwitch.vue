<script setup lang="ts">
// Grid density switch (small/medium/large), shown only when the grid view is
// active — shared by the bookmarks and trash views.
import type { GridSize } from '@/composables/useViewMode'
import { Icon } from '@/components/icons'

const model = defineModel<GridSize>({ required: true })
</script>

<template>
  <div class="grid-size-switch" role="group" aria-label="图标大小">
    <button class="gs-btn" :class="{ active: model === 'small' }" title="小图标" @click="model = 'small'"><Icon name="grid" :size="11" /></button>
    <button class="gs-btn" :class="{ active: model === 'medium' }" title="中图标" @click="model = 'medium'"><Icon name="grid" :size="14" /></button>
    <button class="gs-btn" :class="{ active: model === 'large' }" title="大图标" @click="model = 'large'"><Icon name="grid" :size="17" /></button>
  </div>
</template>
