<script setup lang="ts">
// RestoreDialog: the default restore mechanism for the trash. Picking a
// target folder (defaulting to the item's original location) and confirming
// calls restore with { parentId, includeChildren }. Extends the
// BatchMoveDialog tree-picker pattern with:
//  - original-location default + 「将自动重建路径」 warning when the original
//    parent is itself trashed (server shells it back)
//  - include-children checkbox for folders (default on = whole subtree)
//  - inline new-folder creation under the selected node
//  - batch mode: restore each to its own original spot, or one shared target
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'

const emit = defineEmits<{ done: [] }>()

interface NodeItem { id: string; label: string; children?: NodeItem[] }

const visible = ref(false)
const loading = ref(false)
const folders = ref<NodeItem[]>([])
const target = ref<string | null>(null)
const pending = ref<Bookmark[]>([])
const includeChildren = ref(true)
const batchMode = ref<'own' | 'unified'>('own')

// original-location info per pending item (from the trash data)
const trashById = ref<Map<string, Bookmark>>(new Map())
// live folder ids, to detect "original parent is trashed" (needs path rebuild)
const liveIds = ref<Set<string>>(new Set())

const single = computed(() => pending.value.length === 1 ? pending.value[0] : null)
const isFolder = computed(() => pending.value.length === 1 && pending.value[0].type === 'folder')

// path label of the original parent, e.g. 大文件夹/嵌套 — resolved from
// trash rows + live tree names (trashMap covers trashed ancestors)
const origPaths = computed(() => {
  const out: { id: string; label: string; needsRebuild: boolean }[] = []
  const seen = new Set<string>()
  for (const item of pending.value) {
    if (seen.has(item.parentId)) continue
    seen.add(item.parentId)
    const chain: string[] = []
    let p = item.parentId
    let guard = 0
    let broken = false
    while (p && guard++ < 100) {
      if (liveIds.value.has(p)) {
        chain.unshift(trashById.value.get(p)?.title || nameOf(p) || '(未知)')
        break
      }
      const row = trashById.value.get(p)
      if (!row) { broken = true; break }
      chain.unshift(row.title || '(未命名)')
      p = row.parentId
    }
    if (!p) chain.unshift('根目录')
    out.push({
      id: item.parentId,
      label: chain.join(' / '),
      needsRebuild: broken || (item.parentId !== '' && !liveIds.value.has(item.parentId)),
    })
  }
  return out
})

const origLabel = computed(() => origPaths.value[0]?.label || '根目录')
const needsRebuild = computed(() => origPaths.value.some((o) => o.needsRebuild))
const subtreeCount = computed(() => {
  const item = single.value
  if (!item || item.type !== 'folder') return 0
  // count tombstoned descendants from the trash rows
  let n = 0
  let frontier = [item.id]
  let guard = 0
  while (frontier.length && guard++ < 10000) {
    const next: string[] = []
    for (const row of trashById.value.values()) {
      if (frontier.includes(row.parentId)) { n++; next.push(row.id) }
    }
    frontier = next
  }
  return n
})

let liveNames = new Map<string, string>()
function nameOf(id: string): string | undefined { return liveNames.get(id) }

async function loadFolders() {
  const { nodes } = await bookmarksApi.tree()
  const rows = nodes || [] // server nil-encodes empty sets
  liveIds.value = new Set(rows.map((n) => n.id))
  liveNames = new Map(rows.map((n) => [n.id, n.title || '(未命名)']))
  const mk = (list: Bookmark[]): NodeItem[] =>
    list.filter((n) => n.type === 'folder').map((n) => ({
      id: n.id,
      label: n.title || '(未命名)',
      children: mk(rows.filter((c) => c.parentId === n.id)),
    }))
  folders.value = mk(rows.filter((n) => n.parentId === ''))
}

const newFolderName = ref('')

// open(items, ctx): ctx.trash = all trash rows (for path resolution)
async function open(items: Bookmark[], trashRows: Bookmark[]) {
  pending.value = items
  trashById.value = new Map(trashRows.map((r) => [r.id, r]))
  batchMode.value = items.length > 1 ? 'own' : 'unified'
  includeChildren.value = true
  // target null = "original location" (server rebuilds deleted paths);
  // '' = pinned root; a folder id = pinned folder. Default to original.
  target.value = null
  await loadFolders()
  // preselect the original location ONLY when it is a live folder
  if (items.length === 1 && items[0].parentId && liveIds.value.has(items[0].parentId)) {
    target.value = items[0].parentId
  }
  visible.value = true
}

async function createInlineFolder() {
  const name = newFolderName.value.trim()
  if (!name) { ElMessage.warning('请输入文件夹名称'); return }
  if (target.value === null) { ElMessage.warning('请先选择父级文件夹'); return }
  loading.value = true
  try {
    const created = await bookmarksApi.create({ type: 'folder', parentId: target.value, title: name })
    ElMessage.success(`已创建「${name}」`)
    newFolderName.value = ''
    await loadFolders()
    target.value = created.id
  } catch (e: any) { ElMessage.error(e.message) } finally { loading.value = false }
}

