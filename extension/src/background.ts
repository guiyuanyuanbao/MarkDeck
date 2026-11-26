// MarkDeck extension service worker: snapshot-reconciliation sync engine.
//
// Architecture (0.1.0 rewrite):
// - The server is the single source of truth; identity is the server UUID.
//   There are NO client-side id-mapping tables (md_id_map/md_l2s are gone —
//   nine patch releases fought their drift; the snapshot engine cannot drift).
// - Reconcile: three-way diff (base snapshot / server tree / local tree)
//   planned by the pure engine in reconcile.ts, applied to chrome.bookmarks
//   and pushed to POST /api/sync/apply in one round-trip each way.
// - Persistence: md_base (last synced snapshot + bindings) and md_touch
//   (journaled local edit timestamps). A failed reconcile never advances
//   base, so the next run re-plans identical ops — offline edits replay
//   without a queue, an echo guard, or per-op recovery ladders.
// - Realtime: /api/ws revision pings trigger a reconcile; the 1-min alarm
//   is the convergence guarantee when the MV3 service worker dies.

import {
  planSync, normBookmarkUrl, backoffDelay, detectDuplicateGroups,
  type ServerNode, type LocalNode, type Base, type TouchJournal, type SyncPlan,
} from './reconcile'

interface Config {
  server: string
  token: string
  deviceId: string
  rev: number
}

const CONFIG_KEY = 'md_config'
const BASE_KEY = 'md_base'
const TOUCH_KEY = 'md_touch'
const ALARM = 'md-poll'
// pre-0.1.0 keys — removed once on upgrade
const LEGACY_KEYS = ['md_queue', 'md_local_nodes', 'md_id_map', 'md_l2s']

let reconciling = false
let ws: WebSocket | null = null
let wsAttempt = 0
let deviceIdCached = 'unknown'

// per-reconcile audit counters (the lesson from nine releases: when a sync
// layer swallows per-row errors, statuses stay green while apply fails —
// expose every outcome)
const reconcileStats = {
  planned: 0, pushed: 0, chromeCreates: 0, chromeUpdates: 0,
  chromeMoves: 0, chromeRemoves: 0, adopted: 0, failed: 0,
  errors: [] as string[], lastRunAt: 0,
}

// ---- storage helpers ----

async function getConfig(): Promise<Config | null> {
  const st = await chrome.storage.local.get(CONFIG_KEY)
  return (st[CONFIG_KEY] as Config) || null
}
async function saveConfigPatch(patch: Partial<Config>) {
  const cur = (await getConfig()) || { server: '', token: '', deviceId: '', rev: 0 }
  await chrome.storage.local.set({ [CONFIG_KEY]: { ...cur, ...patch } })
}
async function getBase(): Promise<Base | null> {
  const st = await chrome.storage.local.get(BASE_KEY)
  return (st[BASE_KEY] as Base) || null
}
async function setBase(b: Base) {
  await chrome.storage.local.set({ [BASE_KEY]: b })
}
async function getTouch(): Promise<TouchJournal> {
  const st = await chrome.storage.local.get(TOUCH_KEY)
  return (st[TOUCH_KEY] as TouchJournal) || {}
}
async function setTouch(t: TouchJournal) {
  await chrome.storage.local.set({ [TOUCH_KEY]: t })
}

// ---- chrome adapter: tree → engine shapes ----

interface ResolvedRoots { barId: string; otherId: string }

// Chromium invariant (Chrome AND Edge): root children[0] = bookmarks bar,
// children[1] = other bookmarks (children[2] is Mobile bookmarks when
// present — taking the last child once grabbed Mobile on Edge and silently
// excluded 94 bookmarks). Titles are localized; never match on them.
// Root ids are NOT fixed '1'/'2' — newer profiles assign GUID permanent ids.
let cachedRoots: ResolvedRoots | null = null
async function resolveRoots(): Promise<ResolvedRoots> {
  if (cachedRoots) return cachedRoots
  const tree = await chrome.bookmarks.getTree()
  const kids = tree[0]?.children ?? []
  if (kids.length < 2) throw new Error('bookmark tree has no bar/other roots')
  cachedRoots = { barId: kids[0].id, otherId: kids[1].id }
  return cachedRoots
}
async function barRootId(): Promise<string> {
  return (await resolveRoots()).barId
}

