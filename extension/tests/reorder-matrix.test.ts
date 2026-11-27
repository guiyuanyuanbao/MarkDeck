// Reorder-sweep matrix tests (排序专项 2026-11-27): bidirectional position
// sync. Each test encodes a full-lifecycle story at the engine level — the
// E2E suite (tests/e2e/sync-matrix5.mjs) drives the same stories through a
// real browser against a real server.
//
// The engine contract under test:
//   R1  browser drag with touch evidence pushes the whole sibling order
//       server-side (position = index+1), no opposing moves planned
//   R2  fixedpoint: after the sweep lands, re-planning the same trees
//       plans ZERO ops (the #1 regression class — endless churn)
//   R3  no touch evidence (server reordered, browser stale) → NO sweep;
//       convergence applies the server order to the browser
//   R4  LWW gate: a web reorder NEWER than the browser drag wins; the
//       browser absorbs the server order
//   R5  LWW gate: a browser drag NEWER than the web reorder wins; the
//       sweep re-asserts the browser order
//   R6  server rank scattered (web MaxPosition+1 creates) with NO local
//       edits → browser converges by rank, no sweep, no churn
//   R7  drag inside a nested folder sweeps that folder only — siblings
//       of OTHER parents are untouched
//   R8  partial bucket (unbound local child present) → sweep abstains
//   R9  renamed sibling + drag in one bucket: title AND positions push
//       together, one consistent order
//   R10 other-bookmarks holder bucket sweeps against the canonical holder
//   R11 sweep survives a lost push (base not advanced): identical re-plan
//   R12 stale-touch-only bucket (touch older than base advance) → no
//       re-push loop
//   R13 cross-parent move (bar ↔ others) still syncs position via the
//       pushed op; the moved row's new rank converges
//   R14 delete-then-drag interleaved with pending removals → sweep
//       abstains, removes still plan, no phantom reorder
import { describe, it, expect } from 'vitest'
import {
  planSync,
  type ServerNode, type LocalNode, type Base, type TouchJournal, type PlanInput,
} from '../src/reconcile'

let rev = 100
function sn(partial: Partial<ServerNode> & { id: string; type: 'folder' | 'url'; title: string }): ServerNode {
  rev++
  return {
    parentId: '', position: 1, revision: rev, updatedAt: 1000, deviceId: 'srv',
    ...partial,
  }
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

// standard two-rows-in-bar fixture: server A(1) B(2), browser same, bound
const pairServer = () => [
  sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 }),
  sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 }),
]
const pairLocal = (order: Array<{ id: string; index: number }>) => [
  ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
  ...order.map(({ id, index }) =>
    ln({ id, type: 'url', title: id === 'a1' ? 'A' : 'B', url: id === 'a1' ? 'https://a' : 'https://b', parentId: 'bar', index })),
]
const pairBase = () => makeBase([
  { server: sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 }), localId: 'a1' },
  { server: sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 }), localId: 'b1' },
])

const updPos = (p: ReturnType<typeof planSync>, id: string) =>
  p.serverOps.find((o) => o.op === 'update' && o.id === id) as
    | { op: 'update'; id: string; position?: number; title?: string; updatedAt: number }
    | undefined

describe('R1: browser drag pushes the sibling order server-side', () => {
  it('dragged bucket plans position updates for every drifted sibling and no opposing moves', () => {
    // browser dragged B above A: bar = [B(0), A(1)]; server still A(1) B(2)
    const server = pairServer()
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const base = pairBase()
    const touch: TouchJournal = { b1: { at: 1800 } } // onMoved fired for the dragged row
    const p = planSync(input({ server, local, base, touch }))

    const pa = updPos(p, 'a1')
    const pb = updPos(p, 'b1')
    expect(pa, 'A must be pushed with position 2').toBeDefined()
    expect(pa!.position).toBe(2)
    expect(pb, 'B must be pushed with position 1').toBeDefined()
    expect(pb!.position).toBe(1)
    // the swept timestamps must pass the server's LWW gate (touch > server row)
    expect(pa!.updatedAt).toBeGreaterThanOrEqual(1800)
    // NO chrome move dragging the browser back to the server order
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
    expect(p.stats.positionPushes).toBe(2)
  })

  it('sweep ops never rewrite content; non-dragged siblings never diverge from the server', () => {
    const server = pairServer()
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const base = pairBase()
    const p = planSync(input({ server, local, base, touch: { b1: { at: 1800 } } }))
    for (const o of p.serverOps) {
      // a content op's title must equal what the server already holds
      // (touch-vouched LWW-clock write) — a sweep op carries no title at all
      if ((o as { title?: string }).title !== undefined) {
        const sn = server.find((s) => s.id === (o as { id: string }).id)
        expect((o as { title: string }).title).toBe(sn!.title)
      }
      expect((o as { url?: string }).url).toBeUndefined()
    }
  })
})

