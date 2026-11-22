// MarkDeck extension service worker: sync engine.
//
// Architecture:
// - offline queue: local bookmark events land in chrome.storage.local
// - push: queue drained to /api/sync/device-push with LWW semantics
// - pull: /api/sync/device-pull?since=rev applies remote changes to the tree
// - realtime: /api/ws revision pings trigger pull; alarm polls as fallback
// - re-entrancy guard: applyingRemote blocks local listeners while we write

import { compressQueue, planRemoteActions, opsToPushPayload, backoffDelay, type NodeState, type QueuedOp } from './sync-core'

interface Config {
  server: string
  token: string
  deviceId: string
  rev: number
}

const QUEUE_KEY = 'md_queue'
const CONFIG_KEY = 'md_config'
const LOCAL_KEY = 'md_local_nodes'
const ALARM = 'md-poll'

let applyingRemote = false
let ws: WebSocket | null = null
let wsAttempt = 0
let flushing = false

// ---- storage helpers ----

async function getConfig(): Promise<Config | null> {
  const st = await chrome.storage.local.get(CONFIG_KEY)
  return (st[CONFIG_KEY] as Config) || null
}
async function saveConfigPatch(patch: Partial<Config>) {
  const cur = (await getConfig()) || { server: '', token: '', deviceId: '', rev: 0 }
  await chrome.storage.local.set({ [CONFIG_KEY]: { ...cur, ...patch } })
}
async function getQueue(): Promise<QueuedOp[]> {
  const st = await chrome.storage.local.get(QUEUE_KEY)
  return (st[QUEUE_KEY] as QueuedOp[]) || []
}
async function setQueue(q: QueuedOp[]) {
  await chrome.storage.local.set({ [QUEUE_KEY]: q })
}
async function enqueue(op: QueuedOp) {
  if (applyingRemote) return
  const q = await getQueue()
  q.push(op)
  await setQueue(q)
  scheduleFlush()
}

// ---- local node cache for LWW decisions ----

async function refreshLocalCache(): Promise<Map<string, NodeState>> {
  const tree = await chrome.bookmarks.getTree()
  const map = new Map<string, NodeState>()
  const deviceId = (await getConfig())?.deviceId || 'unknown'
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], parentId: string) => {
    for (const n of nodes) {
      map.set(n.id, {
        id: n.id,
        parentId,
        type: n.url ? 'url' : 'folder',
        title: n.title,
        url: n.url,
        position: (n.index ?? 0) + 1,
        revision: 0,
        updatedAt: Math.floor((n.dateAdded || Date.now()) / 1000),
        deviceId,
        createdAt: Math.floor((n.dateAdded || Date.now()) / 1000),
      })
      if (n.children) walk(n.children, n.id)
    }
  }
  walk(tree, '')
  // Only sync the "Bookmarks Bar" subtree: find its root id
  const barRoot = tree[0]?.children?.find((c) => c.id === '1')
  const scope = new Map<string, NodeState>()
  if (barRoot) scope.set(barRoot.id, map.get(barRoot.id)!)
  const walkScoped = (id: string) => {
    const n = map.get(id)
    if (!n) return
    chrome.bookmarks.getChildren(id).then((kids) => {
      for (const k of kids) {
        scope.set(k.id, map.get(k.id)!)
        if (!k.url) walkScoped(k.id)
      }
    })
  }
  if (barRoot) walkScoped(barRoot.id)
  await chrome.storage.local.set({ [LOCAL_KEY]: Object.fromEntries(scope) })
  return scope
}

async function localCache(): Promise<Map<string, NodeState>> {
  const st = await chrome.storage.local.get(LOCAL_KEY)
  const obj = (st[LOCAL_KEY] as Record<string, NodeState>) || {}
  return new Map(Object.entries(obj))
}

function bookmarksBarRoot(): string {
  return '1' // Chrome/Edge fixed root id for the bookmarks bar
}

// ---- server API ----

function apiBase(server: string) {
  return server.replace(/\/+$/, '')
}

async function apiFetch(cfg: Config, path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiBase(cfg.server) + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
      ...(init?.headers || {}),
    },
  })
}

