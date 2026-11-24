// Pure-TS three-way reconciliation engine for the MarkDeck extension.
// No chrome.* calls — unit-tested with Vitest. The chrome adapter in
// background.ts supplies server/local trees and executes the planned ops.
//
// Model:
//   base    — snapshot of the server tree at the last successful reconcile,
//             plus the local chrome id each server row was bound to then.
//   server  — the server's live tree right now (GET /api/sync/tree).
//   local   — the browser's live tree right now (chrome.bookmarks.getTree,
//             scoped to bookmarks bar + other bookmarks).
//   touch   — tiny journal of local edits since the last reconcile:
//             { localId → { at, url?, title?, removed? } }. It supplies LWW
//             timestamps and survives SW restarts. NOT an op queue — edits
//             themselves are re-derived by diffing local against base.
//
// The plan is idempotent: reconciling the same three trees twice yields
// zero ops the second time. A failed reconcile never advances base, so the
// next run re-plans everything still missing — offline edits replay
// automatically without a queue, an echo guard, or per-row error recovery.

export interface ServerNode {
  id: string
  parentId: string
  type: 'folder' | 'url'
  title: string
  url?: string
  position: number
  revision: number
  updatedAt: number
  deviceId?: string
}

export interface LocalNode {
  id: string // chrome node id (GUID or legacy integer)
  parentId: string // '' for the two root buckets themselves
  type: 'folder' | 'url'
  title: string
  url?: string
  index: number
  dateAdded?: number
}

// One base entry: what the server row looked like and which chrome node
// carried it. Binding lives HERE, not in a side table — it is rewritten
// atomically with every successful reconcile, so it cannot drift.
export interface BaseEntry {
  server: ServerNode
  localId: string | null // null = this device has not placed the row yet
  appliedAt: number // when the binding was established (debug/diag)
}

export interface Base {
  head: number
  othersId: string // canonical server id of the 其他书签 holder
  entries: Record<string, BaseEntry> // keyed by server id
}

// Journal of local edits since the last reconcile (persisted md_touch).
export interface TouchEntry {
  at: number // unix seconds of the edit
  removed?: boolean // node was deleted locally
  title?: string // observed after changed/rename events
  url?: string
  tags?: string[] // quick-save tags to carry on the node's create push
}

export type TouchJournal = Record<string, TouchEntry> // keyed by LOCAL id

// ---- planned operations ----

export type ChromeOp =
  | { kind: 'create'; serverId: string; parentServerId: string; type: 'folder' | 'url'; title: string; url?: string; index: number }
  | { kind: 'update'; serverId: string; localId: string; title: string; url?: string }
  | { kind: 'move'; serverId: string; localId: string; parentServerId: string; index: number }
  | { kind: 'remove'; serverId: string; localId: string }
  | { kind: 'bind'; serverId: string; localId: string } // adopt an existing browser node

export type ServerOp =
  | { op: 'create'; id: string; parentId: string; type: 'folder' | 'url'; title: string; url?: string; position: number; updatedAt: number; deviceId: string }
  | { op: 'update'; id: string; title: string; url?: string; parentId?: string; tags?: string[]; updatedAt: number; deviceId: string; observedRevision: number }
  | { op: 'delete'; id: string; updatedAt: number; deviceId: string }

export interface SyncPlan {
  chromeOps: ChromeOp[]
  serverOps: ServerOp[]
  // The base the caller must persist AFTER both sides applied successfully.
  // Computed as: server tree + the bindings the plan establishes.
  newBaseEntries: Record<string, { server: ServerNode; localId: string | null }>
  stats: {
    planned: number
    chromeCreates: number
    chromeUpdates: number
    chromeMoves: number
    chromeRemoves: number
    adopted: number
    pushed: number
  }
}

// ---- helpers ----

