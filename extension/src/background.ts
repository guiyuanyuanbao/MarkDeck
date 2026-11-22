// MarkDeck extension service worker: sync engine.
//
// Architecture:
// - offline queue: local bookmark events land in chrome.storage.local
// - push: queue drained to /api/sync/device-push with LWW semantics
// - pull: /api/sync/device-pull?since=rev applies remote changes to the tree
// - realtime: /api/ws revision pings trigger pull; alarm polls as fallback
// - re-entrancy guard: applyingRemote blocks local listeners while we write

import { compressQueue, planRemoteActions, opsToPushPayload, backoffDelay, detectDuplicateGroups, type NodeState, type QueuedOp } from './sync-core'

interface Config {
  server: string
  token: string
  deviceId: string
  rev: number
}

const QUEUE_KEY = 'md_queue'
const CONFIG_KEY = 'md_config'
const LOCAL_KEY = 'md_local_nodes'
const IDMAP_KEY = 'md_id_map' // { serverId: localId } — local ids differ per browser
const L2S_KEY = 'md_l2s' // { localId: serverId } — reverse direction for pushes
let idMapSyncCache: Record<string, string> = {}
function idMapSync(): Record<string, string> { return idMapSyncCache }
function setIdMapSync(m: Record<string, string>) { idMapSyncCache = m }
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
// Nodes created/updated/moved by applyRemote fire chrome.bookmarks events that
// would be re-enqueued and pushed back, resurrecting tombstones. applyRemote
// sets applyingRemote=true during its run, but its writes land BEFORE the
// finally-block resets the flag only within the same tick; bookmark events
// are async, so we also track recently-applied local ids explicitly.
// id -> snapshot of what the last remote sync wrote; a local event matching
// the snapshot is our own echo. Real browsers dispatch these events AFTER
// applyRemote finished, and an unblocked 'created' echo re-pushes the node
// under its local integer id, duplicating it on the server.
const recentlyApplied = new Map<string, { title?: string; parentId?: string }>()
// Events that arrive while applyRemote holds the guard are buffered, not
// dropped: a burst of user edits overlapping a sync window would otherwise
// lose ops permanently. On replay each op goes through the echo check again
// with the final snapshots, so remote-write echoes are still blocked.
const deferredOps: QueuedOp[] = []
// bookmark listeners call enqueue fire-and-forget; rapid bursts overlap the
// getQueue/setQueue round-trips and last-write-wins DROPS ops (10 rapid
// creates lost ~half in real chromium). Serialize the read-modify-write.
let enqueueChain: Promise<void> = Promise.resolve()
async function enqueue(op: QueuedOp) {
  if (applyingRemote) { deferredOps.push(op); return }
  const run = enqueueChain.catch(() => {}).then(async () => {
    const echo = recentlyApplied.get(op.id)
    if (echo) {
      const isEcho =
        op.kind === 'removed' ||
        ((op.kind === 'created' || op.kind === 'changed') && op.title === echo.title) ||
        ((op.kind === 'moved' || op.kind === 'reordered') && op.parentId === echo.parentId)
      recentlyApplied.delete(op.id) // one-shot: a later real edit must push
      if (isEcho) return
    }
    const q = await getQueue()
    q.push(op)
    await setQueue(q)
    scheduleFlush()
  })
  enqueueChain = run
  await run
}

// ---- local node cache for LWW decisions ----

