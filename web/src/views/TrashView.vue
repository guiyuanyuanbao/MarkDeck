<script setup lang="ts">
// Trash view, laid out like BookmarksView (side panel + content card) with
// PikPak-style hierarchical browsing: trashed folders are clickable rows —
// entering one shows its tombstoned children, breadcrumbs navigate back up.
// All restore flows go through RestoreDialog (the default mechanism): it
// defaults to the original location, rebuilds deleted ancestor paths
// server-side (RestoreWithPath shells) and merges into same-name folders.
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import EditBookmarkDialog from '@/components/EditBookmarkDialog.vue'
import RestoreDialog from '@/components/RestoreDialog.vue'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'
import ContextMenu, { type CtxMenuItem } from '@/components/ContextMenu.vue'
import ViewSwitch from '@/components/ViewSwitch.vue'
import GridSizeSwitch from '@/components/GridSizeSwitch.vue'
import EmptyState from '@/components/EmptyState.vue'
import { Icon } from '@/components/icons'
import { useSelection } from '@/composables/selection'
import { useRevRefresh } from '@/composables/revRefresh'
import { useViewMode, useGridSize } from '@/composables/useViewMode'
import { applyScopeFilters, buildScopeFilters, origPath as origPathOf, relPath as relPathOf, type SideFilterLike } from '@/composables/trashScopes'
import { fmtDate, confirmAct, errMsg } from '@/utils/ui'

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
  // folder contents are always browsed in the 全部 hierarchy — entering from
  // a flat scope (文件夹/最近7天…) switches scope so the children are never
  // hidden by a leftover filter (user feedback: entering 数据 with the
  // 文件夹 filter active showed "没有匹配的条目" for a folder holding URLs)
  scope.value = 'all'
  currentFolder.value = b.id
  clearSelection()
}
function goUp() {
  if (!currentFolder.value) return
  currentFolder.value = trashById.value.get(currentFolder.value)?.parentId || ''
  clearSelection()
}

// ---- scopes: each sidebar entry is a self-contained scope whose badge
// count always equals the content it shows. 'all' keeps hierarchical folder
// browsing; the other four are flat global lists over the whole trash (the
// old type×time filter pair produced count/content mismatches — the
// 网址书签 badge said 8 while the level-scoped list showed 1).
const scope = ref<'all' | 'url' | 'folder' | '7d' | 'older'>('all')

// ---- filters ----
const q = ref('')
const sortBy = ref<'deletedDesc' | 'deletedAsc' | 'title'>('deletedDesc')

// view mode (list | grid), persisted separately from the bookmarks view;
// grid density shares the bookmarks view's global data-gridsize attribute
// and md-grid-size key (shared composables)
const viewMode = useViewMode('md-trash-view-mode')
const gridSize = useGridSize()

const restoreDlg = ref<InstanceType<typeof RestoreDialog> | null>(null)
const ctxMenu = ref<InstanceType<typeof ContextMenu> | null>(null)
const editDlg = ref<InstanceType<typeof EditBookmarkDialog> | null>(null)

// live tree names: an ancestor may already be restored (shell or whole tree)
// while its children remain trashed — the 原位置 chain must keep resolving
const liveNameMap = ref<Map<string, string>>(new Map())

// original location / relative path renderers live in composables/trashScopes
// (pure, tested: trashed ancestors, restored live ones, purged markers)
// parent of a live row (from the live tree map, refreshed in load())
const liveParent = ref<Map<string, string>>(new Map())
function liveParentId(id: string): string {
  return liveParent.value.get(id) || ''
}
function origPath(pid: string): string {
  return origPathOf(pid, trashById.value, liveNameMap.value, liveParentId)
}
function relPath(pid: string): string {
  return relPathOf(pid, scope.value, currentFolder.value, searching.value, trashById.value, liveNameMap.value, liveParentId)
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
  } catch (e) {
    ElMessage.error('回收站加载失败: ' + errMsg(e))
  } finally {
    loading.value = false
  }
}
onMounted(load)

// background deletes (extension sync) refresh the trash too, coalesced
useRevRefresh(load)

// ---- scope pipeline (composables/trashScopes, tested: badge==content) ----
const searching = computed(() => q.value.trim().length > 0)
const filtered = computed(() =>
  applyScopeFilters(trash.value, scope.value, currentRows.value, searching.value, q.value, sortBy.value, Math.floor(Date.now() / 1000)),
)

