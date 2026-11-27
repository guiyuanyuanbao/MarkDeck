// Bookmark drag & drop: pure helpers extracted verbatim from BookmarksView.
// The list view uses drop-line (insert BEFORE index) semantics; the grid uses
// nearest-edge zones + folder-center move-into. Both share spliceAt and the
// ancestor cycle check — the math was hand-tuned across v0.1.24/v0.1.25, so
// these functions are covered by table-driven tests (dnd.test.ts).
import type { Bookmark } from '@/api/client'

// draggedIds parses a drop event's payload: "text/md-ids" (JSON array,
// multi-select drag) falling back to the legacy single "text/bookmark-id".
export function draggedIds(ev: DragEvent): string[] {
  const raw = ev.dataTransfer?.getData('text/md-ids')
  if (raw) {
    try { return JSON.parse(raw) as string[] } catch { /* fallthrough */ }
  }
  const single = ev.dataTransfer?.getData('text/bookmark-id')
  return single ? [single] : []
}

// spliceAt splices the dragged ids into the sibling sequence at insertAt
// (insert BEFORE list[insertAt]) — shared insertion-point math for both
// views. currentList is the FULL current sibling sequence in display order.
export function spliceAt(currentList: { id: string }[], insertAt: number, ids: string[]): string[] {
  const currentIds = currentList.map((b) => b.id).filter((id) => !ids.includes(id))
  let at = insertAt - currentList.slice(0, insertAt).filter((b) => ids.includes(b.id)).length
  if (at < 0) at = 0
  if (at > currentIds.length) at = currentIds.length
  currentIds.splice(at, 0, ...ids)
  return currentIds
}

// isAncestorOfDragged checks whether folderId sits inside any dragged
// folder's subtree (walking parents through the flat id→row map). Such drops
// would be rejected server-side — the grid keeps edge semantics for them so
// the indicator never promises an impossible move.
export function isAncestorOfDragged(draggedIdsPreview: string[], folderId: string, flat: Map<string, Bookmark>): boolean {
  for (const id of draggedIdsPreview) {
    let p: string | undefined = id
    let guard = 0
    while (p && guard++ < 100) {
      if (p === folderId) return true
      p = flat.get(p)?.parentId || ''
    }
  }
  return false
}

export type GridSide = 'before' | 'after' | 'inside'

// gridDropZone resolves the drop intent for a grid card from the cursor's
// relative position (0..1 within the card rect) and the target row:
//  - folder cards hovered near the CENTER (>0.25 from every edge) → 'inside'
//    (move-into), unless the dragged set contains that folder's ancestor
//  - otherwise the nearest edge wins: left/top insert before, right/bottom after
export function gridDropZone(
  dx: number, dy: number, b: Bookmark,
  opts: { draggingSelfSubtree: boolean },
): GridSide {
  const before = Math.min(dx, dy)
  const after = Math.min(1 - dx, 1 - dy)
  if (b.type === 'folder' && before > 0.25 && after > 0.25 && !opts.draggingSelfSubtree) {
    return 'inside'
  }
  return before <= after ? 'before' : 'after'
}
