<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bookmarksApi, type TagInfo } from '@/api/client'

const tags = ref<TagInfo[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    tags.value = (await bookmarksApi.tags()).tags || []
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function rename(t: TagInfo) {
  let value: string
  try {
    ;({ value } = await ElMessageBox.prompt(`重命名标签「${t.tag}」`, '重命名', { inputValue: t.tag }))
  } catch { return } // cancelled
  const to = value.trim()
  if (!to || to === t.tag) return
  try {
    const r = await bookmarksApi.renameTag(t.tag, to)
    ElMessage.success(`已重命名（影响 ${r.affected} 个书签）`)
    load()
  } catch (e: any) { ElMessage.error(e.message) }
}

async function merge(t: TagInfo) {
  let value: string
  try {
    ;({ value } = await ElMessageBox.prompt(`将「${t.tag}」合并到哪个标签？`, '合并标签'))
  } catch { return } // cancelled
  const to = value.trim()
  if (!to) return
  try {
    const r = await bookmarksApi.renameTag(t.tag, to)
    ElMessage.success(`已合并（影响 ${r.affected} 个书签）`)
    load()
  } catch (e: any) { ElMessage.error(e.message) }
}

async function remove(t: TagInfo) {
  try {
    await ElMessageBox.confirm(`从所有书签移除标签「${t.tag}」？（不影响书签本身）`, '删除标签', { type: 'warning' })
  } catch { return }
  try {
    const r = await bookmarksApi.deleteTag(t.tag)
    ElMessage.success(`已移除（影响 ${r.affected} 个书签）`)
    load()
  } catch (e: any) { ElMessage.error(e.message) }
}
</script>

<template>
  <el-card shadow="never">
    <template #header><h1 class="page-title">标签管理</h1></template>
    <el-table :data="tags" v-loading="loading">
      <el-table-column prop="tag" label="标签" min-width="200" />
      <el-table-column prop="count" label="书签数" width="100" />
      <el-table-column label="操作" width="220">
        <template #default="{ row }">
          <el-button link size="small" @click="rename(row)">重命名</el-button>
          <el-button link size="small" @click="merge(row)">合并</el-button>
          <el-button link size="small" type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty><el-empty description="暂无标签（在书签编辑里添加）" /></template>
    </el-table>
  </el-card>
</template>
