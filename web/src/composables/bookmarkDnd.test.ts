// Table-driven tests for the drag & drop insertion math and grid zone
// resolution — the hand-tuned logic behind v0.1.24/v0.1.25 reorder fixes.
import { describe, it, expect } from 'vitest'
import { spliceAt, isAncestorOfDragged, gridDropZone, type GridSide } from './bookmarkDnd'
import type { Bookmark } from '@/api/client'

const row = (id: string) => ({ id })
const bm = (id: string, type: 'url' | 'folder' = 'url', parentId = ''): Bookmark => ({
  id, parentId, type, title: id, favorite: false, archived: false,
  position: 0, revision: 0, updatedAt: 0, createdAt: 0,
})

describe('spliceAt (insert BEFORE list[insertAt])', () => {
  const list = ['a', 'b', 'c', 'd'].map(row)

  it('inserts a single id at a clean position', () => {
    expect(spliceAt(list, 1, ['x'])).toEqual(['a', 'x', 'b', 'c', 'd'])
  })

  it('appends at the end when insertAt === length', () => {
    expect(spliceAt(list, 4, ['x'])).toEqual(['a', 'b', 'c', 'd', 'x'])
  })

  it('moves an id within the list: dragging b onto the line after d', () => {
    // insertAt=4 counts only non-dragged rows before it — b was removed first
    expect(spliceAt(list, 4, ['b'])).toEqual(['a', 'c', 'd', 'b'])
  })

  it('moves a whole multi-select preserving internal order', () => {
    expect(spliceAt(list, 4, ['b', 'c'])).toEqual(['a', 'd', 'b', 'c'])
  })

  it('drops at 0 when the math would go negative', () => {
    expect(spliceAt(list, 0, ['a', 'b'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reordering to the same spot is a no-op sequence', () => {
    expect(spliceAt(list, 1, ['b'])).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('isAncestorOfDragged', () => {
  // tree: f1 → f2 → url1. Semantics (verbatim from the view): walk each
  // dragged id UP its parent chain — true when folderId appears on the way,
  // i.e. the target is a (transitive) parent of something being dragged.
  // A folder dragged onto its own DESCENDANT is NOT flagged here; moveIds'
  // cycle check rejects that at drop time.
  const flat = new Map<string, Bookmark>([
    ['f1', bm('f1', 'folder')],
    ['f2', bm('f2', 'folder', 'f1')],
    ['url1', bm('url1', 'url', 'f2')],
  ])

  it('flags the parent chain of a dragged folder (target is its ancestor)', () => {
    expect(isAncestorOfDragged(['f2'], 'f1', flat)).toBe(true)
    expect(isAncestorOfDragged(['url1'], 'f1', flat)).toBe(true)
    expect(isAncestorOfDragged(['url1'], 'f2', flat)).toBe(true)
  })

  it('dragging a folder onto its own descendant is NOT flagged (moveIds rejects later)', () => {
    expect(isAncestorOfDragged(['f1'], 'f2', flat)).toBe(false)
    expect(isAncestorOfDragged(['f1'], 'url1', flat)).toBe(false)
  })

  it('flags the dragged id itself when it IS the target', () => {
    expect(isAncestorOfDragged(['f2'], 'f2', flat)).toBe(true)
  })
})

describe('gridDropZone', () => {
  const url = bm('u')
  const folder = bm('f', 'folder')

  const zone = (dx: number, dy: number, target: Bookmark, draggingSelfSubtree = false): GridSide =>
    gridDropZone(dx, dy, target, { draggingSelfSubtree })

  it('left/top edges insert before', () => {
    expect(zone(0.1, 0.5, url)).toBe('before')
    expect(zone(0.5, 0.1, url)).toBe('before')
  })

  it('right/bottom edges insert after', () => {
    expect(zone(0.9, 0.5, url)).toBe('after')
    expect(zone(0.5, 0.9, url)).toBe('after')
  })

  it('folder CENTER (>0.25 from every edge) means move-into', () => {
    expect(zone(0.5, 0.5, folder)).toBe('inside')
    expect(zone(0.3, 0.5, folder)).toBe('inside')
  })

  it('folder edges keep the reorder slot (no accidental move-into)', () => {
    expect(zone(0.1, 0.5, folder)).toBe('before')
    expect(zone(0.9, 0.9, folder)).toBe('after')
  })

  it('folder center falls back to edges when the dragged set contains its subtree', () => {
    expect(zone(0.5, 0.5, folder, true)).toBe('before') // perfect tie → before (before <= after)
    expect(zone(0.5, 0.4, folder, true)).toBe('before') // top edge nearer
    expect(zone(0.7, 0.7, folder, true)).toBe('after')
  })

  it('url cards never resolve to inside', () => {
    expect(zone(0.5, 0.5, url)).toBe('before') // center tie → before, still reorder
  })
})
