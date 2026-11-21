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
    // already logged in? straight to manager
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
    <el-card class="login-card">
      <template #header>
        <div style="text-align:center; font-size: 18px; font-weight: 600">
          {{ mode === 'setup' ? '🎉 欢迎使用 MarkDeck — 设置管理员密码' : '登录 MarkDeck' }}
        </div>
      </template>
      <el-form @submit.prevent="submit" label-position="top">
        <el-form-item label="管理员密码">
          <el-input v-model="password" type="password" show-password placeholder="至少 8 个字符" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item v-if="mode === 'setup'" label="确认密码">
          <el-input v-model="confirmPassword" type="password" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-form-item v-if="mode === 'login' && showTotp" label="两步验证码">
          <el-input v-model="totp" placeholder="6 位动态码" maxlength="6" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="loading" native-type="submit">
          {{ mode === 'setup' ? '创建并登录' : '登录' }}
        </el-button>
        <div v-if="mode === 'setup'" style="color:#909399; font-size: 12px; margin-top: 8px">
          这是首次运行：密码将用于保护你的书签库，请牢记。
        </div>
      </el-form>
    </el-card>
  </div>
</template>
