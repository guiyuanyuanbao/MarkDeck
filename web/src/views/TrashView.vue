<script setup lang="ts">
// Trash view, laid out like BookmarksView (side panel + content card).
// The side panel is a filter list (type / age buckets) instead of a folder
// tree — the trash is flat, but the two-column rhythm stays consistent.
// Right-click menus mirror the bookmark menus with trash-specific actions.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import EditBookmarkDialog from '@/components/EditBookmarkDialog.vue'
import BatchMoveDialog from '@/components/BatchMoveDialog.vue'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'
import ContextMenu, { type CtxMenuItem } from '@/components/ContextMenu.vue'
import { Icon } from '@/components/icons'

const trash = ref<Bookmark[]>([])
const loading = ref(false)
const checked = ref<Set<string>>(new Set())
const busy = ref(false)
let lastIndex = -1

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

const moveDlg = ref<InstanceType<typeof BatchMoveDialog> | null>(null)
const ctxMenu = ref<InstanceType<typeof ContextMenu> | null>(null)
const editDlg = ref<InstanceType<typeof EditBookmarkDialog> | null>(null)

// original parent names: live tree covers surviving parents, the trash list
// itself covers folders deleted together with their children
const nameMap = ref<Map<string, string>>(new Map())
function origName(pid: string): string {
  if (!pid) return '根目录'
  return nameMap.value.get(pid) || '（原文件夹已删除）'
}

async function load() {
  loading.value = true
  try {
    const [r, tree] = await Promise.all([bookmarksApi.trash(), bookmarksApi.tree()])
    trash.value = r.nodes || []
    const m = new Map<string, string>()
    for (const n of tree.nodes || []) m.set(n.id, n.title || '(未命名)')
    for (const t of trash.value) m.set(t.id, t.title || '(未命名)')
    nameMap.value = m
    // keep ids that still exist — a background revision mid-selection
    // shouldn't wipe the user's checked set
    const live = new Set(trash.value.map((b) => b.id))
    checked.value = new Set([...checked.value].filter((id) => live.has(id)))
    lastIndex = -1
  } catch (e: any) {
    ElMessage.error('回收站加载失败: ' + e.message)
  } finally {
    loading.value = false
  }
}
onMounted(load)

// background deletes (extension sync) refresh the trash too, coalesced
let revTimer: ReturnType<typeof setTimeout> | null = null
function onRevision() {
  if (revTimer) return
  revTimer = setTimeout(() => { revTimer = null; load() }, 800)
}
onMounted(() => window.addEventListener('md:revision', onRevision))
onBeforeUnmount(() => window.removeEventListener('md:revision', onRevision))

