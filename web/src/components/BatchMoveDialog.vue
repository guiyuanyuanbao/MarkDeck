<script setup lang="ts">
import { ref } from 'vue'
import type { ElTree } from 'element-plus'
import { ElMessage } from 'element-plus'
import { errMsg } from '@/utils/ui'
import { bookmarksApi, type Bookmark } from '@/api/client'

const visible = ref(false)
const loading = ref(false)
const emit = defineEmits<{ done: [] }>()
const treeRef = ref<InstanceType<typeof ElTree> | null>(null)

interface NodeItem { id: string; label: string; children?: NodeItem[] }
const folders = ref<NodeItem[]>([])
const target = ref('')
const pendingIds = ref<string[]>([])

async function loadFolders() {
  const { nodes } = await bookmarksApi.tree()
  const rows = nodes || [] // server nil-encodes empty sets
  const mk = (list: Bookmark[]): NodeItem[] =>
    list.filter((n) => n.type === 'folder').map((n) => ({
      id: n.id,
      label: n.title || '(未命名)',
      children: mk(rows.filter((c) => c.parentId === n.id)),
    }))
  folders.value = mk(rows.filter((n) => n.parentId === ''))
}

function open(ids: string[], excludeFolderId?: string) {
  pendingIds.value = ids
  target.value = ''
  loadFolders().then(() => {
    // 目标文件夹不能是自己（移动文件夹进自己会被后端拒绝）
    const prune = (items: NodeItem[]): NodeItem[] =>
      items.filter((i) => i.id !== excludeFolderId).map((i) => ({ ...i, children: i.children ? prune(i.children) : undefined }))
    folders.value = prune(folders.value)
    visible.value = true
    // el-tree keeps its highlight-current node across dialog opens while
    // target resets to '' — the highlighted row promised a selection the
    // confirm button would refuse. Clear both together: nothing highlighted
    // until the user actually clicks a folder.
    treeRef.value?.setCurrentKey(null)
  })
}

async function confirm() {
  if (!target.value) { ElMessage.warning('请选择目标文件夹'); return }
  loading.value = true
  try {
    await bookmarksApi.batch({ ids: pendingIds.value, action: 'move', parentId: target.value })
    ElMessage.success(`已移动 ${pendingIds.value.length} 项`)
    visible.value = false
    emit('done')
  } catch (e) {
    ElMessage.error(errMsg(e))
  } finally {
    loading.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" title="移动到文件夹" width="420px">
    <el-tree
      ref="treeRef"
      :data="folders"
      node-key="id"
      :props="{ label: 'label', children: 'children' }"
      :expand-on-click-node="false"
      highlight-current
      style="max-height: 320px; overflow: auto"
      @node-click="(n: NodeItem) => (target = n.id)"
    >
      <template #default="{ data }">
        <span class="folder-node">{{ data.label }}</span>
      </template>
    </el-tree>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="loading" @click="confirm">移动到此处</el-button>
    </template>
  </el-dialog>
</template>