// overrides: localId -> {deviceId, updatedAt} of the last remote change that
// wrote the node. chrome.bookmarks has no author info, so without this merge
// every refresh would stamp nodes with OUR id and a frozen dateAdded — then
// a same-second remote edit ties on updatedAt, the deviceId comparison
// (local ours > theirs) wrongly declares "local newer" and the edit is
// silently ignored (device->device updates could never propagate).
async function refreshLocalCache(overrides?: Map<string, { deviceId: string; updatedAt: number }>): Promise<Map<string, NodeState>> {
  const prev = await localCache()
  const tree = await chrome.bookmarks.getTree()
  const map = new Map<string, NodeState>()
  const deviceId = (await getConfig())?.deviceId || 'unknown'
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], parentId: string) => {
    for (const n of nodes) {
      const ov = overrides?.get(n.id)
      map.set(n.id, {
        id: n.id,
        parentId,
        type: n.url ? 'url' : 'folder',
        title: n.title,
        url: n.url,
        position: (n.index ?? 0) + 1,
        revision: 0,
        updatedAt: ov?.updatedAt || Math.floor((n.dateAdded || Date.now()) / 1000),
        deviceId: ov?.deviceId || prev.get(n.id)?.deviceId || deviceId,
        createdAt: Math.floor((n.dateAdded || Date.now()) / 1000),
      })
      if (n.children) walk(n.children, n.id)
    }
  }
  walk(tree, '')
  // Sync scope: the Bookmarks Bar plus Other Bookmarks (roots '1' and '2'),
  // so bookmarks saved outside the bar also participate in sync.
  const roots = tree[0]?.children ?? []
  const barRoot = roots.find((c) => c.id === '1')
  const otherRoot = roots.find((c) => c.id === '2')
  const scope = new Map<string, NodeState>()
  // async walk that fully awaits getChildren before persisting — a .then
  // fire-and-forget here raced the storage.set below and left the cache
  // incomplete (tombstone deletes then silently missed their local nodes).
  const walkScoped = async (id: string): Promise<void> => {
    const n = map.get(id)
    if (!n) return
    scope.set(id, n)
    const kids = await chrome.bookmarks.getChildren(id)
    for (const k of kids) {
      await walkScoped(k.id)
    }
  }
  if (barRoot) await walkScoped(barRoot.id)
  if (otherRoot) await walkScoped(otherRoot.id)
  await chrome.storage.local.set({ [LOCAL_KEY]: Object.fromEntries(scope) })
  return scope
}

async function localCache(): Promise<Map<string, NodeState>> {
  const st = await chrome.storage.local.get(LOCAL_KEY)
  const obj = (st[LOCAL_KEY] as Record<string, NodeState>) || {}
  return new Map(Object.entries(obj))
}

