<script setup lang="ts">
// Trash view, laid out like BookmarksView (side panel + content card) with
// PikPak-style hierarchical browsing: trashed folders are clickable rows —
// entering one shows its tombstoned children, breadcrumbs navigate back up.
// All restore flows go through RestoreDialog (the default mechanism): it
// defaults to the original location, rebuilds deleted ancestor paths
// server-side (RestoreWithPath shells) and merges into same-name folders.
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import EditBookmarkDialog from '@/components/EditBookmarkDialog.vue'
import RestoreDialog from '@/components/RestoreDialog.vue'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'
import ContextMenu, { type CtxMenuItem } from '@/components/ContextMenu.vue'
import { Icon } from '@/components/icons'
import { useSelection } from '@/composables/selection'
import { useRevRefresh } from '@/composables/revRefresh'
import { fmtDate } from '@/utils/ui'

const trash = ref<Bookmark[]>([])
const loading = ref(false)
const busy = ref(false)

// ---- hierarchy: current browsing folder inside the trash ----
const currentFolder = ref('') // '' = trash top level
const trashById = computed(() => new Map(trash.value.map((b) => [b.id, b])))
// rows whose parent is NOT itself trashed (top level of the trash)
const topRows = computed(() => trash.value.filter((b) => !trashById.value.has(b.parentId)))
const currentRows = computed(() =>
  currentFolder.value === ''
    ? topRows.value
    : trash.value.filter((b) => b.parentId === currentFolder.value)
)

// subtree tombstone counts per folder row (含 N 项 badge): one children-map
// build + a reverse accumulation pass instead of a BFS per folder
const countCache = computed(() => {
  const kidsOf = new Map<string, string[]>()
  for (const b of trash.value) {
    if (!kidsOf.has(b.parentId)) kidsOf.set(b.parentId, [])
    kidsOf.get(b.parentId)!.push(b.id)
  }
  const m = new Map<string, number>()
  // deepest-first isn't known without depths; recursive memoized count
  const count = (id: string, stack: Set<string>): number => {
    const cached = m.get(id)
    if (cached !== undefined) return cached
    if (stack.has(id)) return 0 // corrupted cycle guard
    stack.add(id)
    let n = 0
    for (const cid of kidsOf.get(id) || []) {
      n += 1 + count(cid, stack)
    }
    stack.delete(id)
    m.set(id, n)
    return n
  }
  for (const b of trash.value) if (b.type === 'folder') count(b.id, new Set())
  return m
})
const countOf = (id: string) => countCache.value.get(id) ?? 0

// breadcrumb: 回收站 / ... / current folder
const breadcrumbs = computed(() => {
  const chain: { id: string; title: string }[] = []
  let p = currentFolder.value
  let guard = 0
  while (p && guard++ < 100) {
    const row = trashById.value.get(p)
    if (!row) break
    chain.unshift({ id: row.id, title: row.title || '(未命名)' })
    p = row.parentId
  }
  return [{ id: '', title: '回收站' }, ...chain]
})
function enterFolder(b: Bookmark) {
  if (b.type !== 'folder') return
  currentFolder.value = b.id
  clearSelection()
}
function goUp() {
  if (!currentFolder.value) return
  currentFolder.value = trashById.value.get(currentFolder.value)?.parentId || ''
  clearSelection()
}

// ---- filters ----
const q = ref('')
const typeFilter = ref<'all' | 'url' | 'folder'>('all')
const timeFilter = ref<'all' | '7d' | 'older'>('all')
const sortBy = ref<'deletedDesc' | 'deletedAsc' | 'title'>('deletedDesc')

// view mode (list | grid), persisted separately from the bookmarks view
const viewMode = ref<'list' | 'grid'>((localStorage.getItem('md-trash-view-mode') as 'list' | 'grid') || 'list')
function toggleViewMode() {
  viewMode.value = viewMode.value === 'list' ? 'grid' : 'list'
  localStorage.setItem('md-trash-view-mode', viewMode.value)
}

// grid density: shares the bookmarks view's global data-gridsize attribute and
// md-grid-size key, so both grids stay in sync (same --grid-min variable)
const gridSize = ref<'small' | 'medium' | 'large'>((localStorage.getItem('md-grid-size') as 'small' | 'medium' | 'large') || 'medium')
watch(gridSize, (v) => {
  localStorage.setItem('md-grid-size', v)
  document.documentElement.setAttribute('data-gridsize', v)
})
// entering trash directly (deep link / refresh) — apply the stored density,
// the attribute only carries over when BookmarksView set it earlier
if (!document.documentElement.getAttribute('data-gridsize')) {
  document.documentElement.setAttribute('data-gridsize', gridSize.value)
}

