<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import EditBookmarkDialog from '@/components/EditBookmarkDialog.vue'
import BatchMoveDialog from '@/components/BatchMoveDialog.vue'
import BatchTagDialog from '@/components/BatchTagDialog.vue'
import ContextMenu, { type CtxMenuItem } from '@/components/ContextMenu.vue'
import ViewSwitch from '@/components/ViewSwitch.vue'
import GridSizeSwitch from '@/components/GridSizeSwitch.vue'
import { useSelection } from '@/composables/selection'
import { useRevRefresh } from '@/composables/revRefresh'
import { useViewMode, useGridSize } from '@/composables/useViewMode'
import { useBookmarkClipboard } from '@/composables/useBookmarkClipboard'
import { buildTree, confirmAct, errMsg, type TreeNode } from '@/utils/ui'
import FolderTree from './bookmarks/FolderTree.vue'
import BookmarkList from './bookmarks/BookmarkList.vue'
import BookmarkGrid from './bookmarks/BookmarkGrid.vue'
// BookmarksView shows date-only on list rows (other views use full
// timestamps via the shared fmtDate) — keep this view's format verbatim.
const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString()

const tree = ref<TreeNode[]>([])
const flat = ref<Map<string, Bookmark>>(new Map())
const currentFolder = ref('')
const list = ref<Bookmark[]>([])
const loading = ref(false)
const searchQ = ref('')
const tagFilter = ref('')
const allTags = ref<{ tag: string; count: number }[]>([])

const editDlg = ref<InstanceType<typeof EditBookmarkDialog> | null>(null)
const moveDlg = ref<InstanceType<typeof BatchMoveDialog> | null>(null)
const tagDlg = ref<InstanceType<typeof BatchTagDialog> | null>(null)
const ctxMenu = ref<InstanceType<typeof ContextMenu> | null>(null)

// ---- view mode (list | grid), persisted (shared composable) ----
const viewMode = useViewMode('md-view-mode')
const gridSize = useGridSize()

// searching / tag-filtering shows results outside the current folder —
// drag-reorder and paste are meaningless there, so the view degrades to
// selection + open/edit/delete only
const browsing = computed(() => !searchQ.value && !tagFilter.value)

// tree assembly uses the shared buildTree from @/utils/ui (TreeNode shape)

async function loadTree() {
  const { nodes } = await bookmarksApi.tree()
  const rows = nodes || [] // server nil-encodes empty sets
  flat.value = new Map(rows.map((n) => [n.id, n]))
  tree.value = buildTree(rows)
}

async function loadList() {
  loading.value = true
  try {
    const { nodes } = await bookmarksApi.tree()
    if (searchQ.value) { await doSearch(); return }
    const inFolder = (nodes || []).filter((n) => n.parentId === currentFolder.value)
    inFolder.sort((a, b) => a.position - b.position)
    list.value = tagFilter.value ? inFolder.filter((n) => n.tags?.includes(tagFilter.value)) : inFolder
    // keep ids that still exist: a background revision mid-selection used to
    // wipe the user's checked set entirely
    retainOnly(new Set(list.value.map((n) => n.id)))
  } finally {
    loading.value = false
  }
}

async function doSearch() {
  if (!searchQ.value) { await loadList(); return }
  loading.value = true
  try {
    const { results } = await bookmarksApi.search(searchQ.value, 200)
    // server returns results:null (not []) when nothing matches — assigning
    // null killed the template render and blanked the whole router-view
    const rows = results || []
    list.value = tagFilter.value ? rows.filter((n) => n.tags?.includes(tagFilter.value)) : rows
    checked.value = new Set()
  } finally {
    loading.value = false
  }
}

watch([currentFolder, tagFilter], loadList)
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQ, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(doSearch, 300)
})

// revision bursts (batch syncs fire many pings) used to trigger two full
// reloads per ping; coalesce to one refresh per 800ms window
useRevRefresh(() => { loadTree(); loadList() })
onMounted(() => {
  loadTree(); loadList()
  bookmarksApi.tags().then((r) => (allTags.value = r.tags || []))
})

