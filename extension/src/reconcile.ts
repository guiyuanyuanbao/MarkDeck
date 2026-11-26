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

export type ServerOp =
  | { op: 'create'; id: string; parentId: string; type: 'folder' | 'url'; title: string; url?: string; position: number; updatedAt: number; deviceId: string }
  | { op: 'update'; id: string; title: string; url?: string; parentId?: string; tags?: string[]; undelete?: boolean; updatedAt: number; deviceId: string; observedRevision: number }
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

// URL normalization shared by adoption matching: trailing slashes, case,
// AND percent-encoding are insignificant to bookmark identity. Chrome
// percent-encodes non-ASCII characters when a bookmark is created
// (https://x/中文 → https://x/%e4%b8%ad%e6%96%87), while other clients
// store the raw characters — comparing them literally re-materialized the
// same bookmark every reconcile (remove+create churn forever).
export function normBookmarkUrl(raw: string | undefined): string {
  if (!raw) return ''
  let u = raw.trim().replace(/\/+$/, '').toLowerCase()
  try {
    // decode AFTER lowercasing so %2F and %2f compare equal; a decode
    // failure (bare %) keeps the raw form — best-effort normalization
    u = decodeURIComponent(u)
    u = u.replace(/\/+$/, '').toLowerCase()
  } catch { /* malformed escape: keep as-is */ }
  return u
}

function touchAt(touch: TouchJournal, localId: string | undefined): number {
  if (!localId) return 0
  return touch[localId]?.at || 0
}

// ---- per-reconcile context ----

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

// Shared state threaded through the planning helpers: the maps the passes
// build (bindings, children, ranks, adoption index) plus the op/stats
// accumulators. One ctx replaces the former 7-11-argument helper
// signatures, which re-plumbed the same values at every call site.
interface Ctx {
  chromeOps: ChromeOp[]
  serverOps: ServerOp[]
  stats: SyncPlan['stats']
  binding: Map<string, string | null> // serverId -> localId as the plan leaves it
  reverse: Map<string, string> // localId -> serverId
  serverById: Map<string, ServerNode>
  localById: Map<string, LocalNode>
  localChildren: Map<string, LocalNode[]>
  serverRank: Map<string, number>
  unboundByUrl: Map<string, LocalNode[]>
  touch: TouchJournal
  deviceId: string
  othersId: string
  barRootLid?: string
  otherRootLid?: string
}

// ---- the engine ----

