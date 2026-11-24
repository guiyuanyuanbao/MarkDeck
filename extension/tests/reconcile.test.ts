// Three-way reconciliation engine tests. The engine's contract is
// CONVERGENCE: reconciling the same trees twice must plan zero ops the
// second time, and every diff scenario must terminate in a consistent state
// on both ends. These tests encode that property directly.
import { describe, it, expect } from 'vitest'
import {
  planSync, normBookmarkUrl, mintStableId,
  type ServerNode, type LocalNode, type Base, type TouchJournal, type PlanInput,
} from '../src/reconcile'

// ---- builders ----

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

// helper: mark a local node as the browser's other-bookmarks root (the
// adapter does this based on the children[1] Chromium invariant)
const otherRoot = (n: LocalNode): LocalNode & { isOtherRoot: boolean } =>
  Object.assign(n, { isOtherRoot: true })

// ---- convergence property ----

describe('convergence property', () => {
  it('reconciling the same trees twice plans zero ops the second time', () => {
    const server = [
      sn({ id: 'f1', type: 'folder', title: 'Tech', position: 1 }),
      sn({ id: 'b1', type: 'url', title: 'Go', url: 'https://go.dev', parentId: 'f1', position: 1 }),
      sn({ id: 'b2', type: 'url', title: 'Rust', url: 'https://rust.lang', position: 2 }),
      sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 }),
    ]
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏', parentId: '' }),
      ln({ id: 'c1', type: 'folder', title: 'Tech', parentId: 'bar', index: 0 }),
      ln({ id: 'c2', type: 'url', title: 'Go', url: 'https://go.dev', parentId: 'c1', index: 0 }),
      ln({ id: 'c3', type: 'url', title: 'Rust', url: 'https://rust.lang', parentId: 'bar', index: 1 }),
      otherRoot(ln({ id: 'other-root', type: 'folder', title: '其他书签', parentId: '' })),
    ]
    // first plan with no base: full import
    const p1 = planSync(input({ server, local }))
    expect(p1.serverOps.length).toBe(0) // everything is already on the server
    // the plan must bind every server row to a local node
    expect(Object.keys(p1.newBaseEntries).length).toBe(server.length)

    // simulate the adapter executing chromeOps, building the bound base
    const base = makeBase(Object.entries(p1.newBaseEntries).map(([sid, v]) => ({ server: v.server, localId: v.localId })), 500)
    // second plan, same trees + fresh base: ZERO ops (fixedpoint)
    const p2 = planSync(input({ server, local, base }))
    expect(p2.chromeOps).toEqual([])
    expect(p2.serverOps).toEqual([])
  })

  it('failed reconcile (base not advanced) re-plans identical ops', () => {
    const server = [sn({ id: 'b1', type: 'url', title: 'Go', url: 'https://go.dev' })]
    const local = [ln({ id: 'bar', type: 'folder', title: '书签栏' })]
    const p1 = planSync(input({ server, local }))
    // no base advance: same plan again
    const p2 = planSync(input({ server, local }))
    expect(p2.chromeOps.length).toBe(p1.chromeOps.length)
    expect(p2.chromeOps[0].kind).toBe('create')
    expect((p2.chromeOps[0] as { serverId: string }).serverId).toBe('b1')
  })
})

// ---- server → browser ----

