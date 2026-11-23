// Pure-TS sync core for the MarkDeck extension — no chrome.* calls here so
// it can be unit-tested with Vitest. Storage/event plumbing is injected.

export interface NodeState {
  id: string
  parentId: string
  type: 'folder' | 'url'
  title: string
  url?: string
  note?: string
  favorite?: boolean
  archived?: boolean
  position: number
  deletedAt?: number
  purged?: boolean
  revision: number
  updatedAt: number
  deviceId: string
  createdAt: number
  tags?: string[]
}

export interface QueuedOp {
  kind: 'created' | 'changed' | 'moved' | 'removed' | 'reordered'
  id: string
  parentId?: string
  title?: string
  url?: string
  oldParentId?: string
  oldIndex?: number
  index?: number
  at: number
  tags?: string[]  // popup quick-save tags (applied on create)
}

export interface SyncResult {
  changes: NodeState[]
  head: number
}

// ---- queue ----

// Dedupe queued ops per bookmark id, keeping order: later ops subsume
// earlier ones for the same id except removal which always wins last.
export function compressQueue(ops: QueuedOp[]): QueuedOp[] {
  // a node created AND removed within one batch never existed on the server:
  // drop the whole sequence instead of pushing a tombstone the server would
  // reject (unknown id without a type). Safe: a successful push clears the
  // queue, so both ops can only coexist if neither was pushed yet.
  const lastById = new Map<string, QueuedOp>()
  ops.forEach((op) => lastById.set(op.id, op))
  const firstKind = new Map<string, QueuedOp['kind']>()
  for (const op of ops) if (!firstKind.has(op.id)) firstKind.set(op.id, op.kind)
  const neverSynced = new Set<string>()
  for (const [id, last] of lastById) {
    if (last.kind === 'removed' && firstKind.get(id) === 'created') neverSynced.add(id)
  }
  const lastIdx = new Map<string, number>()
  ops.forEach((op, i) => lastIdx.set(op.id, i))
  const compressed = ops.filter((op, i) => lastIdx.get(op.id) === i && !neverSynced.has(op.id))
  // A merged "changed"/"moved" op for a node whose "created" op was dropped
  // must still carry creation fields (type/url), otherwise the server cannot
  // materialize the new row. Fold creation data into the surviving op.
  const createdById = new Map<string, QueuedOp>()
  for (const op of ops) {
    if (op.kind === 'created' && !createdById.has(op.id)) createdById.set(op.id, op)
  }
  return compressed.map((op) => {
    const created = createdById.get(op.id)
    if (op.kind !== 'created' && created) {
      return {
        ...op,
        kind: 'created',
        parentId: op.parentId ?? created.parentId,
        title: op.title ?? created.title,
        url: created.url,
        index: op.index ?? created.index,
        tags: op.tags ?? created.tags,
      }
    }
    return op
  })
}

// Convert browser events to server push ops.
export function opsToPushPayload(ops: QueuedOp[], deviceId: string, nodes: Map<string, NodeState>): Record<string, unknown>[] {
  const now = Math.floor(Date.now() / 1000)
  return ops.map((op) => {
    const known = nodes.get(op.id)
    // updatedAt must be the REAL local edit time (op.at) — inflating it to
    // push time would let a stale queued edit overwrite a newer remote
    // change and break LWW for everyone else. baseRevision quotes the server
    // revision this op was authored against: on same-second ties the server
    // treats base >= current row as a legitimate follow-up edit (wins) and
    // base below it as a stale op (loses) — no device-id bias either way.
    // pushQueue stashes the pre-translation revision on _baseRev because the
    // cache is keyed by LOCAL id while op.id has already become the server id.
    const baseRev = (op as QueuedOp & { _baseRev?: number })._baseRev || 0
    const base: Record<string, unknown> = {
      id: op.id,
      updatedAt: op.at > 0 ? op.at : now,
      deviceId,
      ...(baseRev > 0 ? { baseRevision: baseRev } : {}),
    }
    switch (op.kind) {
      case 'created':
        return {
          ...base,
          type: op.url ? 'url' : 'folder',
          parentId: op.parentId ?? '',
          title: op.title ?? '',
          url: op.url ?? '',
          position: (op.index ?? 0) + 1,
          ...(op.tags && op.tags.length ? { tags: op.tags } : {}),
        }
      case 'changed':
        return { ...base, title: op.title ?? known?.title ?? '' }
      case 'moved':
        return { ...base, parentId: op.parentId ?? '', position: (op.index ?? 0) + 1 }
      case 'removed':
        return { ...base, deletedAt: op.at, purged: false }
      case 'reordered':
        return { ...base, parentId: op.parentId ?? '', position: (op.index ?? 0) + 1 }
    }
  })
}

// ---- conflict-safe merge decision (client-side mirror of server LWW) ----

