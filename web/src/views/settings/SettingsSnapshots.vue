<script setup lang="ts">
// Settings 备份快照 tab: snapshot create/restore/download/upload + trash
// auto-purge retention. Owns its data load (was funnelled through the parent's
// loadAll before the split).
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { toolsApi, type Snapshot } from '@/api/client'
import { Icon } from '@/components/icons'
import { confirmAct, errMsg } from '@/utils/ui'

const snapshots = ref<Snapshot[]>([])
onMounted(load)
async function load() {
  try {
    const s = await toolsApi.snapshots()
    snapshots.value = s.snapshots || []
  } catch { /* not logged in */ }
}

async function takeSnapshot() {
  try {
    await toolsApi.createSnapshot()
    ElMessage.success('快照已创建')
    load()
  } catch (e) {
    ElMessage.error('快照创建失败: ' + errMsg(e))
  }
}

const restoring = ref(false)
const snapUploadEl = ref<HTMLInputElement | null>(null)
function restoreSnap(s: Snapshot) {
  if (restoring.value) return
  restoring.value = true
  void confirmAct(
    `将书签库恢复到 ${new Date(s.createdAt * 1000).toLocaleString()} 的快照？\n当前状态会先自动备份（pre-restore 快照）。`,
    '恢复快照', async () => {
      await toolsApi.restoreSnapshot(s.id)
      ElMessage.success('已恢复，所有设备将自动同步')
      load()
    }, { errorText: '恢复失败' },
  ).finally(() => {
    restoring.value = false
  })
}

// upload a previously downloaded snapshot file (.json.gz) and restore it
async function uploadSnapshotFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!file.name.endsWith('.json.gz') && !file.name.endsWith('.gz')) {
    ElMessage.error('请选择快照文件（.json.gz）')
    input.value = ''
    return
  }
  await confirmAct(
    `导入并恢复快照「${file.name}」？\n当前状态会先自动备份（pre-restore 快照）。`,
    '导入快照', async () => {
      await toolsApi.uploadSnapshot(file)
      ElMessage.success('快照已导入并恢复，所有设备将自动同步')
      load()
    }, { errorText: '导入失败' },
  )
  input.value = ''
}

// ---- trash auto-purge retention ----
// 0 = never; presets 1/7/30/90; custom value goes in the number input
const retentionDays = ref(0)
const retentionPreset = ref<'never' | '1' | '7' | '30' | '90' | 'custom'>('never')
const retentionCustom = ref<number | null>(null)
const retentionSaving = ref(false)
const retentionPresets = [
  { key: 'never', label: '永不', days: 0 },
  { key: '1', label: '1 天', days: 1 },
  { key: '7', label: '7 天', days: 7 },
  { key: '30', label: '1 个月', days: 30 },
  { key: '90', label: '3 个月', days: 90 },
] as const

async function loadRetention() {
  try {
    const r = await toolsApi.trashRetention()
    retentionDays.value = r.days
    const preset = retentionPresets.find((p) => p.days === r.days)
    if (preset) {
      retentionPreset.value = preset.key
      retentionCustom.value = null
    } else {
      retentionPreset.value = 'custom'
      retentionCustom.value = r.days
    }
  } catch { /* settings tab may not load on first paint */ }
}

async function saveRetention() {
  let days: number
  if (retentionPreset.value === 'custom') {
    days = retentionCustom.value ?? 0
    if (!Number.isFinite(days) || days < 0 || days > 3650 || (days !== 0 && days < 1)) {
      ElMessage.error('自定义天数需为 1–3650 的整数（0/预设=永不）')
      return
    }
  } else {
    days = retentionPresets.find((p) => p.key === retentionPreset.value)!.days
  }
  retentionSaving.value = true
  try {
    const r = await toolsApi.setTrashRetention(days)
    retentionDays.value = r.days
    if (days === 0) ElMessage.success('已关闭自动清理')
    else if (r.purged > 0) ElMessage.success(`已保存：自动清理 ${days} 天前的回收站内容（本次清理 ${r.purged} 项）`)
    else ElMessage.success(`已保存：自动清理 ${days} 天前的回收站内容`)
  } catch (e) {
    ElMessage.error('保存失败: ' + errMsg(e))
  } finally {
    retentionSaving.value = false
  }
}
loadRetention()
</script>