describe('server → local', () => {
  it('new server rows plan chrome creates, parent-first', () => {
    const server = [
      sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 }),
      sn({ id: 'f1', type: 'folder', title: 'A', position: 1 }),
      sn({ id: 'b1', type: 'url', title: 'X', url: 'https://x', parentId: 'f1', position: 1 }),
    ]
    const p = planSync(input({ server, local: [ln({ id: 'bar', type: 'folder', title: '书签栏' })] }))
    const creates = p.chromeOps.filter((o) => o.kind === 'create') as Array<{ kind: 'create'; serverId: string }>
    const fIdx = creates.findIndex((c) => c.serverId === 'f1')
    const bIdx = creates.findIndex((c) => c.serverId === 'b1')
    expect(fIdx).toBeGreaterThanOrEqual(0)
    expect(bIdx).toBeGreaterThan(fIdx) // parent before child
  })

  it('title change on the server plans a chrome update', () => {
    const old = sn({ id: 'b1', type: 'url', title: 'Old', url: 'https://x' })
    const base = makeBase([{ server: old, localId: 'c1' }])
    const newer: ServerNode = { ...old, title: 'New', updatedAt: 1500, revision: old.revision + 1 }
    const local = [ln({ id: 'c1', type: 'url', title: 'Old', url: 'https://x' })]
    const p = planSync(input({ server: [newer], local, base }))
    expect(p.chromeOps).toHaveLength(1)
    expect(p.chromeOps[0]).toMatchObject({ kind: 'update', localId: 'c1', title: 'New' })
  })

  it('server deletion plans a chrome remove (base entry absent from tree)', () => {
    const b1 = sn({ id: 'b1', type: 'url', title: 'Go', url: 'https://go.dev' })
    const base = makeBase([{ server: b1, localId: 'c1' }])
    const local = [ln({ id: 'c1', type: 'url', title: 'Go', url: 'https://go.dev' })]
    const p = planSync(input({ server: [], local, base, touch: {} }))
    expect(p.chromeOps).toHaveLength(1)
    expect(p.chromeOps[0]).toMatchObject({ kind: 'remove', serverId: 'b1', localId: 'c1' })
  })

  it('slash-divergent URL is the same bookmark (no duplicate creates)', () => {
    // server row https://x.com/ vs browser node https://x.com
    const server = [sn({ id: 'b1', type: 'url', title: 'Site', url: 'https://x.com/' })]
    const local = [ln({ id: 'bar', type: 'folder', title: '书签栏' }), ln({ id: 'c1', type: 'url', title: 'Site', url: 'https://x.com', parentId: 'bar', index: 0 })]
    const p = planSync(input({ server, local }))
    const creates = p.chromeOps.filter((o) => o.kind === 'create')
    expect(creates).toHaveLength(0) // adopted, not created
    expect(p.stats.adopted).toBe(1)
    expect(p.newBaseEntries['b1'].localId).toBe('c1')
  })

  it('server-only folder rename cascades without touching children bindings', () => {
    const f1 = sn({ id: 'f1', type: 'folder', title: 'A', position: 1 })
    const b1 = sn({ id: 'b1', type: 'url', title: 'X', url: 'https://x', parentId: 'f1', position: 1 })
    const base = makeBase([
      { server: f1, localId: 'c1' },
      { server: b1, localId: 'c2' },
    ])
    const newer: ServerNode = { ...f1, title: 'B', updatedAt: 1500, revision: f1.revision + 1 }
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'c1', type: 'folder', title: 'A', parentId: 'bar', index: 0 }),
      ln({ id: 'c2', type: 'url', title: 'X', url: 'https://x', parentId: 'c1', index: 0 }),
    ]
    const p = planSync(input({ server: [newer, { ...b1 }], local, base }))
    expect(p.chromeOps).toHaveLength(1)
    expect(p.chromeOps[0]).toMatchObject({ kind: 'update', localId: 'c1', title: 'B' })
    // child binding survives: newBase keeps b1 → c2
    expect(p.newBaseEntries['b1'].localId).toBe('c2')
  })
})

// ---- browser → server ----

