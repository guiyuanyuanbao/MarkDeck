import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('@/views/login/LoginView.vue'), meta: { public: true } },
    { path: '/', component: () => import('@/views/BookmarksView.vue') },
    { path: '/trash', component: () => import('@/views/TrashView.vue') },
    { path: '/tags', component: () => import('@/views/TagsView.vue') },
    { path: '/tools', component: () => import('@/views/ToolsView.vue') },
    { path: '/import', component: () => import('@/views/ImportView.vue') },
    { path: '/settings', component: () => import('@/views/SettingsView.vue') },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.public) return true
  if (!auth.loggedIn) {
    // one state probe per navigation when logged-out
    try { await auth.refreshState() } catch { /* server down */ }
    if (auth.loggedIn) return true
    return { path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
  }
  return true
})

export { router }
