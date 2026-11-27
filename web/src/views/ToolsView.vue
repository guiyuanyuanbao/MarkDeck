<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { toolsApi, authApi, bookmarksApi, type Bookmark } from '@/api/client'
import { Icon } from '@/components/icons'
import BookmarkAvatar from '@/components/BookmarkAvatar.vue'

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
const deadSel = ref<Set<string>>(new Set())
const deadDeleting = ref(false)

onMounted(load)

async function load(preserveSelection = false) {
  loading.value = true
  try {
    const [d, g, fg] = await Promise.all([toolsApi.deadLinks(), toolsApi.duplicates(), toolsApi.folderDuplicates()])
    // the scan's working surface shows only rows that need human attention:
    // 'ok' rows are reachable bookmarks, not dead links — keeping them listed
    // buried the findings and made the tab look permanently cluttered
    dead.value = (d.links || []).filter((x) => x.status !== 'ok')
    dups.value = g.groups || []
    folderDups.value = fg.groups || []
    // selection-preserving mode for the scan poller: wiping deadSel every
    // 3s tick made it impossible to tick checkboxes while a scan ran
    if (!preserveSelection) {
      selDup.value = new Set()
      selFolder.value = new Set()
      deadSel.value = new Set()
    } else {
      const liveDead = new Set(dead.value.map((x) => x.bookmark.id))
      deadSel.value = new Set([...deadSel.value].filter((id) => liveDead.has(id)))
    }
  } catch (e: any) {
    ElMessage.error('工具数据加载失败: ' + e.message)
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
      await load(true)
      if (!st.running) {
        scanning.value = false
        clearInterval(t)
        ElMessage.success('扫描完成')
      }
    } catch { /* keep polling */ }
  }, 3000)
  // the deadline must also reset `scanning` — previously a 10-minute cap
  // left the button loading forever on an over-long scan
  const deadline = setTimeout(() => {
    clearInterval(t)
    if (scanning.value) {
      scanning.value = false
      ElMessage.warning('扫描超时（10 分钟），请稍后手动刷新查看结果')
    }
  }, 10 * 60 * 1000)
  // leaving the page must stop both timers — the interval previously kept
  // firing (and the deadline warning kept firing) after unmount
  onUnmounted(() => {
    clearInterval(t)
    clearTimeout(deadline)
  })
}

// ---- dead links quick actions ----
// row-level selection (the old el-table drove this via selection-change;
// the data-row list drives it from per-row checkboxes)
const allDeadSelected = computed(() => dead.value.length > 0 && dead.value.every((r) => deadSel.value.has(r.bookmark.id)))
function toggleDead(row: { bookmark: Bookmark }) {
  const next = new Set(deadSel.value)
  if (next.has(row.bookmark.id)) next.delete(row.bookmark.id)
  else next.add(row.bookmark.id)
  deadSel.value = next
}
function toggleAllDead() {
  deadSel.value = allDeadSelected.value ? new Set() : new Set(dead.value.map((r) => r.bookmark.id))
}
async function deleteDeadSelected() {
  const ids = [...deadSel.value]
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(`将所选 ${ids.length} 条失效/可疑书签移入回收站？可在回收站恢复。`, '批量删除', { type: 'warning' })
    deadDeleting.value = true
    await bookmarksApi.batch({ ids, action: 'delete' })
    ElMessage.success(`已移入回收站 ${ids.length} 条`)
    deadSel.value = new Set()
    await load()
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message)
  } finally {
    deadDeleting.value = false
  }
}

