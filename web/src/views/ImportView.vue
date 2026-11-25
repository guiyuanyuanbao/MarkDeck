<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { uploadFile, api } from '@/api/client'
import { Icon } from '@/components/icons'

const uploading = ref(false)
const mode = ref<'newfolder' | 'merge'>('merge')
const rootName = ref('')
const result = ref<{ created: number; duplicates: number; errors?: string[] } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragover = ref(false)
// pending file: shown in the drop zone so the user confirms WHAT will import
const pendingFile = ref<File | null>(null)

function pickFile(f?: File | null) {
  if (!f) return
  if (!/\.html?$/i.test(f.name)) {
    ElMessage.warning('请选择 Netscape 书签 HTML 文件')
    return
  }
  pendingFile.value = f
  result.value = null
}

function onDrop(e: DragEvent) {
  dragover.value = false
  pickFile(e.dataTransfer?.files?.[0])
}
function onChange(e: Event) {
  const t = e.target as HTMLInputElement
  pickFile(t.files?.[0])
  // reset so re-picking the SAME file fires change again
  if (t) t.value = ''
}

async function doImport() {
  const f = pendingFile.value
  if (!f) return
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
    pendingFile.value = null
    ElMessage.success(`导入完成：新增 ${data.created}，跳过重复 ${data.duplicates}`)
  } catch (e: any) {
    ElMessage.error('导入失败: ' + e.message)
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

// ---- export: both formats the backend already serves, wired as downloads
async function download(path: string, filename: string) {
  try {
    const blob = await api.getBlob(path)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: any) {
    ElMessage.error('导出失败: ' + e.message)
  }
}
function exportHtml() {
  download('/api/export/html', `bookmarks-${new Date().toISOString().slice(0, 10)}.html`)
}
function exportJson() {
  download('/api/export/json', `markdesk-export-${new Date().toISOString().slice(0, 10)}.json`)
}
</script>

<template>
  <div class="page-shell">
    <div class="page-hero">
      <div class="page-hero-title">
        <h1 class="page-title">导入 / 导出</h1>
        <span class="page-sub">浏览器书签互通</span>
      </div>
    </div>

    <!-- import -->
    <div class="section-card">
      <h2 class="section-card-title">
        <span class="sec-ico"><Icon name="box" :size="16" /></span>
        导入浏览器书签
      </h2>
      <div class="import-mode">
        <label class="mode-opt" :class="{ active: mode === 'merge' }">
          <input v-model="mode" type="radio" value="merge" name="import-mode" />
          <div>
            <div class="mode-opt-title">合并导入</div>
            <div class="mode-opt-sub">按 URL 去重，与现有书签合并</div>
          </div>
        </label>
        <label class="mode-opt" :class="{ active: mode === 'newfolder' }">
          <input v-model="mode" type="radio" value="newfolder" name="import-mode" />
          <div>
            <div class="mode-opt-title">独立文件夹</div>
            <div class="mode-opt-sub">全部书签放进一个新文件夹</div>
          </div>
        </label>
      </div>
      <el-input
        v-if="mode === 'newfolder'"
        v-model="rootName"
        placeholder="文件夹名（默认：导入的书签 + 日期）"
        style="max-width: 360px; margin-bottom: 14px"
      />

      <input ref="fileInput" type="file" accept=".html,.htm" style="display: none" @change="onChange" />
      <div
        v-if="!pendingFile"
        class="drop-zone"
        :class="{ dragover }"
        @click="fileInput?.click()"
        @dragover.prevent="dragover = true"
        @dragleave="dragover = false"
        @drop.prevent="onDrop"
      >
        <div class="drop-zone-icon">
          <Icon name="box" :size="24" />
        </div>
        <div class="drop-zone-title">拖拽书签 HTML 到这里，或点击选择文件</div>
        <div class="drop-zone-hint">支持 Chrome / Edge / Firefox 导出的 Netscape 格式（浏览器 → 书签管理器 → 导出书签）</div>
      </div>

      <div v-else class="file-ready">
        <div class="file-ready-icon"><Icon name="bookmark" :size="20" /></div>
        <div class="file-ready-info">
          <div class="file-ready-name">{{ pendingFile.name }}</div>
          <div class="file-ready-size">{{ (pendingFile.size / 1024).toFixed(1) }} KB</div>
        </div>
        <div class="file-ready-actions">
          <el-button size="small" @click="pendingFile = null">重选</el-button>
          <el-button type="primary" size="small" :loading="uploading" @click="doImport">开始导入</el-button>
        </div>
      </div>

      <el-result v-if="result" icon="success" :title="`新增 ${result.created} 条书签`"
        :sub-title="`跳过重复 ${result.duplicates} 条` + (result.errors?.length ? `，${result.errors.length} 条失败` : '')" />
    </div>

    <!-- export -->
    <div class="section-card">
      <h2 class="section-card-title">
        <span class="sec-ico"><Icon name="download" :size="16" /></span>
        导出全部书签
        <span class="section-card-sub">活动书签全量导出；JSON 额外携带回收站与标签/备注</span>
      </h2>
      <div class="export-row">
        <button class="export-card" @click="exportHtml">
          <div class="export-ico html">H</div>
          <div class="export-info">
            <div class="export-title">Netscape HTML</div>
            <div class="export-sub">可直接导入任意浏览器</div>
          </div>
          <Icon name="chevron" :size="16" style="color: var(--md-text-3)" />
        </button>
        <button class="export-card" @click="exportJson">
          <div class="export-ico json">JSON</div>
          <div class="export-info">
            <div class="export-title">JSON 备份</div>
            <div class="export-sub">含回收站与元数据的完整备份</div>
          </div>
          <Icon name="chevron" :size="16" style="color: var(--md-text-3)" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-mode {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  max-width: 560px;
  margin-bottom: 14px;
}
.mode-opt {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-sm);
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.mode-opt:hover { border-color: var(--md-primary); }
.mode-opt.active { border-color: var(--md-primary); background: var(--md-primary-soft); }
.mode-opt input { margin-top: 3px; accent-color: var(--md-primary); }
.mode-opt-title { font-size: 13.5px; font-weight: 600; color: var(--md-text); }
.mode-opt-sub { font-size: 12px; color: var(--md-text-3); margin-top: 2px; }

.file-ready {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-sm);
  background: var(--md-bg);
  max-width: 560px;
}
.file-ready-icon {
  width: 40px; height: 40px;
  border-radius: 11px;
  background: var(--md-primary-soft);
  color: var(--md-primary);
  display: grid; place-items: center;
  flex-shrink: 0;
}
.file-ready-info { flex: 1; min-width: 0; }
.file-ready-name { font-size: 13.5px; font-weight: 600; color: var(--md-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-ready-size { font-size: 12px; color: var(--md-text-3); margin-top: 2px; }
.file-ready-actions { flex-shrink: 0; display: flex; gap: 8px; }

.export-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  max-width: 640px;
}
.export-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-sm);
  background: var(--md-surface);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: border-color .15s, box-shadow .15s;
}
.export-card:hover { border-color: var(--md-primary); box-shadow: var(--md-shadow); }
.export-ico {
  width: 40px; height: 40px;
  border-radius: 11px;
  display: grid; place-items: center;
  font-size: 12px; font-weight: 800;
  flex-shrink: 0;
}
.export-ico.html { background: var(--md-primary-soft); color: var(--md-primary); }
.export-ico.json { background: var(--md-success-soft); color: var(--md-success); }
.export-info { flex: 1; min-width: 0; }
.export-title { font-size: 13.5px; font-weight: 600; color: var(--md-text); }
.export-sub { font-size: 12px; color: var(--md-text-3); margin-top: 2px; }
</style>
