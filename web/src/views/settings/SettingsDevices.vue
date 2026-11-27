<script setup lang="ts">
// Settings 设备同步 tab: pairing code issue + paired-device list. The tab
// owns its polling lifecycle: fast (3s) while a pairing code is live, slow
// (30s) otherwise; md:revision pings refresh immediately. Device online
// badges derive from lastSeen + a 1s tick (the API flag is a fetch-time
// snapshot and would freeze on "在线").
import { ref, computed, onMounted, onUnmounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { authApi, type Device } from '@/api/client'
import { Icon } from '@/components/icons'
import { confirmAct, errMsg } from '@/utils/ui'

const devices = ref<Device[]>([])
const pairCode = ref('')
const pairDeviceName = ref('')
const pairExpiry = ref(0)

// live countdown so the user sees the code dying instead of copying an
// already-expired one
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { tickTimer = setInterval(() => (nowTick.value = Date.now()), 1000) })
onBeforeUnmount(() => { if (tickTimer) clearInterval(tickTimer) })

const ONLINE_WINDOW = 120
const liveDevices = computed(() => {
  const now = Math.floor(nowTick.value / 1000)
  return devices.value.map(d => ({ ...d, online: d.lastSeen > 0 && now - d.lastSeen <= ONLINE_WINDOW }))
})

const pairRemain = computed(() => {
  if (!pairCode.value || !pairExpiry.value) return null
  return Math.max(0, Math.floor((pairExpiry.value - nowTick.value) / 1000))
})

let pollTimer: number | undefined
let lastDeviceSig = ''
let lastDevicesFetch = 0
onMounted(() => {
  loadDevices()
  // any revision ping (incl. the one broadcast when a device pairs) refreshes
  // the device list — no manual reload needed
  window.addEventListener('md:revision', onRevision)
  pollTimer = window.setInterval(() => {
    const pairing = pairCode.value && Date.now() < pairExpiry.value
    if (pairing || Date.now() - lastDevicesFetch >= 30000) loadDevices()
  }, 3000)
})
onUnmounted(() => {
  window.removeEventListener('md:revision', onRevision)
  if (pollTimer) clearInterval(pollTimer)
})
function onRevision() { loadDevices() }
async function loadDevices() {
  lastDevicesFetch = Date.now()
  try {
    const d = await authApi.devices()
    const list = d.devices || []
    devices.value = list
    // a new device appeared while a pairing code is on screen: announce it
    const sig = list.map(x => x.id).sort().join(',')
    if (pairCode.value && lastDeviceSig && sig !== lastDeviceSig) {
      pairCode.value = '' // consumed: stop showing a dead code
      ElMessage.success('新设备已配对，同步已开始')
    }
    lastDeviceSig = sig
  } catch { /* not logged in */ }
}

async function newPairCode() {
  try {
    const name = pairDeviceName.value.trim() || undefined
    const r = await authApi.newPairCode(name)
    pairCode.value = r.code
    pairExpiry.value = Date.now() + 300_000
  } catch (e) {
    ElMessage.error('生成配对码失败: ' + errMsg(e))
  }
}
async function copyPairCode() {
  if (!pairCode.value) return
  const code = pairCode.value
  // navigator.clipboard only exists in secure contexts — most self-hosted
  // deployments run plain http on a LAN, so fall back to a hidden textarea
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(code)
    } else {
      const ta = document.createElement('textarea')
      ta.value = code
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (!ok) throw new Error('copy rejected')
    }
    ElMessage.success('配对码已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择')
  }
}

function revoke(d: Device) {
  void confirmAct(`吊销设备「${d.name}」？其同步将立即停止。`, '吊销设备', async () => {
    await authApi.revokeDevice(d.id)
    loadDevices()
    ElMessage.success('已吊销')
  }, { errorText: '吊销失败' })
}
</script>

<template>
  <div class="section-card">
    <h2 class="section-card-title">
      <span class="sec-ico"><Icon name="laptop" :size="16" /></span>
      配对新设备
      <span class="section-card-sub">浏览器插件通过一次性配对码接入</span>
    </h2>
    <div class="inline-row">
      <el-input v-model="pairDeviceName" placeholder="设备名称（可选，如：公司电脑）" clearable style="width: 220px" />
      <el-button type="primary" @click="newPairCode">生成配对码</el-button>
    </div>
    <div v-if="pairCode" class="pair-code-box">
      <span class="pair-code">{{ pairCode }}</span>
      <el-button size="small" plain @click="copyPairCode">复制</el-button>
      <span class="pair-expiry">
        <template v-if="pairRemain !== null && pairRemain > 0">
          {{ Math.floor(pairRemain / 60) }}:{{ String(pairRemain % 60).padStart(2, '0') }} 内有效 · 一次性
        </template>
        <span v-else class="pair-expired">已过期 — 请重新生成</span>
      </span>
    </div>
    <p class="field-hint">在插件设置页填入服务器地址与该配对码即可完成连接。</p>
  </div>

  <div class="section-head">
    <h2 class="section-head-title">已配对设备</h2>
    <span class="section-head-sub" v-if="liveDevices.length">{{ liveDevices.length }} 台</span>
  </div>
  <div v-if="liveDevices.length" class="data-list">
    <div v-for="d in liveDevices" :key="d.id" class="data-row">
      <div class="device-ico">
        <Icon name="laptop" :size="17" />
      </div>
      <div class="data-row-main">
        <span class="data-row-title">
          {{ d.name }}
          <span v-if="d.clientName && d.clientName !== d.name" class="device-client">（{{ d.clientName }}）</span>
        </span>
        <span class="data-row-sub">
          配对于 {{ new Date(d.createdAt * 1000).toLocaleString() }}
          · 最近同步 {{ d.lastSeen ? new Date(d.lastSeen * 1000).toLocaleString() : '从未' }}
        </span>
      </div>
      <div class="data-row-meta">
        <span :class="d.online ? 'dot-online' : 'dot-offline'">{{ d.online ? '● 在线' : '○ 离线' }}</span>
      </div>
      <div class="data-row-actions">
        <button class="row-act danger" @click="revoke(d)">吊销</button>
      </div>
    </div>
  </div>
  <div v-else class="list-empty">
    <div class="list-empty-icon"><Icon name="laptop" :size="24" /></div>
    <div class="list-empty-title">还没有配对设备</div>
    <div class="list-empty-hint">生成配对码后在浏览器插件里完成配对</div>
  </div>
</template>

<style scoped>
.pair-code-box {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-top: 14px; padding: 14px 16px;
  background: var(--md-bg);
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-sm);
  max-width: 520px;
}
.pair-code {
  font-size: 24px; font-weight: 700;
  font-family: ui-monospace, monospace;
  letter-spacing: 5px;
  color: var(--md-primary);
}
.pair-expiry { display: inline-flex; align-items: center; gap: 5px; color: var(--md-text-3); font-size: 12.5px; }
.pair-expired { color: var(--md-danger); font-weight: 600; }

.section-head { display: flex; align-items: baseline; gap: 8px; margin: 20px 2px 10px; }
.section-head-title { font-size: 14.5px; font-weight: 700; margin: 0; color: var(--md-text); }
.section-head-sub { color: var(--md-text-3); font-size: 12.5px; }

.device-ico {
  width: 34px; height: 34px; flex-shrink: 0;
  border-radius: 10px;
  background: var(--md-primary-soft);
  color: var(--md-primary);
  display: grid; place-items: center;
}
.device-client { color: var(--md-text-3); font-weight: 400; font-size: 12px; }
</style>