describe('local → server', () => {
  it('new local bookmarks plan server creates with stable minted ids', () => {
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'c1', type: 'url', title: 'New', url: 'https://new.dev', parentId: 'bar', index: 0 }),
    ]
    const p = planSync(input({ server: [], local, touch: { c1: { at: 1900 } } }))
    expect(p.serverOps).toHaveLength(1)
    expect(p.serverOps[0]).toMatchObject({ op: 'create', title: 'New', url: 'https://new.dev', updatedAt: 1900 })
    const minted = p.serverOps[0].id
    // re-plan: identical minted id (stability across re-plans)
    const p2 = planSync(input({ server: [], local, touch: { c1: { at: 1900 } } }))
    expect(p2.serverOps[0].id).toBe(minted)
  })

  it('local title edit pushes an update carrying the touch timestamp', () => {
    const b1 = sn({ id: 'b1', type: 'url', title: 'Old', url: 'https://x' })
    const base = makeBase([{ server: b1, localId: 'c1' }])
    const local = [ln({ id: 'c1', type: 'url', title: 'Edited locally', url: 'https://x' })]
    const p = planSync(input({ server: [b1], local, base, touch: { c1: { at: 1800 } } }))
    expect(p.serverOps).toHaveLength(1)
    expect(p.serverOps[0]).toMatchObject({ op: 'update', id: 'b1', title: 'Edited locally', updatedAt: 1800, observedRevision: b1.revision })
    expect(p.chromeOps).toHaveLength(0) // server unchanged: nothing applies locally
  })

  it('local deletion pushes a server delete', () => {
    const b1 = sn({ id: 'b1', type: 'url', title: 'Go', url: 'https://go.dev' })
    const base = makeBase([{ server: b1, localId: 'c1' }])
    const p = planSync(input({ server: [b1], local: [], base, touch: { c1: { at: 1900, removed: true } } }))
    expect(p.serverOps).toHaveLength(1)
    expect(p.serverOps[0]).toMatchObject({ op: 'delete', id: 'b1' })
  })
})

// ---- conflicts (both sides changed) ----

describe('conflicts', () => {
  it('local edit newer than server: local wins, server gets the push', () => {
    const b1 = sn({ id: 'b1', type: 'url', title: 'Base', url: 'https://x', updatedAt: 1000 })
    const base = makeBase([{ server: b1, localId: 'c1' }])
    const serverNow: ServerNode = { ...b1, title: 'Server edit', updatedAt: 1500, revision: b1.revision + 1 }
    const local = [ln({ id: 'c1', type: 'url', title: 'Local edit', url: 'https://x' })]
    const p = planSync(input({ server: [serverNow], local, base, touch: { c1: { at: 1800 } } }))
    expect(p.serverOps).toHaveLength(1)
    expect(p.serverOps[0]).toMatchObject({ op: 'update', title: 'Local edit', updatedAt: 1800 })
    expect(p.chromeOps).toHaveLength(0)
  })

  it('server edit newer than local: server wins, browser gets the update', () => {
    const b1 = sn({ id: 'b1', type: 'url', title: 'Base', url: 'https://x', updatedAt: 1000 })
    const base = makeBase([{ server: b1, localId: 'c1' }])
    const serverNow: ServerNode = { ...b1, title: 'Server edit', updatedAt: 1900, revision: b1.revision + 1 }
    const local = [ln({ id: 'c1', type: 'url', title: 'Local edit', url: 'https://x' })]
    const p = planSync(input({ server: [serverNow], local, base, touch: { c1: { at: 1500 } } }))
    expect(p.chromeOps).toHaveLength(1)
    expect(p.chromeOps[0]).toMatchObject({ kind: 'update', title: 'Server edit' })
    expect(p.serverOps).toHaveLength(0)
  })
})

// ---- offline replay ----