describe('R2: fixedpoint after a landed sweep', () => {
  it('same trees with an advanced base and cleared touch plan zero ops', () => {
    const serverNow: ServerNode[] = [
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 1, updatedAt: 1800 }),
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 2, updatedAt: 1800 }),
    ]
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const base = makeBase(serverNow.map((s) => ({ server: s, localId: s.id })), 600)
    const p = planSync(input({ server: serverNow, local, base, touch: {} }))
    expect(p.serverOps).toEqual([])
    expect(p.chromeOps).toEqual([])
  })
})

describe('R3: server reorder with no local touch applies server order to the browser', () => {
  it('no sweep; convergence moves the browser rows to the server rank', () => {
    // server now B(1) A(2) — a web-side drag; the browser still [A, B]
    const serverNow: ServerNode[] = [
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 1, updatedAt: 1800 }),
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 2, updatedAt: 1800 }),
    ]
    const base = makeBase([
      { server: sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 }), localId: 'a1' },
      { server: sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 }), localId: 'b1' },
    ])
    const local = pairLocal([{ id: 'a1', index: 0 }, { id: 'b1', index: 1 }])
    const p = planSync(input({ server: serverNow, local, base, touch: {} }))
    expect(p.serverOps).toEqual([]) // never re-assert a stale order
    const moves = p.chromeOps.filter((o) => o.kind === 'move') as Array<{ kind: 'move'; localId: string; index: number }>
    expect(moves.length).toBeGreaterThan(0) // browser absorbs the server order
    // after the moves execute, the next plan is a fixedpoint
    const localAfter = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const p2 = planSync(input({ server: serverNow, local: localAfter, base: makeBase(serverNow.map((s) => ({ server: s, localId: s.id })), 600), touch: {} }))
    expect(p2.serverOps).toEqual([])
    expect(p2.chromeOps).toEqual([])
  })
})

describe('R4/R5: LWW gate between a web reorder and a browser drag', () => {
  it('web reorder newer than the drag: browser absorbs the server order', () => {
    // device dragged B up (touch 1500); THEN the web reordered [B,A] at 1900
    const serverNow: ServerNode[] = [
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 1, updatedAt: 1900 }),
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 2, updatedAt: 1900 }),
    ]
    const base = pairBase()
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const p = planSync(input({ server: serverNow, local, base, touch: { b1: { at: 1500 } } }))
    expect(p.serverOps).toEqual([]) // stale drag loses
    // browser order already matches: nothing to apply
    expect(p.chromeOps).toEqual([])
  })

  it('drag newer than the web reorder: the sweep re-asserts the browser order', () => {
    // web reordered at 1200; device dragged B up at 1800 (offline since)
    const serverNow: ServerNode[] = [
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 1, updatedAt: 1200 }),
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 2, updatedAt: 1200 }),
    ]
    const base = makeBase(serverNow.map((s) => ({ server: s, localId: s.id })), 550)
    const local = pairLocal([{ id: 'a1', index: 0 }, { id: 'b1', index: 1 }])
    const p = planSync(input({ server: serverNow, local, base, touch: { b1: { at: 1800 } } }))
    const pa = updPos(p, 'a1')
    const pb = updPos(p, 'b1')
    expect(pa?.position).toBe(1)
    expect(pb?.position).toBe(2)
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
  })

  it('tie (touch == newest server updatedAt): sweep abstains, convergence decides', () => {
    // equal timestamps: the engine must not fight — server wins by rule 2
    const serverNow: ServerNode[] = [
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 1, updatedAt: 1800 }),
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 2, updatedAt: 1800 }),
    ]
    const base = pairBase()
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const p = planSync(input({ server: serverNow, local, base, touch: { b1: { at: 1800 } } }))
    expect(p.serverOps).toEqual([])
  })
})