// URL normalization shared by adoption matching: trailing slashes and case
// are insignificant to bookmark identity (chrome.bookmarks.search is
// exact-match, which once silently duplicated slash-divergent rows).
export function normBookmarkUrl(raw: string | undefined): string {
  if (!raw) return ''
  return raw.trim().replace(/\/+$/, '').toLowerCase()
}

function touchAt(touch: TouchJournal, localId: string | undefined): number {
  if (!localId) return 0
  return touch[localId]?.at || 0
}

// ---- the engine ----

export interface PlanInput {
  server: ServerNode[]
  // The adapter passes ONLY in-scope nodes: bar subtree + other subtree
  // (+ the two root buckets, bar with parentId '' first, other marked
  // isOtherRoot). Mobile-bookmarks content is out of scope and must not
  // appear here. Local ids outside this list are treated as deleted
  // (removal planning) or unbound (adoption).
  local: LocalNode[]
  base: Base | null
  touch: TouchJournal
  deviceId: string
  now: number
  othersId: string // from the server response (authoritative)
}

export function planSync(input: PlanInput): SyncPlan {
  const { server, local, touch, deviceId } = input
  const base = input.base && input.base.head > 0 ? input.base : null
  const serverById = new Map(server.map((n) => [n.id, n]))
  const localById = new Map(local.map((n) => [n.id, n]))

  const chromeOps: ChromeOp[] = []
  const serverOps: ServerOp[] = []
  const stats = { planned: 0, chromeCreates: 0, chromeUpdates: 0, chromeMoves: 0, chromeRemoves: 0, adopted: 0, pushed: 0 }

  // serverId -> localId binding as this plan leaves it (seeded from base)
  const binding = new Map<string, string | null>()
  if (base) for (const [sid, e] of Object.entries(base.entries)) binding.set(sid, e.localId)

  // reverse index: localId -> serverId (from base bindings)
  const reverse = new Map<string, string>()
  for (const [sid, lid] of binding) if (lid) reverse.set(lid, sid)

  // ---- structural binding: browser other-bookmarks root ↔ canonical holder ----
  // The local tree's OTHER bucket is identified by the adapter (children[1]
  // invariant) and passed with parentId '' + marker `isOtherRoot`. Its
  // server counterpart is input.othersId, structurally — never stored in
  // any mapping table, recomputed every reconcile.
  const otherRootLocal = local.find((n) => (n as LocalNode & { isOtherRoot?: boolean }).isOtherRoot)
  if (otherRootLocal) {
    binding.set(input.othersId, otherRootLocal.id)
    reverse.set(otherRootLocal.id, input.othersId)
  }

  // The local tree adapter passes root buckets with parentId '' (bar root
  // first, other root marked). Server top-level rows (parentId '') live in
  // the bar bucket; the adapter resolves server-top-level → bar root id.
  const barRootLocal = local.find((n) => n.parentId === '' && n !== otherRootLocal)

  // index local children by parent for move/position planning
  const localChildren = new Map<string, LocalNode[]>()
  for (const n of local) {
    const arr = localChildren.get(n.parentId) || []
    arr.push(n)
    localChildren.set(n.parentId, arr)
  }

  // server children by parent — re-ranked 0..n-1 by position. Comparing the
  // RANK instead of the raw position kills the move-churn class of bugs: raw
  // positions are REAL numbers scattered across devices (a web-UI create
  // lands at MaxPosition+1 = 10000 while the browser index is 0), so absolute
  // equality never converges; rank does.
  const serverChildren = new Map<string, ServerNode[]>()
  for (const n of server) {
    const arr = serverChildren.get(n.parentId) || []
    arr.push(n)
    serverChildren.set(n.parentId, arr)
  }
  const serverRank = new Map<string, number>()
  for (const [, arr] of serverChildren) {
    arr.sort((a, b) => a.position - b.position)
    // the canonical holder is structurally bound to the browser's OTHER ROOT
    // bucket — it occupies no slot in any local parent's child list, so it
    // must not consume a rank (otherwise every sibling after it is off by
    // one forever and move-churn returns)
    let rank = 0
    for (const n of arr) {
      if (n.id === input.othersId) continue
      serverRank.set(n.id, rank++)
    }
  }

  // ---- URL adoption index: unbound local url nodes by normalized url ----
  const unboundByUrl = new Map<string, LocalNode[]>()
  for (const n of local) {
    if (n.type !== 'url') continue
    if (reverse.has(n.id)) continue // already bound via base
    const key = normBookmarkUrl(n.url)
    const arr = unboundByUrl.get(key) || []
    arr.push(n)
    unboundByUrl.set(key, arr)
  }

  // ---- Pass 1: server-side rows ----
  for (const sn of server) {
    const bEntry = base?.entries[sn.id]
    const localId = binding.get(sn.id) ?? null
    const ln = localId ? localById.get(localId) ?? undefined : undefined

    if (!bEntry) {
      // NEW on the server (was not in base). Bind or create locally.
      // A structurally bound row (other-bookmarks root ↔ canonical holder)
      // never creates: its browser counterpart IS the root bucket.
      if (sn.id === input.othersId && otherRootLocal) {
        binding.set(sn.id, otherRootLocal.id)
        continue
      }
      // unbound same-URL browser node: adopt it (no duplicate). This is the
      // force-resync / first-pair adoption path — bindings emerge from data,
      // never from a persisted mapping table.
      if (sn.type === 'url') {
        const cand = unboundByUrl.get(normBookmarkUrl(sn.url))?.[0]
        if (cand) {
          binding.set(sn.id, cand.id)
          reverse.set(cand.id, sn.id)
          unboundByUrl.delete(normBookmarkUrl(sn.url))
          stats.adopted++
          if (cand.title !== sn.title && touchAt(touch, cand.id) <= sn.updatedAt) {
            chromeOps.push({ kind: 'update', serverId: sn.id, localId: cand.id, title: sn.title, url: sn.url })
          }
          continue
        }
      }
      // folders: adopt a same-title unbound folder under the same bound
      // parent (two rebuilds must converge on one folder shell, v0.0.20).
      // Server top-level ('') resolves to the local bar bucket.
      if (sn.type === 'folder') {
        const parentLid = sn.parentId === '' && barRootLocal
          ? barRootLocal.id
          : sn.parentId === input.othersId && otherRootLocal
            ? otherRootLocal.id
            : binding.get(sn.parentId) ?? null
        if (parentLid) {
          const sibs = localChildren.get(parentLid) || []
          const same = sibs.filter((s) => s.type === 'folder' && s.title === sn.title && !reverse.has(s.id))
          if (same.length === 1) {
            binding.set(sn.id, same[0].id)
            reverse.set(same[0].id, sn.id)
            stats.adopted++
            continue
          }
        }
      }
      chromeOps.push({
        kind: 'create', serverId: sn.id, parentServerId: sn.parentId,
        type: sn.type, title: sn.title, url: sn.url, index: Math.max(0, Math.round(sn.position) - 1),
      })
      continue
    }

    // row existed in base: three-way compare
    const serverChanged = !serverEq(bEntry.server, sn)
    const localChanged = ln ? localDiffers(ln, bEntry.server, touch, localId as string) : true // null binding = never placed

    if (!ln) {
      // the chrome node is gone. Distinguish WHY:
      //  - touch says the user deleted it locally → push the delete
      //  - binding was null (never placed) → nothing local to lose
      //  - otherwise the node vanished un-journaled (profile reset?) →
      //    recreate from the server row (the server still holds it)
      const tRemoved = localId ? touch[localId]?.removed : undefined
      if (localId && tRemoved) {
        serverOps.push({
          op: 'delete', id: sn.id,
          updatedAt: touch[localId].at,
          deviceId,
        })
        stats.pushed++
        continue
      }
      if (serverChanged || !localId) {
        // server moved on, or the row was never placed here: recreate
        chromeOps.push({
          kind: 'create', serverId: sn.id, parentServerId: sn.parentId,
          type: sn.type, title: sn.title, url: sn.url, index: Math.max(0, Math.round(sn.position) - 1),
        })
      } else {
        // unchanged row whose local node vanished without a journal entry
        // (profile reset, manual storage wipe): adopt by URL or recreate
        if (sn.type === 'url') {
          const cand = unboundByUrl.get(normBookmarkUrl(sn.url))?.[0]
          if (cand) {
            binding.set(sn.id, cand.id)
            reverse.set(cand.id, sn.id)
            unboundByUrl.delete(normBookmarkUrl(sn.url))
            stats.adopted++
            continue
          }
        }
        chromeOps.push({
          kind: 'create', serverId: sn.id, parentServerId: sn.parentId,
          type: sn.type, title: sn.title, url: sn.url, index: Math.max(0, Math.round(sn.position) - 1),
        })
      }
      continue
    }

    // both sides present
    if (serverChanged && localChanged) {
      // both moved since base: LWW by timestamps (touch time vs server time)
      const t = touchAt(touch, localId ?? undefined)
      if (t > sn.updatedAt) {
        // local edit is newer: push local state
        pushLocalState(sn, ln, localId as string, serverOps, deviceId, touch, stats, binding, reverse)
      } else {
        // server is newer (or tie): apply server state to the browser
        planServerToLocal(sn, ln, localId as string, chromeOps, stats, serverRank.get(sn.id) ?? 0)
      }
    } else if (serverChanged) {
      planServerToLocal(sn, ln, localId as string, chromeOps, stats, serverRank.get(sn.id) ?? 0)
    } else if (localChanged) {
      pushLocalState(sn, ln, localId as string, serverOps, deviceId, touch, stats, binding, reverse)
    } else {
      // convergence check: positions may still drift (e.g. index churn on
      // one side). Structurally bound rows (other-bookmarks root) never
      // move — their browser position is the root bucket's own.
      if (sn.id !== input.othersId) {
        planPositionOnly(sn, ln, localId as string, chromeOps, stats, serverRank.get(sn.id) ?? 0, 0)
      }
    }
  }

  // ---- Pass 2: rows in base that the server tree no longer carries ----
  const rebindingEntries: Record<string, { server: ServerNode; localId: string | null }> = {}
  if (base) {
    for (const [sid, entry] of Object.entries(base.entries)) {
      if (serverById.has(sid)) continue // handled in pass 1
      const localId = binding.get(sid) ?? entry.localId
      const ln = localId ? localById.get(localId) ?? undefined : undefined

      // server deleted the row. BUT if the local side edited it after base,
      // the local edit wins: push an undelete-style recreate (offline edit
      // racing a server delete — the edit is newer, it must not be lost).
      const t = localId ? touchAt(touch, localId) : 0
      if (ln && t > entry.server.updatedAt) {
        // re-create server-side with local content. A deleted-then-edited
        // url row carries its url; folders just re-assert the title. The
        // server apply path materializes missing rows from the op fields.
        serverOps.push({
          op: 'update',
          id: sid,
          title: ln.title,
          url: ln.type === 'url' ? (ln.url || '') : undefined,
          updatedAt: t,
          deviceId,
          observedRevision: entry.server.revision,
        })
        stats.pushed++
        continue
      }

      // adoption rescue: an unbound browser node with the same URL is the
      // same bookmark re-imported locally — rebind instead of deleting it
      // (the old chrome node is gone; the content migrated to a new node).
      // Does not require the OLD node to still exist. The rebind carries
      // the base row into the new base: the server still owns this id even
      // though this snapshot's tree request raced the deletion.
      if (entry.server.type === 'url') {
        const cand = unboundByUrl.get(normBookmarkUrl(entry.server.url))
        if (cand && cand.length) {
          binding.set(sid, cand[0].id)
          reverse.set(cand[0].id, sid)
          unboundByUrl.delete(normBookmarkUrl(entry.server.url))
          rebindingEntries[sid] = { server: entry.server, localId: cand[0].id } // rebind into next base
          stats.adopted++
          continue
        }
      }

      if (ln) {
        chromeOps.push({ kind: 'remove', serverId: sid, localId: ln.id })
        stats.chromeRemoves++
        stats.planned++
      } else if (localId) {
        // chrome node already gone (user deleted locally before we saw the
        // server delete): nothing to remove, binding just dissolves
      }
      binding.delete(sid)
    }
  }

  // ---- Pass 3: local rows with no server counterpart ----
  // Never-in-base local nodes (or nodes whose base binding dissolved) are
  // local edits/additions to push. Root buckets never push. A node whose
  // parent cannot be resolved INSIDE the synced scope is out of scope
  // (e.g. Mobile bookmarks content leaked into the tree walk) and is
  // ignored — pushing it would create unreachable server rows.
  const excluded = new Set<string>()
  if (otherRootLocal) excluded.add(otherRootLocal.id)
  const barRootId = barRootLocal?.id
  for (const n of local) {
    if (n.parentId === '' ) continue // root buckets
    if (excluded.has(n.id)) continue
    if (reverse.has(n.id)) continue // bound: handled in pass 1/2
    // parent must resolve to an in-scope ancestor: bar root directly, any
    // bound node, or any node that itself resolves (walk up)
    let anc: string | undefined = n.parentId
    let resolved: string | null = null
    let depth = 0
    while (anc && depth < 50) {
      if (anc === barRootId || anc === otherRootLocal?.id) { resolved = anc; break }
      const boundSid = reverse.get(anc)
      if (boundSid) { resolved = anc; break }
      anc = localById.get(anc)?.parentId
      depth++
    }
    if (!resolved) continue // outside the synced scope (mobile etc.)
    // unbound local node: mint a server id (deterministic per reconcile;
    // the server row id is assigned here, not by chrome)
    const t = touchAt(touch, n.id) || Math.floor((n.dateAdded || input.now * 1000) / 1000) || input.now
    const minted = mintStableId(n)
    binding.set(minted, n.id)
    reverse.set(n.id, minted)
    const parentSid = reverse.get(n.parentId) || '' // root bucket children → top level
    const tags = touch[n.id]?.tags
    if (n.type === 'url') {
      serverOps.push({
        op: 'create', id: minted, parentId: parentSid, type: 'url',
        title: n.title, url: n.url || '', position: n.index + 1,
        ...(tags?.length ? { tags } : {}),
        updatedAt: t, deviceId,
      })
    } else {
      serverOps.push({
        op: 'create', id: minted, parentId: parentSid, type: 'folder',
        title: n.title, position: n.index + 1, ...(tags?.length ? { tags } : {}),
        updatedAt: t, deviceId,
      })
    }
    stats.pushed++
  }

  // ---- topology: chrome creates must be parent-first ----
  const orderedChrome = topoSortChrome(chromeOps, binding)

  // ---- new base: server tree as-is + bindings established by this plan ----
  const newBaseEntries: Record<string, { server: ServerNode; localId: string | null }> = {}
  for (const sn of server) {
    newBaseEntries[sn.id] = { server: sn, localId: binding.get(sn.id) ?? null }
  }
  // rows this plan PUSHES as creates (minted ids) must enter the new base
  // too — otherwise the next reconcile sees them as "server has, base has
  // not" and re-plans them (endless duplicate-create churn)
  const mintedOps = serverOps.filter((o) => o.op === 'create') as Array<{ id: string; title: string; url?: string; parentId: string; position: number; updatedAt: number; type: 'folder' | 'url' }>
  for (const o of mintedOps) {
    if (newBaseEntries[o.id]) continue
    newBaseEntries[o.id] = {
      server: {
        id: o.id, parentId: o.parentId, type: o.type, title: o.title,
        url: o.url || undefined, position: o.position, revision: 0,
        updatedAt: o.updatedAt, deviceId,
      },
      localId: binding.get(o.id) ?? null,
    }
  }
  // rebind rescues keep their (stale) server row in the base: the binding
  // must survive to the next reconcile even though the tree request raced
  Object.assign(newBaseEntries, rebindingEntries)

  stats.planned = orderedChrome.length + serverOps.length
  return { chromeOps: orderedChrome, serverOps, newBaseEntries, stats }
}

