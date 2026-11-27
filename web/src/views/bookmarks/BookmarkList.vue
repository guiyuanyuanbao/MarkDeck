<script setup lang="ts">
// List-view rows for BookmarksView (list tab of the two view modes). All
// state lives in the parent — this component renders rows and forwards drag/
// select/menu events. Column structure: the header row mirrors the data-row
// structure exactly (avatar slot + tags + date) so columns align.
import type { Bookmark } from '@/api/client'
import { ElCheckbox } from 'element-plus'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'
import EmptyState from '@/components/EmptyState.vue'
import { Icon } from '@/components/icons'

defineProps<{
  list: Bookmark[]
  loading: boolean
  checked: Set<string>
  allChecked: boolean
  dropLineIdx: number | null
  dropHoverId: string | null
  // date-only format (this view's verbatim list-row format)
  fmtDate: (ts: number) => string
}>()

const emit = defineEmits<{
  (e: 'toggle-all'): void
  (e: 'toggle-row', b: Bookmark, checked: boolean): void
  (e: 'select-row', b: Bookmark, ev: MouseEvent, idx: number): void
  (e: 'activate', b: Bookmark): void
  (e: 'item-menu', b: Bookmark, ev: MouseEvent): void
  (e: 'drag-start', b: Bookmark, ev: DragEvent, idx: number): void
  (e: 'drag-end'): void
  (e: 'row-drag-over', b: Bookmark, ev: DragEvent, idx: number): void
  (e: 'row-drag-leave'): void
  (e: 'list-drop', ev: DragEvent): void
  (e: 'row-drop-into-folder', b: Bookmark, ev: DragEvent): void
}>()
</script>

<template>
  <div
    class="bm-list"
    @drop="emit('list-drop', $event)"
    @dragover="$event.preventDefault()"
  >
    <div class="bm-row bm-row-head">
      <el-checkbox :model-value="allChecked" @change="emit('toggle-all')" />
      <div class="bm-avatar bm-avatar-head" />
      <span class="bm-main bm-col-head">标题</span>
      <div class="bm-tags bm-tags-head"><span style="visibility:hidden">.</span></div>
      <span class="bm-date bm-col-head">添加日期</span>
    </div>

    <template v-for="(b, idx) in list" :key="b.id">
      <div
        v-if="dropLineIdx === idx"
        class="drop-line"
      />
      <div
        class="bm-row"
        :class="{ selected: checked.has(b.id), droppable: b.type === 'folder' && dropHoverId === b.id }"
        :draggable="true"
        @dragstart="emit('drag-start', b, $event, idx)"
        @dragend="emit('drag-end')"
        @dragover="emit('row-drag-over', b, $event, idx)"
        @dragleave="emit('row-drag-leave')"
        @drop.prevent="b.type === 'folder' ? emit('row-drop-into-folder', b, $event) : emit('list-drop', $event)"
        @click="emit('select-row', b, $event, idx)"
        @dblclick="emit('activate', b)"
        @contextmenu.prevent.stop="emit('item-menu', b, $event)"
      >
        <el-checkbox
          :model-value="checked.has(b.id)"
          @click.stop
          @change="emit('toggle-row', b, !checked.has(b.id))"
        />
        <BookmarkAvatar :b="b" :size="26" />
        <div class="bm-main">
          <div class="bm-title">
            <a v-if="b.type === 'url'" :href="b.url" target="_blank" rel="noopener noreferrer" @click.stop>{{ b.title || b.url }}</a>
            <template v-else>{{ b.title }}</template>
            <span v-if="b.favorite" class="fav-star">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
            </span>
            <span v-if="b.note" title="含备注" style="color:var(--md-text-3);display:inline-flex"><Icon name="note" :size="13" /></span>
          </div>
          <div class="bm-url" v-if="b.type === 'url'">{{ b.url }}</div>
        </div>
        <div class="bm-tags">
          <span v-for="t in (b.tags || [])" :key="t" class="bm-tag">{{ t }}</span>
        </div>
        <span class="bm-date">{{ fmtDate(b.createdAt) }}</span>
      </div>
    </template>
    <div v-if="dropLineIdx === list.length && list.length" class="drop-line" />

    <EmptyState v-if="!loading && !list.length" title="这里还没有书签" hint="右键空白处新建 · 或从浏览器导入 · 拖拽可移动与排序" />
  </div>
</template>