describe('R6: scattered server positions with no local edits converge by rank', () => {
  it('web-created row at MaxPosition+1 lands in the right browser slot; second run is clean', () => {
    // server created C at position 10000 between A and B conceptually:
    // web UI put it first (index 0 for the user) — rank order A,C,B
    const server = [
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 }),
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 }),
      sn({ id: 'c1', type: 'url', title: 'C', url: 'https://c', position: 10000, updatedAt: 1500 }),
    ]
    const base = makeBase([
      { server: server[0], localId: 'a1' },
      { server: server[1], localId: 'b1' },
    ])
    const local = pairLocal([{ id: 'a1', index: 0 }, { id: 'b1', index: 1 }])
    const p = planSync(input({ server, local, base, touch: {} }))
    expect(p.serverOps).toEqual([]) // no sweep without touch evidence
    expect(p.chromeOps.some((o) => o.kind === 'create' && (o as { serverId: string }).serverId === 'c1')).toBe(true)
  })
})

describe('R7: nested-folder drag sweeps only that folder', () => {
  it('folder F drag does not touch bar-level siblings or other folders', () => {
    const server = [
      sn({ id: 'f1', type: 'folder', title: 'F', position: 1, updatedAt: 1000 }),
      sn({ id: 'x1', type: 'url', title: 'Xbar', url: 'https://x', position: 2, updatedAt: 1000 }),
      sn({ id: 'c1', type: 'url', title: 'C', url: 'https://c', parentId: 'f1', position: 1, updatedAt: 1000 }),
      sn({ id: 'c2', type: 'url', title: 'D', url: 'https://d', parentId: 'f1', position: 2, updatedAt: 1000 }),
    ]
    const base = makeBase(server.map((s) => ({ server: s, localId: s.id })), 500)
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'f1', type: 'folder', title: 'F', parentId: 'bar', index: 0 }),
      ln({ id: 'x1', type: 'url', title: 'Xbar', url: 'https://x', parentId: 'bar', index: 1 }),
      ln({ id: 'c2', type: 'url', title: 'D', url: 'https://d', parentId: 'f1', index: 0 }),
      ln({ id: 'c1', type: 'url', title: 'C', url: 'https://c', parentId: 'f1', index: 1 }),
    ]
    const p = planSync(input({ server, local, base, touch: { c2: { at: 1800 } } }))
    // positions pushed for BOTH f1 children (full permutation)
    const pc1 = updPos(p, 'c1')
    const pc2 = updPos(p, 'c2')
    expect(pc1?.position).toBe(2)
    expect(pc2?.position).toBe(1)
    // bar-level rows untouched (already aligned)
    expect(updPos(p, 'x1')).toBeUndefined()
    expect(updPos(p, 'f1')).toBeUndefined()
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
  })
})

describe('R8: bucket with a pending unbound child (create-in-set)', () => {
  it('an appended unbound node pushes as a create via pass 3; bound siblings untouched', () => {
    // server [A(1), B(2)]; browser keeps [A@0, B@1] and appends New@2:
    // order agreed, one pending create at the tail — no renumbering
    const server = pairServer()
    const base = pairBase()
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'a1', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 0 }),
      ln({ id: 'b1', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 1 }),
      ln({ id: 'new1', type: 'url', title: 'New', url: 'https://new', parentId: 'bar', index: 2 }),
    ]
    const p = planSync(input({ server, local, base, touch: { new1: { at: 1801 } } }))
    // the pending create lands via pass 3 with its slot position
    const createOp = p.serverOps.find((o) => o.op === 'create') as { position: number } | undefined
    expect(createOp).toBeDefined()
    expect(createOp!.position).toBe(3) // index 2 → position 3, slot preserved
    // NO position ops: slots unchanged; no chrome moves
    const posOps = p.serverOps.filter((o) => o.op === 'update' && (o as { position?: number }).position !== undefined)
    expect(posOps).toEqual([])
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
  })

  it('drag A below a mid-inserted unbound node renumbers A around the new slot', () => {
    const server = pairServer() // server: A(1), B(2)
    const base = pairBase()
    // browser sequence after the user dragged New to the top: New(0), B(1), A(2)
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'new1', type: 'url', title: 'New', url: 'https://new', parentId: 'bar', index: 0 }),
      ln({ id: 'b1', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 1 }),
      ln({ id: 'a1', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 2 }),
    ]
    const p = planSync(input({ server, local, base, touch: { new1: { at: 1800 } } }))
    const createOp = p.serverOps.find((o) => o.op === 'create') as { position: number; parentId: string } | undefined
    expect(createOp, 'New pushes as create at slot 1').toBeDefined()
    expect(createOp!.position).toBe(1)
    // A's slot moved 1→3 (after B): the sweep renumbers it
    const pa = updPos(p, 'a1')
    expect(pa?.position).toBe(3)
    // B stays at slot 2: no op for it
    expect(updPos(p, 'b1')).toBeUndefined()
  })
})