async function confirm() {
  const unified = pending.value.length > 1 && batchMode.value === 'unified'
  // unified mode = an explicit shared target is required (root '' counts);
  // null there means the user never picked one
  if (unified && target.value === null) { ElMessage.warning('请选择目标文件夹'); return }
  loading.value = true
  let ok = 0
  let failed = 0
  try {
    for (const item of pending.value) {
      // null target = no pin (server rebuilds the original path);
      // '' or a folder id = pinned target (skip when it equals the original)
      const wantsPin = !unified
        ? target.value !== null && target.value !== (item.parentId || '')
        : true
      const pinned = wantsPin
        ? { parentId: unified ? (target.value || '') : target.value!, includeChildren: item.type === 'folder' ? includeChildren.value : true }
        : { includeChildren: item.type === 'folder' ? includeChildren.value : true }
      try {
        await bookmarksApi.restore(item.id, pinned)
        ok++
      } catch { failed++ }
    }
    if (failed) ElMessage.warning(`已恢复 ${ok} 项，${failed} 项失败`)
    else ElMessage.success(`已恢复 ${ok} 项`)
    visible.value = false
    emit('done')
  } finally {
    loading.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="pending.length > 1 ? `恢复 ${pending.length} 项` : `恢复「${pending[0]?.title || pending[0]?.url || ''}」`"
    width="460px"
  >
    <!-- batch mode chooser -->
    <div v-if="pending.length > 1" class="rd-batch-mode">
      <el-radio-group v-model="batchMode">
        <el-radio value="own">各自恢复至原位置</el-radio>
        <el-radio value="unified">统一恢复到…</el-radio>
      </el-radio-group>
    </div>

    <!-- original location summary -->
    <div v-if="pending.length === 1" class="rd-orig">
      <span class="rd-orig-k">原位置</span>
      <span class="rd-orig-v">{{ origLabel }}</span>
      <span v-if="needsRebuild" class="rd-orig-warn">⚠ 原路径已删除，恢复时将自动重建</span>
    </div>
    <div v-else class="rd-orig">
      <span class="rd-orig-k">原位置</span>
      <span class="rd-orig-v">
        <template v-if="origPaths.length === 1">{{ origPaths[0].label }}</template>
        <template v-else>{{ origPaths.length }} 个不同位置</template>
        <span v-if="needsRebuild" class="rd-orig-warn"> ⚠ 部分原路径已删除，将自动重建</span>
      </span>
    </div>

    <!-- include-children (folders only) -->
    <div v-if="isFolder && subtreeCount > 0" class="rd-children">
      <el-checkbox v-model="includeChildren">
        同时恢复其子项（{{ subtreeCount }} 项）
      </el-checkbox>
      <div v-if="!includeChildren" class="rd-children-hint">文件夹将以空壳恢复，子项留在回收站</div>
    </div>

    <!-- target tree (hidden in own-original batch mode) -->
    <template v-if="pending.length === 1 || batchMode === 'unified'">
      <div class="rd-tree-label">目标位置</div>
      <el-tree
        :data="folders"
        node-key="id"
        :props="{ label: 'label', children: 'children' }"
        :expand-on-click-node="false"
        highlight-current
        :current-node-key="target || undefined"
        style="max-height: 260px; overflow: auto"
        @node-click="(n: NodeItem) => (target = n.id)"
      >
        <template #default="{ data }">
          <span class="folder-node">
            <span class="rd-orig-flag" v-if="pending.length === 1 && data.id === pending[0].parentId && liveIds.has(data.id)">原位置</span>
            {{ data.label }}
          </span>
        </template>
      </el-tree>
      <div class="rd-root-row">
        <button class="rd-root-btn" :class="{ active: target === '' }" @click="target = ''">
          根目录
        </button>
        <span v-if="target === null" class="rd-default-note">未选择时恢复到原位置（路径自动重建）</span>
        <span v-if="pending.length === 1 && !pending[0].parentId && target === null" class="rd-orig-flag">原位置</span>
      </div>

      <!-- inline new folder -->
      <div class="rd-newfolder">
        <el-input v-model="newFolderName" placeholder="在所选文件夹下新建" size="small" style="flex: 1" @keyup.enter="createInlineFolder" />
        <el-button size="small" :loading="loading" @click="createInlineFolder">新建文件夹</el-button>
      </div>
    </template>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="confirm">恢复到此处</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rd-batch-mode { margin-bottom: 12px; }
.rd-orig {
  display: flex; align-items: baseline; gap: 8px;
  padding: 8px 10px;
  background: var(--md-bg);
  border: 1px solid var(--md-border);
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  flex-wrap: wrap;
}
.rd-orig-k { color: var(--md-text-3); flex-shrink: 0; }
.rd-orig-v { color: var(--md-text); font-weight: 500; }
.rd-orig-warn { color: var(--md-warning); font-size: 12px; }
.rd-children { margin-bottom: 12px; }
.rd-children-hint { font-size: 12px; color: var(--md-text-3); margin-top: -6px; padding-left: 22px; }
.rd-tree-label { font-size: 12.5px; color: var(--md-text-3); margin: 4px 0 6px; }
.rd-orig-flag {
  font-size: 11px; color: var(--md-primary);
  background: var(--md-primary-soft);
  border-radius: 4px; padding: 1px 5px;
  margin-right: 6px; flex-shrink: 0;
}
.rd-root-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.rd-root-btn {
  border: 1px solid var(--md-border);
  background: var(--md-surface);
  color: var(--md-text-2);
  font-size: 13px; font-family: inherit;
  border-radius: 7px; padding: 5px 12px;
  cursor: pointer;
}
.rd-root-btn.active { color: var(--md-primary); border-color: var(--md-primary); background: var(--md-primary-soft); }
.rd-default-note { font-size: 12px; color: var(--md-text-3); }
.rd-newfolder { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
</style>
