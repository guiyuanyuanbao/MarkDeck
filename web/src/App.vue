<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { Icon } from '@/components/icons'
import { THEMES, currentTheme, applyTheme, type ThemeId } from '@/theme'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// single-header IA: logo + primary nav + utilities + account, all in one bar
const nav = [
  { path: '/', label: '书签', ico: 'bookmark' },
  { path: '/trash', label: '回收站', ico: 'trash' },
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
// the settings gear highlights whenever we're on /settings; the devices icon
// deep-links to /settings#devices and only lights up for that hash (a bare
// /settings means the account tab — that's the gear's active state)
const settingsActive = computed(() => route.path === '/settings' && route.hash !== '#devices')
const devicesActive = computed(() => route.path === '/settings' && route.hash === '#devices')

onMounted(() => {
  window.addEventListener('md:unauthorized', () => {
    auth.loggedIn = false
    router.push('/login')
  })
})
</script>

<template>
  <router-view v-if="route.meta.public" />
  <div v-else class="md-page">
    <header class="md-header">
      <div class="md-header-brand" @click="router.push('/')" role="link">
        <div class="md-logo-mark"><img src="/logo.png" alt="MarkDeck" style="width:100%;height:100%;display:block;border-radius:inherit" /></div>
        <span class="md-brand-name">MarkDeck</span>
      </div>

      <nav class="md-header-nav">
        <button
          v-for="item in nav"
          :key="item.path"
          class="md-hnav-item"
          :class="{ active: isActive(item.path) }"
          @click="router.push(item.path)"
        >
          <Icon :name="item.ico" :size="15" />
          {{ item.label }}
        </button>
      </nav>

      <div class="md-header-right">
        <button class="md-topicon" :class="{ active: devicesActive }" title="配对设备" @click="router.push('/settings#devices')">
          <Icon name="laptop" :size="17" />
        </button>
        <button class="md-topicon" :class="{ active: settingsActive }" title="设置" @click="router.push('/settings')">
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
        <span class="md-header-sep" />
        <div class="md-user-chip" title="账户与安全">
          <button class="md-user-avatar" aria-label="账户设置" @click="router.push('/settings')">A</button>
          <button class="md-logout" @click="auth.logout().then(() => router.push('/login'))">退出</button>
        </div>
      </div>
    </header>
    <main class="md-main">
      <router-view />
    </main>
  </div>
</template>
