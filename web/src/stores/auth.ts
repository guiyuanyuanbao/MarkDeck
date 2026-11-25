import { defineStore } from 'pinia'
import { authApi, setCsrf, api } from '@/api/client'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    loggedIn: false,
    needsSetup: false,
    totpEnabled: false,
  }),
  actions: {
    async refreshState() {
      const s = await authApi.state()
      this.needsSetup = s.setup
      this.totpEnabled = s.totp
      // me() only succeeds when a session cookie is live
      try {
        const me = await authApi.me()
        this.loggedIn = true
        // restore CSRF token after a page reload (module-level variable is lost)
        if (me.csrf) setCsrf(me.csrf)
        // reconnect realtime feed (module-level WebSocket is also lost on reload)
        connectWS()
      } catch {
        this.loggedIn = false
      }
    },
    async setup(password: string) {
      const r = await authApi.setup(password)
      setCsrf(r.csrf)
      this.loggedIn = true
      this.needsSetup = false
      connectWS()
    },
    async login(password: string, totp = '') {
      const r = await authApi.login(password, totp)
      setCsrf(r.csrf)
      this.loggedIn = true
      connectWS()
    },
    async logout() {
      try { await authApi.logout() } catch { /* best effort */ }
      setCsrf('')
      this.loggedIn = false
      disconnectWS()
    },
  },
})

// ---- realtime revision feed (multi-tab consistency) ----
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

export function connectWS() {
  if (ws && ws.readyState <= 1) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  try {
    ws = new WebSocket(`${proto}://${location.host}/api/ws`)
  } catch {
    startPolling()
    return
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.t === 'rev') window.dispatchEvent(new CustomEvent('md:revision', { detail: msg.rev }))
    } catch { /* ignore */ }
  }
  ws.onclose = () => {
    ws = null
    reconnectTimer = setTimeout(connectWS, 5000) // retry, falls back to polling on repeat failure
  }
  ws.onerror = () => startPolling()
}

export function disconnectWS() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (pollTimer) clearInterval(pollTimer)
  ws?.close()
  ws = null
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    if (!useAuthStore().loggedIn) return
    try {
      const st = await api.get<{ head: number }>('/api/sync/status')
      window.dispatchEvent(new CustomEvent('md:revision', { detail: st.head }))
    } catch { /* server unreachable; keep trying */ }
  }, 6000)
}
