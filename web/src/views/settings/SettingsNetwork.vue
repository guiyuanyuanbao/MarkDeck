<script setup lang="ts">
// Settings 网络代理 tab: outbound proxy config + connectivity test.
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { authApi } from '@/api/client'
import { Icon } from '@/components/icons'
import { errMsg } from '@/utils/ui'

const proxyUrl = ref('')
const proxyTesting = ref(false)
const proxyTestResult = ref<{ ok: boolean; text: string } | null>(null)

onMounted(load)
async function load() {
  try {
    const r = await authApi.getProxy()
    proxyUrl.value = r.proxy || ''
  } catch { /* server older than this feature */ }
}

async function testProxy() {
  proxyTesting.value = true
  proxyTestResult.value = null
  try {
    const r = await authApi.testProxy(proxyUrl.value.trim())
    proxyTestResult.value = r.ok && r.status === 204
      ? { ok: true, text: `连通正常（${r.ms} ms 经 Google 连通性端点）` }
      : { ok: false, text: r.ok ? `HTTP ${r.status}（非预期响应）` : (r.error || '无法连接') }
  } catch (e) {
    proxyTestResult.value = { ok: false, text: errMsg(e) }
  } finally {
    proxyTesting.value = false
  }
}

async function saveProxy() {
  try {
    await authApi.setProxy(proxyUrl.value.trim())
    ElMessage.success('代理配置已保存，立即生效')
  } catch (e) {
    ElMessage.error(errMsg(e))
  }
}
</script>

<template>
  <div class="section-card">
    <h2 class="section-card-title">
      <span class="sec-ico"><Icon name="link" :size="16" /></span>
      出站代理
      <span class="section-card-sub">用于服务端抓取网站图标与死链检测</span>
    </h2>
    <div class="inline-row" style="max-width: 640px">
      <el-input v-model="proxyUrl" placeholder="留空为直连；http:// 或 socks5://host:port" clearable />
      <el-button @click="saveProxy">保存</el-button>
      <el-button :loading="proxyTesting" @click="testProxy">连通性检测</el-button>
    </div>
    <div v-if="proxyTestResult" style="margin-top: 12px">
      <el-tag :type="proxyTestResult.ok ? 'success' : 'danger'" size="small">{{ proxyTestResult.text }}</el-tag>
    </div>
    <p class="field-hint">
      检测通过 google.com 连通性端点验证实际可达性。保存后立即生效（无需重启）。示例: http://127.0.0.1:7890 · socks5://127.0.0.1:1080
    </p>
  </div>
</template>
