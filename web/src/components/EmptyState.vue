<script setup lang="ts">
// Illustrated empty state. The bookmarks/trash views repeated the same link
// SVG block verbatim (list + grid each); tools/settings use the Icon-based
// list-empty variant. `variant` picks the wrapper class; icon is either a
// named Icon or the default inline link SVG.
import { Icon } from '@/components/icons'

withDefaults(defineProps<{
  title: string
  hint?: string
  icon?: string
  variant?: 'md-empty' | 'list-empty'
}>(), { variant: 'md-empty' })
</script>

<template>
  <div :class="variant">
    <div :class="`${variant}-icon`">
      <Icon v-if="icon" :name="icon" :size="26" />
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </div>
    <div :class="`${variant}-title`">{{ title }}</div>
    <div :class="`${variant}-hint`">{{ hint }}</div>
  </div>
</template>
