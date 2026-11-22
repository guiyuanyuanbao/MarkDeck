<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { uploadFile } from '@/api/client'

const uploading = ref(false)
const mode = ref<'newfolder' | 'merge'>('merge')
const rootName = ref('')
const result = ref<{ created: number; duplicates: number; errors?: string[] } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function upload() {
  const f = fileInput.value?.files?.[0]
  if (!f) { ElMessage.warning('请选择书签 HTML 文件'); return }
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
  }
}
</script>

<template>
  <el-card shadow="never">
    <template #header><h1 class="page-title">导入浏览器书签</h1></template>
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
  </el-card>
</template>