// ---- filter pipeline ----
const now7 = computed(() => Date.now() / 1000 - 7 * 86400)
const filtered = computed(() => {
  let rows = trash.value
  if (typeFilter.value === 'url') rows = rows.filter((b) => b.type === 'url')
  else if (typeFilter.value === 'folder') rows = rows.filter((b) => b.type === 'folder')
  if (timeFilter.value === '7d') rows = rows.filter((b) => (b.deletedAt || 0) >= now7.value)
  else if (timeFilter.value === 'older') rows = rows.filter((b) => (b.deletedAt || 0) < now7.value)
  if (q.value) {
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
    all: trash.value.length,
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

// ---- selection (file-manager semantics, same as BookmarksView) ----
const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every((b) => checked.value.has(b.id)))
function toggleAll() {
  if (allChecked.value) checked.value = new Set()
  else checked.value = new Set(filtered.value.map((b) => b.id))
}
function selectRow(b: Bookmark, ev: MouseEvent, idx: number) {
  if (ev.ctrlKey || ev.metaKey) {
    if (checked.value.has(b.id)) checked.value.delete(b.id)
    else checked.value.add(b.id)
    lastIndex = idx
    return
  }
  if (ev.shiftKey && lastIndex >= 0) {
    const [a, z] = lastIndex < idx ? [lastIndex, idx] : [idx, lastIndex]
    for (let i = a; i <= z; i++) checked.value.add(filtered.value[i].id)
    return
  }
  checked.value = new Set([b.id])
  lastIndex = idx
}
function clearSelection() { checked.value = new Set(); lastIndex = -1 }

// ---- actions ----
function openUrl(b: Bookmark) {
  if (b.url) window.open(b.url, '_blank', 'noopener')
}
function fmtDate(ts?: number) {
  return ts ? new Date(ts * 1000).toLocaleString() : '—'
}

async function restoreOne(b: Bookmark) {
  try {
    await bookmarksApi.restore(b.id)
    ElMessage.success('已恢复')
    load()
  } catch (e: any) { ElMessage.error('恢复失败: ' + e.message) }
}

// restore first, then let the user pick a folder — Restore re-attaches to
// the original parent (or root when it's gone), the dialog overrides that
async function restoreTo(b: Bookmark) {
  try {
    await bookmarksApi.restore(b.id)
    load()
    moveDlg.value?.open([b.id])
  } catch (e: any) { ElMessage.error('恢复失败: ' + e.message) }
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

async function batchRestore() {
  const ids = [...checked.value]
  if (!ids.length) return
  busy.value = true
  try {
    await bookmarksApi.batch({ ids, action: 'restore' })
    ElMessage.success(`已恢复 ${ids.length} 项`)
    load()
  } catch (e: any) {
    ElMessage.error(e.message)
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
    checked.value = new Set([b.id])
    lastIndex = filtered.value.indexOf(b)
  }
  const ids = [...checked.value]
  const multi = ids.length > 1
  const items: (CtxMenuItem | 'divider')[] = []
  if (multi) {
    if (counts.value.url) {
      // mixed selection may still contain urls — open each in its own tab
      const urls = filtered.value.filter((x) => checked.value.has(x.id) && x.url)
      if (urls.length) items.push({ label: `打开 ${urls.length} 个链接`, icon: 'open', handler: () => urls.forEach(openUrl) })
    }
    items.push(
      { label: `恢复 ${ids.length} 项`, icon: 'restore', handler: batchRestore },
      'divider',
      { label: `彻底删除 ${ids.length} 项`, icon: 'trash', danger: true, handler: () => purge(filtered.value.filter((x) => checked.value.has(x.id))) },
    )
  } else {
    if (b.type === 'url') items.push({ label: '打开链接', icon: 'open', handler: () => openUrl(b) })
    items.push(
      { label: '恢复', icon: 'restore', handler: () => restoreOne(b) },
      { label: '恢复到指定文件夹…', icon: 'folder', handler: () => restoreTo(b) },
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
  if (trash.value.length) {
    items.push('divider', { label: '清空回收站', icon: 'trash', danger: true, handler: emptyAll })
  }
  ctxMenu.value?.open(ev.clientX, ev.clientY, items)
}

// ---- keyboard (scoped to the content pane) ----
function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  const selected = filtered.value.filter((b) => checked.value.has(b.id))
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
      if (b.type === 'url') openUrl(b)
      else viewInfo(b)
      break
    }
    case e.key === 'F2':
      if (selected.length === 1) { e.preventDefault(); viewInfo(selected[0]) }
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
          @click="pickFilter(f)"
        >
          <span class="tr-ico"><Icon :name="f.ico" :size="15" /></span>
          {{ f.label }}
          <span class="count">{{ f.count }}</span>
        </button>
      </div>
      <div class="tr-summary">
        回收站内容不会自动清理，只有「彻底删除」才会真正移除数据。删除的文件夹会连同其中的书签一起入站，恢复时整体还原。
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
            <h1 class="page-title">回收站</h1>
            <div class="page-sub">
              {{ filtered.length }} 项<template v-if="filtered.length !== trash.length">（共 {{ trash.length }} 项）</template><template v-if="checked.size"> · 已选 {{ checked.size }} 项</template>
            </div>
          </div>
          <div class="head-actions">
            <el-input v-model="q" placeholder="搜索标题 / URL" clearable style="width: 220px">
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
            <el-button v-if="trash.length" type="danger" plain :disabled="busy" @click="emptyAll">清空回收站</el-button>
          </div>
        </div>

        <div v-if="checked.size" class="batch-bar">
          已选择 <b>&nbsp;{{ checked.size }}&nbsp;</b> 项
          <span class="spacer" />
          <el-button size="small" type="success" plain @click="batchRestore">恢复</el-button>
          <el-button size="small" type="danger" plain :disabled="busy" @click="purge(filtered.filter((x) => checked.has(x.id)))">彻底删除</el-button>
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
          :class="{ selected: checked.has(b.id) }"
          @click="selectRow(b, $event, idx)"
          @dblclick="b.type === 'url' ? openUrl(b) : viewInfo(b)"
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
              <span v-if="b.type === 'folder'" class="bm-tag">文件夹</span>
            </div>
            <div class="bm-url" v-if="b.type === 'url'">{{ b.url }}</div>
          </div>
          <span class="tr-orig" :title="origName(b.parentId)">{{ origName(b.parentId) }}</span>
          <span style="width: 110px; text-align: right; color: var(--md-text-3); font-size: 12.5px; flex-shrink: 0">{{ fmtDate(b.deletedAt) }}</span>
          <div class="bm-actions">
            <button class="row-act success" title="恢复" @click.stop="restoreOne(b)">
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
          @dblclick="b.type === 'url' ? openUrl(b) : viewInfo(b)"
          @contextmenu.prevent.stop="itemMenu(b, $event)"
        >
          <div class="card-icon-wrap">
            <BookmarkAvatar :b="b" :size="40" />
          </div>
          <div class="card-title" :title="b.title || b.url">{{ b.title || b.url || '(未命名)' }}</div>
          <div class="card-sub">
            {{ b.type === 'folder' ? '文件夹 · ' + origName(b.parentId) : origName(b.parentId) }}
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
    <BatchMoveDialog ref="moveDlg" @done="load" />
  </div>
</template>
