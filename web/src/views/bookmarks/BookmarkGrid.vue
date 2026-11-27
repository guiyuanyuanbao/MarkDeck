<script setup lang="ts">
// Grid-view cards for BookmarksView. State lives in the parent; this renders
// cards and forwards drag/select/menu events. Drop zones (inside/before/
// after) are computed by the parent via composables/bookmarkDnd.
import type { Bookmark } from '@/api/client'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'
import EmptyState from '@/components/EmptyState.vue'

defineProps<{
  list: Bookmark[]
  loading: boolean
  checked: Set<string>
  gridDrop: { id: string; side: 'before' | 'after' | 'inside' } | null
  gridDragSourceId: string | null
  fmtDate: (ts: number) => string
}>()

const emit = defineEmits<{
  (e: 'select-row', b: Bookmark, ev: MouseEvent, idx: number): void
  (e: 'activate', b: Bookmark): void
  (e: 'item-menu', b: Bookmark, ev: MouseEvent): void
  (e: 'drag-start', b: Bookmark, ev: DragEvent, idx: number): void
  (e: 'drag-end'): void
  (e: 'card-drag-over', b: Bookmark, ev: DragEvent): void
  (e: 'card-drag-leave', b: Bookmark): void
  (e: 'card-drop', b: Bookmark, ev: DragEvent): void
  (e: 'grid-drop', ev: DragEvent): void
}>()
</script>

<template>
  <div
    class="bm-grid"
    @drop="emit('grid-drop', $event)"
    @dragover="$event.preventDefault()"
  >
    <template v-for="(b, idx) in list" :key="b.id">
      <div
        class="bm-card"
        :class="{
          selected: checked.has(b.id),
          'drop-target': gridDrop?.id === b.id && gridDrop.side === 'inside',
          'drop-before': gridDrop?.id === b.id && gridDrop.side === 'before',
          'drop-after': gridDrop?.id === b.id && gridDrop.side === 'after',
          'dragging-source': gridDragSourceId === b.id,
        }"
        :draggable="true"
        @dragstart="emit('drag-start', b, $event, idx)"
        @dragend="emit('drag-end')"
        @dragover="emit('card-drag-over', b, $event)"
        @dragleave="emit('card-drag-leave', b)"
        @drop.prevent="emit('card-drop', b, $event)"
        @click="emit('select-row', b, $event, idx)"
        @dblclick="emit('activate', b)"
        @contextmenu.prevent.stop="emit('item-menu', b, $event)"
      >
        <span v-if="b.favorite" class="card-fav">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
        </span>
        <div class="card-icon-wrap">
          <BookmarkAvatar :b="b" :size="40" />
        </div>
        <div class="card-title" :title="b.title || b.url">{{ b.title || b.url }}</div>
        <div class="card-sub">
          {{ b.type === 'folder' ? '文件夹' : (b.tags?.length ? (b.tags.length > 1 ? `${b.tags[0]} +${b.tags.length - 1}` : b.tags[0]) : fmtDate(b.createdAt)) }}
        </div>
      </div>
    </template>

    <EmptyState v-if="!loading && !list.length" title="这里还没有书签" hint="右键空白处新建 · 或从浏览器导入 · 拖拽可移动与排序" />
  </div>
</template>