// toLocalTree: walk the scoped subtrees into the engine's flat LocalNode
// list. Root buckets: bar carries parentId '', other carries isOtherRoot.
// Mobile bookmarks are NOT walked (out of sync scope by design).
async function toLocalTree(): Promise<LocalNode[]> {
  const roots = await resolveRoots()
  const tree = await chrome.bookmarks.getTree()
  const out: LocalNode[] = []
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], parentId: string) => {
    for (const n of nodes) {
      out.push({
        id: n.id,
        parentId,
        type: n.url ? 'url' : 'folder',
        title: n.title,
        url: n.url,
        index: n.index ?? 0,
        dateAdded: n.dateAdded,
      })
      if (n.children) walk(n.children, n.id)
    }
  }
  const rootNode = tree[0]
  if (!rootNode?.children) return out
  for (const kid of rootNode.children) {
    if (kid.id === roots.barId) {
      out.push({ id: kid.id, parentId: '', type: 'folder', title: kid.title, index: 0 })
      if (kid.children) walk(kid.children, kid.id)
    } else if (kid.id === roots.otherId) {
      out.push({ id: kid.id, parentId: '', type: 'folder', title: kid.title, index: kid.index ?? 1, isOtherRoot: true } as LocalNode & { isOtherRoot: true })
      if (kid.children) walk(kid.children, kid.id)
    }
    // else: Mobile bookmarks — excluded from sync scope
  }
  return out
}

// toServerNodes: server response rows → engine shape (already JSON-shaped;
// only normalize the optional fields the engine reads)
function toServerNodes(rows: any[]): ServerNode[] {
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parentId || '',
    type: r.type === 'url' ? 'url' : 'folder',
    title: r.title || '',
    url: r.url || undefined,
    position: r.position ?? 1,
    revision: r.revision ?? 0,
    updatedAt: r.updatedAt ?? 0,
    deviceId: r.deviceId,
  }))
}

// ---- chrome op execution ----

// resolve a server parent id to a local chrome id: bindings from the plan,
// STRUCTURAL roots for '' and the canonical others id, and — critically —
// bindings created EARLIER IN THIS BATCH (createdBindings): a folder this
// reconcile just created is its children's parent, and its chrome id exists
// only from the moment its create op executed. Topo order guarantees the
// parent create precedes the child create, so the lookup succeeds.
function makeParentResolver(plan: SyncPlan, roots: ResolvedRoots, othersId: string, createdBindings: Map<string, string>): (sid: string) => string | null {
  const planned = new Map<string, string | null>()
  for (const [sid, e] of Object.entries(plan.newBaseEntries)) planned.set(sid, e.localId)
  return (sid: string): string | null => {
    if (sid === '') return roots.barId
    if (sid === othersId) return roots.otherId
    const created = createdBindings.get(sid)
    if (created) return created
    const plannedLid = planned.get(sid)
    if (plannedLid) return plannedLid
    return null // unknown parent → caller decides the fallback
  }
}