// sidebar scope entries. badge counts describe the CONTENT the entry shows —
// never two different numbers for one entry (old design showed 网址书签 8 but
// listed the level's 1).
const sideFilters = computed<SideFilterLike[]>(() =>
  buildScopeFilters(trash.value, topRows.value.length, Math.floor(Date.now() / 1000)),
)
function pickFilter(f: SideFilterLike) {
  scope.value = f.key
  // hierarchy browsing only exists in 'all'; leaving it drops the folder
  if (f.key !== 'all') currentFolder.value = ''
}
// content-pane title: matches the picked scope (search overrides)
const scopeTitle = computed(() => {
  if (searching.value) return '搜索结果'
  const s = sideFilters.value.find((f) => f.key === scope.value)
  if (scope.value !== 'all') return s?.label || '回收站'
  return breadcrumbs.value[breadcrumbs.value.length - 1].title
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

function purge(items: Bookmark[]) {
  if (!items.length) return
  busy.value = true
  void confirmAct(confirmPurgeText(items), '彻底删除', async () => {
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
  }, { type: 'error', confirmButtonText: '彻底删除' })
    .finally(() => { busy.value = false })
}

function emptyAll() {
  if (!trash.value.length) return
  busy.value = true
  void confirmAct(`彻底删除回收站中全部 ${trash.value.length} 项？此操作不可撤销。`, '清空回收站', async () => {
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
  }, { type: 'error', confirmButtonText: '全部删除' })
    .finally(() => { busy.value = false })
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
    { label: viewMode.value === 'list' ? '切换到图标视图' : '切换到列表视图', icon: viewMode.value === 'list' ? 'grid' : 'list', handler: () => (viewMode.value = viewMode.value === 'list' ? 'grid' : 'list') },
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
// a scope/search change that hides rows should drop those stale selections
watch([searching, scope, currentFolder], () => {
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
          :class="{ active: scope === f.key }"
          :title="f.hint"
          @click="pickFilter(f)"
        >
          <span class="tr-ico"><Icon :name="f.ico" :size="15" /></span>
          {{ f.label }}
          <span class="count">{{ f.count }}</span>
        </button>
      </div>
      <button v-if="scope === 'all' && currentFolder" class="tr-up-btn" @click="goUp">
        <Icon name="up" :size="13" /> 返回顶层
      </button>
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
            <nav v-if="scope === 'all'" class="crumbs" aria-label="回收站路径">
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
            <h1 class="page-title">{{ searching ? '搜索结果' : (scopeTitle) }}</h1>
            <div class="page-sub">
              {{ filtered.length }} 项<template v-if="!searching && scope === 'all' && currentFolder === '' && trash.length !== topRows.length">（共 {{ trash.length }} 项）</template><template v-if="actionableCount"> · 已选 {{ actionableCount }} 项</template>
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
            <ViewSwitch v-model="viewMode" />
            <GridSizeSwitch v-if="viewMode === 'grid'" v-model="gridSize" />
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
        <!-- header row: mirrors the data-row column structure exactly
             (avatar slot + enter-hint slot + orig + date + actions slot)
             so columns align across folder/url rows -->
        <div class="bm-row bm-row-head">
          <el-checkbox :model-value="allChecked" @change="toggleAll" />
          <div class="bm-avatar bm-avatar-head" />
          <span class="bm-main bm-col-head">标题</span>
          <span class="tr-enter-slot" />
          <span class="tr-orig bm-col-head">原位置</span>
          <span class="bm-date bm-col-head bm-date-wide">删除时间</span>
          <div class="bm-actions bm-actions-head" />
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
          <span class="tr-enter-slot">{{ b.type === 'folder' ? '›' : '' }}</span>
          <span class="tr-orig" :title="origPath(b.parentId)">{{ relPath(b.parentId) }}</span>
          <span class="bm-date bm-date-wide">{{ fmtDate(b.deletedAt) }}</span>
          <div class="bm-actions">
            <button class="row-act success" title="恢复…" @click.stop="openRestore([b])">
              <span style="display:inline-flex"><Icon name="restore" :size="14" /></span>
            </button>
            <button class="row-act danger" title="彻底删除" @click.stop="purge([b])">
              <span style="display:inline-flex"><Icon name="trash" :size="14" /></span>
            </button>
          </div>
        </div>

        <EmptyState v-if="!loading && !filtered.length && trash.length" icon="search" title="没有匹配的条目" hint="换个关键词或筛选条件试试" />
        <EmptyState v-else-if="!loading && !trash.length" title="回收站是空的" hint="删除的书签会先出现在这里，确认后才真正消失" />
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

        <EmptyState v-if="!loading && !filtered.length && trash.length" icon="search" title="没有匹配的条目" hint="换个关键词或筛选条件试试" />
        <EmptyState v-else-if="!loading && !trash.length" title="回收站是空的" hint="删除的书签会先出现在这里，确认后才真正消失" />
      </div>
    </div>

    <ContextMenu ref="ctxMenu" />
    <EditBookmarkDialog ref="editDlg" />
    <RestoreDialog ref="restoreDlg" @done="load" />
  </div>
</template>
