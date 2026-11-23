<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authApi, toolsApi, type Device, type Snapshot } from '@/api/client'

const tab = ref('account')
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
  await authApi.changePassword(oldPw.value, newPw.value)
  ElMessage.success('密码已修改，所有会话已失效，请重新登录')
  location.href = '/login'
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
  await ElMessageBox.confirm('关闭两步验证？', '确认', { type: 'warning' })
  await authApi.totpDisable()
  totpEnabled.value = false
  ElMessage.success('已关闭')
}

async function newPairCode() {
  const r = await authApi.newPairCode()
  pairCode.value = r.code
  pairExpiry.value = Date.now() + 300_000
}

async function revoke(d: Device) {
  await ElMessageBox.confirm(`吊销设备「${d.name}」？其同步将立即停止。`, '吊销设备', { type: 'warning' })
  await authApi.revokeDevice(d.id)
  loadAll()
  ElMessage.success('已吊销')
}

async function takeSnapshot() {
  await toolsApi.createSnapshot()
  ElMessage.success('快照已创建')
  loadAll()
}

async function restoreSnap(s: Snapshot) {
  await ElMessageBox.confirm(
    `将书签库恢复到 ${new Date(s.createdAt * 1000).toLocaleString()} 的快照？\n当前状态会先自动备份（pre-restore 快照）。`,
    '恢复快照', { type: 'warning' })
  await toolsApi.restoreSnapshot(s.id)
  ElMessage.success('已恢复，所有设备将自动同步')
  loadAll()
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
        <div style="margin-bottom: 16px">
          <el-button type="primary" @click="newPairCode">生成配对码</el-button>
          <span v-if="pairCode" style="margin-left: 12px; font-size: 20px; font-family: monospace; letter-spacing: 4px">
            {{ pairCode }}
          </span>
          <span v-if="pairCode" style="color: #909399; font-size: 12px; margin-left: 8px">5 分钟内有效</span>
        </div>
        <el-table :data="devices">
          <el-table-column prop="name" label="设备" min-width="180" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <span v-if="row.online" style="color:#67c23a">● 在线</span>
              <span v-else style="color:#909399">○ 离线</span>
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

      <!-- snapshots -->
      <el-tab-pane label="备份快照" name="snapshots">
        <div style="margin-bottom: 12px">
          <el-button type="primary" @click="takeSnapshot">立即创建快照</el-button>
          <span style="color:#909399; font-size:12px; margin-left: 8px">每天自动快照，保留最近 30 份</span>
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
