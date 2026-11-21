<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

onMounted(() => {
  // session expiry anywhere -> login screen
  window.addEventListener('md:unauthorized', () => {
    auth.loggedIn = false
    router.push('/login')
  })
})
</script>

<template>
  <router-view v-if="route.meta.public" />
  <div v-else class="md-layout">
    <aside class="md-sidebar">
      <div class="logo">📚 MarkDeck</div>
      <el-menu
        :default-active="route.path"
        background-color="#1f2430"
        text-color="#cfd3dc"
        active-text-color="#409eff"
        router
        style="border-right: none"
      >
        <el-menu-item index="/"><span>书签管理</span></el-menu-item>
        <el-menu-item index="/tags"><span>标签</span></el-menu-item>
        <el-menu-item index="/trash"><span>回收站</span></el-menu-item>
        <el-menu-item index="/tools"><span>工具中心</span></el-menu-item>
        <el-menu-item index="/import"><span>导入 / 导出</span></el-menu-item>
        <el-menu-item index="/settings"><span>设置</span></el-menu-item>
      </el-menu>
      <div style="flex: 1" />
      <el-button text style="color:#cfd3dc; margin: 12px" @click="auth.logout().then(() => router.push('/login'))">
        退出登录
      </el-button>
    </aside>
    <main class="md-main">
      <router-view />
    </main>
  </div>
</template>
