// Convergence-matrix tests: scenarios discovered by the sync-specific audit
// (2026-11-26). Each test encodes a full-lifecycle user story at the engine
// level — the E2E suite (tests/e2e/sync-matrix.mjs) drives the same stories
// through a real browser.
import { describe, it, expect } from 'vitest'
import {
  planSync, normBookmarkUrl,
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

describe('matrix: snapshot-restore vs offline edit (E1)', () => {
  it('a push that loses LWW must not re-push doomed updates forever — next plan applies server state', () => {
    // base captured the row as X0@1000. A snapshot restore put the SAME
    // content back with a fresh updatedAt (5000) — content-equal to base.
    // The device was offline and renamed the node (touch 2000).
    const baseRow = sn({ id: 'x1', type: 'url', title: 'X0', url: 'https://x', updatedAt: 1000, revision: 5 })
    const base = makeBase([{ server: baseRow, localId: 'c1' }])
    const restoredRow: ServerNode = { ...baseRow, updatedAt: 5000, revision: 20 }
    const local = [ln({ id: 'c1', type: 'url', title: 'Offline', url: 'https://x' })]
    const touch: TouchJournal = { c1: { at: 2000 } }

    const p1 = planSync(input({ server: [restoredRow], local, base, touch }))
    // the touch (2000) is OLDER than the restored row (5000): the local edit
    // is stale by the engine's own LWW clock — plan 1 must already apply the
    // server state, never emit a doomed push
    expect(p1.serverOps).toHaveLength(0)
    expect(p1.chromeOps.some((o) => o.kind === 'update' && o.serverId === 'x1' && o.title === 'X0')).toBe(true)

    // simulate the adapter: base advances to the fetched tree, touch is
    // cleared, local unchanged — the next plan must be a fixedpoint
    const advancedBase = makeBase([{ server: restoredRow, localId: 'c1' }], 600)
    const p2 = planSync(input({ server: [restoredRow], local, base: advancedBase, touch: {} }))
    const doomed = p2.serverOps.filter((o) => o.op === 'update' && o.id === 'x1' && o.updatedAt <= restoredRow.updatedAt)
    expect(doomed).toEqual([])
    expect(p2.chromeOps.some((o) => o.kind === 'update' && o.serverId === 'x1' && o.title === 'X0')).toBe(true)
  })

  it('with the touch retained after a lost push, the next plan converges to server state', () => {
    // the adapter fix keeps the touch entry for rows whose push lost; encode
    // that the retained touch drives a server-wins apply (not another push)
    const baseRow = sn({ id: 'x1', type: 'url', title: 'X0', url: 'https://x', updatedAt: 1000, revision: 5 })
    const base = makeBase([{ server: baseRow, localId: 'c1' }])
    const restoredRow: ServerNode = { ...baseRow, updatedAt: 5000, revision: 20 }
    const local = [ln({ id: 'c1', type: 'url', title: 'Offline', url: 'https://x' })]
    const advancedBase = makeBase([{ server: restoredRow, localId: 'c1' }], 600)
    const p = planSync(input({ server: [restoredRow], local, base: advancedBase, touch: { c1: { at: 2000 } } }))
    expect(p.serverOps).toEqual([]) // 2000 < 5000: no push
    expect(p.chromeOps.some((o) => o.kind === 'update' && o.title === 'X0')).toBe(true)
  })
})

describe('matrix: offline create inside a server-deleted folder (B2)', () => {
  it('a minted row (revision 0) absent from the server is re-pushed, never removed locally', () => {
    // The device created C inside folder F; the push raced a server-side
    // delete of F and was rejected (parent in trash). The adapter still
    // advanced base (C's minted entry carries revision 0 — never confirmed).
    // Next reconcile: F is gone from the server tree, C must SURVIVE.
    const fRow = sn({ id: 'f1', type: 'folder', title: 'F', updatedAt: 900, revision: 3 })
    const cMinted: ServerNode = {
      id: 'minted-c', parentId: 'f1', type: 'url', title: 'C',
      url: 'https://precious', position: 1, revision: 0, updatedAt: 1700, deviceId: 'dev-1',
    }
    const base = makeBase([
      { server: fRow, localId: 'lf' },
      { server: cMinted, localId: 'lc' },
    ])
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'lf', type: 'folder', title: 'F', parentId: 'bar', index: 0 }),
      ln({ id: 'lc', type: 'url', title: 'C', url: 'https://precious', parentId: 'lf', index: 0 }),
    ]
    const p = planSync(input({ server: [], local, base, touch: {} }))
    // C's content must be pushed (create — the server never confirmed it)
    const pushed = p.serverOps.find((o) => o.op === 'create' && o.id === 'minted-c')
    expect(pushed).toBeDefined()
    // parent F is gone server-side: the push must NOT reference it
    expect((pushed as { parentId: string }).parentId).toBe('')
    // F (a confirmed server row, now deleted server-side) is removed locally
    expect(p.chromeOps.some((o) => o.kind === 'remove' && o.serverId === 'f1')).toBe(true)
    // C's LOCAL node must not be removed
    expect(p.chromeOps.some((o) => o.kind === 'remove' && o.localId === 'lc')).toBe(false)
  })

  it('removing a server-deleted folder does NOT cascade into unconfirmed minted children', () => {
    // F (confirmed) holds minted child C. The server deleted F while C's
    // push was rejected. The chrome remove of F would cascade-delete C in
    // the browser — but C is being re-pushed in the SAME plan, so the plan
    // must not emit a remove that destroys it (remove F's node only).
    const fRow = sn({ id: 'f1', type: 'folder', title: 'F', updatedAt: 900, revision: 3 })
    const cMinted: ServerNode = {
      id: 'minted-c', parentId: 'f1', type: 'url', title: 'C',
      url: 'https://precious', position: 1, revision: 0, updatedAt: 1700, deviceId: 'dev-1',
    }
    const base = makeBase([
      { server: fRow, localId: 'lf' },
      { server: cMinted, localId: 'lc' },
    ])
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'lf', type: 'folder', title: 'F', parentId: 'bar', index: 0 }),
      ln({ id: 'lc', type: 'url', title: 'C', url: 'https://precious', parentId: 'lf', index: 0 }),
    ]
    const p = planSync(input({ server: [], local, base, touch: {} }))
    // C re-pushed (parent re-rooted) — assert again with the remove present
    expect(p.serverOps.some((o) => o.op === 'create' && o.id === 'minted-c')).toBe(true)
    // F removed as chrome op (its server row is gone; F was confirmed)
    expect(p.chromeOps.some((o) => o.kind === 'remove' && o.localId === 'lf')).toBe(true)
    // C never removed
    expect(p.chromeOps.some((o) => o.kind === 'remove' && o.localId === 'lc')).toBe(false)
  })

  it('deep minted chain re-roots to the nearest live bound ancestor', () => {
    const f1Row = sn({ id: 'f1', type: 'folder', title: 'F1', updatedAt: 900, revision: 3 })
    const f2Minted: ServerNode = {
      id: 'minted-f2', parentId: 'f1', type: 'folder', title: 'F2',
      position: 1, revision: 0, updatedAt: 1700, deviceId: 'dev-1',
    }
    const cMinted: ServerNode = {
      id: 'minted-c', parentId: 'minted-f2', type: 'url', title: 'C',
      url: 'https://deep', position: 1, revision: 0, updatedAt: 1700, deviceId: 'dev-1',
    }
    const base = makeBase([
      { server: f1Row, localId: 'lf1' },
      { server: f2Minted, localId: 'lf2' },
      { server: cMinted, localId: 'lc' },
    ])
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'lf1', type: 'folder', title: 'F1', parentId: 'bar', index: 0 }),
      ln({ id: 'lf2', type: 'folder', title: 'F2', parentId: 'lf1', index: 0 }),
      ln({ id: 'lc', type: 'url', title: 'C', url: 'https://deep', parentId: 'lf2', index: 0 }),
    ]
    const p = planSync(input({ server: [f1Row], local, base, touch: {} }))
    const pushedC = p.serverOps.find((o) => o.op === 'create' && o.id === 'minted-c') as { parentId: string } | undefined
    expect(pushedC).toBeDefined()
    expect(pushedC!.parentId).toBe('f1') // re-rooted under the surviving F1
    const pushedF2 = p.serverOps.find((o) => o.op === 'create' && o.id === 'minted-f2') as { parentId: string } | undefined
    expect(pushedF2).toBeDefined()
    expect(pushedF2!.parentId).toBe('f1')
  })
})

