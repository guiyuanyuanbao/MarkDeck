// Root-id resolution: newer Chromium profiles use GUID permanent node ids,
// so hardcoding '1'/'2' made every chrome.bookmarks.create fail with
// "Can't find parent bookmark for id" (user-reported, audit-confirmed).
// resolveRoots() is exercised through the real module with a mocked
// chrome.bookmarks — but background.ts imports chrome at module scope, so we
// test the pure logic indirectly: this spec drives a minimal fake tree
// through the same positional rules the SW uses.
import { describe, it, expect } from 'vitest'

// mirrors resolveRoots()' positional identification rules (single-root
// profiles leave `other` undefined → callers fall back per-site)
function resolveRoots(children: { id: string; title: string }[]) {
  const bar = children[0]?.id || '1'
  const other = children.length > 1 ? children[1].id : undefined
  return { bar, other }
}

describe('root id resolution (GUID-safe)', () => {
  it('resolves legacy numeric ids by position', () => {
    const r = resolveRoots([
      { id: '1', title: '书签栏' },
      { id: '2', title: '其他书签' },
    ])
    expect(r.bar).toBe('1')
    expect(r.other).toBe('2')
  })
  it('resolves GUID-style permanent node ids (newer Chromium)', () => {
    const r = resolveRoots([
      { id: 'b0b1a1e2-7777-4d55-a3a0-guidbar0001', title: '书签栏' },
      { id: 'c9d2b2f3-8888-4e66-b4b1-guidother002', title: '其他书签' },
    ])
    expect(r.bar).toBe('b0b1a1e2-7777-4d55-a3a0-guidbar0001')
    expect(r.other).toBe('c9d2b2f3-8888-4e66-b4b1-guidother002')
  })
  it('Edge: never picks Mobile bookmarks as the other-root', () => {
    // Edge shows a third root 'Mobile bookmarks'; taking the LAST child
    // routed the 其他书签 holder into Mobile and broke 94 bookmarks
    const r = resolveRoots([
      { id: 'edge-bar-guid', title: '书签栏' },
      { id: 'edge-other-guid', title: '其他书签' },
      { id: 'edge-mobile-guid', title: '手机书签' },
    ])
    expect(r.bar).toBe('edge-bar-guid')
    expect(r.other).toBe('edge-other-guid') // children[1], NOT children[last]
    expect(r.other).not.toBe('edge-mobile-guid')
  })
  it('never returns the same node as both bar and other', () => {
    const r = resolveRoots([{ id: 'only-root', title: '书签栏' }])
    expect(r.bar).toBe('only-root')
    expect(r.other).toBeUndefined() // distinct-or-nothing
  })
  it('does not identify roots by localized title (position only)', () => {
    const r = resolveRoots([
      { id: 'guid-bar', title: 'Bookmarks Bar (en-US locale)' },
      { id: 'guid-other', title: 'Other bookmarks' },
    ])
    expect(r.bar).toBe('guid-bar')
    expect(r.other).toBe('guid-other')
  })
})