async function applyChromeOps(ops: SyncPlan['chromeOps'], resolveParent: (sid: string) => string | null, stats: typeof reconcileStats, createdBindings: Map<string, string>) {
  for (const op of ops) {
    try {
      switch (op.kind) {
        case 'create': {
          const parentLid = resolveParent(op.parentServerId)
          if (!parentLid) throw new Error(`parent ${op.parentServerId} unresolvable`)
          // chrome.bookmarks.create rejects out-of-range indexes ("Index out
          // of bounds"), and chrome.bookmarks.get() can return STALE children
          // right after a write (observed in real chromium: a get() after
          // create missed the new node, clamping to a wrong index and
          // scrambling order every reconcile). Append at the tail instead —
          // same-parent order converges through rank-based move ops.
          const created = await chrome.bookmarks.create({
            parentId: parentLid,
            title: op.title,
            ...(op.url ? { url: op.url } : {}),
          })
          // the new node's chrome id is only known NOW: record it so base
          // advances with a real binding (a null binding here would make
          // the next reconcile re-create the row — endless duplicates)
          createdBindings.set(op.serverId, created.id)
          stats.chromeCreates++
          break
        }
        case 'update': {
          await chrome.bookmarks.update(op.localId, { title: op.title })
          stats.chromeUpdates++
          break
        }
        case 'move': {
          const parentLid = resolveParent(op.parentServerId)
          if (!parentLid) throw new Error(`move parent ${op.parentServerId} unresolvable`)
          // out-of-range indexes throw: clamp by the LIVE tree (never get(),
          // which is stale right after writes). Moving within the same
          // parent: removal shifts later siblings left, so the max valid
          // final index is len-1.
          const tree = await chrome.bookmarks.getTree()
          let liveLen = 0
          const find = (ns: chrome.bookmarks.BookmarkTreeNode[]): boolean => {
            for (const n of ns) {
              if (n.id === parentLid) { liveLen = n.children?.length ?? 0; return true }
              if (n.children && find(n.children)) return true
            }
            return false
          }
          find(tree)
          const maxIdx = Math.max(0, liveLen - 1)
          await chrome.bookmarks.move(op.localId, { parentId: parentLid, index: Math.min(op.index, maxIdx) })
          stats.chromeMoves++
          break
        }
        case 'remove': {
          await chrome.bookmarks.removeTree(op.localId)
          stats.chromeRemoves++
          break
        }
        case 'bind':
          // pure binding change — the adapter records it via newBase; nothing
          // to execute in the browser
          break
      }
    } catch (e: any) {
      stats.failed++
      if (stats.errors.length < 5) stats.errors.push(`${op.kind}: ${e?.message || e}`)
    }
  }
}

// ---- the reconcile driver ----

// Single-flight: concurrent reconciles would interleave chrome writes and
// double-apply. The applyingRemote-style guard also lets the touch listeners
// ignore our own writes instead of journaling them.
let pullChain: Promise<void> = Promise.resolve()

