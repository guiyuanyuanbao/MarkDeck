// Adversarial audit suite for the reorder-sweep change (2026-11-27).
// Companion to reorder-matrix.test.ts: this file attacks the NEW code paths
// with the failure modes an audit turn surfaced — orphan rows, duplicate
// positions, empty buckets, pending creates landing mid-sweep, sibling
// deletions racing a drag, cross-root moves, clock skew, and the
// multi-bucket interaction (bar + folder swept in the SAME plan).
import { describe, it, expect } from 'vitest'
import {
  planSync,
  type ServerNode, type LocalNode, type Base, type TouchJournal, type PlanInput,
} from '../src/reconcile'

let rev = 100
function sn(partial: Partial<ServerNode> & { id: string; type: 'folder' | 'url'; title: string }): ServerNode {
  rev++
  return { parentId: '', position: 1, revision: rev, updatedAt: 1000, deviceId: 'srv', ...partial }
}
function ln(partial: Partial<LocalNode> & { id: string; type: 'folder' | 'url'; title: string }): LocalNode {
  return { parentId: '', index: 0, ...partial }
}
function makeBase(entries: Array<{ server: ServerNode; localId: string | null }>, head = 500, othersId = 'md-others'): Base {
  const e: Base['entries'] = {}
  for (const x of entries) e[x.server.id] = { server: x.server, localId: x.localId, appliedAt: 0 }
  return { head, othersId, entries: e }
}
function input(partial: Partial<PlanInput>): PlanInput {
  return {
    server: [], local: [], base: null, touch: {},
    deviceId: 'dev-1', now: 2000, othersId: 'md-others',
    ...partial,
  }
}
const otherRoot = (n: LocalNode): LocalNode & { isOtherRoot: boolean } => Object.assign(n, { isOtherRoot: true })
const posOf = (p: ReturnType<typeof planSync>, id: string) =>
  (p.serverOps.find((o) => o.op === 'update' && o.id === id) as { position?: number } | undefined)?.position

describe('A1: orphan row (dead parent) inside a swept bucket', () => {
  it('orphan repair carries the sweep position — one op, parent fixed AND slot set', () => {
    // server: folder f1 (dead — absent from the tree) used to hold 'Orphan';
    // the row survives with parentId='f1'. Browser shows it at bar index 1.
    // A local drag vouches the bar bucket.
    const live1 = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 })
    const orphan = sn({ id: 'orph', type: 'url', title: 'Orphan', url: 'https://o', parentId: 'f1-dead', position: 1, updatedAt: 1000 })
    const base = makeBase([
      { server: live1, localId: 'la' },
      { server: { ...orphan, parentId: '' }, localId: 'lo' }, // base saw it at top level
    ])
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'la', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 0 }),
      ln({ id: 'lo', type: 'url', title: 'Orphan', url: 'https://o', parentId: 'bar', index: 1 }),
    ]
    const p = planSync(input({ server: [live1, orphan], local, base, touch: { lo: { at: 1800 } } }))
    const ops = p.serverOps.filter((o) => o.op === 'update' && o.id === 'orph')
    // exactly ONE op for the orphan (no double-planning), carrying parentId ''
    expect(ops).toHaveLength(1)
    expect((ops[0] as { parentId?: string }).parentId).toBe('')
    // no chrome moves: the browser placement wins
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
  })
})

