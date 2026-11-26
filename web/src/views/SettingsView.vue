<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authApi, toolsApi, type Device, type Snapshot } from '@/api/client'
import { Icon } from '@/components/icons'

const tab = ref('account')
// deep-link: /settings#devices jumps straight to the pairing tab (the
// topbar's device icon routes here — pairing should never be buried)
function applyHashTab(h: string) {
  if (h === 'account' || h === 'devices' || h === 'network' || h === 'snapshots') tab.value = h
}
applyHashTab(location.hash.replace('#', ''))
// vue-router updates route.hash without a native hashchange event when the
// path stays the same — watch the route instead
const route = useRoute()
watch(() => route.hash, (h: string) => applyHashTab(h.replace('#', '')))
const totpEnabled = ref(false)
const totpLoading = ref(false)
const totpSecret = ref('')
const totpOtpauth = ref('')
const totpCode = ref('')
const qr = ref('')

const oldPw = ref('')
const newPw = ref('')
const newPw2 = ref('')

const devices = ref<Device[]>([])
// the API's `online` flag is a snapshot at fetch time — a device that stops
// syncing would sit on "● 在线" forever if nothing refetches. Derive it live
// from lastSeen + the 1s tick instead (same 120s window as the server).
const ONLINE_WINDOW = 120
const liveDevices = computed(() => {
  const now = Math.floor(nowTick.value / 1000)
  return devices.value.map(d => ({ ...d, online: d.lastSeen > 0 && now - d.lastSeen <= ONLINE_WINDOW }))
})
const pairCode = ref('')
const pairDeviceName = ref('')
const proxyUrl = ref('')
const pairExpiry = ref(0)
const snapshots = ref<Snapshot[]>([])
// live countdown so the user sees the code dying instead of copying an
// already-expired one (the static "5 分钟内有效" gave no feedback)
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { tickTimer = setInterval(() => (nowTick.value = Date.now()), 1000) })
onBeforeUnmount(() => { if (tickTimer) clearInterval(tickTimer) })
const pairRemain = computed(() => {
  if (!pairCode.value || !pairExpiry.value) return null
  const s = Math.max(0, Math.floor((pairExpiry.value - nowTick.value) / 1000))
  return s
})

onMounted(() => {
  loadAll()
  // any revision ping (incl. the one broadcast when a device pairs) refreshes
  // the device list — no manual reload needed
  window.addEventListener('md:revision', onRevision)
  // while a pairing code is live, poll fast so a freshly paired device shows
  // up within seconds even without a WS ping; otherwise a slow poll keeps
  // lastSeen fresh (the online badge itself derives from the 1s tick)
  pollTimer = window.setInterval(() => {
    const pairing = pairCode.value && Date.now() < pairExpiry.value
    if (pairing || Date.now() - lastDevicesFetch >= 30000) loadDevices()
  }, 3000)
  loadProxy()
})
let pollTimer: number | undefined
onUnmounted(() => {
  window.removeEventListener('md:revision', onRevision)
  if (pollTimer) clearInterval(pollTimer)
})
let lastDeviceSig = ''
let lastDevicesFetch = 0
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

async function loadAll() {
  try {
    const me = await authApi.me()
    totpEnabled.value = me.totp
    const [d, s] = await Promise.all([authApi.devices(), toolsApi.snapshots()])
    devices.value = d.devices || []
    lastDeviceSig = (d.devices || []).map((x: Device) => x.id).sort().join(',')
    snapshots.value = s.snapshots || []
  } catch (e: any) { /* not logged in */ }
}

async function changePassword() {
  if (newPw.value !== newPw2.value) { ElMessage.warning('两次输入不一致'); return }
  if (newPw.value.length < 8) { ElMessage.warning('新密码至少 8 个字符'); return }
  try {
    await authApi.changePassword(oldPw.value, newPw.value)
    ElMessage.success('密码已修改，所有会话已失效，请重新登录')
    location.href = '/login'
  } catch (e: any) { ElMessage.error(e.message) }
}

