<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { uploadFile, api } from '@/api/client'

const uploading = ref(false)
const mode = ref<'newfolder' | 'merge'>('merge')
const rootName = ref('')
const result = ref<{ created: number; duplicates: number; errors?: string[] } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function upload() {
  const f = fileInput.value?.files?.[0]
  if (!f) { ElMessage.warning('请选择书签 HTML 文件'); return }
  // merge writes straight into the live tree: confirm before overwriting
  if (mode.value === 'merge') {
    try {
      await ElMessageBox.confirm(
        '合并导入会按 URL 去重写入库中（已有书签保持不动）。继续吗？', '合并导入',
        { type: 'info', confirmButtonText: '开始导入', cancelButtonText: '取消' },
      )
    } catch { return }
  }
  uploading.value = true
  result.value = null
  try {
    const data = await uploadFile<{ created: number; duplicates: number; errors?: string[] }>(
      '/api/import/html', f,
      { mode: mode.value, ...(mode.value === 'newfolder' ? { rootName: rootName.value || '导入的书签' } : {}) },
    )
    result.value = data
    ElMessage.success(`导入完成：新增 ${data.created}，跳过重复 ${data.duplicates}`)
  } catch (e: any) {
    ElMessage.error('导入失败: ' + e.message)
  } finally {
    uploading.value = false
    // reset so re-picking the SAME file fires change again (a kept value
    // made the retry path dead)
    if (fileInput.value) fileInput.value.value = ''
  }
}

// ---- export: both formats the backend already serves, wired as downloads
async function exportHtml() {
  try {
    const blob = await api.getBlob('/api/export/html')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bookmarks-${new Date().toISOString().slice(0, 10)}.html`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: any) {
    ElMessage.error('导出失败: ' + e.message)
  }
}
async function exportJson() {
  try {
    const blob = await api.getBlob('/api/export/json')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `markdesk-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: any) {
    ElMessage.error('导出失败: ' + e.message)
  }
}
</script>

<template>
  <el-card shadow="never">
    <template #header><h1 class="page-title">导入 / 导出</h1></template>

    <h2 class="sec-title">导入浏览器书签</h2>
    <el-alert type="info" :closable="false" style="margin-bottom: 16px"
      title="支持 Chrome / Edge / Firefox 导出的 Netscape HTML 格式。导出方法：浏览器 → 书签管理器 → 导出书签。" />
    <el-form label-width="100px" style="max-width: 560px">
      <el-form-item label="导入方式">
        <el-radio-group v-model="mode">
          <el-radio value="merge">合并导入（按 URL 去重，与现有书签合并）</el-radio>
          <el-radio value="newfolder">导入为独立文件夹</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="mode === 'newfolder'" label="文件夹名">
        <el-input v-model="rootName" placeholder="默认：导入的书签 + 日期" />
      </el-form-item>
      <el-form-item label="书签文件">
        <input ref="fileInput" type="file" accept=".html,.htm" style="display:none" @change="upload" />
        <el-button :loading="uploading" @click="fileInput?.click()">选择 HTML 文件并上传</el-button>
      </el-form-item>
    </el-form>
    <el-result v-if="result" icon="success" :title="`新增 ${result.created} 条书签`"
      :sub-title="`跳过重复 ${result.duplicates} 条` + (result.errors?.length ? `，${result.errors.length} 条失败` : '')" />

    <el-divider />
    <h2 class="sec-title">导出全部书签</h2>
    <el-space wrap :size="12">
      <el-button @click="exportHtml">导出 Netscape HTML（可导入浏览器）</el-button>
      <el-button @click="exportJson">导出 JSON（含回收站与元数据）</el-button>
    </el-space>
    <p class="sec-hint">导出包含当前库中的全部活动书签；JSON 额外携带回收站内容与标签/备注元数据。</p>
  </el-card>
</template>

<style scoped>
.sec-title { font-size: 15px; font-weight: 600; margin: 4px 0 12px; color: var(--md-text); }
.sec-hint { color: var(--md-text-3); font-size: 12.5px; margin-top: 10px; }
</style>
