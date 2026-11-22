<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { toolsApi, type Bookmark } from '@/api/client'

const tab = ref('dead')
const scanning = ref(false)
const dead = ref<{ bookmark: Bookmark; status: string; checked: number }[]>([])
const dups = ref<{ key: string; items: Bookmark[] }[]>([])
const loading = ref(false)

onMounted(load)

async function load() {
  loading.value = true
  try {
    const [d, g] = await Promise.all([toolsApi.deadLinks(), toolsApi.duplicates()])
    dead.value = d.links || []
    dups.value = g.groups || []
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
  // safety: stop polling after 10 min
  setTimeout(() => clearInterval(t), 10 * 60 * 1000)
}

function statusTag(s: string) {
  if (s === 'ok') return 'success'
  if (s.startsWith('blocked:')) return 'warning' // anti-bot, not necessarily dead
  if (s.startsWith('http:4')) return 'warning'
  return 'danger'
}

async function mergeGroup(g: { key: string; items: Bookmark[] }) {
  const keep = g.items[0]
  const removes = g.items.slice(1).map((i) => i.id)
  await ElMessageBox.confirm(
    `保留「${keep.title || keep.url}」（最早创建），其余 ${removes.length} 条移入回收站，标签与备注会合并到保留项。继续？`,
    '合并重复', { type: 'warning' })
  await toolsApi.mergeDup(keep.id, removes)
  ElMessage.success('已合并')
  load()
}
</script>

<template>
  <el-card shadow="never" v-loading="loading">
    <el-tabs v-model="tab">
      <el-tab-pane label="死链检测" name="dead">
        <div style="margin-bottom: 12px">
          <el-button type="primary" :loading="scanning" @click="startScan">开始扫描</el-button>
          <span style="color:#909399; font-size:12px; margin-left: 8px">
            检查所有书签 URL 可达性（HEAD → GET 回退，并发 8，每域名限速）
          </span>
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
      </el-tab-pane>

      <el-tab-pane :label="`重复书签 (${dups.length})`" name="dup">
        <div v-for="g in dups" :key="g.key" style="margin-bottom: 16px; border: 1px solid #ebeef5; border-radius: 6px; padding: 10px">
          <div style="display:flex; justify-content:space-between; margin-bottom: 8px">
            <b style="color:#909399">{{ g.key }}</b>
            <el-button size="small" type="primary" plain @click="mergeGroup(g)">一键合并（保留最早）</el-button>
          </div>
          <div v-for="item in g.items" :key="item.id" style="padding: 4px 0; border-top: 1px dashed #f0f0f0">
            <span>{{ item.title || '(无标题)' }}</span>
            <span class="bm-url" style="margin-left: 8px">{{ item.url }}</span>
            <el-tag v-for="t in item.tags" :key="t" size="small" style="margin-left: 4px">{{ t }}</el-tag>
          </div>
        </div>
        <el-empty v-if="!dups.length" description="没有发现重复书签 🎉" />
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>
