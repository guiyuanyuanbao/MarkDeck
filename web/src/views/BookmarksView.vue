<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import EditBookmarkDialog from '@/components/EditBookmarkDialog.vue'

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
const selection = ref<Bookmark[]>([])
const loading = ref(false)
const searchQ = ref('')
const searching = ref(false)
const tagFilter = ref('')
const allTags = ref<{ tag: string; count: number }[]>([])

const editDlg = ref<InstanceType<typeof EditBookmarkDialog> | null>(null)

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
  } finally {
    loading.value = false
  }
}

async function doSearch() {
  if (!searchQ.value) { await loadList(); return }
  searching.value = true
  try {
    const { results } = await bookmarksApi.search(searchQ.value, 200)
    list.value = tagFilter.value ? results.filter((n) => n.tags?.includes(tagFilter.value)) : results
  } finally {
    searching.value = false
  }
}

watch([currentFolder, tagFilter], loadList)
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQ, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(doSearch, 300)
})

// live updates from other tabs/devices
function onRevision() { loadTree(); loadList() }
onMounted(() => {
  loadTree(); loadList()
  bookmarksApi.tags().then((r) => (allTags.value = r.tags))
  window.addEventListener('md:revision', onRevision)
})
onBeforeUnmount(() => window.removeEventListener('md:revision', onRevision))

// ---- CRUD actions ----
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
async function batchDelete() {
  const ids = selection.value.map((s) => s.id)
  if (!ids.length) return
  await ElMessageBox.confirm(`将 ${ids.length} 项移入回收站？`, '批量删除', { type: 'warning' })
  await bookmarksApi.batch({ ids, action: 'delete' })
  ElMessage.success(`已删除 ${ids.length} 项`)
  loadTree(); loadList()
}
async function batchMove() {
  const ids = selection.value.map((s) => s.id)
  if (!ids.length) return
  // pick destination folder via cascader-less prompt: use tree dialog
  const folders = [...flat.value.values()].filter((n) => n.type === 'folder')
  const names = folders.map((f) => (f.parentId ? f.title : '📂 ' + (f.title || '根')) )
  try {
    const { value } = await ElMessageBox.prompt(
      `输入目标文件夹（共 ${folders.length} 个）：\n` + names.slice(0, 20).join('\n'),
      '批量移动', { inputPlaceholder: '文件夹名称', inputValue: '' })
    const target = folders.find((f) => f.title === value.trim())
    if (!target) { ElMessage.warning('未找到该文件夹'); return }
    await bookmarksApi.batch({ ids, action: 'move', parentId: target.id })
    ElMessage.success(`已移动 ${ids.length} 项`)
    loadTree(); loadList()
  } catch { /* cancelled */ }
}
async function batchTag() {
  const ids = selection.value.map((s) => s.id)
  if (!ids.length) return
  try {
    const { value } = await ElMessageBox.prompt('输入要添加的标签（可逗号分隔多个）', '批量打标签')
    for (const tag of value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)) {
      await bookmarksApi.batch({ ids, action: 'tag', tag })
    }
    ElMessage.success('标签已添加')
    loadList()
  } catch { /* cancelled */ }
}