async function reconcileOnce(reason: string): Promise<{ ok: boolean; error?: string }> {
  if (reconciling) return { ok: true } // already running; this trigger is subsumed
  reconciling = true
  const stats = reconcileStats
  stats.planned = 0; stats.pushed = 0; stats.chromeCreates = 0; stats.chromeUpdates = 0
  stats.chromeMoves = 0; stats.chromeRemoves = 0; stats.adopted = 0; stats.failed = 0
  stats.errors = []
  try {
    const cfg = await getConfig()
    if (!cfg?.token) return { ok: false, error: 'not paired' }
    deviceIdCached = cfg.deviceId

    // 1. fetch the full server state
    const resp = await apiFetch(cfg, '/api/sync/tree')
    if (resp.status === 401) { await setSyncStatus('unauthorized'); return { ok: false, error: 'unauthorized' } }
    if (!resp.ok) throw new Error(`tree fetch failed: ${resp.status}`)
    const data = await resp.json()
    const serverNodes = toServerNodes(data.nodes || [])
    const othersId: string = data.othersId

    // 2. read the browser's scoped tree
    const localNodes = await toLocalTree()
    const roots = await resolveRoots()
    const base = await getBase()
    const touch = await getTouch()

    // 3. plan the three-way diff
    const plan = planSync({
      server: serverNodes,
      local: localNodes,
      base,
      touch,
      deviceId: cfg.deviceId,
      now: Math.floor(Date.now() / 1000),
      othersId,
    })
    stats.planned = plan.chromeOps.length + plan.serverOps.length
    stats.adopted = plan.stats.adopted
    stats.pushed = plan.serverOps.length

    // 4. push server ops FIRST (single batch) — the server is the source of
    // truth; local creates land before local-echo creates are pulled back
    let newHead: number | null = null
    if (plan.serverOps.length) {
      const applyResp = await apiFetch(cfg, '/api/sync/apply', {
        method: 'POST',
        body: JSON.stringify(plan.serverOps),
      })
      if (applyResp.status === 401) { await setSyncStatus('unauthorized'); return { ok: false, error: 'unauthorized' } }
      if (!applyResp.ok) throw new Error(`apply failed: ${applyResp.status}`)
      const applyData = await applyResp.json()
      newHead = applyData.head ?? null
      for (const r of applyData.results || []) {
        if (r.error) {
          stats.failed++
          if (stats.errors.length < 5) stats.errors.push(`push ${r.id}: ${r.error}`)
        }
      }
      // ops the server rejected as LWW losers still exist there with other
      // content: a failed push must NOT advance base past them — but a
      // partial win is fine (the next reconcile re-plans the losers against
      // the fresh tree; nothing is lost).
    }

    // 5. apply chrome ops (parents ordered by the engine's topo sort) and
    // collect the chrome ids of nodes this run CREATED — they become base
    // bindings, without which the next reconcile would re-create every row
    const createdBindings = new Map<string, string>()
    const resolveParent = makeParentResolver(plan, roots, othersId, createdBindings)
    await applyChromeOps(plan.chromeOps, resolveParent, stats, createdBindings)
    for (const [sid, lid] of createdBindings) {
      const e = plan.newBaseEntries[sid]
      // overwrite unconditionally: a null binding is the plain-create case,
      // and a stale binding (URL-change remove+create re-created the row)
      // must be replaced by the NEW chrome id — keeping the old one would
      // point base at a node this plan just removed
      if (e) e.localId = lid
    }

    // 6. advance base atomically: the new snapshot is the server tree plus
    // the bindings this plan established. A failure above already returned.
    const freshTouch = await getTouch()
    // clear journal entries the plan consumed (their edits are now in base)
    const consumed = new Set<string>()
    for (const [sid, e] of Object.entries(plan.newBaseEntries)) {
      if (e.localId && (touch[e.localId] || freshTouch[e.localId])) consumed.add(e.localId)
    }
    const nextTouch: TouchJournal = { ...freshTouch }
    for (const lid of consumed) delete nextTouch[lid]
    await setTouch(nextTouch)
    await setBase({
      head: newHead ?? (data.head ?? 0),
      othersId,
      entries: Object.fromEntries(
        Object.entries(plan.newBaseEntries).map(([sid, e]) => [sid, { ...e, appliedAt: Math.floor(Date.now() / 1000) }]),
      ),
    })
    await saveConfigPatch({ rev: newHead ?? (data.head ?? 0) })

    // 7. favicon sync (best-effort, never fails the reconcile): hosts seen
    // in this pass get their browser-resolved icon pushed to the server.
    // The MV3 "favicon" permission serves chrome's own cached icon (with
    // its Google fallback) via the _favicon/ endpoint — more accurate than
    // the server fetching favicon.ico itself, and shared to every client.
    void syncFavicons(serverNodes, cfg)

    stats.lastRunAt = Math.floor(Date.now() / 1000)
    await setSyncStatus('online')
    return { ok: true }
  } catch (e: any) {
    stats.failed++
    if (stats.errors.length < 5) stats.errors.push(e?.message || String(e))
    // base untouched: the next reconcile re-plans everything still missing
    return { ok: false, error: e?.message || String(e) }
  } finally {
    reconciling = false
  }
}

// serialized wrapper: pullChain guarantees one reconcile at a time even when
// the alarm, WS ping, and a manual resync land together
function scheduleReconcile(reason: string, debounceMs = 0) {
  if (debounceMs > 0) {
    if (pullTimer) clearTimeout(pullTimer)
    pullTimer = setTimeout(() => scheduleReconcile(reason), debounceMs)
    return
  }
  pullChain = pullChain
    .then(() => reconcileOnce(reason))
    .then(() => undefined, () => undefined)
}
let pullTimer: ReturnType<typeof setTimeout> | null = null

// ---- favicon sync (best-effort) ----
// Pushes browser-resolved site icons to the server so the web UI (and any
// client) shows the exact icon chrome shows. MV3 serves them from the
// _favicon/ endpoint (needs the "favicon" permission); each host is fetched
// once per run and uploaded only when the server doesn't already have a
// fresh copy — the server 404s unknown hosts, 200s known ones.
let favFailCount = 0 // consecutive-run error dampener: skip after 3 bad runs

