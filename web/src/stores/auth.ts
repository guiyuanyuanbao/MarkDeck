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
let wsAttempt = 0

export function connectWS() {
  if (ws && ws.readyState <= 1) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  try {
    ws = new WebSocket(`${proto}://${location.host}/api/ws`)
  } catch {
    startPolling()
    return
  }
  ws.onopen = () => {
    wsAttempt = 0
    // WS is live again: the 6s polling fallback is now redundant double
    // channel (it used to run forever once started, doubling every request)
    stopPolling()
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.t === 'rev') window.dispatchEvent(new CustomEvent('md:revision', { detail: msg.rev }))
    } catch { /* ignore */ }
  }
  ws.onclose = () => {
    ws = null
    stopPolling()
    reconnectTimer = setTimeout(() => {
      // only the retry path may degrade to polling: one failed WS attempt
      // starts the 6s fallback; a later successful connect (onopen) stops it
      wsAttempt++
      if (wsAttempt >= 2) startPolling()
      connectWS()
    }, 5000)
  }
  ws.onerror = () => { try { ws?.close() } catch { /* already closing */ } }
}

export function disconnectWS() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  stopPolling()
  ws?.close()
  ws = null
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
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