// ---- drag & drop from list onto tree ----
async function onDropToFolder(folderId: string, ev: DragEvent) {
  ev.preventDefault()
  const id = ev.dataTransfer?.getData('text/bookmark-id')
  if (!id || id === folderId) return
  const node = flat.value.get(id)
  if (!node) return
  if (node.type === 'folder') {
    // reject dropping folder into its own descendant
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

function favicon(b: Bookmark) {
  if (b.type === 'folder') return '📁'
  try { return '🌐' } catch { return '🌐' }
}

function openUrl(url?: string) {
  if (url) window.open(url, '_blank', 'noopener')
}
</script>

<template>
  <div style="display:flex; gap: 16px; height: 100%">
    <!-- folder tree -->
    <el-card shadow="never" style="width: 280px; flex-shrink: 0; overflow:auto" body-style="padding: 8px">
      <template #header>
        <div style="display:flex; justify-content:space-between; align-items:center">
          <b>文件夹</b>
          <el-button size="small" @click="openCreate('folder')">＋</el-button>
        </div>
      </template>
      <el-tree
        :data="tree"
        node-key="id"
        :props="{ label: 'label', children: 'children', isLeaf: 'isLeaf' }"
        :expand-on-click-node="false"
        highlight-current
        @node-click="(n: TreeNode) => (currentFolder = n.id)"
        @node-drag-start="(e: any) => e.dataTransfer?.setData('text/bookmark-id', e.node?.data?.id || '')"
        draggable
      >
        <template #default="{ data }">
          <span
            style="display:flex; align-items:center; gap:6px; width:100%"
            @dragover.prevent
            @drop="onDropToFolder(data.id, $event)"
          >
            📁 {{ data.label }}
          </span>
        </template>
      </el-tree>
    </el-card>

    <!-- list -->
    <el-card shadow="never" style="flex:1; overflow:auto" body-style="padding: 12px">
      <template #header>
        <div style="display:flex; flex-wrap: wrap; gap: 8px; align-items:center">
          <b style="margin-right: 4px">{{ folderName }}</b>
          <el-input v-model="searchQ" placeholder="全文搜索：标题 / URL / 备注" clearable style="width: 260px" />
          <el-select v-model="tagFilter" placeholder="按标签筛选" clearable style="width: 140px">
            <el-option v-for="t in allTags" :key="t.tag" :label="`${t.tag} (${t.count})`" :value="t.tag" />
          </el-select>
          <el-button type="primary" @click="openCreate('url')">＋ 新书签</el-button>
          <el-button v-if="selection.length" type="danger" plain @click="batchDelete">删除 ({{ selection.length }})</el-button>
          <el-button v-if="selection.length" plain @click="batchMove">移动</el-button>
          <el-button v-if="selection.length" plain @click="batchTag">打标签</el-button>
        </div>
      </template>

      <el-table
        :data="list"
        v-loading="loading"
        @selection-change="(rows: Bookmark[]) => (selection = rows)"
        size="default"
        :row-key="(r: Bookmark) => r.id"
        @row-dblclick="(row: Bookmark) => row.type === 'url' && openUrl(row.url)"
        draggable
      >
        <el-table-column type="selection" width="42" />
        <el-table-column label="" width="44">
          <template #default="{ row }">{{ favicon(row) }}</template>
        </el-table-column>
        <el-table-column label="标题" min-width="220">
          <template #default="{ row }">
            <div
              class="bm-title"
              :draggable="true"
              @dragstart="(e: DragEvent) => e.dataTransfer?.setData('text/bookmark-id', row.id)"
              style="cursor: grab"
            >
              <b v-if="row.type === 'folder'">{{ row.title }}</b>
              <a v-else :href="row.url" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: none">{{ row.title || row.url }}</a>
              <el-icon v-if="row.favorite" style="color:#f7ba2a; vertical-align: -2px"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></el-icon>
            </div>
            <div class="bm-url" v-if="row.type === 'url'">{{ row.url }}</div>
          </template>
        </el-table-column>
        <el-table-column label="标签" width="180">
          <template #default="{ row }">
            <el-tag v-for="t in (row.tags || [])" :key="t" size="small" style="margin-right:4px">{{ t }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link size="small" @click="toggleFav(row)">{{ row.favorite ? '取消收藏' : '收藏' }}</el-button>
            <el-button v-if="row.type === 'folder'" link size="small" @click="currentFolder = row.id">打开</el-button>
            <el-button link size="small" type="danger" @click="removeOne(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="此文件夹为空（试试拖拽书签到左侧文件夹）" />
        </template>
      </el-table>
    </el-card>

    <EditBookmarkDialog ref="editDlg" @saved="() => { loadTree(); loadList() }" />
  </div>
</template>