describe('offline edits replay without a queue', () => {
  it('edits made while offline (never pushed) re-plan identically until acked', () => {
    const b1 = sn({ id: 'b1', type: 'url', title: 'Base', url: 'https://x' })
    const base = makeBase([{ server: b1, localId: 'c1' }])
    const local = [ln({ id: 'c1', type: 'url', title: 'Offline rename', url: 'https://x' })]
    const touch: TouchJournal = { c1: { at: 1800 } }
    const p1 = planSync(input({ server: [b1], local, base, touch }))
    const p2 = planSync(input({ server: [b1], local, base, touch })) // reconcile failed, base stale
    expect(p1.serverOps).toEqual(p2.serverOps)
  })

  it('locally created folders + children arrive as one ordered batch', () => {
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'f1', type: 'folder', title: 'Deep', parentId: 'bar', index: 0 }),
      ln({ id: 'f2', type: 'folder', title: 'Deeper', parentId: 'f1', index: 0 }),
      ln({ id: 'c1', type: 'url', title: 'Leaf', url: 'https://leaf', parentId: 'f2', index: 0 }),
    ]
    const touch: TouchJournal = { f1: { at: 1900 }, f2: { at: 1900 }, c1: { at: 1900 } }
    const p = planSync(input({ server: [], local, touch }))
    expect(p.serverOps).toHaveLength(3)
    const ids = p.serverOps.map((o) => o.id)
    // the leaf's parentId must resolve to its folder's minted id
    const leaf = p.serverOps.find((o) => o.op === 'create' && (o as { title: string }).title === 'Leaf')!
    const deeper = p.serverOps.find((o) => o.op === 'create' && (o as { title: string }).title === 'Deeper')!
    expect((leaf as { parentId: string }).parentId).toBe(deeper.id)
    void ids
  })
})

// ---- 其他书签 structural binding ----

describe('other-bookmarks structural binding', () => {
  it('browser other-root binds to the canonical holder, content flows both ways', () => {
    const server = [
      sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 }),
      sn({ id: 'ob1', type: 'url', title: 'From server', url: 'https://srv', parentId: 'md-others', position: 1 }),
    ]
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      otherRoot(ln({ id: 'other-root', type: 'folder', title: '其他书签', parentId: '' })),
      ln({ id: 'oc1', type: 'url', title: 'From browser', url: 'https://loc', parentId: 'other-root', index: 0 }),
    ]
    const touch: TouchJournal = { oc1: { at: 1900 } }
    const p = planSync(input({ server, local, touch }))
    // server row applies into the other-root bucket (adapter maps parent)
    expect(p.chromeOps.some((o) => o.kind === 'create' && o.serverId === 'ob1')).toBe(true)
    // browser row pushes under the canonical holder id
    expect(p.serverOps.some((o) => o.op === 'create' && (o as { title: string }).title === 'From browser' && (o as { parentId: string }).parentId === 'md-others')).toBe(true)
    // the holder row itself never pushes (structural, not data)
    expect(p.serverOps.some((o) => o.op === 'create' && (o as { title: string }).title === '其他书签')).toBe(false)
  })

  it('Edge 3-root layout: mobile bookmarks are ignored entirely', () => {
    const server = [sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 })]
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      otherRoot(ln({ id: 'other-root', type: 'folder', title: '其他书签' })),
      ln({ id: 'mobile-root', type: 'folder', title: 'Mobile bookmarks' }),
      ln({ id: 'm1', type: 'url', title: 'Mobile-only', url: 'https://m', parentId: 'mobile-root', index: 0 }),
    ]
    const p = planSync(input({ server, local }))
    // mobile content never syncs (out of scope), never pushes
    expect(p.serverOps.some((o) => o.op === 'create' && (o as { title: string }).title === 'Mobile-only')).toBe(false)
  })
})

// ---- adoption / graveyard scenarios ----

