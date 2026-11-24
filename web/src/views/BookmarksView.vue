<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import EditBookmarkDialog from '@/components/EditBookmarkDialog.vue'
import BatchMoveDialog from '@/components/BatchMoveDialog.vue'
import BatchTagDialog from '@/components/BatchTagDialog.vue'

interface TreeNode {
  id: string
  label: string
  type: 'folder' | 'url'
  isLeaf: boolean
  children: TreeNode[]
  raw: Bookmark
}

const tree = ref<TreeNode[]>([])
const flat = ref<Map<string, Bookmark>>(new Map())
const currentFolder = ref('')
const list = ref<Bookmark[]>([])
const checked = ref<Set<string>>(new Set())
const loading = ref(false)
const searchQ = ref('')
const tagFilter = ref('')
const allTags = ref<{ tag: string; count: number }[]>([])

const favFailed = ref<Set<string>>(new Set()) // hosts whose favicon failed to load
const editDlg = ref<InstanceType<typeof EditBookmarkDialog> | null>(null)
const moveDlg = ref<InstanceType<typeof BatchMoveDialog> | null>(null)
const tagDlg = ref<InstanceType<typeof BatchTagDialog> | null>(null)

// ---- palette for bookmark avatars ----
const AVATAR_COLORS = [
  'linear-gradient(135deg,#6474f3,#8b5cf6)',
  'linear-gradient(135deg,#22b07d,#17a2b8)',
  'linear-gradient(135deg,#f7b955,#f2874b)',
  'linear-gradient(135deg,#ec6f9c,#d84f75)',
  'linear-gradient(135deg,#38a2e8,#2b7de0)',
  'linear-gradient(135deg,#8f62e8,#6b46d9)',
]
function avatarColor(b: Bookmark): string {
  if (b.type === 'folder') return ''
  let h = 0
  for (const c of (b.url || b.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
function initial(b: Bookmark): string {
  const t = (b.title || b.url || '?').trim()
  return t.slice(0, 1).toUpperCase()
}

function hostOf(b: Bookmark): string {
  if (!b.url) return ''
  try { return new URL(b.url).host } catch { return '' }
}

function faviconSrc(b: Bookmark): string | null {
  const h = hostOf(b)
  if (!h || favFailed.value.has(h)) return null
  return '/api/favicon/' + encodeURIComponent(h)
}

function onFaviconError(b: Bookmark) {
  const h = hostOf(b)
  if (h) favFailed.value.add(h)
}

// ---- tree assembly ----
function buildTree(nodes: Bookmark[]): TreeNode[] {
  const byParent = new Map<string, Bookmark[]>()
  for (const n of nodes) {
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, [])
    byParent.get(n.parentId)!.push(n)
  }
  const sortKids = (a: Bookmark, b: Bookmark) => a.position - b.position
  const mk = (b: Bookmark): TreeNode => {
    const kids = (byParent.get(b.id) || []).filter((k) => k.type === 'folder').sort(sortKids)
    return { id: b.id, label: b.title || '(未命名)', type: b.type, isLeaf: b.type === 'url', raw: b, children: kids.map(mk) }
  }
  const roots = (byParent.get('') || []).filter((k) => k.type === 'folder').sort(sortKids)
  return roots.map(mk)
}

async function loadTree() {
  const { nodes } = await bookmarksApi.tree()
  flat.value = new Map(nodes.map((n) => [n.id, n]))
  tree.value = buildTree(nodes)
}

async function loadList() {
  loading.value = true
  try {
    const { nodes } = await bookmarksApi.tree()
    if (searchQ.value) { await doSearch(); return }
    const inFolder = nodes.filter((n) => n.parentId === currentFolder.value)
    inFolder.sort((a, b) => a.position - b.position)
    list.value = tagFilter.value ? inFolder.filter((n) => n.tags?.includes(tagFilter.value)) : inFolder
    checked.value = new Set()
  } finally {
    loading.value = false
  }
}

async function doSearch() {
  if (!searchQ.value) { await loadList(); return }
  loading.value = true
  try {
    const { results } = await bookmarksApi.search(searchQ.value, 200)
    list.value = tagFilter.value ? results.filter((n) => n.tags?.includes(tagFilter.value)) : results
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

function onRevision() { loadTree(); loadList() }
onMounted(() => {
  loadTree(); loadList()
  bookmarksApi.tags().then((r) => (allTags.value = r.tags))
  window.addEventListener('md:revision', onRevision)
})
onBeforeUnmount(() => window.removeEventListener('md:revision', onRevision))

// ---- CRUD ----
function openCreate(type: 'url' | 'folder') {
  editDlg.value?.openCreate(currentFolder.value, type)
}
function openEdit(b: Bookmark) {
  editDlg.value?.openEdit(b)
}
async function toggleFav(b: Bookmark) {
  await bookmarksApi.update(b.id, { favorite: !b.favorite })
  loadList()
}
async function removeOne(b: Bookmark) {
  await ElMessageBox.confirm(`将「${b.title || b.url}」移入回收站？`, '删除', { type: 'warning' })
  await bookmarksApi.remove(b.id)
  ElMessage.success('已移入回收站')
  loadTree(); loadList()
}

// ---- batch ----
const allChecked = computed(() => list.value.length > 0 && list.value.every((b) => checked.value.has(b.id)))
function toggleAll() {
  if (allChecked.value) checked.value = new Set()
  else checked.value = new Set(list.value.map((b) => b.id))
}
const selectedCount = computed(() => checked.value.size)

async function batchDelete() {
  const ids = [...checked.value]
  if (!ids.length) return
  await ElMessageBox.confirm(`将 ${ids.length} 项移入回收站？`, '批量删除', { type: 'warning' })
  await bookmarksApi.batch({ ids, action: 'delete' })
  ElMessage.success(`已删除 ${ids.length} 项`)
  loadTree(); loadList()
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

// ---- drag & drop ----
async function onDropToFolder(folderId: string, ev: DragEvent) {
  ev.preventDefault()
  const id = ev.dataTransfer?.getData('text/bookmark-id')
  if (!id || id === folderId) return
  const node = flat.value.get(id)
  if (!node) return
  if (node.type === 'folder') {
    let p = folderId
    while (p) {
      if (p === id) { ElMessage.warning('不能移动到自身子目录'); return }
      p = flat.value.get(p)?.parentId || ''
    }
  }
  try {
    await bookmarksApi.move(id, folderId, Date.now() % 1000)
    ElMessage.success('已移动')
    loadTree(); loadList()
  } catch (e: any) { ElMessage.error(e.message) }
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

function openUrl(url?: string) {
  if (url) window.open(url, '_blank', 'noopener')
}
function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString()
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
          draggable
        >
          <template #default="{ data }">
            <span
              class="folder-node"
              @dragover.prevent
              @drop="onDropToFolder(data.id, $event)"
            >
              <span>📁</span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ data.label }}</span>
            </span>
          </template>
        </el-tree>
      </div>
    </div>

    <!-- list -->
    <div class="bm-content" v-loading="loading">
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
              <template #prefix>🔍</template>
            </el-input>
            <el-select v-model="tagFilter" placeholder="按标签筛选" clearable style="width: 140px">
              <el-option v-for="t in allTags" :key="t.tag" :label="`${t.tag} (${t.count})`" :value="t.tag" />
            </el-select>
            <el-button type="primary" @click="openCreate('url')">＋ 新书签</el-button>
          </div>
        </div>

        <div v-if="selectedCount" class="batch-bar">
          已选择 <b>&nbsp;{{ selectedCount }}&nbsp;</b> 项
          <span class="spacer" />
          <el-button size="small" plain @click="batchTag">打标签</el-button>
          <el-button size="small" plain @click="batchMove">移动</el-button>
          <el-button size="small" type="danger" plain @click="batchDelete">删除</el-button>
          <el-button size="small" text @click="checked = new Set()">取消</el-button>
        </div>
      </div>

      <div class="bm-list">
        <!-- header row -->
        <div class="bm-row" style="opacity: .75; border: none; padding-top: 4px; padding-bottom: 2px">
          <el-checkbox :model-value="allChecked" @change="toggleAll" />
          <span style="flex: 1; font-size: 12px; color: var(--md-text-3)">标题</span>
          <span style="width: 200px; font-size: 12px; color: var(--md-text-3); text-align: right">标签</span>
          <span style="width: 96px; font-size: 12px; color: var(--md-text-3); text-align: right">添加日期</span>
        </div>

        <div
          v-for="b in list"
          :key="b.id"
          class="bm-row"
          :class="{ selected: checked.has(b.id) }"
          :draggable="true"
          @dragstart="(e: DragEvent) => e.dataTransfer?.setData('text/bookmark-id', b.id)"
          @dblclick="b.type === 'url' && openUrl(b.url)"
        >
          <el-checkbox
            :model-value="checked.has(b.id)"
            @change="checked.has(b.id) ? checked.delete(b.id) : checked.add(b.id)"
          />
          <div v-if="b.type === 'folder'" class="bm-avatar folder">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>
          </div>
          <div v-else-if="faviconSrc(b)" class="bm-avatar icon">
            <img :src="faviconSrc(b) ?? undefined" :alt="initial(b)" loading="lazy" @error="onFaviconError(b)" />
          </div>
          <div v-else class="bm-avatar" :style="`background:${avatarColor(b)}`">{{ initial(b) }}</div>
          <div class="bm-main" @click="b.type === 'folder' ? (currentFolder = b.id) : undefined" :style="b.type === 'folder' ? 'cursor:pointer' : ''">
            <div class="bm-title">
              <template v-if="b.type === 'folder'">{{ b.title }}</template>
              <a v-else :href="b.url" target="_blank" rel="noopener noreferrer" @click.stop>{{ b.title || b.url }}</a>
              <span v-if="b.favorite" class="fav-star">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
              </span>
              <span v-if="b.note" title="含备注" style="color:var(--md-text-3); font-size:12px">📝</span>
            </div>
            <div class="bm-url" v-if="b.type === 'url'">{{ b.url }}</div>
          </div>
          <div class="bm-tags">
            <span v-for="t in (b.tags || [])" :key="t" class="bm-tag">{{ t }}</span>
          </div>
          <span style="width: 96px; text-align: right; color: var(--md-text-3); font-size: 12.5px; flex-shrink: 0">{{ fmtDate(b.createdAt) }}</span>
          <div class="bm-actions">
            <button class="bm-act primary" @click="openEdit(b)">编辑</button>
            <button v-if="b.type === 'url'" class="bm-act" @click="toggleFav(b)">{{ b.favorite ? '取消收藏' : '收藏' }}</button>
            <button v-if="b.type === 'folder'" class="bm-act" @click="currentFolder = b.id">打开</button>
            <button class="bm-act danger" @click="removeOne(b)">删除</button>
          </div>
        </div>

        <div v-if="!loading && !list.length" class="md-empty">
          <div class="md-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <div class="md-empty-title">这里还没有书签</div>
          <div class="md-empty-hint">点击右上角「＋ 新书签」添加，或从浏览器导入 · 也可以把书签拖进左侧文件夹</div>
        </div>
      </div>
    </div>

    <EditBookmarkDialog ref="editDlg" @saved="() => { loadTree(); loadList() }" />
    <BatchMoveDialog ref="moveDlg" @done="() => { loadTree(); loadList() }" />
    <BatchTagDialog ref="tagDlg" @done="() => { loadList() }" />
  </div>
</template>