<template>
  <div class="section-card">
    <h2 class="section-card-title">
      <span class="sec-ico"><Icon name="restore" :size="16" /></span>
      备份快照
      <span class="section-card-sub">每天自动快照，保留最近 30 份</span>
    </h2>
    <div class="inline-row">
      <el-button type="primary" @click="takeSnapshot">立即创建快照</el-button>
      <el-button @click="snapUploadEl?.click()">导入快照文件…</el-button>
      <input
        ref="snapUploadEl"
        type="file"
        accept=".gz"
        style="display: none"
        @change="uploadSnapshotFile"
      >
    </div>
    <p class="field-hint">下载的快照文件可随时通过「导入快照文件」恢复（先自动备份当前状态）。</p>
  </div>

  <div class="section-card">
    <h2 class="section-card-title">
      <span class="sec-ico"><Icon name="trash" :size="16" /></span>
      回收站自动清理
      <span class="section-card-sub">超过保留期的回收站内容将被彻底删除（逐项清理，文件夹连同其内容）</span>
    </h2>
    <div class="retention-row">
      <button
        v-for="p in retentionPresets"
        :key="p.key"
        class="retention-opt"
        :class="{ active: retentionPreset === p.key }"
        @click="retentionPreset = p.key"
      >{{ p.label }}</button>
      <span
        class="retention-opt"
        :class="{ active: retentionPreset === 'custom' }"
        role="button"
        tabindex="0"
        @click="retentionPreset = 'custom'"
      >
        自定义
        <input
          v-if="retentionPreset === 'custom'"
          v-model.number="retentionCustom"
          type="number"
          min="1"
          max="3650"
          class="retention-input"
          @click.stop
        > 天
      </span>
    </div>
    <div class="inline-row" style="margin-top: 12px">
      <el-button type="primary" :loading="retentionSaving" @click="saveRetention">保存设置</el-button>
      <span class="field-hint" style="margin: 0">
        当前：{{ retentionDays === 0 ? '永不自动清理' : `自动清理 ${retentionDays} 天前的内容` }}。服务端每小时检查一次，保存后立即执行一轮。
      </span>
    </div>
  </div>
  <div v-if="snapshots.length" class="data-list">
    <div v-for="s in snapshots" :key="s.id" class="data-row">
      <div class="device-ico"><Icon name="restore" :size="17" /></div>
      <div class="data-row-main">
        <span class="data-row-title">{{ new Date(s.createdAt * 1000).toLocaleString() }}</span>
        <span class="data-row-sub">{{ (s.size / 1024).toFixed(1) }} KB · {{ s.cause }}</span>
      </div>
      <div class="data-row-actions">
        <button class="row-act" @click="restoreSnap(s)">恢复</button>
        <a :href="'/api/snapshots/' + s.id + '/download'" target="_blank" class="row-act">下载</a>
      </div>
    </div>
  </div>
  <div v-else class="list-empty">
    <div class="list-empty-icon"><Icon name="restore" :size="24" /></div>
    <div class="list-empty-title">暂无快照</div>
    <div class="list-empty-hint">点击「立即创建快照」，或等待每天自动备份</div>
  </div>
</template>

<style scoped>
/* trash retention: preset chips + inline custom-days input */
.retention-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.retention-opt {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 16px;
  border: 1px solid var(--md-border);
  border-radius: 999px;
  background: var(--md-surface);
  color: var(--md-text-2);
  font-size: 13px; font-family: inherit; font-weight: 600;
  cursor: pointer;
  transition: color .15s, border-color .15s, background .15s;
  user-select: none;
}
.retention-opt:hover { color: var(--md-primary); border-color: var(--md-primary); }
.retention-opt.active { background: var(--md-primary-soft); border-color: var(--md-primary); color: var(--md-primary); }
.retention-input {
  width: 64px;
  padding: 2px 8px;
  border: 1px solid var(--md-primary);
  border-radius: 8px;
  font-family: inherit; font-size: 13px;
  color: var(--md-text);
  background: #fff;
  outline: none;
}
.retention-input:focus { box-shadow: 0 0 0 3px var(--md-primary-soft); }

.device-ico {
  width: 34px; height: 34px; flex-shrink: 0;
  border-radius: 10px;
  background: var(--md-primary-soft);
  color: var(--md-primary);
  display: grid; place-items: center;
}
</style>