// ---- CRUD ----
function openCreate(type: 'url' | 'folder') {
  editDlg.value?.openCreate(currentFolder.value, type)
}
function openEdit(b: Bookmark) {
  editDlg.value?.openEdit(b)
}
async function toggleFav(b: Bookmark) {
  try {
    await bookmarksApi.update(b.id, { favorite: !b.favorite })
    loadList()
  } catch (e) { ElMessage.error(errMsg(e)) }
}
async function removeMany(ids: string[]) {
  if (!ids.length) return
  await confirmAct(`将 ${ids.length} 项移入回收站？`, '删除', async () => {
    await bookmarksApi.batch({ ids, action: 'delete' })
    ElMessage.success(`已删除 ${ids.length} 项`)
    loadTree(); loadList()
  })
}

// ---- selection (composable: ctrl/shift range semantics) ----
const { checked, allChecked, selectedCount, toggleAll, selectRow, selectOnly, clearSelection, retainOnly } = useSelection(list)

async function batchDelete() {
  await removeMany([...checked.value])
}
function batchMove() {
  const ids = [...checked.value]
  if (!ids.length) return
  moveDlg.value?.open(ids)
}
function batchTag() {
  const ids = [...checked.value]
  if (!ids.length) return
  tagDlg.value?.open(ids)
}
async function batchFavorite(value: boolean) {
  const ids = [...checked.value]
  if (!ids.length) return
  try {
    await bookmarksApi.batch({ ids, action: 'favorite', value })
    loadTree(); loadList()
  } catch (e) { ElMessage.error(errMsg(e)) }
}

// ---- open semantics ----
function activate(b: Bookmark) {
  if (b.type === 'folder') currentFolder.value = b.id
  else if (b.url) window.open(b.url, '_blank', 'noopener')
}
function openUrl(url?: string) {
  if (url) window.open(url, '_blank', 'noopener')
}

// ---- drag & drop ----
// dataTransfer payload: "text/md-ids" = JSON array (multi-select drag),
// falling back to the legacy single "text/bookmark-id" (payload parsing,
// splice math, ancestor check and grid zones live in composables/bookmarkDnd
// with table-driven tests).
import { draggedIds as parseDraggedIds, spliceAt as spliceIds, isAncestorOfDragged as draggedCoversAncestorOf, gridDropZone } from '@/composables/bookmarkDnd'
function draggedIds(ev: DragEvent): string[] {
  return parseDraggedIds(ev)
}
function onDragStart(b: Bookmark, ev: DragEvent, idx: number) {
  const ids = checked.value.has(b.id) ? [...checked.value] : [b.id]
  if (!checked.value.has(b.id)) {
    selectOnly(b.id, idx)
  }
  ev.dataTransfer?.setData('text/md-ids', JSON.stringify(ids))
  ev.dataTransfer!.effectAllowed = 'copyMove'
}

// drop-target highlight (folder nodes + folder rows/cards)
const dropHoverId = ref<string | null>(null)

async function moveIds(ids: string[], folderId: string) {
  const targets = ids.filter((id) => id !== folderId)
  if (!targets.length) return
  for (const id of targets) {
    const node = flat.value.get(id)
    if (!node) continue
    if (node.type === 'folder') {
      let p = folderId
      while (p) {
        if (p === id) { ElMessage.warning('不能移动到自身子目录'); return }
        p = flat.value.get(p)?.parentId || ''
      }
    }
  }
  try {
    await bookmarksApi.batch({ ids: targets, action: 'move', parentId: folderId })
    ElMessage.success(`已移动 ${targets.length} 项`)
    loadTree(); loadList()
  } catch (e) { ElMessage.error(errMsg(e)) }
}

// reorder within the current folder: drop above/below a target row inserts
// the dragged set there; everything else keeps relative order. One reorder
// call persists the whole sibling sequence.
const dropLineIdx = ref<number | null>(null) // insert BEFORE this index
const dragging = ref(false)