// Chrome's _favicon/ endpoint returns a DETERMINISTIC default placeholder
// (a 601-byte gray-globe PNG, same bytes every time) for hosts the browser
// has never rendered. Pushing it overwrites real icons with garbage — the
// user-visible "icons didn't sync" bug. Root fix: learn the placeholder
// once by fetching a guaranteed-unvisited host, fingerprint it, and refuse
// to upload any payload matching that fingerprint.
let placeholderHash: string | null = null
function faviconHash(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < b.length; i++) {
    h1 = ((h1 ^ b[i]) * 16777619) >>> 0
    h2 = ((h2 + b[b.length - 1 - i]) * 16777619) >>> 0
  }
  return `${b.length}:${h1.toString(16)}${h2.toString(16)}`
}
async function placeholderFingerprint(cfg: Config): Promise<string | null> {
  if (placeholderHash) return placeholderHash
  try {
    // an RFC 2606 .test domain is guaranteed unvisited/unresolvable —
    // chrome falls back to the default placeholder for it
    const url = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent('https://placeholder-probe-' + Date.now() + '.test/')}&size=32`)
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    if (!buf.byteLength) return null
    placeholderHash = faviconHash(buf)
    return placeholderHash
  } catch {
    return null
  }
}

async function syncFavicons(nodes: ServerNode[], cfg: Config) {
  if (typeof chrome.runtime.getURL !== 'function') return
  try {
    const hosts = new Set<string>()
    for (const n of nodes) {
      if (n.type !== 'url' || !n.url) continue
      try { hosts.add(new URL(n.url).hostname) } catch { /* malformed */ }
    }
    if (!hosts.size) return
    const ph = await placeholderFingerprint(cfg)
    let pushed = 0
    let skippedPlaceholder = 0
    for (const host of hosts) {
      try {
        // probe=1: cache-only check. Policy (server fetcher is
        // authoritative; extension pushes are a fallback for hosts the
        // server can't reach):
        //   200 → server already holds an icon → skip entirely (never
        //         overwrite server content from the browser — chrome's
        //         _favicon/ may serve placeholders that look real)
        //   404 → server has nothing → push ours ONLY if chrome's icon is
        //         real (fingerprint != placeholder)
        const probe = await fetch(apiBase(cfg.server) + '/api/favicon/' + encodeURIComponent(host) + '?probe=1', {
          signal: AbortSignal.timeout(5000),
        })
        if (probe.ok) continue
        const iconUrl = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent('https://' + host)}&size=32`)
        const iconResp = await fetch(iconUrl, { signal: AbortSignal.timeout(5000) })
        if (!iconResp.ok) continue
        const buf = await iconResp.arrayBuffer()
        if (!buf.byteLength || buf.byteLength > 200 * 1024) continue
        // never publish the chrome-default placeholder ourselves
        if (ph && faviconHash(buf) === ph) { skippedPlaceholder++; continue }
        const ctype = iconResp.headers.get('content-type') || 'image/png'
        const up = await fetch(apiBase(cfg.server) + '/api/favicon/' + encodeURIComponent(host), {
          method: 'PUT',
          headers: { 'Content-Type': ctype, Authorization: `Bearer ${cfg.token}` },
          body: buf,
          signal: AbortSignal.timeout(8000),
        })
        if (up.ok) pushed++
      } catch { /* per-host best effort */ }
    }
    if (pushed || skippedPlaceholder) console.log(`[favicons] pushed ${pushed}/${hosts.size} (skipped ${skippedPlaceholder} placeholders)`)
    favFailCount = 0
  } catch {
    if (++favFailCount >= 3) {
      // repeated failures (old server without the PUT route): back off hard
      // until the server is upgraded — retry only on full resyncs
      favFailCount = 0
      console.log('[favicons] server rejected pushes repeatedly; backing off')
    }
  }
}

// ---- connectivity ----

