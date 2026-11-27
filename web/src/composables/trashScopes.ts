// Trash scope pipeline (pure logic, extracted from TrashView): the sidebar's
// five self-contained scopes, the search-lifted filtering pipeline and the
// badge counts. Invariant under test: each sidebar badge equals the content
// its scope lists (the old type×time filter pair showed 网址书签 8 while
// listing 1).
import type { Bookmark } from '@/api/client'

export type TrashScope = 'all' | 'url' | 'folder' | '7d' | 'older'

// sidebar entry shape (TrashView's SideFilter)
export interface ScopeFilter {
  key: TrashScope
  label: string
  ico: string
  count: number
  hint: string
}
export type SideFilterLike = ScopeFilter

// buildScopeFilters assembles the sidebar entries. counts.all describes the
// top level of the hierarchy ('all' scope), the rest describe the global
// filtered totals.
export function buildScopeFilters(trash: Bookmark[], topLevelCount: number, nowSec: number): ScopeFilter[] {
  const total = trash.length
  const url = trash.filter((b) => b.type === 'url').length
  const folder = trash.filter((b) => b.type === 'folder').length
  const week = trash.filter((b) => (b.deletedAt || 0) >= nowSec - 7 * 86400).length
  return [
    { key: 'all', label: '全部', ico: 'trash', count: topLevelCount, hint: `按层级浏览 · 顶层 ${topLevelCount} 项 / 共 ${total} 项` },
    { key: 'url', label: '网址书签', ico: 'bookmark', count: url, hint: '全部网址书签（含文件夹内的）' },
    { key: 'folder', label: '文件夹', ico: 'folder', count: folder, hint: '全部已删除文件夹' },
    { key: '7d', label: '最近 7 天', ico: 'refresh', count: week, hint: '最近 7 天删除的所有内容' },
    { key: 'older', label: '7 天前', ico: 'stack', count: total - week, hint: '更早删除的所有内容' },
  ]
}

export type TrashSortBy = 'deletedDesc' | 'deletedAsc' | 'title'

// applyScopeFilters runs the pipeline: scope gate (flat scopes see the WHOLE
// trash; 'all' sees the browsed level unless a search lifts it to everything)
// → search substring over title/url → sort. nowSec pins the 7-day boundary.
export function applyScopeFilters(
  trash: Bookmark[],
  scope: TrashScope,
  currentRows: Bookmark[],
  searching: boolean,
  query: string,
  sortBy: TrashSortBy,
  nowSec: number,
): Bookmark[] {
  let rows = scope !== 'all' ? trash : (searching ? trash : currentRows)
  switch (scope) {
    case 'url': rows = rows.filter((b) => b.type === 'url'); break
    case 'folder': rows = rows.filter((b) => b.type === 'folder'); break
    case '7d': rows = rows.filter((b) => (b.deletedAt || 0) >= nowSec - 7 * 86400); break
    case 'older': rows = rows.filter((b) => (b.deletedAt || 0) < nowSec - 7 * 86400); break
  }
  if (searching) {
    const k = query.toLowerCase()
    rows = rows.filter((b) => (b.title || '').toLowerCase().includes(k) || (b.url || '').toLowerCase().includes(k))
  }
  return [...rows].sort((a, b) =>
    sortBy === 'deletedDesc' ? (b.deletedAt || 0) - (a.deletedAt || 0)
      : sortBy === 'deletedAsc' ? (a.deletedAt || 0) - (b.deletedAt || 0)
        : (a.title || '').localeCompare(b.title || ''),
  )
}

// ancestorChain walks the trash parent chain up from id (deepest-first list,
// root last) — used for breadcrumbs and 原位置 paths.
export function ancestorChain(id: string, byId: Map<string, Bookmark>): { id: string; title: string }[] {
  const chain: { id: string; title: string }[] = []
  let p: string | undefined = id
  let guard = 0
  while (p && guard++ < 100) {
    const row = byId.get(p)
    if (!row) break
    chain.unshift({ id: row.id, title: row.title || '(未命名)' })
    p = row.parentId
  }
  return chain
}

// origPath renders the full relative path of a trashed row's original
// location. Trashed ancestors supply names; live (restored) ones come from
// liveNames/liveParent; purged ancestors degrade to （已删除） markers.
export function origPath(
  pid: string,
  trashById: Map<string, Bookmark>,
  liveNames: Map<string, string>,
  liveParent: (id: string) => string,
): string {
  if (!pid) return '根目录'
  const chain: string[] = []
  let p: string | undefined = pid
  let guard = 0
  while (p && guard++ < 100) {
    const trow = trashById.get(p)
    if (trow) {
      chain.unshift(trow.title || '(未命名)')
      p = trow.parentId
      continue
    }
    const lname = liveNames.get(p)
    if (lname) {
      chain.unshift(lname)
      p = liveParent(p)
      continue
    }
    return chain.length ? chain.join(' / ') + ' / （已删除）' : '（原文件夹已删除）'
  }
  return chain.join(' / ') || '根目录'
}

// relPath renders the path relative to the browsed folder: '本层' when the
// row's parent IS the browsed folder, the partial chain when it is a
// descendant, and the full origPath otherwise (flat scopes + trash top).
export function relPath(
  pid: string,
  scope: TrashScope,
  currentFolderId: string,
  searching: boolean,
  trashById: Map<string, Bookmark>,
  liveNames: Map<string, string>,
  liveParent: (id: string) => string,
): string {
  // flat scopes have no "current level" concept — always the full path
  // (check FIRST: pid===''===currentFolder at trash top would otherwise say 本层)
  if (scope !== 'all') return origPath(pid, trashById, liveNames, liveParent)
  // during global search the browsed folder itself can appear in results
  if (pid === currentFolderId && !searching) return '本层'
  if (currentFolderId === '') return origPath(pid, trashById, liveNames, liveParent)
  const chain: string[] = []
  let p: string | undefined = pid
  let guard = 0
  while (p && guard++ < 100) {
    if (p === currentFolderId) return chain.join(' / ') || '本层'
    const row = trashById.get(p)
    if (!row) break
    chain.unshift(row.title || '(未命名)')
    p = row.parentId
  }
  return origPath(pid, trashById, liveNames, liveParent)
}
