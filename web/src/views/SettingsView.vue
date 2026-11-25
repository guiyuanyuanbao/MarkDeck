<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authApi, toolsApi, type Device, type Snapshot } from '@/api/client'

const tab = ref('account')
// deep-link: /settings#devices jumps straight to the pairing tab (the
// topbar's device icon routes here — pairing should never be buried)
function applyHashTab(h: string) {
  if (h === 'devices' || h === 'network' || h === 'snapshots') tab.value = h
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
const pairCode = ref('')
const pairDeviceName = ref('')
const proxyUrl = ref('')
const pairExpiry = ref(0)
const snapshots = ref<Snapshot[]>([])

onMounted(() => {
  loadAll()
  // any revision ping (incl. the one broadcast when a device pairs) refreshes
  // the device list — no manual reload needed
  window.addEventListener('md:revision', onRevision)
  // while a pairing code is live, poll so a freshly paired device shows up
  // within seconds even without a WS ping
  pollTimer = window.setInterval(() => {
    if (pairCode.value && Date.now() < pairExpiry.value) loadDevices()
  }, 3000)
  loadProxy()
})
let pollTimer: number | undefined
onUnmounted(() => {
  window.removeEventListener('md:revision', onRevision)
  if (pollTimer) clearInterval(pollTimer)
})
let lastDeviceSig = ''
function onRevision() { loadDevices() }
async function loadDevices() {
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
  <el-card shadow="never">
    <el-tabs v-model="tab">
      <!-- account -->
      <el-tab-pane label="账户" name="account">
        <h3>修改密码</h3>
        <el-form label-width="90px" style="max-width: 420px">
          <el-form-item label="当前密码"><el-input v-model="oldPw" type="password" show-password /></el-form-item>
          <el-form-item label="新密码"><el-input v-model="newPw" type="password" show-password /></el-form-item>
          <el-form-item label="确认新密码"><el-input v-model="newPw2" type="password" show-password /></el-form-item>
          <el-button type="primary" @click="changePassword">修改密码</el-button>
        </el-form>

        <el-divider />
        <h3>两步验证 (TOTP)</h3>
        <p v-if="totpEnabled">
          <el-tag type="success">已开启</el-tag>
          <el-button size="small" style="margin-left: 8px" @click="disableTotp">关闭两步验证</el-button>
        </p>
        <div v-else>
          <el-button type="primary" :loading="totpLoading" @click="startTotp">开启两步验证</el-button>
          <div v-if="totpOtpauth" style="margin-top: 12px; max-width: 480px">
            <el-alert type="info" :closable="false" style="margin-bottom: 8px"
              title="用 Google Authenticator / 1Password 等 App 扫码或手动输入密钥" />
            <p style="word-break: break-all; font-family: monospace; font-size: 12px">{{ totpOtpauth }}</p>
            <p>密钥: <b style="font-family: monospace">{{ totpSecret }}</b></p>
            <el-input v-model="totpCode" placeholder="输入 App 显示的 6 位验证码" maxlength="6" style="width: 200px" />
            <el-button type="primary" style="margin-left: 8px" @click="confirmTotp">确认开启</el-button>
          </div>
        </div>
      </el-tab-pane>

      <!-- devices -->
      <el-tab-pane label="设备同步" name="devices">
        <el-alert type="info" :closable="false" style="margin-bottom: 12px"
          title="浏览器插件通过一次性配对码接入。生成配对码后，在插件设置页填入服务器地址与配对码。" />
        <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
          <el-input v-model="pairDeviceName" placeholder="设备名称（可选，如：公司电脑）" clearable style="width: 220px" />
          <el-button type="primary" @click="newPairCode">生成配对码</el-button>
          <span v-if="pairCode" style="font-size: 20px; font-family: monospace; letter-spacing: 4px">
            {{ pairCode }}
          </span>
          <el-button v-if="pairCode" size="small" plain @click="copyPairCode">复制</el-button>
          <span v-if="pairCode" style="color: #909399; font-size: 12px">5 分钟内有效 · 使用一次后立即失效</span>
        </div>
        <el-table :data="devices">
          <el-table-column label="设备" min-width="200">
            <template #default="{ row }">
              <div style="display:flex;align-items:center;gap:8px">
                <b>{{ row.name }}</b>
                <span v-if="row.clientName && row.clientName !== row.name"
                  style="color:var(--md-text-3);font-size:12px">（客户端报名: {{ row.clientName }}）</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <span v-if="row.online" style="color:var(--md-success)">● 在线</span>
              <span v-else style="color:var(--md-text-3)">○ 离线</span>
            </template>
          </el-table-column>
          <el-table-column label="配对时间" width="170">
            <template #default="{ row }">{{ new Date(row.createdAt * 1000).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="最近同步" width="170">
            <template #default="{ row }">{{ row.lastSeen ? new Date(row.lastSeen * 1000).toLocaleString() : '从未' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{ row }">
              <el-button link type="danger" size="small" @click="revoke(row)">吊销</el-button>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无已配对设备" /></template>
        </el-table>
      </el-tab-pane>

      <!-- network -->
      <el-tab-pane label="网络代理" name="network">
        <el-alert type="info" :closable="false" style="margin-bottom: 12px"
          title="服务端抓取网页图标和死链检测的出站代理。部署在国内访问境外站点困难时，配置后图标抓取成功率会显著提升。" />
        <div style="display:flex;gap:10px;align-items:center;max-width:640px">
          <el-input v-model="proxyUrl" placeholder="留空为直连；支持 http:// 或 socks5://host:port" clearable />
          <el-button @click="saveProxy">保存</el-button>
          <el-button :loading="proxyTesting" @click="testProxy">连通性检测</el-button>
        </div>
        <div v-if="proxyTestResult" style="margin-top:10px">
          <el-tag :type="proxyTestResult.ok ? 'success' : 'danger'" size="small">{{ proxyTestResult.text }}</el-tag>
        </div>
        <div style="color:var(--md-text-3);font-size:12px;margin-top:8px">
          检测通过 google.com 连通性端点验证实际可达性。保存后立即生效（无需重启）。示例: http://127.0.0.1:7890 · socks5://127.0.0.1:1080
        </div>
      </el-tab-pane>

      <!-- snapshots -->
      <el-tab-pane label="备份快照" name="snapshots">
        <div style="margin-bottom: 12px">
          <el-button type="primary" @click="takeSnapshot">立即创建快照</el-button>
          <span style="color:var(--md-text-3); font-size:12px; margin-left: 8px">每天自动快照，保留最近 30 份</span>
        </div>
        <el-table :data="snapshots">
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ new Date(row.createdAt * 1000).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="大小" width="100">
            <template #default="{ row }">{{ (row.size / 1024).toFixed(1) }} KB</template>
          </el-table-column>
          <el-table-column prop="cause" label="来源" width="120" />
          <el-table-column label="操作" width="180">
            <template #default="{ row }">
              <el-button link size="small" @click="restoreSnap(row)">恢复</el-button>
              <a :href="`/api/snapshots/${row.id}/download`" target="_blank">
                <el-button link size="small">下载</el-button>
              </a>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无快照" /></template>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>