// clear the whole result list: the dead-links list is a temporary working
// surface (scan → review → fix/delete → clear), not an archive
async function clearDeadRecords() {
  try {
    await ElMessageBox.confirm('清空全部检测记录？书签本身不受影响，下次扫描会重新生成。', '清空检测记录', { type: 'warning' })
    await toolsApi.clearDead()
    deadSel.value = new Set()
    ElMessage.success('检测记录已清空')
    await load()
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message)
  }
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
  <div class="page-shell">
    <div class="page-hero">
      <div class="page-hero-title">
        <h1 class="page-title">工具中心</h1>
        <span class="page-sub">批量整理与健康检查</span>
      </div>
    </div>

    <div class="pill-tabs">
      <button class="pill-tab" :class="{ active: tab === 'dead' }" @click="tab = 'dead'">死链检测</button>
      <button class="pill-tab" :class="{ active: tab === 'dup' }" @click="tab = 'dup'">
        重复书签 <span v-if="dups.length" class="tm-count">{{ dups.length }}</span>
      </button>
      <button class="pill-tab" :class="{ active: tab === 'folderdup' }" @click="tab = 'folderdup'">
        重复文件夹 <span v-if="folderDups.length" class="tm-count">{{ folderDups.length }}</span>
      </button>
      <button class="pill-tab" :class="{ active: tab === 'favicon' }" @click="tab = 'favicon'">网站图标</button>
    </div>

    <!-- dead links -->
    <div v-if="tab === 'dead'">
      <div class="section-card">
        <div class="inline-row">
          <el-button type="primary" :loading="scanning" @click="startScan">开始扫描</el-button>
          <el-button v-if="dead.length" type="danger" plain :disabled="!deadSel.size" :loading="deadDeleting" @click="deleteDeadSelected">
            移入回收站（{{ deadSel.size }}）
          </el-button>
          <el-button v-if="dead.length" plain @click="clearDeadRecords">清空记录</el-button>
          <span class="tm-hint">HEAD → GET 回退，并发 8；blocked:4xx 多为反爬拦截，点击标题或链接可人工核实（新标签页打开）</span>
        </div>
      </div>
      <div v-if="dead.length" class="data-list">
        <div class="data-row" style="padding: 9px 18px; background: var(--md-bg)">
          <el-checkbox class="row-check" :model-value="allDeadSelected" @change="toggleAllDead" />
          <span class="data-row-sub" style="font-size: 12.5px">{{ dead.length }} 条待确认<template v-if="deadSel.size"> · 已选 {{ deadSel.size }}</template></span>
        </div>
        <div
          v-for="row in dead"
          :key="row.bookmark.id"
          class="data-row"
          :class="{ selected: deadSel.has(row.bookmark.id) }"
        >
          <el-checkbox
            class="row-check"
            :model-value="deadSel.has(row.bookmark.id)"
            @change="toggleDead(row)"
          />
          <BookmarkAvatar :b="row.bookmark" :size="34" />
          <div class="data-row-main">
            <a
              class="data-row-title dead-link"
              :href="row.bookmark.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ row.bookmark.title || row.bookmark.url }}</a>
            <a
              class="data-row-sub dead-link"
              :href="row.bookmark.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ row.bookmark.url }}</a>
          </div>
          <div class="data-row-meta">
            <span class="status-pill" :class="row.status === 'ok' ? 'ok' : row.status.startsWith('blocked') ? 'warn' : 'err'">
              {{ row.status === 'ok' ? '正常' : row.status }}
            </span>
            <span>{{ row.checked ? new Date(row.checked * 1000).toLocaleString() : '-' }}</span>
          </div>
        </div>
      </div>
      <div v-else class="list-empty">
        <div class="list-empty-icon"><Icon name="check" :size="26" style="color: var(--md-success)" /></div>
        <div class="list-empty-title">暂无死链记录</div>
        <div class="list-empty-hint">点击「开始扫描」检查所有书签的可达性</div>
      </div>
    </div>

    <!-- duplicate bookmarks -->
    <div v-if="tab === 'dup'" class="section-card">
      <div v-if="dups.length" class="inline-row" style="margin-bottom: 14px">
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
      <div v-if="!dups.length" class="list-empty">
        <div class="list-empty-icon"><Icon name="check" :size="26" style="color: var(--md-success)" /></div>
        <div class="list-empty-title">没有发现重复书签</div>
        <div class="list-empty-hint">书签库很干净</div>
      </div>
    </div>

    <!-- duplicate folders -->
    <div v-if="tab === 'folderdup'" class="section-card">
      <p class="field-hint" style="margin-bottom: 14px">
        同名文件夹的多份副本（多设备历史同步产生）。合并会把副本中的书签并入保留文件夹，URL 重复的丢弃，副本壳移入回收站。
      </p>
      <div v-if="folderDups.length" class="inline-row" style="margin-bottom: 14px">
        <el-checkbox :model-value="allFolderSelected" @change="toggleAllFolder">全选</el-checkbox>
        <el-button type="primary" :disabled="!selFolder.size" :loading="mergingAll" @click="mergeSelectedFolders">
          合并所选组（{{ selFolder.size }}）
        </el-button>
      </div>
      <div v-for="g in folderDups" :key="folderKey(g)" class="tm-group">
        <div class="tm-group-head">
          <div class="tm-group-title">
            <el-checkbox :model-value="selFolder.has(folderKey(g))" @change="toggleFolder(g)" />
            <Icon name="folder" :size="15" style="color: var(--md-warning)" />
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
      <div v-if="!folderDups.length" class="list-empty">
        <div class="list-empty-icon"><Icon name="check" :size="26" style="color: var(--md-success)" /></div>
        <div class="list-empty-title">没有发现重复文件夹</div>
        <div class="list-empty-hint">文件夹结构很干净</div>
      </div>
    </div>

    <!-- favicons -->
    <div v-if="tab === 'favicon'" class="section-card">
      <h2 class="section-card-title">
        <span class="sec-ico"><Icon name="star" :size="16" /></span>
        网站图标
      </h2>
      <p class="field-hint" style="margin: 0 0 14px">
        网站图标由已配对的浏览器插件上传（浏览器里显示什么，管理页就显示什么）。若某些图标缺失或显示为占位图，清空缓存后各设备会在下次同步时重新上传；服务端也会对未命中的站点重新抓取（国内部署建议先配置出站代理）。
      </p>
      <el-button type="primary" :loading="clearingFavicons" @click="clearFavicons">清空图标缓存并重扫</el-button>
    </div>
  </div>
</template>

<style scoped>
.inline-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.field-hint { color: var(--md-text-3); font-size: 12.5px; margin: 0; line-height: 1.7; }
.status-pill {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.status-pill.ok { background: var(--md-success-soft); color: var(--md-success); }
.status-pill.warn { background: color-mix(in srgb, var(--md-warning) 15%, transparent); color: var(--md-warning); }
.status-pill.err { background: var(--md-danger-soft); color: var(--md-danger); }
.dead-link {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.dead-link:hover { color: var(--md-primary); text-decoration: underline; }
</style>