const restoreDlg = ref<InstanceType<typeof RestoreDialog> | null>(null)
const ctxMenu = ref<InstanceType<typeof ContextMenu> | null>(null)
const editDlg = ref<InstanceType<typeof EditBookmarkDialog> | null>(null)

// live tree names: an ancestor may already be restored (shell or whole tree)
// while its children remain trashed — the 原位置 chain must keep resolving
const liveNameMap = ref<Map<string, string>>(new Map())

// original location: full relative path from the trash top, e.g. 大文件夹/嵌套
// (trashed ancestors supply names; live ancestors too; purged ones can't —
// show 已删除 marker)
function origPath(pid: string): string {
  if (!pid) return '根目录'
  const chain: string[] = []
  let p = pid
  let guard = 0
  while (p && guard++ < 100) {
    const trow = trashById.value.get(p)
    if (trow) {
      chain.unshift(trow.title || '(未命名)')
      p = trow.parentId
      continue
    }
    // not in trash: live row (restored) or gone (purged / deleted elsewhere)
    const lname = liveNameMap.value.get(p)
    if (lname) {
      chain.unshift(lname)
      p = liveParentId(p)
      continue
    }
    return chain.length ? chain.join(' / ') + ' / （已删除）' : '（原文件夹已删除）'
  }
  return chain.join(' / ') || '根目录'
}
// parent of a live row (from the live tree map, refreshed in load())
const liveParent = ref<Map<string, string>>(new Map())
function liveParentId(id: string): string {
  return liveParent.value.get(id) || ''
}
// path relative to the browsed folder (for the 原位置 column inside a level)
function relPath(pid: string): string {
  // during global search the browsed folder itself can appear in results —
  // show its real parent path, not a misleading 本层
  if (pid === currentFolder.value && !searching.value) return '本层'
  if (currentFolder.value === '') return origPath(pid)
  // walk up to currentFolder; if pid is not a descendant, fall back to full path
  const chain: string[] = []
  let p = pid
  let guard = 0
  while (p && guard++ < 100) {
    if (p === currentFolder.value) return chain.join(' / ') || '本层'
    const row = trashById.value.get(p)
    if (!row) break
    chain.unshift(row.title || '(未命名)')
    p = row.parentId
  }
  return origPath(pid)
}

async function load() {
  loading.value = true
  try {
    const [r, tree] = await Promise.all([bookmarksApi.trash(), bookmarksApi.tree()])
    trash.value = r.nodes || []
    const rows = tree.nodes || []
    liveNameMap.value = new Map(rows.map((b) => [b.id, b.title || '(未命名)']))
    liveParent.value = new Map(rows.map((b) => [b.id, b.parentId]))
    // keep ids that still exist — a background revision mid-selection
    // shouldn't wipe the user's checked set
    const live = new Set(trash.value.map((b) => b.id))
    retainOnly(live)
    // browsed folder vanished (restored/purged elsewhere): climb back up to
    // the nearest ancestor that is still in the trash (browsable), else top.
    // The vanished row itself is gone from trashById, so its old parent comes
    // from the live tree hint — usable only if that parent is still trashed.
    if (currentFolder.value && !live.has(currentFolder.value)) {
      let p = trashById.value.get(currentFolder.value)?.parentId
        || liveParentId(currentFolder.value) || ''
      const seen = new Set([currentFolder.value])
      while (p && !live.has(p) && !seen.has(p)) {
        seen.add(p)
        p = trashById.value.get(p)?.parentId || ''
      }
      // p is browsable only while it is still a tombstoned folder
      currentFolder.value = p && live.has(p) ? p : ''
    }
    clearSelection()
  } catch (e: any) {
    ElMessage.error('回收站加载失败: ' + e.message)
  } finally {
    loading.value = false
  }
}
onMounted(load)

// background deletes (extension sync) refresh the trash too, coalesced
useRevRefresh(load)