describe('A2: duplicate raw positions on the server', () => {
  it('two siblings sharing raw position: rank still distinguishes them, sweep normalizes', () => {
    // both rows at raw 5 — server orders by (position, created_at); the
    // engine sees ranks 0 and 1 and plans the browser order accordingly
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 5, updatedAt: 1000, revision: 10 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 5, updatedAt: 1000, revision: 11 })
    const server = [a, b]
    const base = makeBase(server.map((s) => ({ server: s, localId: s.id })))
    // browser wants [B, A] — drag vouched
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    const p = planSync(input({ server, local, base, touch: { b: { at: 1800 } } }))
    expect(posOf(p, 'b')).toBe(1)
    expect(posOf(p, 'a')).toBe(2)
    // no chrome moves fighting the drag
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
    // fixedpoint: server now normalized, browser unchanged → zero ops
    const serverNow = [
      { ...a, position: 2, updatedAt: 1800, revision: 20 },
      { ...b, position: 1, updatedAt: 1800, revision: 21 },
    ]
    const p2 = planSync(input({ server: serverNow, local, base: makeBase(serverNow.map((s) => ({ server: s, localId: s.id })), 600), touch: {} }))
    expect(p2.serverOps).toEqual([])
    expect(p2.chromeOps).toEqual([])
  })
})

describe('A3: empty buckets never plan POSITION ops', () => {
  it('bar with only the holder row + no local children plans no position/sweep ops', () => {
    const holder = sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 })
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      otherRoot(ln({ id: 'oroot', type: 'folder', title: '其他书签', parentId: '' })),
    ]
    const base = makeBase([{ server: holder, localId: 'oroot' }], 500)
    // a journal on the OTHER ROOT (e.g. a rename echo) may push the holder's
    // content op — pre-existing pushLocalState semantics — but the SWEEP must
    // never emit position ops for the holder (it is structurally bound)
    const p = planSync(input({ server: [holder], local, base, touch: { oroot: { title: '其他书签', at: 1800 } } }))
    expect(p.serverOps.filter((o) => (o as { position?: number }).position !== undefined)).toEqual([])
    expect(p.chromeOps).toEqual([])
  })
})

describe('A4: pending create + pending remove in the SAME bucket', () => {
  it('create occupies its slot, removed row vacates — sweep renumbers the survivors', () => {
    // server [A(1), B(2)]; browser deletes B and inserts New between... →
    // sequence [New(0), A(1)]. After the plan: A keeps slot 2? NO — B is
    // being deleted and New takes slot 1, so A must move to slot 2.
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 })
    const server = [a, b]
    const base = makeBase([{ server: a, localId: 'la' }, { server: b, localId: 'lb' }])
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'ln', type: 'url', title: 'New', url: 'https://new', parentId: 'bar', index: 0 }),
      ln({ id: 'la', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    const touch: TouchJournal = { lb: { at: 1800, removed: true }, ln: { at: 1801 } }
    const p = planSync(input({ server, local, base, touch }))
    // B deleted server-side
    expect(p.serverOps.some((o) => o.op === 'delete' && o.id === 'b')).toBe(true)
    // New created at slot 1
    const create = p.serverOps.find((o) => o.op === 'create') as { position: number } | undefined
    expect(create?.position).toBe(1)
    // A pushed to slot 2 (its browser index 1 + 1)
    expect(posOf(p, 'a')).toBe(2)
    // B was deleted OFFLINE (the node is already gone from chrome): the
    // engine pushes a server DELETE for it — no chrome remove can exist
    expect(p.serverOps.some((o) => o.op === 'delete' && o.id === 'b')).toBe(true)
    expect(p.chromeOps.filter((o) => o.kind === 'remove' && o.localId === 'lb')).toEqual([])
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
  })
})

