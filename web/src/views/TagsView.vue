<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus' // ElMessageBox: prompt dialogs (rename/merge tag)
import { bookmarksApi, type TagInfo } from '@/api/client'
import { Icon } from '@/components/icons'
import { confirmAct } from '@/utils/ui'

const tags = ref<TagInfo[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    tags.value = (await bookmarksApi.tags()).tags || []
  } catch (e: any) {
    ElMessage.error('标签加载失败: ' + e.message)
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

function remove(t: TagInfo) {
  void confirmAct(`从所有书签移除标签「${t.tag}」？（不影响书签本身）`, '删除标签', async () => {
    const r = await bookmarksApi.deleteTag(t.tag)
    ElMessage.success(`已移除（影响 ${r.affected} 个书签）`)
    load()
  })
}

// deterministic pastel per tag name (matches BookmarkAvatar palette family)
function tagHue(t: string): number {
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return h % 360
}
</script>

<template>
  <div class="page-shell">
    <div class="page-hero">
      <div class="page-hero-title">
        <h1 class="page-title">标签</h1>
        <span class="page-sub">{{ tags.length ? `${tags.length} 个标签 · 点标签名可在书签页快速筛选` : '管理所有书签标签' }}</span>
      </div>
    </div>

    <div v-loading="loading">
      <div v-if="tags.length" class="tag-cloud">
        <div v-for="t in tags" :key="t.tag" class="tag-card">
          <span
            class="tag-chip"
            :style="{ background: `hsl(${tagHue(t.tag)} 70% 92%)`, color: `hsl(${tagHue(t.tag)} 55% 32%)` }"
          >
            <Icon name="tag" :size="13" />
            {{ t.tag }}
          </span>
          <span class="tag-count">{{ t.count }} 个书签</span>
          <div class="tag-actions">
            <button class="row-act" @click="rename(t)">重命名</button>
            <button class="row-act" @click="merge(t)">合并</button>
            <button class="row-act danger" @click="remove(t)">删除</button>
          </div>
        </div>
      </div>

      <div v-else-if="!loading" class="list-empty">
        <div class="list-empty-icon">
          <Icon name="tag" :size="26" />
        </div>
        <div class="list-empty-title">还没有标签</div>
        <div class="list-empty-hint">在书签编辑里添加标签，或批量给书签打标签后在这里管理</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tag-cloud {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.tag-card {
  background: var(--md-surface);
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius);
  box-shadow: var(--md-shadow);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: box-shadow .15s, transform .1s;
}
.tag-card:hover { box-shadow: var(--md-shadow-lg); }
.tag-card:active { transform: scale(.99); }
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-count { color: var(--md-text-3); font-size: 12px; }
.tag-actions {
  display: flex;
  gap: 2px;
  margin-top: 2px;
  border-top: 1px dashed var(--md-border);
  padding-top: 8px;
}
</style>
