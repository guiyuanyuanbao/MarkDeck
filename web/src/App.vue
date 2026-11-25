<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Icon } from '@/components/icons'
import { THEMES, currentTheme, applyTheme, type ThemeId } from '@/theme'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// primary destinations live in the sidebar; everything else is one click
// away in the top bar — no more digging through settings tabs
const sideNav = [
  { path: '/', label: '书签', ico: 'bookmark' },
  { path: '/trash', label: '回收站', ico: 'trash' },
]
const topTools = [
  { path: '/tags', label: '标签', ico: 'tag' },
  { path: '/tools', label: '工具', ico: 'tools' },
  { path: '/import', label: '导入导出', ico: 'box' },
]

const themeOpen = ref(false)
const theme = ref<ThemeId>(currentTheme())
function pickTheme(t: ThemeId) {
  theme.value = t
  applyTheme(t)
  themeOpen.value = false
}

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
          v-for="item in sideNav"
          :key="item.path"
          class="md-nav-item"
          :class="{ active: isActive(item.path) }"
          @click="router.push(item.path)"
        >
          <span class="md-nav-ico"><Icon :name="item.ico" :size="17" /></span>
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
      <!-- top bar: page utilities one click away -->
      <div class="md-topbar">
        <div class="md-topbar-left">
          <button
            v-for="item in topTools"
            :key="item.path"
            class="md-toplink"
            :class="{ active: isActive(item.path) }"
            @click="router.push(item.path)"
          >
            <Icon :name="item.ico" :size="15" />
            {{ item.label }}
          </button>
        </div>
        <div class="md-topbar-right">
          <button class="md-topicon" :class="{ active: isActive('/settings#devices') }" title="配对设备" @click="router.push('/settings#devices')">
            <Icon name="laptop" :size="17" />
          </button>
          <button class="md-topicon" title="设置" @click="router.push('/settings')">
            <Icon name="settings" :size="17" />
          </button>
          <div class="theme-wrap">
            <button class="md-topicon" title="配色主题" @click="themeOpen = !themeOpen">
              <Icon name="palette" :size="17" />
            </button>
            <div v-if="themeOpen" class="theme-pop">
              <button
                v-for="t in THEMES"
                :key="t.id"
                class="theme-opt"
                :class="{ active: theme === t.id }"
                @click="pickTheme(t.id)"
              >
                <span class="theme-swatch" :style="{ background: t.swatch }" />
                {{ t.label }}
                <Icon v-if="theme === t.id" name="check" :size="14" style="margin-left:auto" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <router-view />
    </main>
  </div>
</template>
