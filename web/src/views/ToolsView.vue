<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { toolsApi, authApi, type Bookmark } from '@/api/client'
import { Icon } from '@/components/icons'

const tab = ref('dead')
const scanning = ref(false)
const dead = ref<{ bookmark: Bookmark; status: string; checked: number }[]>([])
const dups = ref<{ key: string; items: Bookmark[] }[]>([])
const folderDups = ref<{ parentId: string; title: string; items: Bookmark[] }[]>([])
const loading = ref(false)

// batch selection per tool
const selDup = ref<Set<string>>(new Set())      // group keys
const selFolder = ref<Set<string>>(new Set())   // parentId+title
const mergingAll = ref(false)
const clearingFavicons = ref(false)

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [d, g, fg] = await Promise.all([toolsApi.deadLinks(), toolsApi.duplicates(), toolsApi.folderDuplicates()])
    dead.value = d.links || []
    dups.value = g.groups || []
    folderDups.value = fg.groups || []
    selDup.value = new Set()
    selFolder.value = new Set()
  } finally {
    loading.value = false
  }
}

async function startScan() {
  scanning.value = true
  try {
    await toolsApi.scanDead()
    ElMessage.info('扫描已开始，完成后列表自动更新')
    pollScan()
  } catch (e: any) {
    ElMessage.error(e.message)
    scanning.value = false
  }
}

function pollScan() {
  const t = setInterval(async () => {
    try {
      const st = await toolsApi.scanStatus()
      await load()
      if (!st.running) {
        scanning.value = false
        clearInterval(t)
        ElMessage.success('扫描完成')
      }
    } catch { /* keep polling */ }
  }, 3000)
  setTimeout(() => clearInterval(t), 10 * 60 * 1000)
}

function statusTag(s: string) {
  if (s === 'ok') return 'success'
  if (s.startsWith('blocked:')) return 'warning'
  if (s.startsWith('http:4')) return 'warning'
  return 'danger'
}

// ---- duplicate bookmarks ----
const dupKey = (g: { key: string }) => g.key
const allDupSelected = computed(() => dups.value.length > 0 && dups.value.every((g) => selDup.value.has(dupKey(g))))
function toggleDup(g: { key: string }) {
  if (selDup.value.has(dupKey(g))) selDup.value.delete(dupKey(g))
  else selDup.value.add(dupKey(g))
}
function toggleAllDup() {
  if (allDupSelected.value) selDup.value = new Set()
  else selDup.value = new Set(dups.value.map(dupKey))
}

async function mergeGroup(g: { key: string; items: Bookmark[] }) {
  const keep = g.items[0]
  const removes = g.items.slice(1).map((i) => i.id)
  try {
    await ElMessageBox.confirm(
      `保留「${keep.title || keep.url}」（最早创建），其余 ${removes.length} 条移入回收站，标签与备注会合并到保留项。继续？`,
      '合并重复', { type: 'warning' })
    await toolsApi.mergeDup(keep.id, removes)
    ElMessage.success('已合并')
    load()
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error('合并失败: ' + e.message)
  }
}

async function mergeSelectedDups() {
  const groups = dups.value.filter((g) => selDup.value.has(dupKey(g)))
  if (!groups.length) return
  const totalRemove = groups.reduce((n, g) => n + g.items.length - 1, 0)
  try {
    await ElMessageBox.confirm(
      `将合并 ${groups.length} 组重复书签，各组保留最早一条，其余 ${totalRemove} 条移入回收站（标签/备注并入保留项）。继续？`,
      '批量合并重复书签', { type: 'warning' })
    await runBatch(groups.map((g) => ({
      keep: g.items[0].id,
      removes: g.items.slice(1).map((i) => i.id),
    })), 'dup')
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error('批量合并失败: ' + e.message)
  }
}

// ---- duplicate folders ----
const folderKey = (g: { parentId: string; title: string }) => g.parentId + '\u0000' + g.title
const allFolderSelected = computed(() => folderDups.value.length > 0 && folderDups.value.every((g) => selFolder.value.has(folderKey(g))))
function toggleFolder(g: { parentId: string; title: string }) {
  if (selFolder.value.has(folderKey(g))) selFolder.value.delete(folderKey(g))
  else selFolder.value.add(folderKey(g))
}
function toggleAllFolder() {
  if (allFolderSelected.value) selFolder.value = new Set()
  else selFolder.value = new Set(folderDups.value.map(folderKey))
}