let statusCache: string | null = null
async function setSyncStatus(status: string) {
  if (statusCache === null) {
    statusCache = ((await chrome.storage.local.get('md_status')).md_status as string) || ''
  }
  // 'unauthorized' (revoked token) must stay visible: the WS reconnect loop
  // keeps failing and its onclose would otherwise mask the real problem.
  if (status === 'disconnected' && statusCache === 'unauthorized') return
  statusCache = status
  await chrome.storage.local.set({ md_status: status })
  const badges: Record<string, { text: string; color: string }> = {
    online: { text: '', color: '#2e7d32' },
    disconnected: { text: '!', color: '#f5a623' },
    unauthorized: { text: '×', color: '#e5484d' },
    unconfigured: { text: '·', color: '#9ca1b6' },
  }
  const badge = badges[status] || badges.disconnected
  chrome.action.setBadgeText({ text: badge.text })
  chrome.action.setBadgeBackgroundColor({ color: badge.color })
}

async function apiFetch(cfg: Config, path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiBase(cfg.server) + path, {
    ...init,
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
      ...(init?.headers || {}),
    },
  })
}
function apiBase(server: string): string {
  return server.replace(/\/+$/, '')
}

let wsKeepalive: ReturnType<typeof setInterval> | null = null
const wsDiag = { state: 'idle' as string, lastFrameAt: 0, lastFrameRev: 0 }
async function connectWS(cfg: Config) {
  if (ws && ws.readyState <= 1) return
  const url = apiBase(cfg.server).replace(/^http/, 'ws') + '/api/ws?token=' + encodeURIComponent(cfg.token)
  try {
    ws = new WebSocket(url)
  } catch {
    setTimeout(() => { getConfig().then((c) => c && connectWS(c)) }, backoffDelay(wsAttempt++))
    return
  }
  ws.onopen = () => {
    wsAttempt = 0
    wsDiag.state = 'open'
    void setSyncStatus('online')
    wsKeepalive = setInterval(() => { try { ws?.send('ping') } catch { /* dead conn closes itself */ } }, 20000)
  }
  ws.onmessage = (ev) => {
    wsDiag.lastFrameAt = Date.now()
    try {
      const msg = JSON.parse(String(ev.data))
      if (msg.t === 'rev') {
        wsDiag.lastFrameRev = msg.rev
        scheduleReconcile('ws', 500)
      }
    } catch { /* non-JSON frame (pong) */ }
  }
  ws.onclose = () => {
    wsDiag.state = 'closed'
    if (wsKeepalive) { clearInterval(wsKeepalive); wsKeepalive = null }
    void setSyncStatus('disconnected')
    setTimeout(() => { getConfig().then((c) => c && connectWS(c)) }, backoffDelay(wsAttempt++))
  }
  ws.onerror = () => { try { ws?.close() } catch { /* already closing */ } }
}

// ---- local touch journal: 5 listeners, one job ----
// Events during a reconcile are OUR OWN writes — ignore them (the plan
// captured the resulting state already; journaling our echoes would make
// every applied row look locally-edited and churn forever).

// journal writes must serialize against reconcileOnce's read-clear-write
// of the SAME key: a concurrent journalTouch finishing between the
// reconciler's read and its setTouch would be silently overwritten (the
// touch entry vanishes → the next reconcile ADOPTS the node as if it
// were server content → the user's pending create is swallowed).
// pullChain is the shared serialization channel (reconciles already run
// through it); journal writes enter the same chain.
function journalTouch(localId: string, extra?: { removed?: boolean; title?: string; url?: string }) {
  if (reconciling) return
  pullChain = pullChain
    .then(async () => {
      const t = await getTouch()
      const prev = t[localId]
      t[localId] = { at: Math.floor(Date.now() / 1000), ...extra, ...(prev?.removed ? { removed: true } : {}) }
      await setTouch(t)
    })
    .then(() => undefined, () => undefined)
  scheduleReconcile('edit', 1200)
}

chrome.bookmarks.onCreated.addListener((id) => { void journalTouch(id) })
chrome.bookmarks.onChanged.addListener((id, info) => { void journalTouch(id, { title: info.title }) })
chrome.bookmarks.onMoved.addListener((id) => { void journalTouch(id) })
chrome.bookmarks.onRemoved.addListener((id) => { void journalTouch(id, { removed: true }) })
chrome.bookmarks.onChildrenReordered.addListener((id) => { void journalTouch(id) })