describe('R9: rename + drag combined push title and positions consistently', () => {
  it('the renamed sibling carries its title; the sweep carries the order', () => {
    const server = pairServer()
    const base = pairBase()
    const local: LocalNode[] = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'b1', type: 'url', title: 'B-renamed', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'a1', type: 'url', title: 'A', url: 'https://a', parentId: 'bar', index: 1 }),
    ]
    const p = planSync(input({ server, local, base, touch: { b1: { at: 1800 } } }))
    const pb = updPos(p, 'b1')
    expect(pb, 'renamed row pushes').toBeDefined()
    expect(pb!.title).toBe('B-renamed') // content op for the renamed row
    expect(pb!.position).toBe(1)
    const pa = updPos(p, 'a1')
    expect(pa?.position).toBe(2)
  })
})

describe('R10: other-bookmarks bucket sweeps against the canonical holder', () => {
  it('drag inside 其他书签 pushes holder-child positions', () => {
    const server = [
      sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 }),
      sn({ id: 'o1', type: 'url', title: 'O1', url: 'https://o1', parentId: 'md-others', position: 1, updatedAt: 1000 }),
      sn({ id: 'o2', type: 'url', title: 'O2', url: 'https://o2', parentId: 'md-others', position: 2, updatedAt: 1000 }),
    ]
    const base = makeBase(server.map((s) => ({ server: s, localId: s.id === 'md-others' ? 'other-root' : s.id })), 500)
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'other-root', type: 'folder', title: '其他书签', parentId: '' }),
      ln({ id: 'o2', type: 'url', title: 'O2', url: 'https://o2', parentId: 'other-root', index: 0 }),
      ln({ id: 'o1', type: 'url', title: 'O1', url: 'https://o1', parentId: 'other-root', index: 1 }),
    ]
    // mark other-root via the adapter's marker
    ;(local[1] as LocalNode & { isOtherRoot: boolean }).isOtherRoot = true
    const p = planSync(input({ server, local, base, touch: { o2: { at: 1800 } } }))
    const po1 = updPos(p, 'o1')
    const po2 = updPos(p, 'o2')
    expect(po2?.position).toBe(1)
    expect(po1?.position).toBe(2)
    expect(p.chromeOps.filter((o) => o.kind === 'move')).toEqual([])
  })
})

describe('R11: a failed reconcile re-plans the identical sweep', () => {
  it('base not advanced → same position ops again (deterministic replay)', () => {
    const server = pairServer()
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const base = pairBase()
    const touch: TouchJournal = { b1: { at: 1800 } }
    const p1 = planSync(input({ server, local, base, touch }))
    const p2 = planSync(input({ server, local, base, touch }))
    expect(p1.serverOps).toEqual(p2.serverOps)
    expect(p1.serverOps.length).toBeGreaterThan(0)
  })
})

