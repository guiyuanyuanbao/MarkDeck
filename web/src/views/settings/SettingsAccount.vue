<script setup lang="ts">
// Settings 账户 tab: password change + TOTP two-factor setup.
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { authApi } from '@/api/client'
import { Icon } from '@/components/icons'
import { confirmAct, errMsg } from '@/utils/ui'

const totpEnabled = ref(false)
const totpLoading = ref(false)
const totpSecret = ref('')
const totpOtpauth = ref('')
const totpCode = ref('')

const oldPw = ref('')
const newPw = ref('')
const newPw2 = ref('')

onLoad()
async function onLoad() {
  try {
    const me = await authApi.me()
    totpEnabled.value = me.totp
  } catch { /* not logged in */ }
}

async function changePassword() {
  if (newPw.value !== newPw2.value) { ElMessage.warning('两次输入不一致'); return }
  if (newPw.value.length < 8) { ElMessage.warning('新密码至少 8 个字符'); return }
  try {
    await authApi.changePassword(oldPw.value, newPw.value)
    ElMessage.success('密码已修改，所有会话已失效，请重新登录')
    location.href = '/login'
  } catch (e) { ElMessage.error(errMsg(e)) }
}

async function startTotp() {
  totpLoading.value = true
  try {
    const r = await authApi.totpSetup()
    totpSecret.value = r.secret
    totpOtpauth.value = r.otpauth
    // render QR locally (no external service): minimal fallback — show URI + secret
  } finally {
    totpLoading.value = false
  }
}

async function confirmTotp() {
  try {
    await authApi.totpEnable(totpCode.value)
    ElMessage.success('两步验证已开启')
    totpEnabled.value = true
    totpSecret.value = ''; totpOtpauth.value = ''; totpCode.value = ''
  } catch (e) {
    ElMessage.error(errMsg(e))
  }
}

function disableTotp() {
  void confirmAct('关闭两步验证？', '确认', async () => {
    await authApi.totpDisable()
    totpEnabled.value = false
    ElMessage.success('已关闭')
  }, { errorText: '操作失败' })
}
</script>

<template>
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

<style scoped>
.form-stack { display: flex; flex-direction: column; gap: 10px; max-width: 380px; }
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
</style>