// ---- lifecycle ----

async function fullSync() {
  const cfg = await getConfig()
  if (!cfg?.token) return
  await reconcileOnce('fullSync')
  connectWS(cfg)
}

chrome.runtime.onInstalled.addListener(async () => {
  // one-time cleanup of the pre-0.1.0 persisted state
  await chrome.storage.local.remove(LEGACY_KEYS)
  chrome.alarms.create(ALARM, { periodInMinutes: 1 })
  await fullSync()
})
chrome.runtime.onStartup.addListener(() => { void fullSync() })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void reconcileOnce('alarm') })
;(async () => {
  // module top-level: a revived SW reconnects immediately
  const cfg = await getConfig()
  if (cfg?.token) {
    await reconcileOnce('boot')
    connectWS(cfg)
  } else {
    void setSyncStatus('unconfigured')
  }
})()

// ---- message surface (popup/options; shapes preserved for the UI) ----

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
        // CRITICAL: wipe base on every pairing. md_base described
        // the PREVIOUS pairing's server lineage; keeping it against a new
        // (possibly emptied) server makes the reconcile read every stale
        // base entry as 'server deleted this row' and mass-delete the
        // browser's bookmarks — the wipe bug. A fresh pairing is a fresh
        // three-way identity: empty base ⇒ first reconcile adopts the
        // browser tree and pushes it (nothing is deleted).
        // The TOUCH JOURNAL SURVIVES: it is the only record of pending
        // offline edits — wiping it (re-pair after a token revocation)
        // silently discarded edits that never reached the server.
        await chrome.storage.local.remove([BASE_KEY])
        await saveConfigPatch({ server, token: data.token, deviceId: data.deviceId, rev: 0 })
        deviceIdCached = data.deviceId
        // first reconcile against an empty base = full adoption/import,
        // identical mechanics to a re-pair — no special initialImport
        const r = await reconcileOnce('pair')
        if (!r.ok && r.error !== 'unauthorized') throw new Error(r.error || 'reconcile failed')
        // the SW booted before pairing (no token → no WS); the realtime
        // channel must come up HERE, not on some later service-worker restart
        const cfgNow = await getConfig()
        if (cfgNow) await connectWS(cfgNow)
        await setSyncStatus('online')
        sendResponse({ ok: true })
      } catch (e: any) {
        sendResponse({ ok: false, error: e.message })
      }
    } else if (msg.type === 'status') {
      const st = await chrome.storage.local.get(['md_status', CONFIG_KEY, TOUCH_KEY]) as any
      sendResponse({
        status: st.md_status || 'unconfigured',
        server: st[CONFIG_KEY]?.server || '',
        queued: Object.keys(st[TOUCH_KEY] || {}).length,
      })
    } else if (msg.type === 'resync') {
      const r = await reconcileOnce('resync')
      sendResponse({ ok: r.ok, error: r.error })
    } else if (msg.type === 'forceResync') {
      // last-resort recovery: wipe base; the next reconcile is a full-adopt
      // pass (URL/folder adoption binds onto the existing tree — this is
      // now the SAME code path as a first pair, not special recovery).
      // The TOUCH JOURNAL MUST SURVIVE: it is the only record of pending
      // local edits that never reached the server — wiping it made the
      // adoption pass overwrite those edits with server content (the
      // user's offline rename silently reverted by the very tool meant
      // to fix sync).
      await chrome.storage.local.remove([BASE_KEY])
      cachedRoots = null
      const r = await reconcileOnce('forceResync')
      sendResponse({ ok: r.ok, error: r.error, ...flattenStats() })
      return
    } else if (msg.type === 'applyStats') {
      sendResponse({ ...flattenStats() })
      return
    } else if (msg.type === 'deepDiag') {
      deepDiag().then(sendResponse).catch((e: any) => sendResponse({ ok: false, error: e.message }))
      return
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
      const isEdge = /Edg\//.test(navigator.userAgent)
      const url = isEdge ? 'edge://settings/profiles/sync' : 'chrome://settings/syncSetup'
      chrome.tabs.create({ url })
      sendResponse({ ok: true })
    } else if (msg.type === 'saveCurrent') {
      const cfg = await getConfig()
      if (!cfg?.token) { sendResponse({ ok: false, error: 'not paired' }); return }
      try {
        const created = await chrome.bookmarks.create({
          parentId: await barRootId(),
          title: msg.title,
          url: msg.url,
        })
        const tags = typeof msg.tags === 'string' && msg.tags.trim()
          ? msg.tags.split(/[,，]/).map((t: string) => t.trim()).filter(Boolean)
          : undefined
        // tags ride the touch journal: reconcile picks them up when the
        // created node is pushed (server apply carries tags on create)
        if (tags?.length) {
          const t = await getTouch()
          t[created.id] = { at: Math.floor(Date.now() / 1000), tags }
          await setTouch(t)
        }
        sendResponse({ ok: true })
      } catch (e: any) {
        sendResponse({ ok: false, error: e.message })
      }
    }
  })()
  return true // async response
})