describe('R12: stale touch (already consumed by an advanced base) never loops', () => {
  it('touch older than the base-advance moment + server rows touched since → no sweep', () => {
    // The last reconcile already pushed the sweep; the server rows carry
    // updatedAt = the push time (1900). The old touch (1500) survives in
    // the journal. The user has NOT dragged since. No re-push may plan.
    const serverNow: ServerNode[] = [
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 1, updatedAt: 1900 }),
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 2, updatedAt: 1900 }),
    ]
    const base = makeBase(serverNow.map((s) => ({ server: s, localId: s.id })), 600)
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const p = planSync(input({ server: serverNow, local, base, touch: { b1: { at: 1500 } } }))
    expect(p.serverOps).toEqual([])
    expect(p.chromeOps).toEqual([])
  })
})

describe('R13: cross-parent move (bar → others) syncs the new rank', () => {
  it('moved row pushes parentId + position in one op; next plan is a fixedpoint', () => {
    const server = [
      sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 }),
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 }),
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 2, updatedAt: 1000 }),
      sn({ id: 'o1', type: 'url', title: 'O1', url: 'https://o1', parentId: 'md-others', position: 1, updatedAt: 1000 }),
    ]
    const base = makeBase(server.map((s) => ({ server: s, localId: s.id === 'md-others' ? 'other-root' : s.id })), 500)
    // browser moved A into other-root BELOW O1: others=[O1, A], bar=[B]
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'other-root', type: 'folder', title: '其他书签', parentId: '' }),
      ln({ id: 'b1', type: 'url', title: 'B', url: 'https://b', parentId: 'bar', index: 0 }),
      ln({ id: 'o1', type: 'url', title: 'O1', url: 'https://o1', parentId: 'other-root', index: 0 }),
      ln({ id: 'a1', type: 'url', title: 'A', url: 'https://a', parentId: 'other-root', index: 1 }),
    ]
    ;(local[1] as LocalNode & { isOtherRoot: boolean }).isOtherRoot = true
    const touch: TouchJournal = { a1: { at: 1800 } } // onMoved fired for A
    const p = planSync(input({ server, local, base, touch }))
    const pa = p.serverOps.find((o) => o.op === 'update' && o.id === 'a1') as
      | { parentId?: string; position?: number }
      | undefined
    expect(pa, 'A pushes its move').toBeDefined()
    expect(pa!.parentId).toBe('md-others')
    expect(pa!.position).toBe(2)
  })
})

describe('R14: pending removals in the bucket make the sweep abstain', () => {
  it('server-deleted sibling present locally → removes plan, positions do not', () => {
    // base had a1+b1; server deleted a1; browser dragged B up meanwhile
    const server: ServerNode[] = [
      sn({ id: 'b1', type: 'url', title: 'B', url: 'https://b', position: 1, updatedAt: 1000 }),
    ]
    const base = pairBase()
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const touch: TouchJournal = { b1: { at: 1800 } }
    const p = planSync(input({ server, local, base, touch }))
    // a1 must be removed locally (server deleted it)
    expect(p.chromeOps.some((o) => o.kind === 'remove' && o.localId === 'a1')).toBe(true)
    // NO position push: the bucket membership is transient (remove pending)
    expect(p.serverOps.some((o) => o.op === 'update' && (o as { position?: number }).position !== undefined)).toBe(false)
  })
})

describe('R15: sweep clamps against concurrent row updates (no content clobber)', () => {
  it('a sibling edited on the server AFTER the drag keeps its server title — the sweep only writes position', () => {
    // server renamed B → 'B-web' at 1900 (after the drag at 1800). The
    // sweep must NOT push the stale local title 'B' — position-only op,
    // and for the CONTENT-diverged sibling the push loses LWW server-side.
    const serverNow: ServerNode[] = [
      sn({ id: 'a1', type: 'url', title: 'A', url: 'https://a', position: 1, updatedAt: 1000 }),
      sn({ id: 'b1', type: 'url', title: 'B-web', url: 'https://b', position: 2, updatedAt: 1900 }),
    ]
    const base = pairBase()
    const local = pairLocal([{ id: 'b1', index: 0 }, { id: 'a1', index: 1 }])
    const p = planSync(input({ server: serverNow, local, base, touch: { b1: { at: 1800 } } }))
    // the sweep abstains entirely: server row newer than the newest touch
    expect(p.serverOps.filter((o) => o.op === 'update' && (o as { position?: number }).position !== undefined)).toEqual([])
  })
})