describe('matrix: dual-device same-row edits (B1 self-heal lock)', () => {
  it('loser content with no touch and unchanged server converges to the server copy', () => {
    // device B lost the LWW race; its browser still holds the loser content.
    // server content equals the advanced base → next plan must APPLY the
    // server copy (overwrite the loser locally), not push the loser again.
    const baseRow = sn({ id: 'x1', type: 'url', title: 'A-edit', url: 'https://x', updatedAt: 1200, revision: 9 })
    const base = makeBase([{ server: baseRow, localId: 'c1' }])
    const local = [ln({ id: 'c1', type: 'url', title: 'B-edit', url: 'https://x' })]
    const p = planSync(input({ server: [baseRow], local, base, touch: {} }))
    expect(p.serverOps).toEqual([]) // never re-push a touchless loser
    expect(p.chromeOps.some((o) => o.kind === 'update' && o.title === 'A-edit')).toBe(true)
  })
})

void normBookmarkUrl

describe('matrix round 2: purge terminality + forceResync journal (N2/N9)', () => {
  it('N2: offline edit under a purged folder converges — edit loses to purge, node removed, no undelete loop', () => {
    // Simulate the FULL loop: round 1 pushes undelete (server rejects it
    // silently — purged rows refuse revival); base advances (adapter);
    // round 2 must NOT re-push another doomed undelete — it must plan the
    // local remove (purge is terminal).
    const fRow = sn({ id: 'f1', type: 'folder', title: 'F', updatedAt: 900, revision: 3 })
    const cRow = sn({ id: 'c1', type: 'url', title: 'C', url: 'https://c/x', parentId: 'f1', updatedAt: 900, revision: 4 })
    const base = makeBase([{ server: fRow, localId: 'lf' }, { server: cRow, localId: 'lc' }])
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'lf', type: 'folder', title: 'F', parentId: 'bar', index: 0 }),
      ln({ id: 'lc', type: 'url', title: 'C-改名', url: 'https://c/x', parentId: 'lf', index: 0 }),
    ]
    // round 1: edit timestamp NEWER than purge → undelete push attempted
    const p1 = planSync(input({ server: [], local, base, touch: { lc: { at: 2000 } } }))
    expect(p1.serverOps.some((o) => o.op === 'update' && o.id === 'c1' && o.undelete)).toBe(true)
    // server REJECTED it (purged); adapter advanced base; touch SURVIVES
    // (fix: touch must not be consumed on rejected pushes). Round 2: the
    // edit timestamp is now ≤ the purge timestamp → no more undelete.
    const advancedBase = makeBase([{ server: { ...fRow, updatedAt: 2500, revision: 9 } as ServerNode, localId: 'lf' }, { server: { ...cRow, updatedAt: 2500, revision: 10 } as ServerNode, localId: 'lc' }], 600)
    const p2 = planSync(input({ server: [], local, base: advancedBase, touch: { lc: { at: 2000 } } }))
    expect(p2.serverOps.some((o) => o.op === 'update' && o.undelete)).toBe(false) // no doomed re-push
    expect(p2.chromeOps.some((o) => o.kind === 'remove' && o.localId === 'lc')).toBe(true) // deletion wins
    expect(p2.chromeOps.some((o) => o.kind === 'remove' && o.localId === 'lf')).toBe(true)
  })

  it('N9: forceResync (base wiped, touch kept) preserves the pending offline rename', () => {
    // base row 'Original'; device offline renamed to 'Renamed' (touch).
    // forceResync wipes ONLY the base. The adoption pass must push the
    // rename — never overwrite the local edit with the server title.
    const baseRow = sn({ id: 'x1', type: 'url', title: 'Original', url: 'https://keep/x', updatedAt: 900, revision: 5 })
    const local = [ln({ id: 'c1', type: 'url', title: 'Renamed', url: 'https://keep/x' })]
    const p = planSync(input({ server: [baseRow], local, base: null, touch: { c1: { at: 2000 } } }))
    expect(p.serverOps.some((o) => o.op === 'update' && o.id === 'x1' && o.title === 'Renamed')).toBe(true)
    expect(p.chromeOps.some((o) => o.kind === 'update' && o.title === 'Original')).toBe(false)
  })
})