async function pushQueue(cfg: Config): Promise<boolean> {
  let q = await getQueue()
  if (!q.length) return true
  q = compressQueue(q)
  const nodes = await localCache()
  const payload = opsToPushPayload(q, cfg.deviceId, nodes)
  try {
    const resp = await apiFetch(cfg, '/api/sync/device-push', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (resp.status === 401) {
      await setSyncStatus('unauthorized')
      return false
    }
    if (!resp.ok) throw new Error(`push HTTP ${resp.status}`)
    await setQueue([])
    return true
  } catch {
    // offline: queue keeps accumulating (bounded to avoid runaway storage)
    if (q.length > 5000) await setQueue(q.slice(-5000))
    return false
  }
}

async function pullRemote(cfg: Config): Promise<boolean> {
  try {
    const resp = await apiFetch(cfg, `/api/sync/device-pull?since=${cfg.rev}`)
    if (resp.status === 401) { await setSyncStatus('unauthorized'); return false }
    if (!resp.ok) throw new Error(`pull HTTP ${resp.status}`)
    const data = await resp.json() as { changes: NodeState[]; head: number }
    if (data.changes?.length) {
      await applyRemote(data.changes)
    }
    await saveConfigPatch({ rev: data.head })
    return true
  } catch {
    return false
  }
}

// Apply server changes to the browser tree under the re-entrancy guard.
async function applyRemote(changes: NodeState[]) {
  applyingRemote = true
  try {
    const local = await localCache()
    const actions = planRemoteActions(
      changes.map((c) => ({ ...c, deviceId: c.deviceId === deviceIdSafe() ? '__self__' : c.deviceId })),
      local,
    )
    for (const act of actions) {
      try {
        if (act.action === 'create') {
          const n = act.node
          if (n.type === 'url') {
            await chrome.bookmarks.create({ parentId: mapParent(n.parentId), title: n.title, url: n.url })
          } else {
            await chrome.bookmarks.create({ parentId: mapParent(n.parentId), title: n.title })
          }
        } else if (act.action === 'update') {
          await chrome.bookmarks.update(act.node.id, { title: act.node.title, url: act.node.url })
        } else if (act.action === 'remove') {
          await chrome.bookmarks.removeTree(act.id)
        } else if (act.action === 'move') {
          await chrome.bookmarks.move(act.id, { parentId: mapParent(act.parentId), index: act.index })
        }
      } catch {
        // individual action failures shouldn't abort the batch
      }
    }
    await refreshLocalCache()
  } finally {
    applyingRemote = false
  }
}

// Server stores '' as root; extension maps unknown parents to the bookmarks bar.
function mapParent(parentId: string): string {
  if (!parentId) return bookmarksBarRoot()
  return parentId
}

function deviceIdSafe(): string {
  return deviceIdCached || 'unknown'
}
let deviceIdCached = 'unknown'

// ---- connectivity ----

async function setSyncStatus(status: string) {
  await chrome.storage.local.set({ md_status: status })
  chrome.action.setBadgeText({ text: status === 'online' ? '' : '!' })
  chrome.action.setBadgeBackgroundColor({ color: status === 'online' ? '#2e7d32' : '#c62828' })
}

async function connectWS(cfg: Config) {
  if (ws && ws.readyState <= 1) return
  try {
    const url = apiBase(cfg.server).replace(/^http/, 'ws') + `/api/ws?token=${encodeURIComponent(cfg.token)}`
    ws = new WebSocket(url)
    ws.onopen = async () => {
      wsAttempt = 0
      await setSyncStatus('online')
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.t === 'rev') schedulePull()
      } catch { /* ignore */ }
    }
    ws.onclose = async () => {
      ws = null
      await setSyncStatus('disconnected')
      setTimeout(() => getConfig().then((c) => c && connectWS(c)), backoffDelay(wsAttempt++))
    }
    ws.onerror = () => { try { ws?.close() } catch { /* noop */ } }
  } catch {
    await setSyncStatus('disconnected')
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(async () => {
    flushTimer = null
    const cfg = await getConfig()
    if (!cfg?.token) return
    if (await pushQueue(cfg)) {
      // after push, pull to converge
      await pullRemote(cfg)
    }
  }, 1500) // debounce bursts
}

let pullTimer: ReturnType<typeof setTimeout> | null = null
function schedulePull() {
  if (pullTimer) return
  pullTimer = setTimeout(async () => {
    pullTimer = null
    const cfg = await getConfig()
    if (!cfg?.token) return
    await pullRemote(cfg)
  }, 300)
}

async function fullSync() {
  const cfg = await getConfig()
  if (!cfg?.token) return
  deviceIdCached = cfg.deviceId
  const ok = await pushQueue(cfg)
  if (ok) await pullRemote(cfg)
  connectWS(cfg)
}