// ---- filter pipeline (current level; search is global) ----
const searching = computed(() => q.value.trim().length > 0)
const now7 = computed(() => Date.now() / 1000 - 7 * 86400)
const baseRows = computed(() => (searching.value ? trash.value : currentRows.value))
const filtered = computed(() => {
  let rows = baseRows.value
  if (typeFilter.value === 'url') rows = rows.filter((b) => b.type === 'url')
  else if (typeFilter.value === 'folder') rows = rows.filter((b) => b.type === 'folder')
  if (timeFilter.value === '7d') rows = rows.filter((b) => (b.deletedAt || 0) >= now7.value)
  else if (timeFilter.value === 'older') rows = rows.filter((b) => (b.deletedAt || 0) < now7.value)
  if (searching.value) {
    const k = q.value.toLowerCase()
    rows = rows.filter((b) => (b.title || '').toLowerCase().includes(k) || (b.url || '').toLowerCase().includes(k))
  }
  const s = sortBy.value
  rows = [...rows].sort((a, b) =>
    s === 'deletedDesc' ? (b.deletedAt || 0) - (a.deletedAt || 0)
      : s === 'deletedAsc' ? (a.deletedAt || 0) - (b.deletedAt || 0)
        : (a.title || '').localeCompare(b.title || '')
  )
  return rows
})

// sidebar counts (always over the full trash, ignoring the active filter)
const counts = computed(() => {
  const week = now7.value
  return {
    all: topRows.value.length,
    total: trash.value.length,
    url: trash.value.filter((b) => b.type === 'url').length,
    folder: trash.value.filter((b) => b.type === 'folder').length,
    week: trash.value.filter((b) => (b.deletedAt || 0) >= week).length,
    older: trash.value.filter((b) => (b.deletedAt || 0) < week).length,
  }
})
type SideFilter = { key: string; label: string; ico: string; count: number; kind: 'type' | 'time' | 'all'; value: string }
const sideFilters = computed<SideFilter[]>(() => [
  { key: 'all', label: '全部', ico: 'trash', count: counts.value.all, kind: 'all', value: 'all' },
  { key: 'url', label: '网址书签', ico: 'bookmark', count: counts.value.url, kind: 'type', value: 'url' },
  { key: 'folder', label: '文件夹', ico: 'folder', count: counts.value.folder, kind: 'type', value: 'folder' },
  { key: '7d', label: '最近 7 天', ico: 'refresh', count: counts.value.week, kind: 'time', value: '7d' },
  { key: 'older', label: '7 天前', ico: 'stack', count: counts.value.older, kind: 'time', value: 'older' },
])
function pickFilter(f: SideFilter) {
  if (f.kind === 'all') { typeFilter.value = 'all'; timeFilter.value = 'all' }
  else if (f.kind === 'type') typeFilter.value = f.value as 'url' | 'folder'
  else timeFilter.value = f.value as '7d' | 'older'
}
const activeFilterKey = computed(() => {
  if (typeFilter.value === 'url') return 'url'
  if (typeFilter.value === 'folder') return 'folder'
  if (timeFilter.value === '7d') return '7d'
  if (timeFilter.value === 'older') return 'older'
  return 'all'
})

// ---- selection (composable, file-manager semantics) ----
const { checked, allChecked, toggleAll, selectRow, selectOnly, clearSelection, retainOnly } = useSelection(filtered)

// ---- actions ----
function openUrl(b: Bookmark) {
  if (b.url) window.open(b.url, '_blank', 'noopener')
}

// every restore goes through the dialog (default mechanism)
function openRestore(items: Bookmark[]) {
  if (!items.length) return
  restoreDlg.value?.open(items, trash.value)
}

function confirmPurgeText(items: Bookmark[]): string {
  if (items.length === 1) {
    const b = items[0]
    return `永久删除「${b.title || b.url}」？此操作不可撤销。`
  }
  return `永久删除所选 ${items.length} 项？此操作不可撤销。`
}

async function purge(items: Bookmark[]) {
  if (!items.length) return
  try {
    await ElMessageBox.confirm(confirmPurgeText(items), '彻底删除', { type: 'error', confirmButtonText: '彻底删除' })
  } catch { return }
  busy.value = true
  let ok = 0
  let failed = 0
  try {
    for (const b of items) {
      try { await bookmarksApi.purge(b.id); ok++ } catch { failed++ }
    }
    if (failed) ElMessage.warning(`已删除 ${ok} 项，${failed} 项失败`)
    else ElMessage.success(`已永久删除 ${ok} 项`)
    load()
  } finally {
    busy.value = false
  }
}