async function startTotp() {
  totpLoading.value = true
  try {
    const r = await authApi.totpSetup()
    totpSecret.value = r.secret
    totpOtpauth.value = r.otpauth
    // render QR locally (no external service): use browser QR via otpauth uri in QRCode lib — minimal fallback: show URI + secret
    qr.value = r.otpauth
  } finally {
    totpLoading.value = false
  }
}

async function confirmTotp() {
  try {
    await authApi.totpEnable(totpCode.value)
    ElMessage.success('两步验证已开启')
    totpEnabled.value = true
    totpSecret.value = ''; totpOtpauth.value = ''; totpCode.value = ''; qr.value = ''
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

async function disableTotp() {
  try {
    await ElMessageBox.confirm('关闭两步验证？', '确认', { type: 'warning' })
    await authApi.totpDisable()
    totpEnabled.value = false
    ElMessage.success('已关闭')
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message)
  }
}

async function loadProxy() {
  try {
    const r = await authApi.getProxy()
    proxyUrl.value = r.proxy || ''
  } catch { /* server older than this feature */ }
}
const proxyTesting = ref(false)
const proxyTestResult = ref<{ ok: boolean; text: string } | null>(null)
async function testProxy() {
  proxyTesting.value = true
  proxyTestResult.value = null
  try {
    const r = await authApi.testProxy(proxyUrl.value.trim())
    proxyTestResult.value = r.ok && r.status === 204
      ? { ok: true, text: `连通正常（${r.ms} ms 经 Google 连通性端点）` }
      : { ok: false, text: r.ok ? `HTTP ${r.status}（非预期响应）` : (r.error || '无法连接') }
  } catch (e: any) {
    proxyTestResult.value = { ok: false, text: e.message }
  } finally {
    proxyTesting.value = false
  }
}

async function saveProxy() {
  try {
    await authApi.setProxy(proxyUrl.value.trim())
    ElMessage.success('代理配置已保存，立即生效')
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

async function newPairCode() {
  try {
    const name = pairDeviceName.value.trim() || undefined
    const r = await authApi.newPairCode(name)
    pairCode.value = r.code
    pairExpiry.value = Date.now() + 300_000
  } catch (e: any) {
    ElMessage.error('生成配对码失败: ' + e.message)
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

async function revoke(d: Device) {
  try {
    await ElMessageBox.confirm(`吊销设备「${d.name}」？其同步将立即停止。`, '吊销设备', { type: 'warning' })
    await authApi.revokeDevice(d.id)
    loadAll()
    ElMessage.success('已吊销')
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message)
  }
}

async function takeSnapshot() {
  try {
    await toolsApi.createSnapshot()
    ElMessage.success('快照已创建')
    loadAll()
  } catch (e: any) {
    ElMessage.error('快照创建失败: ' + e.message)
  }
}

const restoring = ref(false)
async function restoreSnap(s: Snapshot) {
  if (restoring.value) return
  restoring.value = true
  try {
    await ElMessageBox.confirm(
      `将书签库恢复到 ${new Date(s.createdAt * 1000).toLocaleString()} 的快照？\n当前状态会先自动备份（pre-restore 快照）。`,
      '恢复快照', { type: 'warning' })
    await toolsApi.restoreSnapshot(s.id)
    ElMessage.success('已恢复，所有设备将自动同步')
    loadAll()
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error('恢复失败: ' + e.message)
  } finally {
    restoring.value = false
  }
}
</script>
<template>
  <div class="page-shell">
    <div class="page-hero">
      <div class="page-hero-title">
        <h1 class="page-title">设置</h1>
        <span class="page-sub">账户安全、设备同步与数据备份</span>
      </div>
    </div>

    <div class="pill-tabs">
      <button class="pill-tab" :class="{ active: tab === 'account' }" @click="tab = 'account'">
        <Icon name="shield" :size="14" /> 账户
      </button>
      <button class="pill-tab" :class="{ active: tab === 'devices' }" @click="tab = 'devices'">
        <Icon name="laptop" :size="14" /> 设备同步
      </button>
      <button class="pill-tab" :class="{ active: tab === 'network' }" @click="tab = 'network'">
        <Icon name="link" :size="14" /> 网络代理
      </button>
      <button class="pill-tab" :class="{ active: tab === 'snapshots' }" @click="tab = 'snapshots'">
        <Icon name="restore" :size="14" /> 备份快照
      </button>
    </div>

    <!-- ================= account ================= -->
    <template v-if="tab === 'account'">
      <div class="section-card">
        <h2 class="section-card-title">
          <span class="sec-ico"><Icon name="shield" :size="16" /></span>
          修改密码
          <span class="section-card-sub">修改后所有会话失效，需重新登录</span>
        </h2>
        <div class="form-stack">
          <el-input v-model="oldPw" type="password" show-password placeholder="当前密码" />
          <el-input v-model="newPw" type="password" show-password placeholder="新密码（至少 8 位）" />
          <el-input v-model="newPw2" type="password" show-password placeholder="确认新密码" />
          <div>
            <el-button type="primary" @click="changePassword">修改密码</el-button>
          </div>
        </div>
      </div>

      <div class="section-card">
        <h2 class="section-card-title">
          <span class="sec-ico"><Icon name="shield" :size="16" /></span>
          两步验证 (TOTP)
        </h2>
        <div v-if="totpEnabled" class="inline-row">
          <span class="status-pill ok">已开启</span>
          <el-button size="small" @click="disableTotp">关闭两步验证</el-button>
        </div>
        <div v-else>
          <el-button v-if="!totpOtpauth" type="primary" :loading="totpLoading" @click="startTotp">开启两步验证</el-button>
          <div v-if="totpOtpauth" class="totp-setup">
            <p class="totp-tip">用 Google Authenticator / 1Password 等 App 添加以下密钥：</p>
            <div class="totp-secret-row">
              <code class="totp-secret">{{ totpSecret }}</code>
            </div>
            <p class="totp-uri">{{ totpOtpauth }}</p>
            <div class="inline-row">
              <el-input v-model="totpCode" placeholder="App 显示的 6 位验证码" maxlength="6" style="width: 200px" />
              <el-button type="primary" @click="confirmTotp">确认开启</el-button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ================= devices ================= -->
    <template v-if="tab === 'devices'">
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

    <!-- ================= network ================= -->
    <template v-if="tab === 'network'">
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

    <!-- ================= snapshots ================= -->
    <template v-if="tab === 'snapshots'">
      <div class="section-card">
        <h2 class="section-card-title">
          <span class="sec-ico"><Icon name="restore" :size="16" /></span>
          备份快照
          <span class="section-card-sub">每天自动快照，保留最近 30 份</span>
        </h2>
        <el-button type="primary" @click="takeSnapshot">立即创建快照</el-button>
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
  </div>
</template>

<style scoped>
.form-stack { display: flex; flex-direction: column; gap: 10px; max-width: 380px; }
.inline-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.field-hint { color: var(--md-text-3); font-size: 12px; margin: 10px 0 0; line-height: 1.6; }
.status-pill { padding: 3px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; }
.status-pill.ok { background: var(--md-success-soft); color: var(--md-success); }

.totp-setup { margin-top: 4px; max-width: 480px; }
.totp-tip { font-size: 13px; color: var(--md-text-2); margin: 0 0 10px; }
.totp-secret-row { margin-bottom: 10px; }
.totp-secret {
  display: inline-block;
  font-family: ui-monospace, monospace;
  font-size: 14px;
  letter-spacing: 1px;
  background: var(--md-bg);
  border: 1px solid var(--md-border);
  border-radius: 8px;
  padding: 8px 14px;
  user-select: all;
}
.totp-uri { font-size: 11.5px; color: var(--md-text-3); word-break: break-all; margin: 0 0 12px; font-family: ui-monospace, monospace; }

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
