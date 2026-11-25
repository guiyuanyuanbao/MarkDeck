<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'
import { Icon } from '@/components/icons'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'

const trash = ref<Bookmark[]>([])
const loading = ref(false)
const selection = ref<Set<string>>(new Set())
const busy = ref(false)
// selection drives per-row check state directly (checkbox + row highlight)

async function load() {
  loading.value = true
  try {
    const r = await bookmarksApi.trash()
    trash.value = r.nodes || []
    selection.value = new Set()
  } catch (e: any) {
    ElMessage.error('回收站加载失败: ' + e.message)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const selectedRows = computed(() => trash.value.filter((b) => selection.value.has(b.id)))
const allSelected = computed(() => trash.value.length > 0 && trash.value.every((b) => selection.value.has(b.id)))
function toggleRow(b: Bookmark) {
  const next = new Set(selection.value)
  if (next.has(b.id)) next.delete(b.id)
  else next.add(b.id)
  selection.value = next
}
function toggleAll() {
  selection.value = allSelected.value ? new Set() : new Set(trash.value.map((b) => b.id))
}

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
  if (!selection.value.size) return
  await runForAll(selectedRows.value, (b) => bookmarksApi.restore(b.id), '已恢复')
}

function fmtTime(ts?: number) {
  return ts ? new Date(ts * 1000).toLocaleString() : '—'
}
</script>

<template>
  <div class="page-shell">
    <div class="page-hero">
      <div class="page-hero-title">
        <h1 class="page-title">回收站</h1>
        <span class="page-sub">删除的书签保留在此，可随时恢复</span>
      </div>
      <div class="page-hero-actions">
        <el-button v-if="selection.size" type="primary" plain size="small" :disabled="busy" @click="batchRestore">
          恢复所选 ({{ selection.size }})
        </el-button>
        <el-button v-if="trash.length" type="danger" plain size="small" :disabled="busy" @click="emptyAll">
          清空回收站
        </el-button>
      </div>
    </div>

    <div v-loading="loading">
      <div v-if="trash.length" class="data-list">
        <!-- header row: select-all -->
        <div class="data-row" style="padding: 9px 18px; background: var(--md-bg)">
          <el-checkbox
            class="row-check"
            :model-value="allSelected"
            @change="toggleAll"
          />
          <span class="data-row-sub" style="font-size: 12.5px">
            {{ trash.length }} 项<template v-if="selection.size"> · 已选 {{ selection.size }} 项</template>
          </span>
        </div>
        <div
          v-for="b in trash"
          :key="b.id"
          class="data-row"
          :class="{ selected: selection.has(b.id) }"
        >
          <el-checkbox
            class="row-check"
            :model-value="selection.has(b.id)"
            @change="toggleRow(b)"
          />
          <BookmarkAvatar :b="b" :size="34" />
          <div class="data-row-main">
            <span class="data-row-title">{{ b.title || b.url }}</span>
            <span v-if="b.url" class="data-row-sub">{{ b.url }}</span>
          </div>
          <div class="data-row-meta">
            <span>{{ fmtTime(b.deletedAt) }}</span>
          </div>
          <div class="data-row-actions">
            <button class="row-act success" @click="restore(b)">恢复</button>
            <button class="row-act danger" @click="purge(b)">彻底删除</button>
          </div>
        </div>
      </div>

      <div v-else-if="!loading" class="list-empty">
        <div class="list-empty-icon">
          <Icon name="trash" :size="26" />
        </div>
        <div class="list-empty-title">回收站是空的</div>
        <div class="list-empty-hint">删除的书签会先出现在这里，确认后再彻底清除</div>
      </div>
    </div>
  </div>
</template>