async function mergeFolderGroup(g: { parentId: string; title: string; items: Bookmark[] }) {
  const keep = g.items[0]
  const removes = g.items.slice(1).map((i) => i.id)
  try {
    await ElMessageBox.confirm(
      `保留第一个「${g.title}」文件夹，其余 ${removes.length} 个副本中的书签会并入保留文件夹（URL 重复的丢弃），副本壳移入回收站。继续？`,
      '合并重复文件夹', { type: 'warning' })
    const r = await toolsApi.mergeFolderDup(keep.id, removes)
    ElMessage.success(`已合并，${r.moved ?? 0} 条书签移入保留文件夹`)
    load()
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error('合并失败: ' + e.message)
  }
}

async function mergeSelectedFolders() {
  const groups = folderDups.value.filter((g) => selFolder.value.has(folderKey(g)))
  if (!groups.length) return
  try {
    await ElMessageBox.confirm(
      `将合并 ${groups.length} 组重复文件夹（每组保留第一个副本，其余内容并入）。继续？`,
      '批量合并重复文件夹', { type: 'warning' })
    await runBatch(groups.map((g) => ({
      keep: g.items[0].id,
      removes: g.items.slice(1).map((i) => i.id),
    })), 'folder')
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error('批量合并失败: ' + e.message)
  }
}

// sequential merge with progress; server endpoints are per-group but the
// loop is client-side batch (MergeDuplicate/MergeFolderDuplicates already
// accept the full removeIds list per group)
async function runBatch(groups: { keep: string; removes: string[] }[], kind: 'dup' | 'folder') {
  mergingAll.value = true
  let ok = 0, fail = 0, moved = 0
  try {
    for (const g of groups) {
      try {
        if (kind === 'dup') {
          await toolsApi.mergeDup(g.keep, g.removes)
        } else {
          const r = await toolsApi.mergeFolderDup(g.keep, g.removes)
          moved += r.moved ?? 0
        }
        ok++
      } catch {
        fail++
      }
    }
  } finally {
    mergingAll.value = false
  }
  ElMessage[fail ? 'warning' : 'success'](
    `合并完成：成功 ${ok} 组${kind === 'folder' ? `（${moved} 条书签并入）` : ''}${fail ? `，失败 ${fail} 组` : ''}`,
  )
  load()
}