function flattenStats() {
  return {
    planned: reconcileStats.planned,
    pushed: reconcileStats.pushed,
    created: reconcileStats.chromeCreates,
    updated: reconcileStats.chromeUpdates,
    removed: reconcileStats.chromeRemoves,
    moved: reconcileStats.chromeMoves,
    adopted: reconcileStats.adopted,
    failed: reconcileStats.failed,
    errors: [...reconcileStats.errors],
    lastRunAt: reconcileStats.lastRunAt,
  }
}

// ---- diagnostics ----

// Tree-level URL parity check: what the server holds vs what the browser
// holds. With tombstone rows gone from the protocol, this is THE content
// correctness signal (per-URL set symmetric difference).
async function deepDiag() {
  const cfg = await getConfig()
  if (!cfg?.token) return { ok: false, error: 'not paired' }
  try {
    const resp = await apiFetch(cfg, '/api/sync/tree')
    if (resp.status === 401) return { ok: false, error: 'unauthorized' }
    if (!resp.ok) throw new Error(`tree fetch failed: ${resp.status}`)
    const data = await resp.json()
    const serverUrls = new Set<string>()
    for (const n of data.nodes || []) {
      if (n.type === 'url' && n.url) serverUrls.add(normBookmarkUrl(n.url))
    }
    const local = await toLocalTree()
    const localUrls = new Set<string>()
    const walk = (nodes: LocalNode[]) => {
      for (const n of nodes) {
        if (n.type === 'url' && n.url) localUrls.add(normBookmarkUrl(n.url))
      }
    }
    walk(local)
    const missingLocally: string[] = []
    for (const u of serverUrls) if (!localUrls.has(u)) missingLocally.push(u)
    const extraLocally: string[] = []
    for (const u of localUrls) if (!serverUrls.has(u)) extraLocally.push(u)
    const base = await getBase()
    const touch = await getTouch()
    const bound = base ? Object.values(base.entries).filter((e) => e.localId).length : 0
    return {
      ok: true,
      serverUrls: serverUrls.size,
      localUrls: localUrls.size,
      missingLocally: missingLocally.slice(0, 20),
      extraLocally: extraLocally.slice(0, 20),
      missingCount: missingLocally.length,
      extraCount: extraLocally.length,
      bindings: bound,
      touchEntries: Object.keys(touch).length,
      rev: base?.head ?? 0,
      serverHead: data.head ?? 0,
      stats: flattenStats(),
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// test/debug hooks (E2E suites drive the SW through these)
;(globalThis as unknown as Record<string, unknown>).__markdeckResync = fullSync
;(globalThis as unknown as Record<string, unknown>).__markdeckWsDiag = wsDiag
;(globalThis as unknown as Record<string, unknown>).__markdeckDeepDiag = deepDiag
;(globalThis as unknown as Record<string, unknown>).__markdeckForceResync = async () => {
  // base only — the touch journal carries pending offline edits that the
  // adoption pass must push, never wipe
  await chrome.storage.local.remove([BASE_KEY])
  cachedRoots = null
  return reconcileOnce('forceResync-hook')
}
;(globalThis as unknown as Record<string, unknown>).__markdeckReconcileStats = flattenStats
