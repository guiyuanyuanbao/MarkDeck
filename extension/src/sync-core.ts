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
  const lastIdx = new Map<string, number>()
  ops.forEach((op, i) => lastIdx.set(op.id, i))
  return ops.filter((op, i) => {
    if (lastIdx.get(op.id) !== i) return false
    return true
  })
}

// Convert browser events to server push ops.
export function opsToPushPayload(ops: QueuedOp[], deviceId: string, nodes: Map<string, NodeState>): Record<string, unknown>[] {
  const now = Math.floor(Date.now() / 1000)
  return ops.map((op) => {
    const known = nodes.get(op.id)
    const base: Record<string, unknown> = {
      id: op.id,
      updatedAt: Math.max(now, op.at),
      deviceId,
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

export function clientWins(local: NodeState | undefined, remote: NodeState): boolean {
  if (!local) return false // remote wins for unknown nodes
  if (local.updatedAt !== remote.updatedAt) return local.updatedAt > remote.updatedAt
  return local.deviceId > remote.deviceId // higher device id wins ties
}

// Apply a remote change description onto the local browser tree.
// Returns a list of actions the caller (chrome.bookmarks adapter) executes.
export type RemoteAction =
  | { action: 'create'; node: NodeState }
  | { action: 'update'; node: NodeState }
  | { action: 'remove'; id: string }
  | { action: 'move'; id: string; parentId: string; index: number }
  | { action: 'ignore'; id: string; why: string }

export function planRemoteActions(changes: NodeState[], localNodes: Map<string, NodeState>): RemoteAction[] {
  const actions: RemoteAction[] = []
  for (const c of changes) {
    if (c.deviceId === '__self__') continue // our own echo
    const local = localNodes.get(c.id)
    if (c.deletedAt && c.deletedAt > 0) {
      if (local && !local.deletedAt) actions.push({ action: 'remove', id: c.id })
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