export function planSync(input: PlanInput): SyncPlan {
  const { server, touch, deviceId } = input
  const base = input.base && input.base.head > 0 ? input.base : null
  const serverById = new Map(server.map((n) => [n.id, n]))
  const localById = new Map(input.local.map((n) => [n.id, n]))

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
  const otherRootLocal = input.local.find((n) => (n as LocalNode & { isOtherRoot?: boolean }).isOtherRoot)
  if (otherRootLocal) {
    binding.set(input.othersId, otherRootLocal.id)
    reverse.set(otherRootLocal.id, input.othersId)
  }

  // The local tree adapter passes root buckets with parentId '' (bar root
  // first, other root marked). Server top-level rows (parentId '') live in
  // the bar bucket; the adapter resolves server-top-level → bar root id.
  // Root buckets are FOLDER nodes; a url node with parentId '' in a
  // synthetic/unit tree is a top-level bookmark, NOT a bucket — requiring
  // type folder keeps parent-matching from mistaking the bookmark under
  // test for its own root (which planned spurious moves).
  const barRootLocal = input.local.find((n) => n.parentId === '' && n.type === 'folder' && n !== otherRootLocal)

  // index local children by parent for move/position planning
  const localChildren = new Map<string, LocalNode[]>()
  for (const n of input.local) {
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
  for (const n of input.local) {
    if (n.type !== 'url') continue
    if (reverse.has(n.id)) continue // already bound via base
    const key = normBookmarkUrl(n.url)
    const arr = unboundByUrl.get(key) || []
    arr.push(n)
    unboundByUrl.set(key, arr)
  }

  const ctx: Ctx = {
    chromeOps, serverOps, stats, binding, reverse,
    serverById, localById, localChildren, serverRank, unboundByUrl,
    touch, deviceId,
    othersId: input.othersId,
    barRootLid: barRootLocal?.id,
    otherRootLid: otherRootLocal?.id,
  }

  // ---- Pass 1: server-side rows ----
  // Orphan normalization FIRST: a row whose parent id is not itself in the
  // server tree (parent deleted while the child survived — messy-history
  // artifact) re-parents to top level, matching server-side Restore's
  // semantics. Creating it under a dead parent id would fail parent lookup.
  const orphanIds = new Set<string>()
  const normalizedServer = server.map((sn) => {
    if (sn.parentId !== '' && !serverById.has(sn.parentId)) {
      orphanIds.add(sn.id)
      return { ...sn, parentId: '' }
    }
    return sn
  })
  for (const sn of normalizedServer) {
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
          adoptBinding(ctx, sn.id, cand, normBookmarkUrl(sn.url))
          // Title divergence on adoption: a journaled local edit that is
          // NEWER than the server row must PUSH (the pending edit survives
          // forceResync — the touch journal is the adoption pass's only
          // record of edits that never reached the server). Only an older
          // or unjournaled node absorbs the server title.
          if (cand.title !== sn.title) {
            const tt = touchAt(touch, cand.id)
            if (tt > sn.updatedAt) {
              pushLocalState(ctx, sn, cand, cand.id)
            } else if (!touch[cand.id]) {
              chromeOps.push({ kind: 'update', serverId: sn.id, localId: cand.id, title: sn.title, url: sn.url })
            }
          }
          continue
        }
      }
      // folders: adopt a same-title unbound folder under the same bound
      // parent (two rebuilds must converge on one folder shell, v0.0.20).
      // Server top-level ('') resolves to the local bar bucket.
      // NOT for freshly-journaled local folders on a PAIRED device: an
      // unbound folder with a touch NEWER than the server row is this
      // device's own pending create (two devices racing same-title
      // folders) — adopting it would swallow the second device's create
      // into the first device's row. Adoption only claims rows the
      // server already held. On a FIRST pair (base === null) every local
      // node is pre-pair content being IMPORTED: its touch predates any
      // server knowledge, so touch must NOT block adoption there.
      if (sn.type === 'folder') {
        const parentLid = sn.parentId === '' && barRootLocal
          ? barRootLocal.id
          : sn.parentId === input.othersId && otherRootLocal
            ? otherRootLocal.id
            : binding.get(sn.parentId) ?? null
        if (parentLid) {
          const sibs = localChildren.get(parentLid) || []
          const same = sibs.filter((s) => s.type === 'folder' && s.title === sn.title && !reverse.has(s.id))
          const cand = same.length === 1 ? same[0] : undefined
          const candTouch = cand ? touchAt(touch, cand.id) : 0
          const serverNewer = sn.updatedAt > candTouch
          const pendingOwnCreate = base !== null && cand !== undefined && !!touch[cand.id] && !serverNewer
          if (cand && !pendingOwnCreate) {
            adoptBinding(ctx, sn.id, cand, normBookmarkUrl(cand.url))
            continue
          }
        }
      }
      chromeOps.push(createOpFromServerRow(sn))
      continue
    }

    // row existed in base: three-way compare
    const serverChanged = !serverEq(bEntry.server, sn)
    const localChanged = ln ? localDiffers(ln, bEntry.server, touch, localId as string) : true // null binding = never placed

    if (!ln) {
      // the chrome node is gone. Distinguish WHY:
      //  - touch says the user deleted it locally AND the deletion is newer
      //    than the server row (local delete beats a stale server row) →
      //    push the delete. A server RESTORE bumps updatedAt past the local
      //    deletion, so a restored subtree re-creates locally (B2c) instead
      //    of being re-deleted by the stale journal — deletes are LWW too.
      //  - binding was null (never placed) → nothing local to lose
      //  - otherwise the node vanished un-journaled (profile reset?) →
      //    recreate from the server row (the server still holds it)
      const tRemoved = localId ? touch[localId]?.removed : undefined
      if (localId && tRemoved && touch[localId].at > sn.updatedAt) {
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
        chromeOps.push(createOpFromServerRow(sn))
      } else {
        // unchanged row whose local node vanished without a journal entry
        // (profile reset, manual storage wipe): adopt by URL or recreate
        if (sn.type === 'url') {
          const cand = unboundByUrl.get(normBookmarkUrl(sn.url))?.[0]
          if (cand) {
            adoptBinding(ctx, sn.id, cand, normBookmarkUrl(sn.url))
            continue
          }
        }
        chromeOps.push(createOpFromServerRow(sn))
      }
      continue
    }

    // both sides present
    // ORPHAN REPAIR FIRST: a row whose server parent died must converge on
    // the browser's healthy placement (push the parent fix) regardless of
    // what the content compare says — the normalized parent ('') differs
    // from base's dead-parent record, which would otherwise trigger a
    // browser move to an unresolvable parent instead of a server repair.
    if (orphanIds.has(sn.id) && ln) {
      const localParentSid = reverse.get(ln.parentId) ?? ''
      serverOps.push({
        op: 'update', id: sn.id, title: ln.title,
        parentId: localParentSid === input.othersId ? input.othersId : '',
        updatedAt: Math.max(touchAt(touch, localId as string), input.now),
        deviceId, observedRevision: sn.revision,
      })
      stats.pushed++
      continue
    }
    if (serverChanged && localChanged) {
      // both moved since base: LWW by timestamps (touch time vs server time)
      const t = touchAt(touch, localId ?? undefined)
      if (t > sn.updatedAt) {
        // local edit is newer: push local state
        pushLocalState(ctx, sn, ln, localId as string)
      } else {
        // server is newer (or tie): apply server state to the browser
        planServerToLocal(ctx, sn, ln, localId as string, serverRank.get(sn.id) ?? 0)
      }
    } else if (serverChanged) {
      planServerToLocal(ctx, sn, ln, localId as string, serverRank.get(sn.id) ?? 0)
    } else if (localChanged) {
      // Guard against re-pushing DOOMED updates: a previous round may have
      // pushed this edit and lost the LWW race (base advanced past the
      // rejection — snapshot era has no per-op ack). The engine's honest
      // signal is time: when the local touch is STRICTLY OLDER than the
      // server row, the local content is STALE — the browser must absorb
      // the server state instead of re-pushing forever (snapshot-restore
      // and dual-device races land here). EQUAL timestamps still push:
      // the server's same-second tie rule (observedRevision) lets a
      // legitimate follow-up edit win, and resync runs sub-second — a
      // `<=` here would eat genuine fresh edits.
      const t = touchAt(touch, localId ?? undefined)
      if (t < sn.updatedAt) {
        planServerToLocal(ctx, sn, ln, localId as string, serverRank.get(sn.id) ?? 0)
      } else {
        pushLocalState(ctx, sn, ln, localId as string)
      }
    } else {
      // convergence check: positions may still drift (e.g. index churn on
      // one side). Structurally bound rows (other-bookmarks root) never
      // move — their browser position is the root bucket's own.
      if (sn.id !== input.othersId) {
        planPositionOnly(ctx, sn, ln, localId as string, serverRank.get(sn.id) ?? 0)
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

      // UNCONFIRMED MINTED ROW: revision 0 means the server never accepted
      // this create (offline push raced a parent delete and was rejected —
      // base still advanced because a failed reconcile cannot be told from
      // a partial win). This is a pending local ADDITION, not a server
      // deletion: re-push it with the parent re-rooted to the nearest
      // SURVIVING bound ancestor. Removing the local node here would
      // destroy the user's offline work permanently.
      if (entry.server.revision === 0 && ln) {
        // walk the minted chain up: find the closest ancestor that still
        // exists in the server tree (bound or structural root)
        let parentSid = ''
        let anc: string | undefined = entry.server.parentId
        let depth = 0
        while (anc && depth < 50) {
          if (anc === '' || serverById.has(anc) || anc === input.othersId) { parentSid = anc; break }
          const baseParent: { server: ServerNode; localId: string | null; appliedAt: number } | undefined = base.entries[anc]
          if (baseParent && baseParent.localId && localById.get(baseParent.localId)) {
            anc = baseParent.server.parentId
          } else {
            break
          }
          depth++
        }
        const t = touchAt(touch, localId as string) || entry.server.updatedAt
        if (entry.server.type === 'url') {
          serverOps.push({
            op: 'create', id: sid, parentId: parentSid, type: 'url',
            title: ln.title, url: ln.url || '', position: ln.index + 1,
            updatedAt: Math.max(t, entry.server.updatedAt), deviceId,
          })
        } else {
          serverOps.push({
            op: 'create', id: sid, parentId: parentSid, type: 'folder',
            title: ln.title, position: ln.index + 1,
            updatedAt: Math.max(t, entry.server.updatedAt), deviceId,
          })
        }
        stats.pushed++
        // keep the minted base entry but refresh the projected parent so a
        // rejected push re-plans identically (re-rooted, never as a delete)
        rebindingEntries[sid] = {
          server: { ...entry.server, parentId: parentSid },
          localId: ln.id,
        }
        continue
      }

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
          undelete: true,
          updatedAt: t,
          deviceId,
          observedRevision: entry.server.revision,
        })
        stats.pushed++
        continue
      }
      // The undelete push already lost once (t <= updatedAt): the server
      // row was deleted (or PURGED — undelete refuses purged rows, the
      // rejection is silent) with a timestamp at or after the local edit.
      // Re-pushing every reconcile would loop forever. Deletion wins:
      // plan the local remove (the ln branch below handles it — with the
      // touch treated as consumed so pass 3 does not resurrect the same
      // node as a fresh local-only create, which would ping-pong
      // remove/create against the server's delete).
      if (ln && localId) {
        chromeOps.push({ kind: 'remove', serverId: sid, localId: ln.id })
        stats.chromeRemoves++
        binding.delete(sid)
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
          adoptBinding(ctx, sid, cand[0], normBookmarkUrl(entry.server.url))
          rebindingEntries[sid] = { server: entry.server, localId: cand[0].id } // rebind into next base
          continue
        }
      }

      if (ln) {
        chromeOps.push({ kind: 'remove', serverId: sid, localId: ln.id })
        stats.chromeRemoves++
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
  for (const n of input.local) {
    if (n.parentId === '') continue // root buckets
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
    // parent id → server id. CRITICAL data-loss guard: the local parent may
    // be bound to a row the SERVER has just deleted (offline create inside
    // a folder that raced a server-side delete). Pushing the create under
    // that id gets rejected ('parent in trash') AND the folder's chrome
    // remove (same plan, pass 2) cascades away the local copy — the new
    // bookmark is gone from BOTH ends, silently. Re-root the create to the
    // nearest ancestor the server still holds: the push lands (top level),
    // the cascade only loses a copy the server now owns, and the next
    // reconcile restores the node. Content can no longer be destroyed by
    // this race.
    let parentSid: string = ''
    {
      let ancLid: string | undefined = n.parentId
      let depth = 0
      while (ancLid && depth < 50) {
        const sid = reverse.get(ancLid)
        if (sid !== undefined) {
          if (sid === input.othersId) { parentSid = input.othersId; break }
          // live on the server, OR minted earlier in THIS pass (parents
          // precede children in the local walk, so a minted parent's create
          // is already queued — same-batch parent ordering the server
          // applies in order)
          if (serverById.has(sid) || serverOps.some((o) => o.op === 'create' && o.id === sid)) { parentSid = sid; break }
          // bound but server-deleted: walk further up the LOCAL chain
          ancLid = localById.get(ancLid)?.parentId
          depth++
          continue
        }
        if (ancLid === barRootId) { parentSid = ''; break }
        if (ancLid === otherRootLocal?.id) { parentSid = input.othersId; break }
        ancLid = localById.get(ancLid)?.parentId
        depth++
      }
    }
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
  const orderedChrome = topoSortChrome(chromeOps)

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
  return false // title/url equal and no touch: treat as unchanged (position drift handled by planPositionOnly)
}

// parent-equivalence for placement planning: the browser parent (chrome id)
// matches the server parent (server id) when the plan's bindings say so.
// The two root buckets are structural: '' ↔ bar-root chrome id, othersId ↔
// other-root chrome id. Without this, comparing ids literally planned
// moves forever ('bar' !== '') or never planned cross-root moves
// (rank equal, parent "equal" though the node sat in the other root).
// UNDECIDABLE is not UNMATCHED: when neither the binding nor a structural
// root can identify the local parent (degenerate trees without root
// buckets, e.g. synthetic unit trees), the check abstains — abstaining
// never plans a move (pre-fix behavior), so no churn can regress.
function localParentMatchesServer(
  ln: LocalNode, snParentId: string, ctx: Ctx,
): boolean | null {
  const lp = ln.parentId
  if (snParentId === '' && ctx.barRootLid !== undefined) return lp === ctx.barRootLid
  if (snParentId === ctx.othersId && ctx.otherRootLid !== undefined) return lp === ctx.otherRootLid
  const bound = ctx.reverse.get(lp)
  if (bound !== undefined) return bound === snParentId
  // the local parent is a root bucket but the server parent is a REAL row
  // (or vice versa): the node moved between a root and a folder — that is
  // a definite mismatch, never an abstention (a swap-reparent batch left
  // the inner folder stranded at top level when this returned null).
  if ((lp === ctx.barRootLid || lp === ctx.otherRootLid) && snParentId !== '' && snParentId !== ctx.othersId) {
    return false
  }
  // binding unknown AND no structural root: abstain
  return null
}

// ---- planning helpers ----

// chrome create op materializing a server row: the raw server position is
// 1-based and may be scattered (MaxPosition+1 from web creates), so convert
// to a 0-based index and clamp. Order converges later through rank-based
// move ops.
function createOpFromServerRow(sn: ServerNode): ChromeOp {
  return {
    kind: 'create', serverId: sn.id, parentServerId: sn.parentId,
    type: sn.type, title: sn.title, url: sn.url,
    index: Math.max(0, Math.round(sn.position) - 1),
  }
}

// bind an unbound browser node to a server row (adoption/rebind): record it
// in both binding directions, retire the node from the URL adoption index,
// count it. Callers pass the normalized URL key of the SERVER row — a
// folder has no URL, and its key ('') can never collide with real entries.
function adoptBinding(ctx: Ctx, sid: string, cand: LocalNode, urlKey: string) {
  ctx.binding.set(sid, cand.id)
  ctx.reverse.set(cand.id, sid)
  ctx.unboundByUrl.delete(urlKey)
  ctx.stats.adopted++
}

// apply server state to the browser (update/move/remove-and-recreate).
// chrome.bookmarks.update can only change the TITLE — a URL change cannot
// be applied in place, and dropping it made the browser keep the old URL
// forever while every reconcile churned. A URL-differing row is therefore
// re-materialized: remove the bound node, recreate with the new URL (the
// binding re-forms in this same plan via createdBindings).
function planServerToLocal(ctx: Ctx, sn: ServerNode, ln: LocalNode, localId: string, rank: number) {
  const urlChanged = sn.type === 'url' && normBookmarkUrl(ln.url) !== normBookmarkUrl(sn.url)
  if (urlChanged) {
    ctx.chromeOps.push({ kind: 'remove', serverId: sn.id, localId })
    ctx.stats.chromeRemoves++
    ctx.chromeOps.push({ kind: 'create', serverId: sn.id, parentServerId: sn.parentId, type: 'url', title: sn.title, url: sn.url, index: rank })
    ctx.stats.chromeCreates++
    return
  }
  if (ln.title !== sn.title) {
    ctx.chromeOps.push({ kind: 'update', serverId: sn.id, localId, title: sn.title, url: sn.url })
    ctx.stats.chromeUpdates++
  }
  planPositionOnly(ctx, sn, ln, localId, rank)
}

// position-only drift: rebind parent/order without touching content.
// Compares the server-side RANK (0-based position among bound siblings)
// with the local index, AND the parent binding (via the plan's reverse
// map + structural roots). Rank equality is achievable; raw positions are
// not (a web-UI create lands at MaxPosition+1 while the browser index is
// 0 — demanding raw equality produced endless move churn every reconcile).
// The parent MUST be compared through bindings: rank is per-parent, so a
// node moved between roots (holder ↔ bar, index 0 → rank 0) shares the
// rank but sits under the WRONG parent — comparing index alone made every
// cross-root server move silently never reach the browser.
function planPositionOnly(ctx: Ctx, sn: ServerNode, ln: LocalNode, localId: string, rank: number) {
  const parentCheck = localParentMatchesServer(ln, sn.parentId, ctx)
  // null = undecidable → abstain (no move from the parent axis alone)
  const parentMismatch = parentCheck === false
  if (ln.index !== rank || parentMismatch) {
    ctx.chromeOps.push({ kind: 'move', serverId: sn.id, localId, parentServerId: sn.parentId, index: rank })
    ctx.stats.chromeMoves++
  }
}

// push the local node's content to the server. A local MOVE must carry
// the new parent's server id (the browser-only parentId → server id
// translation runs through the binding maps); quick-save TAGS ride the
// touch journal onto the op.
function pushLocalState(ctx: Ctx, sn: ServerNode, ln: LocalNode, localId: string) {
  const t = touchAt(ctx.touch, localId) || Math.floor((ln.dateAdded || Date.now()) / 1000)
  const localParentSid = ctx.reverse.get(ln.parentId)
  const parentChanged = localParentSid !== undefined && localParentSid !== sn.parentId
  const tags = ctx.touch[localId]?.tags
  ctx.serverOps.push({
    op: 'update', id: sn.id,
    title: ln.title,
    ...(ln.url !== undefined ? { url: ln.url } : {}),
    ...(parentChanged ? { parentId: localParentSid } : {}),
    ...(tags?.length ? { tags } : {}),
    updatedAt: t, deviceId: ctx.deviceId,
    observedRevision: sn.revision,
  })
  ctx.stats.pushed++
}

// ---- topology: parents before children (chrome creates) ----

function topoSortChrome(ops: ChromeOp[]): ChromeOp[] {
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

// ---- root-id resolution (chrome adapter helper, kept pure for tests) ----

export interface ResolvedRoots {
  barId: string
  otherId: string
}

/**
 * Chromium invariant (Chrome AND Edge): root children[0] = bookmarks bar,
 * children[1] = other bookmarks (children[2] is Mobile bookmarks when
 * present — taking the last child once grabbed Mobile on Edge and silently
 * excluded 94 bookmarks). Titles are localized; never match on them.
 * Root ids are NOT fixed '1'/'2' — newer profiles assign GUID permanent ids.
 * Throws when the profile exposes fewer than two roots (single-root or
 * malformed tree): callers surface the error instead of syncing the wrong
 * scope. Extracted from background.ts so the TESTS drive the real logic
 * (roots.test.ts previously re-implemented these rules and could drift).
 */
export function resolveRootsFromTree(
  tree: Array<{ id?: string; children?: Array<{ id: string; title?: string }> | null }>
): ResolvedRoots {
  const kids = tree[0]?.children ?? []
  if (kids.length < 2) throw new Error('bookmark tree has no bar/other roots')
  return { barId: kids[0].id, otherId: kids[1].id }
}
