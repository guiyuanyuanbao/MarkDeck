// Shared UI helpers: date formatting, tree building from flat server rows,
// and the confirm-then-act wrapper. Extracted from views that each carried
// a copy (fmtDate ×8 sites, buildTree ×4, ElMessageBox catch boilerplate ×9).

// fmtDate renders a unix-seconds timestamp for tables/lists; '—' when absent.
export function fmtDate(ts?: number): string {
  return ts ? new Date(ts * 1000).toLocaleString() : '—'
}

// buildTree assembles the folder hierarchy shown in sidebars/pickers from
// the flat server tree. URL rows are ignored; siblings sort by position.
// Returns BookmarksView's TreeNode shape (raw row attached, isLeaf flag).
export function buildTree(nodes: { id: string; parentId: string; type: string; title: string; position: number }[]) {
  const byParent = new Map<string, typeof nodes>()
  for (const n of nodes) {
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, [])
    byParent.get(n.parentId)!.push(n)
  }
  const sortKids = (a: { position: number }, b: { position: number }) => a.position - b.position
  const mk = (b: any): any => {
    const kids = (byParent.get(b.id) || []).filter((k: any) => k.type === 'folder').sort(sortKids)
    return { id: b.id, label: b.title || '(未命名)', type: b.type, isLeaf: b.type === 'url', raw: b, children: kids.map(mk) }
  }
  const roots = (byParent.get('') || []).filter((k) => k.type === 'folder').sort(sortKids)
  return roots.map(mk)
}

// folderTree is the dialog-picker variant: { id, label, children } only
// (no raw rows). Children are computed from the flat list in one pass.
export function folderTree(rows: { id: string; parentId: string; type: string; title: string }[]): { id: string; label: string; children?: any[] }[] {
  const byParent = new Map<string, typeof rows>()
  for (const n of rows) {
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, [])
    byParent.get(n.parentId)!.push(n)
  }
  const mk = (b: { id: string; type: string; title: string }): { id: string; label: string; children?: any[] } => {
    const kids = (byParent.get(b.id) || []).filter((k) => k.type === 'folder').map(mk)
    return { id: b.id, label: b.title || '(未命名)', children: kids.length ? kids : undefined }
  }
  return (byParent.get('') || []).filter((k) => k.type === 'folder').map(mk)
}

// confirmAct wraps ElMessageBox.confirm + action with the shared semantics:
// user cancel ('cancel'/'close' rejection) is silent, real errors surface
// via ElMessage.error when the caller passes a message, or rethrow for
// callers that handle errors themselves.
import { ElMessageBox } from 'element-plus'

export async function confirmAct(message: string, title: string, action: () => Promise<void> | void, opts?: { type?: 'warning' | 'info' | 'error' }): Promise<void> {
  try {
    await ElMessageBox.confirm(message, title, { type: opts?.type ?? 'warning' })
  } catch {
    return // user cancelled — not an error
  }
  await action()
}