async function emptyAll() {
  if (!trash.value.length) return
  try {
    await ElMessageBox.confirm(`彻底删除回收站中全部 ${trash.value.length} 项？此操作不可撤销。`, '清空回收站', { type: 'error', confirmButtonText: '全部删除' })
  } catch { return }
  busy.value = true
  let ok = 0
  let failed = 0
  try {
    for (const b of trash.value) {
      try { await bookmarksApi.purge(b.id); ok++ } catch { failed++ }
    }
    if (failed) ElMessage.warning(`已删除 ${ok} 项，${failed} 项失败`)
    else ElMessage.success('回收站已清空')
    currentFolder.value = ''
    load()
  } finally {
    busy.value = false
  }
}

function viewInfo(b: Bookmark) {
  // read-only peek at a trashed item without restoring it
  editDlg.value?.openEdit(b)
}

// ---- context menus ----
function itemMenu(b: Bookmark, ev: MouseEvent) {
  if (!checked.value.has(b.id)) {
    selectOnly(b.id, filtered.value.indexOf(b))
  }
  const ids = [...checked.value]
  const multi = ids.length > 1
  const items: (CtxMenuItem | 'divider')[] = []
  if (multi) {
    items.push(
      { label: `恢复 ${ids.length} 项…`, icon: 'restore', handler: () => openRestore(selectedItems()) },
      'divider',
      { label: `彻底删除 ${ids.length} 项`, icon: 'trash', danger: true, handler: () => purge(selectedItems()) },
    )
  } else {
    if (b.type === 'folder') items.push({ label: '打开', icon: 'folder', handler: () => enterFolder(b) })
    else items.push({ label: '打开链接', icon: 'open', handler: () => openUrl(b) })
    items.push(
      { label: '恢复…', icon: 'restore', handler: () => openRestore([b]) },
      'divider',
      { label: '查看详情', icon: 'edit', handler: () => viewInfo(b) },
      'divider',
      { label: '彻底删除', icon: 'trash', danger: true, handler: () => purge([b]) },
    )
  }
  ctxMenu.value?.open(ev.clientX, ev.clientY, items)
}

function blankMenu(ev: MouseEvent) {
  if ((ev.target as HTMLElement).closest('.bm-row, .bm-card')) return
  clearSelection()
  const items: (CtxMenuItem | 'divider')[] = [
    { label: '全选', icon: 'check', handler: toggleAll },
    { label: '刷新', icon: 'refresh', handler: load },
    { label: viewMode.value === 'list' ? '切换到图标视图' : '切换到列表视图', icon: viewMode.value === 'list' ? 'grid' : 'list', handler: toggleViewMode },
  ]
  if (currentFolder.value) {
    items.push('divider', { label: '返回上一级', icon: 'up', handler: goUp })
  }
  if (trash.value.length) {
    items.push('divider', { label: '清空回收站', icon: 'trash', danger: true, handler: emptyAll })
  }
  ctxMenu.value?.open(ev.clientX, ev.clientY, items)
}

function selectedItems(): Bookmark[] {
  return filtered.value.filter((b) => checked.value.has(b.id))
}
// the batch bar acts on VISIBLE selected rows only — selections hidden by a
// later filter/search change would be silently dropped, so count what the
// buttons actually touch
const actionableCount = computed(() => selectedItems().length)
// a filter/search change that hides rows should drop those stale selections
watch([searching, typeFilter, timeFilter, currentFolder], () => {
  const visible = new Set(filtered.value.map((b) => b.id))
  const clipped = new Set([...checked.value].filter((id) => visible.has(id)))
  if (clipped.size !== checked.value.size) checked.value = clipped
})

// ---- keyboard (scoped to the content pane) ----
function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  const selected = selectedItems()
  switch (true) {
    case (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a':
      e.preventDefault(); toggleAll(); break
    case e.key === 'Escape':
      clearSelection(); break
    case e.key === 'Delete':
      if (selected.length) { e.preventDefault(); purge(selected) }
      break
    case e.key === 'Enter': {
      if (selected.length !== 1) break
      e.preventDefault()
      const b = selected[0]
      if (b.type === 'folder') enterFolder(b)
      else openRestore([b])
      break
    }
    case e.key === 'F2':
      if (selected.length === 1) { e.preventDefault(); viewInfo(selected[0]) }
      break
    case e.key === 'Backspace':
      if (currentFolder.value) { e.preventDefault(); goUp() }
      break
    case e.key === 'F5':
      e.preventDefault(); load(); break
  }
}
</script>

