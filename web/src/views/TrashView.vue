<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'

const trash = ref<Bookmark[]>([])
const loading = ref(false)
const selection = ref<Bookmark[]>([])
const busy = ref(false)

async function load() {
  loading.value = true
  try {
    const r = await bookmarksApi.trash()
    trash.value = r.nodes || []
  } catch (e: any) {
    ElMessage.error('回收站加载失败: ' + e.message)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function restore(b: Bookmark) {
  try {
    await bookmarksApi.restore(b.id)
    ElMessage.success('已恢复')
    load()
  } catch (e: any) { ElMessage.error('恢复失败: ' + e.message) }
}
async function purge(b: Bookmark) {
  try {
    await ElMessageBox.confirm(`永久删除「${b.title || b.url}」？此操作不可撤销。`, '彻底删除', { type: 'error', confirmButtonText: '彻底删除' })
  } catch { return }
  try {
    await bookmarksApi.purge(b.id)
    ElMessage.success('已永久删除')
    load()
  } catch (e: any) { ElMessage.error('删除失败: ' + e.message) }
}
// per-item loop with a failure tally: one bad row used to abort the whole
// batch silently with no feedback and no refresh
async function runForAll(items: Bookmark[], op: (b: Bookmark) => Promise<unknown>, doneLabel: string) {
  busy.value = true
  let ok = 0
  let failed = 0
  try {
    for (const b of items) {
      try { await op(b); ok++ } catch { failed++ }
    }
    if (failed) ElMessage.warning(`${doneLabel} ${ok} 项，${failed} 项失败`)
    else ElMessage.success(`${doneLabel} ${ok} 项`)
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
  await runForAll(trash.value, (b) => bookmarksApi.purge(b.id), '已删除')
}
async function batchRestore() {
  if (!selection.value.length) return
  await runForAll(selection.value, (b) => bookmarksApi.restore(b.id), '已恢复')
}
</script>

<template>
  <el-card shadow="never">
    <template #header>
      <div style="display:flex; gap:8px; align-items:center">
        <h1 class="page-title">回收站</h1>
        <span style="color:var(--md-text-3); font-size: 12px">删除的书签保留在此，可随时恢复</span>
        <el-button v-if="selection.length" type="success" plain size="small" :disabled="busy" @click="batchRestore">恢复所选 ({{ selection.length }})</el-button>
        <el-button v-if="trash.length" type="danger" plain size="small" :disabled="busy" @click="emptyAll">清空回收站</el-button>
      </div>
    </template>
    <el-table :data="trash" v-loading="loading" @selection-change="(rows: Bookmark[]) => (selection = rows)" row-key="id">
      <el-table-column type="selection" width="42" />
      <el-table-column label="标题" min-width="240">
        <template #default="{ row }">{{ row.title || row.url }}</template>
      </el-table-column>
      <el-table-column label="URL" min-width="240">
        <template #default="{ row }"><span class="bm-url">{{ row.url }}</span></template>
      </el-table-column>
      <el-table-column label="删除时间" width="160">
        <template #default="{ row }">{{ row.deletedAt ? new Date(row.deletedAt * 1000).toLocaleString() : '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button link size="small" type="success" @click="restore(row)">恢复</el-button>
          <el-button link size="small" type="danger" @click="purge(row)">彻底删除</el-button>
        </template>
      </el-table-column>
      <template #empty><el-empty description="回收站为空" /></template>
    </el-table>
  </el-card>
</template>