describe('A5: two buckets swept in the SAME plan', () => {
  it('bar AND a nested folder both dragged — independent slots, no cross-talk', () => {
    const f = sn({ id: 'f', type: 'folder', title: 'F', position: 1, updatedAt: 1000 })
    const f1 = sn({ id: 'f1', type: 'url', title: 'F1', url: 'https://f1', parentId: 'f', position: 1, updatedAt: 1000 })
    const f2 = sn({ id: 'f2', type: 'url', title: 'F2', url: 'https://f2', parentId: 'f', position: 2, updatedAt: 1000 })
    const b1 = sn({ id: 'b1', type: 'url', title: 'B1', url: 'https://b1', position: 2, updatedAt: 1000 })
    const server = [f, f1, f2, b1]
    const base = makeBase(server.map((s) => ({ server: s, localId: s.id })))
    // browser: folder children reversed [F2, F1]; bar has F at 0, B1 at 1
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'f', type: 'folder', title: 'F', parentId: 'bar', index: 0 }),
      ln({ id: 'b1', type: 'url', title: 'B1', url: 'https://b1', parentId: 'bar', index: 1 }),
      ln({ id: 'f2', type: 'url', title: 'F2', url: 'https://f2', parentId: 'f', index: 0 }),
      ln({ id: 'f1', type: 'url', title: 'F1', url: 'https://f1', parentId: 'f', index: 1 }),
    ]
    // bar order already matches ranks (F@0, B1@1) — no bar drift; only the
    // folder's children drift.
    const p = planSync(input({ server, local, base, touch: { f2: { at: 1800 } } }))
    expect(posOf(p, 'f2')).toBe(1)
    expect(posOf(p, 'f1')).toBe(2)
    // bar rows untouched (no drift there)
    expect(posOf(p, 'b1')).toBeUndefined()
    expect(posOf(p, 'f')).toBeUndefined()
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
  })
})

describe('A6: clock skew — future-dated touch clamps, past-dated touch loses', () => {
  it('a touch 10 minutes in the future still wins (server clamps at +300s)', () => {
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 })
    const server = [a, b]
    const base = makeBase([{ server: a, localId: 'a' }, { server: b, localId: 'b' }])
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    // now = 2000; touch 2600 (10 min ahead) — plan must still emit the sweep
    const p = planSync(input({ server, local, base, touch: { b: { at: 2600 } }, now: 2000 }))
    expect(posOf(p, 'b')).toBe(1)
    expect(posOf(p, 'a')).toBe(2)
  })

  it('a far-past touch with a server row touched since base loses (no stale override)', () => {
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1500 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1500 })
    const server = [a, b]
    const base = makeBase([
      { server: { ...a, updatedAt: 1000 }, localId: 'a' },
      { server: { ...b, updatedAt: 1000 }, localId: 'b' },
    ])
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    // both server rows moved since base (1500 > 1000); the drag is 1200 < 1500
    const p = planSync(input({ server, local, base, touch: { b: { at: 1200 } }, now: 2000 }))
    expect(p.serverOps).toEqual([]) // stale drag must not override the remote edits
    expect(p.chromeOps.filter((o) => o.kind === 'move').length).toBeGreaterThan(0) // browser absorbs server order
  })
})

describe('A7: sibling renamed remotely while the drag is in flight', () => {
  it('the sweep op wins the slot but the remote title survives (no title in the op)', () => {
    const a = sn({ id: 'a', type: 'url', title: 'A-web', url: 'https://a', position: 1, updatedAt: 1500 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 })
    const server = [a, b]
    // base knew A as 'A' at updatedAt 1000 — the web renamed it at 1500
    const base = makeBase([
      { server: { ...a, title: 'A', updatedAt: 1000 }, localId: 'a' },
      { server: b, localId: 'b' },
    ])
    // browser still shows the OLD title and the user dragged B to the top at 1800
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    const p = planSync(input({ server, local, base, touch: { b: { at: 1800 } } }))
    // drag (1800) beats the remote rename (1500): sweep proceeds
    expect(posOf(p, 'b')).toBe(1)
    expect(posOf(p, 'a')).toBe(2)
    // A's op must NOT carry a title (the sweep never writes content) —
    // the remote 'A-web' title must survive the position write
    const aOp = p.serverOps.find((o) => o.op === 'update' && o.id === 'a') as { title?: string } | undefined
    expect(aOp?.title).toBeUndefined()
    // A's local browser title update comes from the content pass
    expect(p.chromeOps.some((o) => o.kind === 'update' && o.localId === 'a' && o.title === 'A-web')).toBe(true)
  })
})

