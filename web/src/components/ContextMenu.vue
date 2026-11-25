<script setup lang="ts">
// Custom floating context menu (net-disk style). Items are plain objects;
// the menu teleports to <body>, flips at viewport edges and closes on
// click-away / Escape / scroll. One instance per view, driven via expose().
import { nextTick, ref } from 'vue'
import { Icon } from './icons'

export interface CtxMenuItem {
  label: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  handler: () => void
}
type Item = CtxMenuItem | 'divider'

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const items = ref<Item[]>([])
const menuEl = ref<HTMLElement | null>(null)

async function open(px: number, py: number, list: Item[]) {
  items.value = list
  x.value = px
  y.value = py
  visible.value = true
  await nextTick()
  // flip at viewport edges (after mount so we know the real size)
  const el = menuEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (px + rect.width > window.innerWidth - 8) x.value = Math.max(4, window.innerWidth - rect.width - 8)
  if (py + rect.height > window.innerHeight - 8) y.value = Math.max(4, window.innerHeight - rect.height - 8)
}
function close() {
  visible.value = false
}
function onItem(it: CtxMenuItem) {
  if (it.disabled) return
  close()
  it.handler()
}
function onDocClick(e: MouseEvent) {
  if (visible.value && menuEl.value && !menuEl.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && visible.value) close()
}
function onScroll() {
  if (visible.value) close()
}
window.addEventListener('click', onDocClick, true)
window.addEventListener('keydown', onKey)
window.addEventListener('scroll', onScroll, true)
window.addEventListener('resize', close)

defineExpose({ open, close })
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" ref="menuEl" class="ctx-menu" :style="{ left: x + 'px', top: y + 'px' }">
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it === 'divider'" class="ctx-divider" />
        <button
          v-else
          class="ctx-item"
          :class="{ danger: it.danger, disabled: it.disabled }"
          :disabled="it.disabled"
          @click.stop="onItem(it)"
        >
          <span v-if="it.icon" class="ctx-ico"><Icon :name="it.icon" :size="14" /></span>
          <span class="ctx-label">{{ it.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