function onRowDragOver(b: Bookmark, ev: DragEvent, idx: number) {
  if (!dragging.value) return
  const ids = draggedIdsPreview
  if (ids.includes(b.id)) return // dropping onto itself
  ev.preventDefault()
  ev.dataTransfer!.dropEffect = 'move'
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  const above = ev.clientY < rect.top + rect.height / 2
  dropLineIdx.value = above ? idx : idx + 1
}
function onRowDragLeave() {
  // only clear when leaving the list entirely; dragover on siblings refreshes
}
async function onListDrop(ev: DragEvent) {
  ev.preventDefault()
  dragging.value = false
  if (!browsing.value) return
  const ids = draggedIds(ev)
  const insertAt = dropLineIdx.value
  dropLineIdx.value = null
  // dropping onto a folder row = move into it (only when NOT over a reorder line)
  if (insertAt === null) return
  if (!ids.length) return
  await persistReorder(spliceIds(list.value, insertAt, ids))
}

// folder-row drop (forwarded from BookmarkList): a folder row takes a
// move-into only when NOT over a reorder line — otherwise the list drop
// (reorder) wins. Semantics verbatim from the pre-split template expression.
async function onRowFolderDrop(b: Bookmark, ev: DragEvent) {
  if (dropLineIdx.value !== null) {
    await onListDrop(ev)
    return
  }
  dropHoverId.value = null
  await moveIds(draggedIds(ev), b.id)
}

// persist a reorder: currentIds is the FULL sibling sequence with the
// dragged set already spliced at the insertion point. Both views end here.
async function persistReorder(currentIds: string[]) {
  try {
    await bookmarksApi.reorder(currentFolder.value, currentIds)
    ElMessage.success('已排序')
    loadList()
  } catch (e) { ElMessage.error(errMsg(e)) }
}

// preview set for dragover filtering (set at dragstart, read during dragover)
let draggedIdsPreview: string[] = []

// ---- grid view drag:二维判定(高亮目标卡 + 边缘插入缝) ----
// The row model (above/below + drop-line) does not map onto a multi-column
// grid: the indicator never rendered there, left/right intent was unreadable,
// and folder-vs-reorder feedback fought each other. Grid cards carry their
// own state: nearest-edge zone picks the slot, the card CENTER of a folder
// picks move-into-it. Zone resolution lives in composables/bookmarkDnd
// (tested); only the event wiring stays here.
const gridDrop = ref<{ id: string; side: 'before' | 'after' | 'inside' } | null>(null)
const gridDragSourceId = ref<string | null>(null)

// draggedCoversAncestorOf(folderId): true when the dragged set contains a
// folder whose parent chain reaches folderId — the grid then keeps edge
// semantics so the indicator never promises an impossible move (moveIds'
// cycle check would reject it anyway).
function onCardDragOver(b: Bookmark, ev: DragEvent) {
  if (!dragging.value || !browsing.value) return
  const ids = draggedIdsPreview
  if (ids.includes(b.id)) return // dropping onto itself
  ev.preventDefault()
  ev.dataTransfer!.dropEffect = 'move'
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  const dx = (ev.clientX - rect.left) / rect.width
  const dy = (ev.clientY - rect.top) / rect.height
  gridDrop.value = {
    id: b.id,
    side: gridDropZone(dx, dy, b, { draggingSelfSubtree: draggedCoversAncestorOf(draggedIdsPreview, b.id, flat.value) }),
  }
}

function onCardDragLeave(b: Bookmark) {
  if (gridDrop.value?.id === b.id) gridDrop.value = null
}

async function onCardDrop(b: Bookmark, ev: DragEvent) {
  ev.preventDefault()
  dragging.value = false
  const drop = gridDrop.value
  gridDrop.value = null
  if (!browsing.value) return
  if (!drop || drop.id !== b.id) return
  const ids = draggedIds(ev)
  if (!ids.length) return
  if (drop.side === 'inside') {
    await moveIds(ids, b.id)
    return
  }
  const idx = list.value.findIndex((x) => x.id === b.id)
  if (idx < 0) return
  await persistReorder(spliceIds(list.value, drop.side === 'before' ? idx : idx + 1, ids))
}

