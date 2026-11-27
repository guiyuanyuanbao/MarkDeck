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

// confirmAct wraps ElMessageBox.confirm + action with the codebase's shared
// semantics (previously copy-pasted ×15+): user cancel ('cancel'/'close'
// rejection) is silent, real action errors surface via ElMessage.error with
// the caller's prefix. opts pass through to the dialog (type, button text).
import { ElMessageBox, ElMessage } from 'element-plus'

export async function confirmAct(
  message: string,
  title: string,
  action: () => Promise<void> | void,
  opts?: {
    type?: 'warning' | 'info' | 'error'
    confirmButtonText?: string
    cancelButtonText?: string
    // error prefix for ElMessage.error, e.g. '合并失败'
    errorText?: string
  },
): Promise<void> {
  try {
    await ElMessageBox.confirm(message, title, {
      type: opts?.type ?? 'warning',
      confirmButtonText: opts?.confirmButtonText,
      cancelButtonText: opts?.cancelButtonText,
    })
  } catch {
    return // user cancelled — not an error
  }
  try {
    await action()
  } catch (e) {
    ElMessage.error(opts?.errorText ? `${opts.errorText}: ${errMsg(e)}` : errMsg(e))
  }
}

// errMsg extracts a human-readable message from a thrown value without
// typing it as any — the typed-error migration's single funnel.
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return '未知错误'
}