<template>
  <div class="bm-layout">
    <!-- side panel: filter groups + retention hint -->
    <div class="bm-side">
      <div class="panel-head">
        <span class="panel-title">回收站筛选</span>
        <button class="icon-btn" title="刷新" @click="load">
          <span style="display:inline-flex"><Icon name="refresh" :size="14" /></span>
        </button>
      </div>
      <div class="tr-nav">
        <button
          v-for="f in sideFilters"
          :key="f.key"
          class="tr-link"
          :class="{ active: activeFilterKey === f.key }"
          :title="f.key === 'all' ? `顶层 ${counts.all} 项 · 共 ${counts.total} 项` : ''"
          @click="pickFilter(f)"
        >
          <span class="tr-ico"><Icon :name="f.ico" :size="15" /></span>
          {{ f.label }}
          <span class="count">{{ f.count }}</span>
        </button>
      </div>
      <button v-if="currentFolder" class="tr-up-btn" @click="goUp">
        <Icon name="up" :size="13" /> 返回顶层
      </button>
      <div class="tr-summary">
        回收站内容不会自动清理，只有「彻底删除」才会真正移除数据。删除的文件夹可点开浏览，恢复时回到原位置（路径已删除会自动重建）。
      </div>
    </div>

    <!-- content -->
    <div
      class="bm-content"
      v-loading="loading"
      tabindex="0"
      @keydown="onKeydown"
      @contextmenu.prevent="blankMenu"
    >
      <div class="content-head">
        <div class="head-top">
          <div>
            <nav class="crumbs" aria-label="回收站路径">
              <template v-for="(c, i) in breadcrumbs" :key="c.id || '__top__'">
                <span v-if="i > 0" class="crumb-sep">/</span>
                <button
                  class="crumb"
                  :class="{ active: i === breadcrumbs.length - 1 }"
                  :disabled="i === breadcrumbs.length - 1"
                  @click="currentFolder = c.id; clearSelection()"
                >{{ c.title }}</button>
              </template>
              <button v-if="currentFolder" class="icon-btn up-btn" title="返回上一级" @click="goUp">↑</button>
            </nav>
            <h1 class="page-title">{{ searching ? '搜索结果' : (breadcrumbs[breadcrumbs.length - 1].title) }}</h1>
            <div class="page-sub">
              {{ filtered.length }} 项<template v-if="!searching && currentFolder === '' && counts.total !== counts.all">（共 {{ counts.total }} 项）</template><template v-if="actionableCount"> · 已选 {{ actionableCount }} 项</template>
            </div>
          </div>
          <div class="head-actions">
            <el-input v-model="q" placeholder="搜索全部回收站" clearable style="width: 220px">
              <template #prefix><span style="display:inline-flex;color:var(--md-text-3)"><Icon name="search" :size="14" /></span></template>
            </el-input>
            <el-select v-model="sortBy" style="width: 130px">
              <el-option label="最近删除优先" value="deletedDesc" />
              <el-option label="最早删除优先" value="deletedAsc" />
              <el-option label="按标题排序" value="title" />
            </el-select>
            <div class="view-switch" role="group" aria-label="视图切换">
              <button class="view-btn" :class="{ active: viewMode === 'list' }" title="列表视图" @click="viewMode = 'list'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
              </button>
              <button class="view-btn" :class="{ active: viewMode === 'grid' }" title="图标视图" @click="viewMode = 'grid'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
              </button>
            </div>
            <div v-if="viewMode === 'grid'" class="grid-size-switch" role="group" aria-label="图标大小">
              <button class="gs-btn" :class="{ active: gridSize === 'small' }" title="小图标" @click="gridSize = 'small'"><Icon name="grid" :size="11" /></button>
              <button class="gs-btn" :class="{ active: gridSize === 'medium' }" title="中图标" @click="gridSize = 'medium'"><Icon name="grid" :size="14" /></button>
              <button class="gs-btn" :class="{ active: gridSize === 'large' }" title="大图标" @click="gridSize = 'large'"><Icon name="grid" :size="17" /></button>
            </div>
            <el-button v-if="trash.length" type="danger" plain :disabled="busy" @click="emptyAll">清空回收站</el-button>
          </div>
        </div>

        <div v-if="actionableCount" class="batch-bar">
          已选择 <b>&nbsp;{{ actionableCount }}&nbsp;</b> 项
          <span class="spacer" />
          <el-button size="small" type="success" plain @click="openRestore(selectedItems())">恢复…</el-button>
          <el-button size="small" type="danger" plain :disabled="busy" @click="purge(selectedItems())">彻底删除</el-button>
          <el-button size="small" text @click="clearSelection">取消</el-button>
        </div>
      </div>

      <!-- ==================== LIST VIEW ==================== -->
      <div v-if="viewMode === 'list'" class="bm-list">
        <div class="bm-row" style="opacity: .75; border: none; padding-top: 4px; padding-bottom: 2px">
          <el-checkbox :model-value="allChecked" @change="toggleAll" />
          <span style="flex: 1; font-size: 12px; color: var(--md-text-3)">标题</span>
          <span style="width: 150px; font-size: 12px; color: var(--md-text-3); text-align: right">原位置</span>
          <span style="width: 110px; font-size: 12px; color: var(--md-text-3); text-align: right">删除时间</span>
        </div>

        <div
          v-for="(b, idx) in filtered"
          :key="b.id"
          class="bm-row"
          :class="{ selected: checked.has(b.id), 'tr-folder': b.type === 'folder' }"
          @click="selectRow(b, $event, idx)"
          @dblclick="b.type === 'folder' ? enterFolder(b) : openUrl(b)"
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
              <span>{{ b.title || b.url || '(未命名)' }}</span>
              <span v-if="b.type === 'folder'" class="bm-tag">{{ countOf(b.id) }} 项</span>
              <span v-if="b.type === 'folder' && countOf(b.id) === 0" class="bm-tag warn">空壳</span>
            </div>
            <div class="bm-url" v-if="b.type === 'url'">{{ b.url }}</div>
          </div>
          <span v-if="b.type === 'folder'" class="tr-enter-hint">›</span>
          <span class="tr-orig" :title="origPath(b.parentId)">{{ relPath(b.parentId) }}</span>
          <span style="width: 110px; text-align: right; color: var(--md-text-3); font-size: 12.5px; flex-shrink: 0">{{ fmtDate(b.deletedAt) }}</span>
          <div class="bm-actions">
            <button class="row-act success" title="恢复…" @click.stop="openRestore([b])">
              <span style="display:inline-flex"><Icon name="restore" :size="14" /></span>
            </button>
            <button class="row-act danger" title="彻底删除" @click.stop="purge([b])">
              <span style="display:inline-flex"><Icon name="trash" :size="14" /></span>
            </button>
          </div>
        </div>

        <div v-if="!loading && !filtered.length && trash.length" class="md-empty">
          <div class="md-empty-icon"><Icon name="search" :size="26" /></div>
          <div class="md-empty-title">没有匹配的条目</div>
          <div class="md-empty-hint">换个关键词或筛选条件试试</div>
        </div>
        <div v-else-if="!loading && !trash.length" class="md-empty">
          <div class="md-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
            </svg>
          </div>
          <div class="md-empty-title">回收站是空的</div>
          <div class="md-empty-hint">删除的书签会先出现在这里，确认后才真正消失</div>
        </div>
      </div>

      <!-- ==================== GRID VIEW ==================== -->
      <div v-else class="bm-grid">
        <div
          v-for="(b, idx) in filtered"
          :key="b.id"
          class="bm-card"
          :class="{ selected: checked.has(b.id) }"
          @click="selectRow(b, $event, idx)"
          @dblclick="b.type === 'folder' ? enterFolder(b) : openUrl(b)"
          @contextmenu.prevent.stop="itemMenu(b, $event)"
        >
          <div class="card-icon-wrap">
            <BookmarkAvatar :b="b" :size="40" />
          </div>
          <div class="card-title" :title="b.title || b.url">{{ b.title || b.url || '(未命名)' }}</div>
          <div class="card-sub">
            {{ b.type === 'folder' ? `含 ${countOf(b.id)} 项 · ${relPath(b.parentId)}` : relPath(b.parentId) }}
          </div>
          <div class="card-sub" style="margin-top: 2px">删除于 {{ fmtDate(b.deletedAt) }}</div>
        </div>

        <div v-if="!loading && !filtered.length && trash.length" class="md-empty" style="grid-column: 1 / -1">
          <div class="md-empty-icon"><Icon name="search" :size="26" /></div>
          <div class="md-empty-title">没有匹配的条目</div>
          <div class="md-empty-hint">换个关键词或筛选条件试试</div>
        </div>
        <div v-else-if="!loading && !trash.length" class="md-empty" style="grid-column: 1 / -1">
          <div class="md-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
            </svg>
          </div>
          <div class="md-empty-title">回收站是空的</div>
          <div class="md-empty-hint">删除的书签会先出现在这里，确认后才真正消失</div>
        </div>
      </div>
    </div>

    <ContextMenu ref="ctxMenu" />
    <EditBookmarkDialog ref="editDlg" />
    <RestoreDialog ref="restoreDlg" @done="load" />
  </div>
</template>
