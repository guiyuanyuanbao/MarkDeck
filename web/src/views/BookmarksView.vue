<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import EditBookmarkDialog from '@/components/EditBookmarkDialog.vue'
import BatchMoveDialog from '@/components/BatchMoveDialog.vue'
import BatchTagDialog from '@/components/BatchTagDialog.vue'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'
import ContextMenu, { type CtxMenuItem } from '@/components/ContextMenu.vue'
import ViewSwitch from '@/components/ViewSwitch.vue'
import GridSizeSwitch from '@/components/GridSizeSwitch.vue'
import EmptyState from '@/components/EmptyState.vue'
import { Icon } from '@/components/icons'
import { useSelection } from '@/composables/selection'
import { useRevRefresh } from '@/composables/revRefresh'
import { useViewMode, useGridSize } from '@/composables/useViewMode'
import { buildTree, confirmAct, errMsg, type TreeNode } from '@/utils/ui'
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

// internal clipboard for copy/cut/paste
const clipboard = ref<{ mode: 'copy' | 'cut'; ids: string[] } | null>(null)

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
// falling back to the legacy single "text/bookmark-id".
function draggedIds(ev: DragEvent): string[] {
  const raw = ev.dataTransfer?.getData('text/md-ids')
  if (raw) {
    try { return JSON.parse(raw) as string[] } catch { /* fallthrough */ }
  }
  const single = ev.dataTransfer?.getData('text/bookmark-id')
  return single ? [single] : []
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
  await persistReorder(spliceAt(insertAt, ids))
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

// splice the dragged ids into the sibling sequence at insertAt
// (insert BEFORE list[insertAt]) — shared insertion-point math
function spliceAt(insertAt: number, ids: string[]): string[] {
  const currentIds = list.value.map((b) => b.id).filter((id) => !ids.includes(id))
  let at = insertAt - list.value.slice(0, insertAt).filter((b) => ids.includes(b.id)).length
  if (at < 0) at = 0
  if (at > currentIds.length) at = currentIds.length
  currentIds.splice(at, 0, ...ids)
  return currentIds
}

// preview set for dragover filtering (set at dragstart, read during dragover)
let draggedIdsPreview: string[] = []

// ---- grid view drag:二维判定(高亮目标卡 + 边缘插入缝) ----
// The row model (above/below + drop-line) does not map onto a multi-column
// grid: the indicator never rendered there, left/right intent was unreadable,
// and folder-vs-reorder feedback fought each other. Grid cards carry their
// own state: nearest-edge zone picks the slot, the card CENTER of a folder
// picks move-into-it.
const gridDrop = ref<{ id: string; side: 'before' | 'after' | 'inside' } | null>(null)
const gridDragSourceId = ref<string | null>(null)

// dragging a folder onto its own descendant would be rejected by moveIds'
// cycle check — keep the edge semantics for that case so the indicator
// never promises an impossible move
function isAncestorOfDragged(folderId: string): boolean {
  for (const id of draggedIdsPreview) {
    let p: string | undefined = id
    let guard = 0
    while (p && guard++ < 100) {
      if (p === folderId) return true
      p = flat.value.get(p)?.parentId || ''
    }
  }
  return false
}

function onCardDragOver(b: Bookmark, ev: DragEvent) {
  if (!dragging.value || !browsing.value) return
  const ids = draggedIdsPreview
  if (ids.includes(b.id)) return // dropping onto itself
  ev.preventDefault()
  ev.dataTransfer!.dropEffect = 'move'
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  const dx = (ev.clientX - rect.left) / rect.width
  const dy = (ev.clientY - rect.top) / rect.height
  // nearest-edge zone: the smallest distance wins; left/top edges insert
  // before, right/bottom edges insert after
  const before = Math.min(dx, dy)
  const after = Math.min(1 - dx, 1 - dy)
  // folder cards: hovering the CENTER means move-into (edge zone keeps the
  // reorder slot; self-subtree drops fall through — moveIds would reject them)
  if (b.type === 'folder' && before > 0.25 && after > 0.25 && !isAncestorOfDragged(b.id)) {
    gridDrop.value = { id: b.id, side: 'inside' }
    return
  }
  gridDrop.value = { id: b.id, side: before <= after ? 'before' : 'after' }
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
  await persistReorder(spliceAt(drop.side === 'before' ? idx : idx + 1, ids))
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

// ---- copy / cut / paste ----
function copySelected(mode: 'copy' | 'cut') {
  const ids = [...checked.value]
  if (!ids.length) return
  clipboard.value = { mode, ids }
  ElMessage.success(mode === 'copy' ? `已复制 ${ids.length} 项` : `已剪切 ${ids.length} 项`)
}
let pasting = false
async function paste() {
  const clip = clipboard.value
  if (!clip || pasting) return // Ctrl+V auto-repeat / double-fire guard
  pasting = true
  try {
    if (clip.mode === 'cut') {
      await bookmarksApi.batch({ ids: clip.ids, action: 'move', parentId: currentFolder.value })
      clipboard.value = null // cut is one-shot
      ElMessage.success('已粘贴（移动）')
    } else {
      let done = 0
      let failed = 0
      for (const id of clip.ids) {
        const src = flat.value.get(id)
        if (!src) continue
        try {
          await bookmarksApi.create({
            type: src.type,
            parentId: currentFolder.value,
            title: src.title,
            url: src.url || '',
            note: src.note || '',
            favorite: src.favorite,
            tags: src.tags || [],
          })
          done++
        } catch { failed++ }
      }
      if (failed) ElMessage.warning(`已粘贴 ${done} 项，${failed} 项失败`)
      else ElMessage.success(`已复制 ${done} 项`)
    }
    loadTree(); loadList()
  } catch (e) { ElMessage.error(errMsg(e)) } finally {
    pasting = false
  }
}

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
    <div class="bm-side">
      <div class="panel-head">
        <span class="panel-title">文件夹</span>
        <button class="icon-btn" title="新建文件夹" @click="openCreate('folder')">＋</button>
      </div>
      <div class="tree-scroll">
        <el-tree
          :data="tree"
          node-key="id"
          :props="{ label: 'label', children: 'children', isLeaf: 'isLeaf' }"
          :expand-on-click-node="false"
          highlight-current
          @node-click="(n: TreeNode) => (currentFolder = n.id)"
        >
          <template #default="{ data }">
            <span
              class="folder-node"
              :class="{ 'drop-target': dropHoverId === data.id }"
              @dragover.prevent="dropHoverId = data.id"
              @dragleave="dropHoverId === data.id && (dropHoverId = null)"
              @drop.prevent="dropHoverId = null; moveIds(draggedIds($event), data.id)"
              @contextmenu.prevent.stop="ctxMenu?.open($event.clientX, $event.clientY, [
                { label: '打开', icon: 'folder', handler: () => (currentFolder = data.id) },
                { label: '新建书签', icon: 'plus', handler: () => editDlg?.openCreate(data.id, 'url') },
                { label: '新建文件夹', icon: 'folder', handler: () => editDlg?.openCreate(data.id, 'folder') },
                'divider',
                { label: '粘贴到此', icon: 'paste', disabled: !clipboard, handler: () => { const f = currentFolder; currentFolder = data.id; paste().then(() => (currentFolder = f)) } },
              ])"
            >
              <span style="display:inline-flex;color:var(--md-warning)"><Icon name="folder" :size="15" /></span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ data.label }}</span>
            </span>
          </template>
        </el-tree>
      </div>
    </div>

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
      <div
        v-if="viewMode === 'list'"
        class="bm-list"
        @drop="onListDrop"
        @dragover="dragging && browsing && $event.preventDefault()"
      >
        <!-- header row: mirrors the data-row column structure exactly
             (avatar slot + tags + date) so columns align -->
        <div class="bm-row bm-row-head">
          <el-checkbox :model-value="allChecked" @change="toggleAll" />
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
            @dragstart="onDragStartCapture(b, $event, idx)"
            @dragend="onDragEnd"
            @dragover="onRowDragOver(b, $event, idx)"
            @dragleave="onRowDragLeave"
            @drop.prevent="b.type === 'folder' && dropLineIdx === null ? (dropHoverId = null, moveIds(draggedIds($event), b.id)) : onListDrop($event)"
            @click="selectRow(b, $event, idx)"
            @dblclick="activate(b)"
            @contextmenu.prevent.stop="itemMenu(b, $event)"
          >
            <el-checkbox
              :model-value="checked.has(b.id)"
              @click.stop
              @change="checked.has(b.id) ? checked.delete(b.id) : checked.add(b.id)"
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

      <!-- ==================== GRID VIEW ==================== -->
      <div
        v-else
        class="bm-grid"
        @drop="onGridContainerDrop"
        @dragover="dragging && browsing && $event.preventDefault()"
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
            @dragstart="onDragStartCapture(b, $event, idx)"
            @dragend="onDragEnd"
            @dragover="onCardDragOver(b, $event)"
            @dragleave="onCardDragLeave(b)"
            @drop.prevent="onCardDrop(b, $event)"
            @click="selectRow(b, $event, idx)"
            @dblclick="activate(b)"
            @contextmenu.prevent.stop="itemMenu(b, $event)"
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
    </div>

    <ContextMenu ref="ctxMenu" />
    <EditBookmarkDialog ref="editDlg" @saved="() => { loadTree(); loadList() }" />
    <BatchMoveDialog ref="moveDlg" @done="() => { loadTree(); loadList() }" />
    <BatchTagDialog ref="tagDlg" @done="() => { loadList() }" />
  </div>
</template>