describe('adoption', () => {
  it('unbound same-URL browser node adopts instead of duplicating across force-resync', () => {
    const server = [
      sn({ id: 'f1', type: 'folder', title: 'F', position: 1 }),
      sn({ id: 'b1', type: 'url', title: 'Same', url: 'https://same', parentId: 'f1', position: 1 }),
    ]
    // browser has the same content unbound (e.g. after storage wipe)
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'cf', type: 'folder', title: 'F', parentId: 'bar', index: 0 }),
      ln({ id: 'cc', type: 'url', title: 'Same', url: 'https://same', parentId: 'cf', index: 0 }),
    ]
    const p = planSync(input({ server, local }))
    const urlCreates = p.chromeOps.filter((o) => o.kind === 'create' && (o as { type?: string }).type === 'url')
    expect(urlCreates).toHaveLength(0) // adopted
    // both the folder shell (cf) and the url (cc) adopt onto the existing tree
    expect(p.stats.adopted).toBe(2)
    expect(p.newBaseEntries['b1'].localId).toBe('cc')
    expect(p.newBaseEntries['f1'].localId).toBe('cf')
  })

  it('graveyard pair (live row + tombstone same URL) converges — tombstones are invisible', () => {
    // The server tree endpoint returns only live rows: the tombstone simply
    // does not appear. The live row + unbound browser node adopt.
    const live = sn({ id: 'live1', type: 'url', title: 'Page', url: 'https://page', updatedAt: 2000 })
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'c1', type: 'url', title: 'Page', url: 'https://page', parentId: 'bar', index: 0 }),
    ]
    const p = planSync(input({ server: [live], local }))
    expect(p.chromeOps.filter((o) => o.kind === 'create')).toHaveLength(0)
    expect(p.stats.adopted).toBe(1)
  })

  it('server row vanished but an unbound node with the same URL exists: rebind, not delete', () => {
    const b1 = sn({ id: 'b1', type: 'url', title: 'Page', url: 'https://page' })
    const base = makeBase([{ server: b1, localId: 'old-chrome-node' }])
    // the old chrome node is gone; user re-imported and now a NEW node holds the URL
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'new-node', type: 'url', title: 'Page', url: 'https://page', parentId: 'bar', index: 0 }),
    ]
    const p = planSync(input({ server: [], local, base, touch: { 'old-chrome-node': { at: 1900, removed: true } } }))
    expect(p.chromeOps.some((o) => o.kind === 'remove' && o.localId === 'new-node')).toBe(false)
    expect(p.newBaseEntries['b1'].localId).toBe('new-node')
  })
})

// ---- resync from scratch ----

describe('force resync (wiped base) converges without duplicates', () => {
  it('wiping base and re-planning binds onto the existing tree', () => {
    const server = [
      sn({ id: 'f1', type: 'folder', title: 'Work', position: 1 }),
      sn({ id: 'b1', type: 'url', title: 'Go', url: 'https://go.dev', parentId: 'f1', position: 1 }),
      sn({ id: 'md-others', type: 'folder', title: '其他书签', position: 9999 }),
    ]
    const local = [
      ln({ id: 'bar', type: 'folder', title: '书签栏' }),
      ln({ id: 'cf', type: 'folder', title: 'Work', parentId: 'bar', index: 0 }),
      ln({ id: 'cc', type: 'url', title: 'Go', url: 'https://go.dev', parentId: 'cf', index: 0 }),
      otherRoot(ln({ id: 'other-root', type: 'folder', title: '其他书签', parentId: '' })),
    ]
    // base wiped (forceResync): full adopt pass
    const p = planSync(input({ server, local, base: null }))
    expect(p.chromeOps.filter((o) => o.kind === 'create' && (o as { type?: string }).type === 'url')).toHaveLength(0)
    expect(p.newBaseEntries['b1'].localId).toBe('cc')
    expect(p.newBaseEntries['f1'].localId).toBe('cf')
    // second run after base advance: fixedpoint
    const base = makeBase(Object.entries(p.newBaseEntries).map(([sid, v]) => ({ server: v.server, localId: v.localId })))
    const p2 = planSync(input({ server, local, base }))
    expect(p2.chromeOps).toEqual([])
    expect(p2.serverOps).toEqual([])
  })
})

// ---- helpers exposed ----

describe('helpers', () => {
  it('normBookmarkUrl strips trailing slashes and lowercases', () => {
    expect(normBookmarkUrl('https://X.com/')).toBe('https://x.com')
    expect(normBookmarkUrl('https://x.com')).toBe('https://x.com')
    expect(normBookmarkUrl('')).toBe('')
  })
  it('mintStableId is deterministic and UUID-shaped', () => {
    const n = ln({ id: 'x', type: 'url', title: 'T', url: 'https://t', parentId: 'bar', index: 2 })
    const a = mintStableId(n)
    const b = mintStableId(n)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    const m = mintStableId({ ...n, title: 'Different' })
    expect(m).not.toBe(a)
  })
})