// ---- comparison helpers ----

function serverEq(a: ServerNode, b: ServerNode): boolean {
  return a.parentId === b.parentId && a.title === b.title &&
    normBookmarkUrl(a.url) === normBookmarkUrl(b.url) &&
    Math.abs(a.position - b.position) < 0.0001
}

// localDiffers: does the chrome node look different from what base recorded?
// chrome.bookmarks has no note/favorite/archive fields — those server-only
// fields must NEVER gate a local diff (the note comparison once caused an
// infinite update churn: comparing a field the cache cannot persist).
function localDiffers(ln: LocalNode, baseServer: ServerNode, touch: TouchJournal, localId: string): boolean {
  if (touch[localId]?.at) return true // any journaled local edit counts
  if (ln.title !== baseServer.title) return true
  if (normBookmarkUrl(ln.url) !== normBookmarkUrl(baseServer.url)) return true
  // structural: parent binding + position
  const parentKey = ln.parentId // adapter maps root buckets to '' already
  void parentKey
  return false // title/url equal and no touch: treat as unchanged (position drift handled by planPositionOnly)
}

// apply server state to the browser (update/move/remove-and-recreate)
function planServerToLocal(sn: ServerNode, ln: LocalNode, localId: string, chromeOps: ChromeOp[], stats: SyncPlan['stats'], rank: number) {
  if (ln.title !== sn.title || normBookmarkUrl(ln.url) !== normBookmarkUrl(sn.url)) {
    chromeOps.push({ kind: 'update', serverId: sn.id, localId, title: sn.title, url: sn.url })
    stats.chromeUpdates++
  }
  planPositionOnly(sn, ln, localId, chromeOps, stats, rank, 0)
}