describe('matrix round 3: swap-reparent (P7)', () => {
  it('server swaps two folders parent/child in one batch — BOTH moves planned, fixedpoint after', () => {
    const f1 = sn({ id: 'f1', type: 'folder', title: 'F1', parentId: '', position: 1, updatedAt: 900, revision: 3 })
    const f2 = sn({ id: 'f2', type: 'folder', title: 'F2', parentId: 'f1', position: 1, updatedAt: 900, revision: 4 })
    const base = makeBase([{ server: f1, localId: 'lf1' }, { server: f2, localId: 'lf2' }])
    const serverNow: ServerNode[] = [
      { ...f1, parentId: 'f2', position: 1, updatedAt: 1800, revision: 8 },
      { ...f2, parentId: '', position: 2, updatedAt: 1800, revision: 9 },
    ]
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'lf1', type: 'folder', title: 'F1', parentId: 'bar', index: 0 }),
      ln({ id: 'lf2', type: 'folder', title: 'F2', parentId: 'lf1', index: 0 }),
    ]
    const p = planSync(input({ server: serverNow, local, base }))
    expect(p.chromeOps.some((o) => o.kind === 'move' && o.serverId === 'f1' && o.parentServerId === 'f2')).toBe(true)
    expect(p.chromeOps.some((o) => o.kind === 'move' && o.serverId === 'f2' && o.parentServerId === '')).toBe(true)
    // after both moves execute, the next plan is a fixedpoint
    const localAfter = [
      local[0],
      ln({ id: 'lf2', type: 'folder', title: 'F2', parentId: 'bar', index: 0 }), // F2 is the ONLY top-level row: rank 0
      ln({ id: 'lf1', type: 'folder', title: 'F1', parentId: 'lf2', index: 0 }),
    ]
    const p2 = planSync(input({ server: serverNow, local: localAfter, base: makeBase([{ server: serverNow[0], localId: 'lf1' }, { server: serverNow[1], localId: 'lf2' }], 600) }))
    expect(p2.chromeOps).toEqual([])
  })

  it('root-bucket parent vs folder server parent is a MISMATCH, not an abstention', () => {
    const f1 = sn({ id: 'f1', type: 'folder', title: 'F1', parentId: '', position: 1, updatedAt: 900, revision: 3 })
    const f2 = sn({ id: 'f2', type: 'folder', title: 'F2', parentId: 'f1', position: 1, updatedAt: 900, revision: 4 })
    const base = makeBase([{ server: f1, localId: 'lf1' }, { server: f2, localId: 'lf2' }])
    // server moved F1 into F2; browser still has F1 at bar root
    const serverNow: ServerNode[] = [f1, { ...f2 }]
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'lf1', type: 'folder', title: 'F1', parentId: 'bar', index: 0 }),
      ln({ id: 'lf2', type: 'folder', title: 'F2', parentId: 'bar', index: 0 }), // F2 is the ONLY top-level row: rank 0
    ]
    const p = planSync(input({ server: [{ ...f2, parentId: 'f1', updatedAt: 1800, revision: 8 } as ServerNode, { ...f1 }], local, base }))
    expect(p.chromeOps.some((o) => o.kind === 'move' && o.serverId === 'f2')).toBe(true)
  })
})