// drop on the grid's empty space: no card hovered → cancel (no accidental reorder)
async function onGridContainerDrop(ev: DragEvent) {
  const target = gridDrop.value ? list.value.find((x) => x.id === gridDrop.value!.id) : null
  gridDrop.value = null
  dragging.value = false
  if (!target) return
  await onCardDrop(target, ev)
}

function onDragStartCapture(b: Bookmark, ev: DragEvent, idx: number) {
  draggedIdsPreview = checked.value.has(b.id) ? [...checked.value] : [b.id]
  dragging.value = true
  gridDragSourceId.value = b.id
  onDragStart(b, ev, idx)
}
function onDragEnd() {
  dragging.value = false
  dropLineIdx.value = null
  dropHoverId.value = null
  gridDrop.value = null
  gridDragSourceId.value = null
}

// ---- copy / cut / paste (composable: cut one-shot, paste double-fire guard) ----
const { clipboard, copySelected, paste, setLookup, setSelectionSource } = useBookmarkClipboard(
  () => currentFolder.value,
  () => { loadTree(); loadList() },
)
setLookup((id) => flat.value.get(id))
setSelectionSource(() => [...checked.value])

// ---- keyboard (scoped to .bm-content) ----
function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  const ids = [...checked.value]
  switch (true) {
    case (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a':
      e.preventDefault(); toggleAll(); break
    case e.key === 'Escape':
      clearSelection(); break
    case e.key === 'Delete':
      if (ids.length) { e.preventDefault(); removeMany(ids) }
      break
    case e.key === 'F2':
      if (ids.length === 1) { e.preventDefault(); const b = flat.value.get(ids[0]); if (b) openEdit(b) }
      break
    case (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c':
      if (ids.length) { e.preventDefault(); copySelected('copy') }
      break
    case (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x':
      if (ids.length) { e.preventDefault(); copySelected('cut') }
      break
    case (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v':
      if (clipboard.value) { e.preventDefault(); paste() }
      break
    case e.key === 'Enter':
      if (ids.length === 1) { e.preventDefault(); const b = flat.value.get(ids[0]); if (b) activate(b) }
      break
  }
}

// ---- context menus ----
function itemMenu(b: Bookmark, ev: MouseEvent) {
  // right-click selects the row under the cursor when it's not already in the set
  if (!checked.value.has(b.id)) {
    selectOnly(b.id, list.value.indexOf(b))
  }
  const ids = [...checked.value]
  const multi = ids.length > 1
  const items: (CtxMenuItem | 'divider')[] = []
  if (multi) {
    items.push(
      { label: `移动 ${ids.length} 项到…`, icon: 'folder', handler: batchMove },
      { label: `打标签（${ids.length} 项）`, icon: 'tag', handler: batchTag },
      { label: '全部收藏', icon: 'star', handler: () => batchFavorite(true) },
      { label: '取消收藏', icon: 'starOff', handler: () => batchFavorite(false) },
      { label: `删除 ${ids.length} 项`, icon: 'trash', danger: true, handler: batchDelete },
    )
  } else {
    if (b.type === 'folder') {
      items.push({ label: '打开', icon: 'folder', handler: () => (currentFolder.value = b.id) })
    } else {
      items.push({ label: '打开', icon: 'open', handler: () => openUrl(b.url) })
    }
    items.push(
      'divider',
      { label: '编辑', icon: 'edit', handler: () => openEdit(b) },
      { label: b.favorite ? '取消收藏' : '收藏', icon: 'star', handler: () => toggleFav(b) },
      { label: '移动到…', icon: 'folder', handler: () => moveDlg.value?.open([b.id]) },
      { label: '复制', icon: 'copy', disabled: !browsing.value, handler: () => copySelected('copy') },
      { label: '剪切', icon: 'cut', disabled: !browsing.value, handler: () => copySelected('cut') },
      'divider',
      { label: '删除', icon: 'trash', danger: true, handler: () => removeMany([b.id]) },
    )
  }
  ctxMenu.value?.open(ev.clientX, ev.clientY, items)
}

function blankMenu(ev: MouseEvent) {
  // right-click on empty space (not on an item) — root menu
  if ((ev.target as HTMLElement).closest('.bm-row, .bm-card')) return
  clearSelection()
  const items: (CtxMenuItem | 'divider')[] = [
    { label: '新建书签', icon: 'plus', disabled: !browsing.value, handler: () => openCreate('url') },
    { label: '新建文件夹', icon: 'folder', disabled: !browsing.value, handler: () => openCreate('folder') },
  ]
  if (clipboard.value) {
    items.push('divider', { label: `粘贴 ${clipboard.value.ids.length} 项`, icon: 'paste', disabled: !browsing.value, handler: paste })
  }
  items.push(
    'divider',
    { label: '全选', icon: 'check', handler: toggleAll },
    { label: viewMode.value === 'list' ? '切换到图标视图' : '切换到列表视图', icon: viewMode.value === 'list' ? 'grid' : 'list', handler: () => (viewMode.value = viewMode.value === 'list' ? 'grid' : 'list') },
  )
  ctxMenu.value?.open(ev.clientX, ev.clientY, items)
}

// sidebar folder node menu (forwarded from FolderTree; previously inline in
// the el-tree node template)
function folderMenu(folderId: string, ev: MouseEvent) {
  ctxMenu.value?.open(ev.clientX, ev.clientY, [
    { label: '打开', icon: 'folder', handler: () => (currentFolder.value = folderId) },
    { label: '新建书签', icon: 'plus', handler: () => editDlg.value?.openCreate(folderId, 'url') },
    { label: '新建文件夹', icon: 'folder', handler: () => editDlg.value?.openCreate(folderId, 'folder') },
    'divider',
    { label: '粘贴到此', icon: 'paste', disabled: !clipboard.value, handler: () => pasteIntoFolder(folderId) },
  ])
}

// paste the clipboard into a sidebar folder: temporarily browse that folder
// so paste()'s target resolves there, then restore the previous folder
async function pasteIntoFolder(folderId: string) {
  const f = currentFolder.value
  currentFolder.value = folderId
  try {
    await paste()
  } finally {
    currentFolder.value = f
  }
}

// left-click on empty space clears the selection (file-manager habit):
// anything that is NOT an item row/card counts as blank — header, side
// tree, paddings, gaps. Clicks inside interactive widgets (dialogs,
// context menus, batch bar buttons) bubble through overlays whose
// closest() also matches, so they never reach the clear path.
function blankClick(ev: MouseEvent) {
  if (!checked.value.size) return
  if ((ev.target as HTMLElement).closest('.bm-row, .bm-card, .folder-node, .el-dialog, .ctx-menu, .batch-bar, .el-tree, .crumbs, .head-actions, button, input, .el-select, .el-input')) return
  clearSelection()
}

const folderName = computed(() => currentFolder.value === '' ? '根目录' : flat.value.get(currentFolder.value)?.title || '')

// breadcrumb: root → ... → current folder, every crumb clickable
const breadcrumbs = computed(() => {
  const crumbs: { id: string; title: string }[] = [{ id: '', title: '根目录' }]
  let p = currentFolder.value
  const chain: { id: string; title: string }[] = []
  let guard = 0
  while (p && guard++ < 100) {
    const n = flat.value.get(p)
    if (!n) break
    chain.unshift({ id: n.id, title: n.title })
    p = n.parentId
  }
  return [...crumbs, ...chain]
})

function goUp() {
  if (!currentFolder.value) return
  currentFolder.value = flat.value.get(currentFolder.value)?.parentId || ''
}
</script>

<template>
  <div class="bm-layout">
    <!-- folder tree -->
    <FolderTree
      :tree="tree"
      :drop-hover-id="dropHoverId"
      @open-folder="(id) => (currentFolder = id)"
      @create="(folderId, type) => editDlg?.openCreate(folderId, type)"
      @paste-into="pasteIntoFolder"
      @node-drop="(folderId, ev) => moveIds(parseDraggedIds(ev), folderId)"
      @hover="(id) => (dropHoverId = id)"
      @node-menu="folderMenu"
    />

    <!-- content -->
    <div
      class="bm-content"
      v-loading="loading"
      tabindex="0"
      @keydown="onKeydown"
      @contextmenu.prevent="blankMenu"
      @click="blankClick"
    >
      <div class="content-head">
        <div class="head-top">
          <div>
            <nav class="crumbs" aria-label="文件夹路径">
              <template v-for="(c, i) in breadcrumbs" :key="c.id || '__root__'">
                <span v-if="i > 0" class="crumb-sep">/</span>
                <button
                  class="crumb"
                  :class="{ active: i === breadcrumbs.length - 1 }"
                  :disabled="i === breadcrumbs.length - 1"
                  @click="currentFolder = c.id"
                >{{ c.title }}</button>
              </template>
              <button v-if="currentFolder" class="icon-btn up-btn" title="返回上一级" @click="goUp">↑</button>
            </nav>
            <h1 class="page-title">{{ folderName }}</h1>
            <div class="page-sub">{{ list.length }} 项</div>
          </div>
          <div class="head-actions">
            <el-input v-model="searchQ" placeholder="搜索标题 / URL / 备注" clearable style="width: 250px" :prefix-icon="null">
              <template #prefix><span style="display:inline-flex;color:var(--md-text-3)"><Icon name="search" :size="14" /></span></template>
            </el-input>
            <el-select v-model="tagFilter" placeholder="按标签筛选" clearable style="width: 140px">
              <el-option v-for="t in allTags" :key="t.tag" :label="`${t.tag} (${t.count})`" :value="t.tag" />
            </el-select>
            <ViewSwitch v-model="viewMode" />
            <GridSizeSwitch v-if="viewMode === 'grid'" v-model="gridSize" />
            <el-button type="primary" @click="openCreate('url')">＋ 新书签</el-button>
          </div>
        </div>

        <div v-if="selectedCount" class="batch-bar">
          已选择 <b>&nbsp;{{ selectedCount }}&nbsp;</b> 项
          <span class="spacer" />
          <el-button size="small" plain @click="batchTag">打标签</el-button>
          <el-button size="small" plain @click="batchMove">移动</el-button>
          <el-button size="small" plain @click="copySelected('copy')">复制</el-button>
          <el-button size="small" plain @click="copySelected('cut')">剪切</el-button>
          <el-button size="small" type="danger" plain @click="batchDelete">删除</el-button>
          <el-button size="small" text @click="clearSelection">取消</el-button>
        </div>
      </div>

      <!-- ==================== LIST VIEW ==================== -->
      <BookmarkList
        v-if="viewMode === 'list'"
        :list="list"
        :loading="loading"
        :checked="checked"
        :all-checked="allChecked"
        :drop-line-idx="dropLineIdx"
        :drop-hover-id="dropHoverId"
        :fmt-date="fmtDate"
        @toggle-all="toggleAll"
        @toggle-row="(b, on) => on ? checked.add(b.id) : checked.delete(b.id)"
        @select-row="selectRow"
        @activate="activate"
        @item-menu="itemMenu"
        @drag-start="onDragStartCapture"
        @drag-end="onDragEnd"
        @row-drag-over="onRowDragOver"
        @row-drag-leave="onRowDragLeave"
        @list-drop="onListDrop"
        @row-drop-into-folder="onRowFolderDrop"
      />

      <!-- ==================== GRID VIEW ==================== -->
      <BookmarkGrid
        v-else
        :list="list"
        :loading="loading"
        :checked="checked"
        :grid-drop="gridDrop"
        :grid-drag-source-id="gridDragSourceId"
        :fmt-date="fmtDate"
        @select-row="selectRow"
        @activate="activate"
        @item-menu="itemMenu"
        @drag-start="onDragStartCapture"
        @drag-end="onDragEnd"
        @card-drag-over="onCardDragOver"
        @card-drag-leave="onCardDragLeave"
        @card-drop="onCardDrop"
        @grid-drop="onGridContainerDrop"
      />
    </div>

    <ContextMenu ref="ctxMenu" />
    <EditBookmarkDialog ref="editDlg" @saved="() => { loadTree(); loadList() }" />
    <BatchMoveDialog ref="moveDlg" @done="() => { loadTree(); loadList() }" />
    <BatchTagDialog ref="tagDlg" @done="() => { loadList() }" />
  </div>
</template>