// position-only drift: rebind parent/order without touching content.
// Compares the server-side RANK (0-based position among bound siblings)
// with the local index. Rank equality is achievable; raw positions are not
// (a web-UI create lands at MaxPosition+1 while the browser index is 0 —
// demanding raw equality produced endless move churn every reconcile).
function planPositionOnly(sn: ServerNode, ln: LocalNode, localId: string, chromeOps: ChromeOp[], stats: SyncPlan['stats'], rank: number, boundSiblingCount: number) {
  void localId
  void boundSiblingCount
  if (ln.index !== rank) {
    chromeOps.push({ kind: 'move', serverId: sn.id, localId, parentServerId: sn.parentId, index: rank })
    stats.chromeMoves++
  }
}

  // push the local node's content to the server. A local MOVE must carry
  // the new parent's server id (the browser-only parentId → server id
  // translation runs through the binding maps); quick-save TAGS ride the
  // touch journal onto the op.
  function pushLocalState(
    sn: ServerNode, ln: LocalNode, localId: string,
    serverOps: ServerOp[], deviceId: string, touch: TouchJournal, stats: SyncPlan['stats'],
    binding: Map<string, string | null>, reverse: Map<string, string>,
  ) {
    const t = touchAt(touch, localId) || Math.floor((ln.dateAdded || Date.now()) / 1000)
    const localParentSid = reverse.get(ln.parentId)
    const parentChanged = localParentSid !== undefined && localParentSid !== sn.parentId
    const tags = touch[localId]?.tags
    serverOps.push({
      op: 'update', id: sn.id,
      title: ln.title,
      ...(ln.url !== undefined ? { url: ln.url } : {}),
      ...(parentChanged ? { parentId: localParentSid } : {}),
      ...(tags?.length ? { tags } : {}),
      updatedAt: t, deviceId,
      observedRevision: sn.revision,
    })
    stats.pushed++
  }

