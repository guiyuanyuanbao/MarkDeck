// Revision-ping refresh composable: the WS layer broadcasts md:revision on
// every server change; batch syncs fire many pings, so listeners coalesce
// to one refresh per 800ms window. Shared by views that previously each
// re-implemented the revTimer pattern.
import { onMounted, onBeforeUnmount } from 'vue'

export function useRevRefresh(refresh: () => void | Promise<void>) {
  let revTimer: ReturnType<typeof setTimeout> | null = null
  function onRevision() {
    if (revTimer) return
    revTimer = setTimeout(() => {
      revTimer = null
      void refresh()
    }, 800)
  }
  onMounted(() => window.addEventListener('md:revision', onRevision))
  onBeforeUnmount(() => window.removeEventListener('md:revision', onRevision))
}
