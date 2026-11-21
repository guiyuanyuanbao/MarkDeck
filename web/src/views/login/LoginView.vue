<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { ElMessage } from 'element-plus'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const password = ref('')
const confirmPassword = ref('')
const totp = ref('')
const loading = ref(false)
const mode = ref<'login' | 'setup'>('login')
const showTotp = ref(false)

onMounted(async () => {
  try {
    await auth.refreshState()
    mode.value = auth.needsSetup ? 'setup' : 'login'
    if (auth.loggedIn) router.replace((route.query.redirect as string) || '/')
  } catch {
    ElMessage.error('无法连接服务器')
  }
})

async function submit() {
  if (loading.value) return
  if (mode.value === 'setup' && password.value !== confirmPassword.value) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  loading.value = true
  try {
    if (mode.value === 'setup') {
      await auth.setup(password.value)
      router.replace('/')
    } else {
      await auth.login(password.value, totp.value)
      router.replace((route.query.redirect as string) || '/')
    }
  } catch (e: any) {
    if (e?.message?.includes('TOTP') || e?.message?.includes('totp')) {
      showTotp.value = true
    }
    ElMessage.error(e?.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-card" :shadow="false">
      <div class="login-brand">
        <div class="md-logo-mark">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div class="login-title">{{ mode === 'setup' ? '欢迎使用 MarkDeck' : '登录 MarkDeck' }}</div>
        <div class="login-sub">
          {{ mode === 'setup' ? '首次使用，请先设置管理员密码' : '自托管书签同步服务' }}
        </div>
      </div>
      <el-form @submit.prevent="submit" label-position="top">
        <el-form-item label="管理员密码">
          <el-input v-model="password" type="password" show-password placeholder="至少 8 个字符" size="large" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item v-if="mode === 'setup'" label="确认密码">
          <el-input v-model="confirmPassword" type="password" show-password size="large" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item v-if="mode === 'login' && showTotp" label="两步验证码">
          <el-input v-model="totp" placeholder="6 位动态码" maxlength="6" size="large" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" style="width: 100%; margin-top: 4px" size="large" :loading="loading" native-type="submit">
          {{ mode === 'setup' ? '创建并进入' : '登 录' }}
        </el-button>
        <div v-if="mode === 'setup'" style="color: var(--md-text-3); font-size: 12px; margin-top: 10px; text-align: center">
          密码将用于保护你的书签库，请牢记
        </div>
      </el-form>
    </el-card>
  </div>
</template>