describe('A8: deleted-locally row must not vouch the sweep', () => {
  it('a removed journal on a child neither vouches nor occupies a slot', () => {
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 })
    const c = sn({ id: 'c', type: 'url', title: 'C', url: 'https://c', position: 3, updatedAt: 1000 })
    const server = [a, b, c]
    const base = makeBase(server.map((s) => ({ server: s, localId: s.id })))
    // browser deleted C; order [B, A] for the survivors. The ONLY journal is
    // C's removal — no drag happened.
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    const p = planSync(input({ server, local, base, touch: { c: { at: 1800, removed: true } } }))
    // C is deleted; the survivor sequence B,A vs server rank A,B DOES drift —
    // but the only journal is a removal, which must not reorder the server.
    expect(p.serverOps.filter((o) => o.op === 'update' && (o as { position?: number }).position !== undefined)).toEqual([])
    expect(p.serverOps.some((o) => o.op === 'delete' && o.id === 'c')).toBe(true)
  })
})

describe('A9: bucket membership with a folder row bound to a DIFFERENT local parent', () => {
  it('a server child whose local node sits elsewhere makes the bucket abstain', () => {
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 })
    const f = sn({ id: 'f', type: 'folder', title: 'F', position: 3, updatedAt: 1000 })
    const server = [a, b, f]
    const base = makeBase(server.map((s) => ({ server: s, localId: s.id })))
    // b's local node lives under f (a cross-parent move in flight) — the bar
    // bucket is mid-mutation, its sequence is transient → abstain
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'f', type: 'folder', title: 'F', parentId: 'bar', index: 1 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 0 }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'f', index: 0 }),
    ]
    const p = planSync(input({ server, local, base, touch: { b: { at: 1800 } } }))
    // bar bucket must not sweep (membership incomplete) — the move pushes
    // b's parentId instead, and no position-only op targets the bar rows
    expect(posOf(p, 'a')).toBeUndefined()
    expect(posOf(p, 'f')).toBeUndefined()
    const bOp = p.serverOps.find((o) => o.op === 'update' && o.id === 'b') as { parentId?: string } | undefined
    expect(bOp?.parentId).toBe('f')
  })
})

describe('A10: first pair (base === null) must never sweep', () => {
  it('no base means no settled order to compare — adoption path plans no position ops', () => {
    const server = [
      sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1 }),
      sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2 }),
    ]
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    const p = planSync(input({ server, local, base: null, touch: { b: { at: 1800 } } }))
    // first pair: nodes adopt; the browser order is NOT asserted onto the
    // server (nothing has been agreed yet — the server is the source of truth)
    expect(p.serverOps.filter((o) => o.op === 'update' && (o as { position?: number }).position !== undefined)).toEqual([])
    expect(p.stats.adopted).toBe(2)
  })
})

