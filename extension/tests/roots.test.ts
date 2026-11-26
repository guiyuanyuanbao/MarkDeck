// Root-id resolution: newer Chromium profiles use GUID permanent node ids,
// so hardcoding '1'/'2' made every chrome.bookmarks.create fail with
// "Can't find parent bookmark for id" (user-reported, audit-confirmed).
// Drives the REAL resolveRootsFromTree from src/reconcile.ts — the previous
// version of this spec re-implemented the positional rules locally, which
// could drift from the service worker's actual behavior.
import { describe, it, expect } from 'vitest'
import { resolveRootsFromTree } from '../src/reconcile'

describe('root id resolution (GUID-safe, real implementation)', () => {
  it('resolves legacy numeric ids by position', () => {
    const r = resolveRootsFromTree([{
      id: '0',
      children: [
        { id: '1', title: '书签栏' },
        { id: '2', title: '其他书签' },
      ],
    }])
    expect(r.barId).toBe('1')
    expect(r.otherId).toBe('2')
  })
  it('resolves GUID-style permanent node ids (newer Chromium)', () => {
    const r = resolveRootsFromTree([{
      id: '0',
      children: [
        { id: 'b0b1a1e2-7777-4d55-a3a0-guidbar0001', title: '书签栏' },
        { id: 'c9d2b2f3-8888-4e66-b4b1-guidother002', title: '其他书签' },
      ],
    }])
    expect(r.barId).toBe('b0b1a1e2-7777-4d55-a3a0-guidbar0001')
    expect(r.otherId).toBe('c9d2b2f3-8888-4e66-b4b1-guidother002')
  })
  it('Edge: never picks Mobile bookmarks as the other-root', () => {
    // Edge shows a third root 'Mobile bookmarks'; taking the LAST child
    // routed the 其他书签 holder into Mobile and broke 94 bookmarks
    const r = resolveRootsFromTree([{
      id: '0',
      children: [
        { id: 'edge-bar-guid', title: '书签栏' },
        { id: 'edge-other-guid', title: '其他书签' },
        { id: 'edge-mobile-guid', title: '手机书签' },
      ],
    }])
    expect(r.barId).toBe('edge-bar-guid')
    expect(r.otherId).toBe('edge-other-guid') // children[1], NOT children[last]
    expect(r.otherId).not.toBe('edge-mobile-guid')
  })
  it('throws on a single-root tree (callers surface the error, never guess)', () => {
    expect(() => resolveRootsFromTree([{ id: '0', children: [{ id: 'only-root', title: '书签栏' }] }]))
      .toThrow('bookmark tree has no bar/other roots')
  })
  it('does not identify roots by localized title (position only)', () => {
    const r = resolveRootsFromTree([{
      id: '0',
      children: [
        { id: 'guid-bar', title: 'Bookmarks Bar (en-US locale)' },
        { id: 'guid-other', title: 'Other bookmarks' },
      ],
    }])
    expect(r.barId).toBe('guid-bar')
    expect(r.otherId).toBe('guid-other')
  })
})