// The server is the single write point, so same-second ties resolve by
// ARRIVAL order there: a push overwrites whatever row holds, and every
// replica converges on the server's final state. The extension mirrors that:
// a same-second remote change always applies (it arrived later than the
// local cache row it supersedes), EXCEPT our own echo — a same-second row
// carrying our own device id is the server's copy of what we just pushed.
// Previous rules failed in both directions: device-id strings let the web
// UI's fixed 'web' id beat every extension uuid; a content key let a stale
// local copy out-rank a rename whose new title sorted lower.
// ---- conflict-safe merge decision (client-side mirror of server LWW) ----

// The server is the single write point, so a same-second remote change
// ALWAYS applies: it arrived after the local cache row it supersedes (the
// server kept it, and pull delivers only server-winning rows). Rows we
// pushed ourselves never reach this function — applyRemote maps them to
// deviceId '__self__' and skips them before planning. Earlier rules failed
// in both directions: device-id strings let the web UI's fixed 'web' id beat
// every extension uuid, and comparing the CACHED author id treated every
// same-second web edit as "our echo" (the cache stamps rows with the
// author's id, not ours).
export function clientWins(local: NodeState | undefined, remote: NodeState): boolean {
  if (!local) return false // remote wins for unknown nodes
  return local.updatedAt > remote.updatedAt // strictly newer local wins only
}

// Apply a remote change description onto the local browser tree.
// Returns a list of actions the caller (chrome.bookmarks adapter) executes.
export type RemoteAction =
  | { action: 'create'; node: NodeState }
  | { action: 'update'; node: NodeState }
  | { action: 'remove'; id: string; title?: string }
  | { action: 'move'; id: string; parentId: string; index: number }
  | { action: 'ignore'; id: string; why: string }

export function planRemoteActions(changes: NodeState[], localNodes: Map<string, NodeState>, mapToLocalId?: (serverId: string) => string | null): RemoteAction[] {
  const actions: RemoteAction[] = []
  // 同一节点在本批可能带多条变更（created+changed 各自 bump 了 revision）；
  // 只保留 revision 最大的一条，避免对同一 id 重复 create/update。
  const latest = new Map<string, NodeState>()
  for (const c of changes) {
    const cur = latest.get(c.id)
    if (!cur || c.revision > cur.revision) latest.set(c.id, c)
  }
  for (const c of latest.values()) {
    if (c.deviceId === '__self__') continue // our own echo
    // 服务器 id 需要映射为本地 id 才能在 localNodes 里找到（initialImport 用 UUID 时，
    // 本地 chrome id 与服务器 id 不同）
    const localId = mapToLocalId ? mapToLocalId(c.id) : c.id
    const local = localId ? localNodes.get(localId) : undefined
    if (c.deletedAt && c.deletedAt > 0) {
      // title rides along so the adapter can still locate the local node by
      // name when the mapping was lost (folder-shell ghosts, see applyRemote).
      // 'already absent' is NOT safe to assume: mapToLocalId falls back to
      // the raw server id, so a node whose mapping was pruned looks absent
      // here but may exist in the tree under a different local id.
      if (!local || !local.deletedAt) actions.push({ action: 'remove', id: localId ?? c.id, title: c.title })
      else actions.push({ action: 'ignore', id: c.id, why: 'already absent' })
      continue
    }
    if (!local) {
      actions.push({ action: 'create', node: c })
      continue
    }
    if (clientWins(local, c)) {
      actions.push({ action: 'ignore', id: c.id, why: 'local newer' })
      continue
    }
    if (local.parentId !== c.parentId || local.position !== c.position) {
      actions.push({ action: 'move', id: c.id, parentId: c.parentId, index: Math.max(0, Math.round(c.position) - 1) })
    }
    if (local.title !== c.title || local.url !== c.url || local.note !== c.note) {
      actions.push({ action: 'update', node: c })
    }
  }
  return actions
}

// ---- reconnection backoff ----

export function backoffDelay(attempt: number): number {
  const base = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)))
  return base * (0.75 + Math.random() * 0.5) // jitter
}

// ---- offline semantics: the queue is the source of truth for unsent edits ----

export function isOfflineState(status: string | null): boolean {
  return status === null || status === 'disconnected'
}

// ---- browser-sync conflict detection ----

export interface DupGroup {
  title: string
  url: string
  count: number
}

/**
 * Heuristic: two bookmark-sync systems fighting over the same bar produce
 * exact-duplicate nodes (same URL, same title). A group of >=2 is strong
 * evidence of double-sync.
 */
export function detectDuplicateGroups(nodes: { id: string; title: string; url?: string }[]): DupGroup[] {
  const byKey = new Map<string, { title: string; url: string; count: number }>()
  for (const n of nodes) {
    if (!n.url) continue // folders are not duplicated by sync engines
    const key = n.url.replace(/\/+$/, '').toLowerCase() + '|' + (n.title || '').trim()
    const g = byKey.get(key)
    if (g) g.count++
    else byKey.set(key, { title: n.title, url: n.url, count: 1 })
  }
  const out: DupGroup[] = []
  for (const g of byKey.values()) if (g.count >= 2) out.push(g)
  return out.sort((a, b) => b.count - a.count)
}
