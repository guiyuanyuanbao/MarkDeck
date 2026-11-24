<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const nav = [
  { path: '/', label: '书签管理', ico: '🔖' },
  { path: '/tags', label: '标签', ico: '🏷️' },
  { path: '/trash', label: '回收站', ico: '🗑️' },
  { path: '/tools', label: '工具中心', ico: '🧰' },
  { path: '/import', label: '导入 / 导出', ico: '📦' },
  { path: '/settings', label: '设置', ico: '⚙️' },
]

function isActive(p: string) {
  if (p === '/') return route.path === '/'
  return route.path.startsWith(p)
}

onMounted(() => {
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
      <div class="md-logo">
        <div class="md-logo-mark"><img src="/logo.png" alt="MarkDeck" style="width:100%;height:100%;display:block;border-radius:inherit" /></div>
        <div class="md-logo-name">MarkDeck</div>
      </div>

      <nav class="md-nav">
        <button
          v-for="item in nav"
          :key="item.path"
          class="md-nav-item"
          :class="{ active: isActive(item.path) }"
          @click="router.push(item.path)"
        >
          <span class="md-nav-ico">{{ item.ico }}</span>
          {{ item.label }}
        </button>
      </nav>

      <div class="md-sidebar-foot">
        <div class="md-user-row">
          <div class="md-user-avatar">A</div>
          <div class="md-user-name">管理员</div>
          <button class="md-logout" @click="auth.logout().then(() => router.push('/login'))">退出</button>
        </div>
      </div>
    </aside>
    <main class="md-main">
      <router-view />
    </main>
  </div>
</template>