// ---- event wiring ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 5 })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) fullSync() // WS-dead fallback
})

chrome.bookmarks.onCreated.addListener((id, bm) =>
  enqueue({ kind: 'created', id, parentId: bm.parentId || '', title: bm.title, url: bm.url, index: bm.index ?? 0, at: Math.floor(Date.now() / 1000) }))
chrome.bookmarks.onChanged.addListener((id, info) =>
  enqueue({ kind: 'changed', id, title: info.title, at: Math.floor(Date.now() / 1000) }))
chrome.bookmarks.onMoved.addListener((id, info) =>
  enqueue({ kind: 'moved', id, parentId: info.parentId, oldParentId: info.oldParentId, index: info.index ?? 0, at: Math.floor(Date.now() / 1000) }))
chrome.bookmarks.onRemoved.addListener((id, info) =>
  enqueue({ kind: 'removed', id, at: Math.floor(Date.now() / 1000) }))
chrome.bookmarks.onChildrenReordered.addListener((id, reorderInfo) =>
  enqueue({ kind: 'reordered', id: reorderInfo.childIds[0] || id, parentId: id, index: 0, at: Math.floor(Date.now() / 1000) }))

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'pair') {
      try {
        const server = String(msg.server || '')
        const resp = await fetch(apiBase(server) + '/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: msg.code, name: msg.name || 'browser-extension' }),
        })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || 'pair failed')
        await saveConfigPatch({ server, token: data.token, deviceId: data.deviceId, rev: 0 })
        deviceIdCached = data.deviceId
        // First sync after pairing: push whole local bar up (import), then pull
        await initialImport()
        await fullSync()
        await setSyncStatus('online')
        sendResponse({ ok: true })
      } catch (e: any) {
        sendResponse({ ok: false, error: e.message })
      }
    } else if (msg.type === 'status') {
      const st = await chrome.storage.local.get(['md_status', CONFIG_KEY, QUEUE_KEY]) as any
      sendResponse({
        status: st.md_status || 'unconfigured',
        server: st[CONFIG_KEY]?.server || '',
        queued: (st[QUEUE_KEY] || []).length,
      })
    } else if (msg.type === 'resync') {
      await fullSync()
      sendResponse({ ok: true })
    } else if (msg.type === 'saveCurrent') {
      const cfg = await getConfig()
      if (!cfg?.token) { sendResponse({ ok: false, error: 'not paired' }); return }
      try {
        const created = await chrome.bookmarks.create({
          parentId: bookmarksBarRoot(),
          title: msg.title,
          url: msg.url,
        })
        const tags = typeof msg.tags === 'string' && msg.tags.trim()
          ? msg.tags.split(/[,，]/).map((t: string) => t.trim()).filter(Boolean)
          : undefined
        await enqueue({ kind: 'created', id: created.id, parentId: created.parentId || '', title: msg.title, url: msg.url, index: created.index ?? 0, at: Math.floor(Date.now() / 1000), tags })
        sendResponse({ ok: true })
      } catch (e: any) {
        sendResponse({ ok: false, error: e.message })
      }
    }
  })()
  return true // async response
})

// First-pair import: push current bookmarks-bar content to the server
async function initialImport() {
  const cfg = await getConfig()
  if (!cfg) return
  applyingRemote = true
  try {
    const tree = await chrome.bookmarks.getTree()
    const bar = tree[0]?.children?.find((c) => c.id === bookmarksBarRoot())
    const ops: Record<string, unknown>[] = []
    const now = Math.floor(Date.now() / 1000)
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], parentId: string) => {
      for (const n of nodes) {
        ops.push({
          id: n.id, type: n.url ? 'url' : 'folder', parentId,
          title: n.title, url: n.url || '',
          position: (n.index ?? 0) + 1,
          updatedAt: Math.floor((n.dateAdded || Date.now() * 0) / 1000) || now,
          deviceId: cfg.deviceId,
        })
        if (n.children) walk(n.children, n.id)
      }
    }
    if (bar) walk(bar.children || [], bar.id)
    if (ops.length) {
      // chunk to stay under body limits
      for (let i = 0; i < ops.length; i += 500) {
        await apiFetch(cfg, '/api/sync/device-push', { method: 'POST', body: JSON.stringify(ops.slice(i, i + 500)) })
      }
    }
    await refreshLocalCache()
  } finally {
    applyingRemote = false
  }
}

// reconnect on startup
chrome.runtime.onStartup.addListener(() => fullSync())
fullSync()