// ---- server<->local id mapping ----
// The server knows nodes by the creator device's local id. Other devices
// create their own local ids when applying remote creates, so every device
// keeps a serverId->localId map to translate push/pull payloads.
// md_id_map holds serverId->localId; md_l2s holds localId->serverId. Small
// integer local ids collide ACROSS devices and runs, so nodes created after
// pairing get a minted UUID as their server id — pushing raw local ids made
// two devices overwrite each other's rows (server merges different nodes
// into one id, then devices ping-pong create/delete fighting over it).
async function idMap(): Promise<Record<string, string>> {
  const st = await chrome.storage.local.get(IDMAP_KEY)
  return (st[IDMAP_KEY] as Record<string, string>) || {}
}
async function l2sMap(): Promise<Record<string, string>> {
  const st = await chrome.storage.local.get(L2S_KEY)
  return (st[L2S_KEY] as Record<string, string>) || {}
}
async function setIdMap(map: Record<string, string>) {
  idMapSyncCache = map // keep the sync mirror coherent with storage
  await chrome.storage.local.set({ [IDMAP_KEY]: map })
}
async function mapToServerId(localId: string): Promise<string> {
  const l2s = await l2sMap()
  if (localId in l2s) return l2s[localId]
  const map = await idMap()
  // `in` check (not ||) — the bar root maps to '' and must not fall through
  return localId in map ? map[localId] : localId // creator devices use local id == server id
}
// mintedServerId = mapToServerId that always yields a globally-unique id
async function mintedServerId(localId: string): Promise<string> {
  const l2s = await l2sMap()
  if (localId in l2s) return l2s[localId]
  const map = await idMap()
  if (localId in map) return map[localId] // initialImport already assigned one
  return mintServerId(localId)
}
async function mapToLocalId(serverId: string): Promise<string | null> {
  const map = await idMap()
  return serverId in map ? map[serverId] : serverId // creator devices keep local id == server id
}
async function recordIdMapping(serverId: string, localId: string) {
  const map = await idMap()
  map[serverId] = localId
  await setIdMap(map)
  // keep the push-direction mirror in step: later local edits of this node
  // must translate back to the same server row, or they land on a raw
  // local-integer id row that no other device knows about
  const l2s = await l2sMap()
  if (!(localId in l2s)) {
    l2s[localId] = serverId
    await chrome.storage.local.set({ [L2S_KEY]: l2s })
  }
}
// mint a globally-unique server id for a locally-created node and remember
// both directions; minting must happen exactly once per local id
async function mintServerId(localId: string): Promise<string> {
  const l2s = await l2sMap()
  if (localId in l2s) return l2s[localId]
  const uuid = crypto.randomUUID()
  l2s[localId] = uuid
  await chrome.storage.local.set({ [L2S_KEY]: l2s })
  await recordIdMapping(uuid, localId)
  return uuid
}
async function hydrateIdMapSync() {
  // applyRemote plans actions synchronously, so it reads the in-memory copy;
  // without hydrating it from storage every remote edit/tombstone from another
  // device "looks absent" (deletes skipped, updates duplicated as creates)
  setIdMapSync(await idMap())
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
    signal: AbortSignal.timeout(15000), // never let a hung connection block sync
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
  // claim the queue BEFORE the network round-trip: ops enqueued while the
  // push is in flight must survive the post-push cleanup (the old
  // read→push→setQueue([]) wiped them, losing edits permanently)
  await setQueue([])
  try {
    q = compressQueue(q)
    // translate local ids to server ids (nodes created by remote devices).
    // A created op for an unmapped local id mints a UUID server id first —
    // pushing raw small-integer local ids let two devices push DIFFERENT
    // nodes under the same server id and LWW-merge them into one row
    for (const op of q) {
      if (op.kind === 'created') op.id = await mintedServerId(op.id)
      else op.id = await mapToServerId(op.id)
      if (op.parentId) op.parentId = await mapToServerId(op.parentId)
    }
    const nodes = await localCache()
    const payload = opsToPushPayload(q, cfg.deviceId, nodes)
    const resp = await apiFetch(cfg, '/api/sync/device-push', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (resp.status === 401) {
      await restoreQueue(q)
      await setSyncStatus('unauthorized')
      return false
    }
    if (!resp.ok) throw new Error(`push HTTP ${resp.status}`)
    await refreshLocalCache() // local creates bypass applyRemote; keep cache fresh
    return true
  } catch {
    // offline: put the claimed ops back (merged with any new arrivals);
    // bounded to avoid runaway storage
    await restoreQueue(q)
    return false
  }
}

// merge claimed-but-unpushed ops back to the head of the current queue
async function restoreQueue(claimed: QueuedOp[]) {
  const fresh = await getQueue()
  const back = [...claimed, ...fresh]
  if (back.length > 5000) await setQueue(back.slice(-5000))
  else await setQueue(back)
}

// pulls serialize: fullSync, the debounced flush and WS schedulePull can all
// trigger one; overlapping runs fetched the same revision window and applied
// it twice (duplicate creates). Chaining keeps fetch+apply atomic per pull.
let pullChain: Promise<boolean> = Promise.resolve(false)
function pullRemote(cfg: Config): Promise<boolean> {
  const run = pullChain.catch(() => false).then(async () => {
    try {
      const cur = await getConfig()
      // WS-triggered pulls bypass fullSync, so the echo-detection id must be
      // (re)established here too — a fresh SW would otherwise see 'unknown'
      if (cur?.deviceId) deviceIdCached = cur.deviceId
      const rev = cur?.rev ?? cfg.rev
      const resp = await apiFetch(cfg, `/api/sync/device-pull?since=${rev}`)
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
  })
  pullChain = run
  return run
}

// Apply server changes to the browser tree under the re-entrancy guard.
async function applyRemote(changes: NodeState[]) {
  applyingRemote = true
  try {
    const local = await localCache()
    const actions = planRemoteActions(
      changes.map((c) => ({ ...c, deviceId: c.deviceId === deviceIdSafe() ? '__self__' : c.deviceId })),
      local,
      (serverId) => {
        // mapToLocalId from md_id_map, falling back to the raw server id
        // (the creating device uses its local chrome id as the server id)
        return idMapSync()[serverId] ?? serverId
      },
    )
    for (const act of actions) {
      try {
        if (act.action === 'create') {
          const n = act.node
          // pre-mark BEFORE the chrome call: the bookmark event fires
          // asynchronously and must find the guard already in place
          recentlyApplied.set('__pre__' + n.id, { title: n.title })
          // parent may itself need translating (folder created by remote)
          // unknown remote parent (e.g. another device's 'Other Bookmarks'
          // holder) falls back to the bookmarks bar so the node is reachable
          let parentLocal = await mapToLocalId(n.parentId)
          if (parentLocal) {
            try { await chrome.bookmarks.get(parentLocal) } catch { parentLocal = null }
          }
          const created = n.type === 'url'
            ? await chrome.bookmarks.create({ parentId: parentLocal || bookmarksBarRoot(), title: n.title, url: n.url })
            : await chrome.bookmarks.create({ parentId: parentLocal || bookmarksBarRoot(), title: n.title })
          // remember which server id this new local node corresponds to
          await recordIdMapping(n.id, created.id)
          recentlyApplied.delete('__pre__' + n.id)
          recentlyApplied.set(created.id, { title: n.title, parentId: created.parentId })
        } else if (act.action === 'update') {
          const localId = await mapToLocalId(act.node.id)
          if (localId) {
            recentlyApplied.set(localId, { title: act.node.title }) // pre-mark
            await chrome.bookmarks.update(localId, { title: act.node.title, url: act.node.url })
          }
        } else if (act.action === 'remove') {
          const localId = await mapToLocalId(act.id)
          if (localId) {
            recentlyApplied.delete(localId) // removal events must NOT be blocked
            await chrome.bookmarks.removeTree(localId)
          }
        } else if (act.action === 'move') {
          const localId = await mapToLocalId(act.id)
          const parentLocal = await mapToLocalId(act.parentId)
          if (localId) {
            const target = parentLocal || mapParent(act.parentId)
            await chrome.bookmarks.move(localId, { parentId: target, index: act.index })
            const movedTitle = 'node' in act ? (act.node as { title?: string } | undefined)?.title ?? '' : ''
            recentlyApplied.set(localId, { title: movedTitle, parentId: target })
          }
        }
      } catch {
        // individual action failures shouldn't abort the batch
      }
    }
    // carry the authoring device + timestamp of each applied change into the
    // local cache so future LWW ties resolve against the real author, not us
    const overrides = new Map<string, { deviceId: string; updatedAt: number }>()
    for (const c of changes) {
      if (c.deletedAt && c.deletedAt > 0) continue
      const localId = (await mapToLocalId(c.id)) || c.id
      overrides.set(localId, { deviceId: c.deviceId, updatedAt: c.updatedAt })
    }
    await refreshLocalCache(overrides)
  } finally {
    applyingRemote = false
    // replay edits buffered during the apply window (echoes get filtered)
    const pending = deferredOps.splice(0)
    for (const op of pending) enqueue(op).catch(() => {})
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

let statusCache: string | null = null
async function setSyncStatus(status: string) {
  if (statusCache === null) {
    // seed from storage: a fresh SW must not downgrade a persisted state
    statusCache = ((await chrome.storage.local.get('md_status')).md_status as string) || ''
  }
  // 'unauthorized' (revoked token) must stay visible: the WS reconnect loop
  // keeps failing and its onclose would otherwise mask the real problem as a
  // mere network blip. Only a successful auth (401 cleared / online) lifts it.
  if (status === 'disconnected' && statusCache === 'unauthorized') return
  statusCache = status
  await chrome.storage.local.set({ md_status: status })
  // distinct toolbar badges so the user can tell WHAT is wrong at a glance
  const badges: Record<string, { text: string; color: string }> = {
    online: { text: '', color: '#2e7d32' },
    disconnected: { text: '!', color: '#f5a623' },   // offline: amber
    unauthorized: { text: '×', color: '#e5484d' },   // token dead: red
    unconfigured: { text: '·', color: '#9ca1b6' },   // not paired: grey
  }
  const badge = badges[status] || badges.disconnected
  chrome.action.setBadgeText({ text: badge.text })
  chrome.action.setBadgeBackgroundColor({ color: badge.color })
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
  await hydrateIdMapSync()
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
    } else if (msg.type === 'conflictStatus') {
      ;(async () => {
        const tree = await chrome.bookmarks.getTree()
        const flat: { id: string; title: string; url?: string }[] = []
        const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
          for (const n of nodes) { flat.push({ id: n.id, title: n.title, url: n.url }); if (n.children) walk(n.children) }
        }
        walk(tree)
        const groups = detectDuplicateGroups(flat)
        sendResponse({ groups, hasConflict: groups.length > 0 })
      })()
    } else if (msg.type === 'openSyncSettings') {
      // open the browser's own sync settings (Chrome vs Edge)
      const isEdge = /Edg\//.test(navigator.userAgent)
      const url = isEdge ? 'edge://settings/profiles/sync' : 'chrome://settings/syncSetup'
      chrome.tabs.create({ url })
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
    // pre-pair local edits are about to be pushed with fresh UUIDs below;
    // clear the queue first so scheduleFlush can't push stale local-id ops
    // in parallel (that would duplicate every bookmark)
    await setQueue([])
    const tree = await chrome.bookmarks.getTree()
    const roots = tree[0]?.children ?? []
    const bar = roots.find((c) => c.id === bookmarksBarRoot())
    // 'Other Bookmarks' gets a server-side top-level folder so its content
    // is visible everywhere, while the local root stays untouched.
    const others = roots.find((c) => c.id === '2')
    const ops: Record<string, unknown>[] = []
    const now = Math.floor(Date.now() / 1000)
    // Local chrome ids collide across devices (every browser numbers its
    // bookmarks from small integers), so each node gets a fresh server UUID
    // and a local→server mapping. Without this, device B's initial import
    // overwrites device A's bookmarks that happen to share the same ids.
    const localToServer: Record<string, string> = {}
    // local chrome roots have no server rows: bar root '1' maps to server
    // top-level ('') and '2' maps to the per-device 其他书签 holder once pushed
    localToServer['1'] = ''
    const serverIdOf = (localId: string): string => {
      if (localToServer[localId]) return localToServer[localId]
      const uuid = localId === 'others-root'
        ? 'others-' + cfg.deviceId // stable holder id per device
        : crypto.randomUUID()
      localToServer[localId] = uuid
      return uuid
    }
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], parentServerId: string) => {
      for (const n of nodes) {
        if (isAlreadySynced(n.id)) continue // already on the server
        const sid = serverIdOf(n.id)
        ops.push({
          id: sid, type: n.url ? 'url' : 'folder', parentId: parentServerId,
          title: n.title, url: n.url || '',
          position: (n.index ?? 0) + 1,
          updatedAt: Math.floor((n.dateAdded || Date.now() * 0) / 1000) || now,
          deviceId: cfg.deviceId,
        })
        if (n.children) walk(n.children, sid)
      }
    }
    // nodes already mapped (pulled from the server via another device's
    // sync) must not be re-pushed, or every device would duplicate them
    const alreadyOnServer = await idMap()
    const isAlreadySynced = (localId: string): boolean => localId in alreadyOnServer
    if (bar) walk(bar.children || [], '')
    if (others && others.children?.length) {
      const othersFolderId = serverIdOf('others-root')
      localToServer['2'] = othersFolderId
      ops.push({
        id: othersFolderId, type: 'folder', parentId: '',
        title: '其他书签', url: '', position: 9999,
        updatedAt: now, deviceId: cfg.deviceId,
      })
      walk(others.children, othersFolderId)
    }
    if (ops.length) {
      // chunk to stay under body limits
      for (let i = 0; i < ops.length; i += 500) {
        await apiFetch(cfg, '/api/sync/device-push', { method: 'POST', body: JSON.stringify(ops.slice(i, i + 500)) })
      }
    }
    // persist local→server mapping so future local edits push to the right
    // server nodes instead of colliding with other devices' ids.
    // NOTE: this must be the localToServer table — spreading the idMap
    // function object here silently dropped every new mapping and made
    // later edits of imported bookmarks duplicate on the server.
    // The holder also needs the reverse entry so remote children of the
    // 其他书签 folder land in the browser's root '2', not the bookmarks bar.
    const existing = await idMap()
    const merged = { ...existing, ...localToServer }
    const othersHolderId = localToServer['others-root']
    if (othersHolderId) merged[othersHolderId] = '2'
    await setIdMap(merged)
    await refreshLocalCache()
  } finally {
    applyingRemote = false
    const pending = deferredOps.splice(0)
    for (const op of pending) enqueue(op).catch(() => {})
  }
}

// reconnect on startup
chrome.runtime.onStartup.addListener(() => fullSync())
fullSync()

// test/debug hook: lets Playwright E2E drive a full sync directly from the SW
;(globalThis as unknown as Record<string, unknown>).__markdeckResync = fullSync