// ---- topology: parents before children (chrome creates) ----

function topoSortChrome(ops: ChromeOp[], binding: Map<string, string | null>): ChromeOp[] {
  // creates reference parents by server id; a parent's own create must
  // precede them. Everything else keeps its original relative order.
  const creates = ops.filter((o): o is Extract<ChromeOp, { kind: 'create' }> => o.kind === 'create')
  const others = ops.filter((o) => o.kind !== 'create')
  if (!creates.length) return ops

  // Kahn's algorithm over the create set: an edge parent→child exists when
  // both are creates. Parents bound to existing local nodes are not creates
  // and thus always "ready".
  const createByServerId = new Map(creates.map((c) => [c.serverId, c]))
  const deps = new Map<string, Set<string>>() // serverId -> parent serverIds that are creates
  for (const c of creates) {
    const d = deps.get(c.serverId) || new Set<string>()
    if (createByServerId.has(c.parentServerId) && c.parentServerId !== c.serverId) {
      d.add(c.parentServerId)
    }
    deps.set(c.serverId, d)
  }
  const out: ChromeOp[] = []
  const ready = creates.filter((c) => (deps.get(c.serverId)?.size || 0) === 0)
  const pending = new Set(creates.filter((c) => (deps.get(c.serverId)?.size || 0) > 0).map((c) => c.serverId))
  const queue = [...ready]
  while (queue.length) {
    const c = queue.shift()!
    out.push(c)
    for (const sid of pending) {
      const d = deps.get(sid)
      if (d?.delete(c.serverId) && d.size === 0) {
        pending.delete(sid)
        queue.push(createByServerId.get(sid)!)
      }
    }
  }
  if (pending.size) {
    // cycle: cannot happen in a tree, but never hang — append the rest
    for (const sid of pending) out.push(createByServerId.get(sid)!)
  }
  // interleave: keep the original op order for non-creates, splice creates
  // in their topological position (creates first — the adapter executes
  // creates before it can move anything into them)
  return [...out, ...others]
}