// ---- favicon cache maintenance ----
async function clearFavicons() {
  try {
    await ElMessageBox.confirm(
      '清空服务端缓存的全部网站图标。清空后各设备下次同步会重新上传浏览器里的真实图标，服务端也会重新抓取。此操作立即生效。',
      '重扫网站图标', { type: 'warning' })
    clearingFavicons.value = true
    await authApi.clearFavicons()
    ElMessage.success('图标缓存已清空，等待各设备下次同步自动重推')
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error('操作失败: ' + e.message)
  } finally {
    clearingFavicons.value = false
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="tm-head">
      <h1 class="page-title">工具中心</h1>
      <div class="page-sub">批量整理与健康检查</div>
    </div>

    <div class="tm-tabs">
      <button class="tm-tab" :class="{ active: tab === 'dead' }" @click="tab = 'dead'">死链检测</button>
      <button class="tm-tab" :class="{ active: tab === 'dup' }" @click="tab = 'dup'">
        重复书签 <span v-if="dups.length" class="tm-count">{{ dups.length }}</span>
      </button>
      <button class="tm-tab" :class="{ active: tab === 'folderdup' }" @click="tab = 'folderdup'">
        重复文件夹 <span v-if="folderDups.length" class="tm-count">{{ folderDups.length }}</span>
      </button>
      <button class="tm-tab" :class="{ active: tab === 'favicon' }" @click="tab = 'favicon'">网站图标</button>
    </div>

    <!-- dead links -->
    <div v-if="tab === 'dead'" class="tm-panel">
      <div class="tm-bar">
        <el-button type="primary" :loading="scanning" @click="startScan">开始扫描</el-button>
        <span class="tm-hint">检查所有书签 URL 可达性（HEAD → GET 回退，并发 8，每域名限速）</span>
      </div>
      <el-table :data="dead">
        <el-table-column label="书签" min-width="260">
          <template #default="{ row }">{{ row.bookmark.title || row.bookmark.url }}</template>
        </el-table-column>
        <el-table-column label="URL" min-width="240">
          <template #default="{ row }"><span class="bm-url">{{ row.bookmark.url }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small">{{ row.status === 'ok' ? '正常' : row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="检查时间" width="160">
          <template #default="{ row }">{{ row.checked ? new Date(row.checked * 1000).toLocaleString() : '-' }}</template>
        </el-table-column>
        <template #empty><el-empty description="暂无死链记录（点击开始扫描）" /></template>
      </el-table>
    </div>

    <!-- duplicate bookmarks -->
    <div v-if="tab === 'dup'" class="tm-panel">
      <div v-if="dups.length" class="tm-bar">
        <el-checkbox :model-value="allDupSelected" @change="toggleAllDup">全选</el-checkbox>
        <el-button type="primary" :disabled="!selDup.size" :loading="mergingAll" @click="mergeSelectedDups">
          合并所选组（{{ selDup.size }}）
        </el-button>
        <span class="tm-hint">每组保留最早创建的一条，标签与备注合并到保留项</span>
      </div>
      <div v-for="g in dups" :key="g.key" class="tm-group">
        <div class="tm-group-head">
          <div class="tm-group-title">
            <el-checkbox :model-value="selDup.has(dupKey(g))" @change="toggleDup(g)" />
            <span class="tm-key">{{ g.key }}</span>
            <span class="tm-badge">{{ g.items.length }} 份</span>
          </div>
          <el-button size="small" plain @click="mergeGroup(g)">合并此组（保留最早）</el-button>
        </div>
        <div v-for="item in g.items" :key="item.id" class="tm-member">
          <span class="tm-member-title">{{ item.title || '(无标题)' }}</span>
          <span class="bm-url">{{ item.url }}</span>
          <el-tag v-for="t in item.tags" :key="t" size="small">{{ t }}</el-tag>
        </div>
      </div>
      <el-empty v-if="!dups.length" description="没有发现重复书签">
        <template #image><Icon name="check" :size="42" style="color:var(--md-success)" /></template>
      </el-empty>
    </div>

    <!-- duplicate folders -->
    <div v-if="tab === 'folderdup'" class="tm-panel">
      <el-alert type="info" :closable="false" style="margin-bottom: 12px"
        title="同名文件夹的多份副本（多设备历史同步产生）。合并会把副本中的书签并入保留文件夹，URL 重复的丢弃，副本壳移入回收站。" />
      <div v-if="folderDups.length" class="tm-bar">
        <el-checkbox :model-value="allFolderSelected" @change="toggleAllFolder">全选</el-checkbox>
        <el-button type="primary" :disabled="!selFolder.size" :loading="mergingAll" @click="mergeSelectedFolders">
          合并所选组（{{ selFolder.size }}）
        </el-button>
      </div>
      <div v-for="g in folderDups" :key="folderKey(g)" class="tm-group">
        <div class="tm-group-head">
          <div class="tm-group-title">
            <el-checkbox :model-value="selFolder.has(folderKey(g))" @change="toggleFolder(g)" />
            <Icon name="folder" :size="15" style="color:var(--md-warning)" />
            <span class="tm-key">{{ g.title }}</span>
            <span class="tm-badge">{{ g.items.length }} 份</span>
          </div>
          <el-button size="small" plain @click="mergeFolderGroup(g)">合并此组（保留第一个）</el-button>
        </div>
        <div v-for="item in g.items" :key="item.id" class="tm-member">
          <span class="tm-member-title">{{ item.title || '(无名称)' }}</span>
          <span class="tm-member-dim">创建于 {{ new Date(item.createdAt * 1000).toLocaleString() }}</span>
        </div>
      </div>
      <el-empty v-if="!folderDups.length" description="没有发现重复文件夹">
        <template #image><Icon name="check" :size="42" style="color:var(--md-success)" /></template>
      </el-empty>
    </div>

    <!-- favicons -->
    <div v-if="tab === 'favicon'" class="tm-panel">
      <el-alert type="info" :closable="false" style="margin-bottom: 12px"
        title="网站图标由已配对的浏览器插件上传（浏览器里显示什么，管理页就显示什么）。若某些图标缺失或显示为占位图，清空缓存后各设备会在下次同步时重新上传。" />
      <div class="tm-bar">
        <el-button type="primary" :loading="clearingFavicons" @click="clearFavicons">清空图标缓存并重扫</el-button>
        <span class="tm-hint">服务端也会对未命中的站点重新抓取（国内部署建议先配置出站代理）</span>
      </div>
    </div>
  </div>
</template>