describe('A11: sweep must not fight a web reorder that landed mid-drag', () => {
  it('web reorder bumps every sibling past the drag → sweep abstains for that bucket only', () => {
    const f = sn({ id: 'f', type: 'folder', title: 'F', position: 1, updatedAt: 1000 })
    // web REVERSED the folder children at 1900: server now [FB(1900), FA(1901)]
    const fb = sn({ id: 'fb', type: 'url', title: 'FB', url: 'https://fb', parentId: 'f', position: 1900, updatedAt: 1900 })
    const fa = sn({ id: 'fa', type: 'url', title: 'FA', url: 'https://fa', parentId: 'f', position: 1901, updatedAt: 1900 })
    const ba = sn({ id: 'ba', type: 'url', title: 'BA', url: 'https://ba', position: 1, updatedAt: 1000 })
    const server = [f, fb, fa, ba]
    // base captured the PRE-reorder world: FA(1), FB(2) at updatedAt 1000 —
    // the web reorder at 1900 is invisible to base (happened after the sync)
    const base = makeBase([
      { server: { ...f, updatedAt: 1000 }, localId: 'lf' },
      { server: { ...fa, position: 1, updatedAt: 1000 }, localId: 'lfa' },
      { server: { ...fb, position: 2, updatedAt: 1000 }, localId: 'lfb' },
      { server: { ...ba, updatedAt: 1000 }, localId: 'lba' },
    ])
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'lf', type: 'folder', title: 'F', parentId: 'bar', index: 0 }),
      ln({ id: 'lba', type: 'url', title: 'BA', url: 'https://ba', parentId: 'bar', index: 1 }),
      // browser still shows the OLD folder order [FA, FB]; the user dragged
      // FA (1500) BEFORE the web reversed it (1900)
      ln({ id: 'lfa', type: 'url', title: 'FA', url: 'https://fa', parentId: 'lf', index: 0 }),
      ln({ id: 'lfb', type: 'url', title: 'FB', url: 'https://fb', parentId: 'lf', index: 1 }),
    ]
    const touch: TouchJournal = { lfa: { at: 1500 }, lba: { at: 1500 } }
    const p = planSync(input({ server, local, base, touch }))
    // folder bucket: every row moved remotely (1900 > base 1000) and the
    // local touch (1500) is older → no folder sweep; no position ops target it
    expect(posOf(p, 'fa')).toBeUndefined()
    expect(posOf(p, 'fb')).toBeUndefined()
    expect(posOf(p, 'ba')).toBeUndefined()
    // the browser must converge to the WEB folder order [FB, FA]
    const moves = p.chromeOps.filter((o) => o.kind === 'move') as Array<{ localId: string; index: number }>
    const faMove = moves.find((m) => m.localId === 'lfa')
    const fbMove = moves.find((m) => m.localId === 'lfb')
    expect(faMove?.index).toBe(1)
    expect(fbMove?.index).toBe(0)
  })
})

describe('A12: other-bookmarks holder must never be swept as a bar member', () => {
  it('holder row is excluded from the bar sequence even when it sorts first by raw position', () => {
    // pathological: someone set the holder's raw position to 0 (before all)
    const holder = sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 0 })
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 })
    const server = [holder, a, b]
    const base = makeBase([
      { server: holder, localId: 'oroot' },
      { server: a, localId: 'a' },
      { server: b, localId: 'b' },
    ])
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
      otherRoot(ln({ id: 'oroot', type: 'folder', title: '其他书签', parentId: '' })),
    ]
    const p = planSync(input({ server, local, base, touch: { b: { at: 1800 } } }))
    // [B, A] drifted from rank [A=0, B=1] → swept to 1/2, NOT 2/3
    expect(posOf(p, 'b')).toBe(1)
    expect(posOf(p, 'a')).toBe(2)
    expect(posOf(p, 'md-others')).toBeUndefined() // the holder is never a sweep target
  })
})

describe('A13: unchanged content but dragged — op carries title equal to the server (idempotent)', () => {
  it('the LWW clock advances without changing any content field', () => {
    const a = sn({ id: 'a', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 })
    const b = sn({ id: 'b', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 })
    const server = [a, b]
    const base = makeBase([{ server: a, localId: 'a' }, { server: b, localId: 'b' }])
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    const p = planSync(input({ server, local, base, touch: { b: { at: 1800 } } }))
    const bOp = p.serverOps.find((o) => o.op === 'update' && o.id === 'b') as { title?: string; url?: string; position?: number } | undefined
    expect(bOp?.title).toBe('B') // equal to server: harmless, advances the clock
    expect(bOp?.url).toBeUndefined() // URL never rides an equal-value write
    expect(bOp?.position).toBe(1)
    // and the plan is not churny: server = browser order after apply
    const serverNow = [
      { ...a, position: 2, updatedAt: 1800, revision: 30 },
      { ...b, position: 1, updatedAt: 1800, revision: 31 },
    ]
    const p2 = planSync(input({ server: serverNow, local, base: makeBase(serverNow.map((s) => ({ server: s, localId: s.id })), 600), touch: {} }))
    expect(p2.serverOps).toEqual([])
    expect(p2.chromeOps).toEqual([])
  })
})