// ---- deterministic id minting for local-only rows ----
// The minted id must be STABLE across re-plans of the same local node,
// otherwise every failed reconcile would mint a different id and the server
// would accumulate ghost rows. Derive from content + parent (not chrome id,
// which differs per browser profile): a UUIDv5-style hash.
export function mintStableId(n: LocalNode, parentServerId?: string): string {
  const key = `${n.type}|${n.title}|${normBookmarkUrl(n.url)}|${parentServerId || n.parentId}|${n.index}`
  return uuidFromHash(key)
}

function uuidFromHash(key: string): string {
  // FNV-1a 64-bit ×2 → 128 bits, formatted as a UUID v4-shaped string.
  // Not cryptographic; only needs uniqueness across the bookmark set.
  let h1 = 0x811c9dc5n, h2 = 0x01000193n
  const fnv = (h: bigint, c: number) => {
    h ^= BigInt(c)
    h *= 0x01000193n
    h &= 0xffffffffffffffffn
    return h
  }
  for (let i = 0; i < key.length; i++) {
    h1 = fnv(h1, key.charCodeAt(i))
    h2 = fnv(h2, key.charCodeAt(key.length - 1 - i))
  }
  const hex1 = h1.toString(16).padStart(16, '0')
  const hex2 = h2.toString(16).padStart(16, '0')
  const hex = (hex1 + hex2).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// ---- reconnection backoff ----

export function backoffDelay(attempt: number): number {
  const base = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)))
  return base * (0.75 + Math.random() * 0.5) // jitter
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
