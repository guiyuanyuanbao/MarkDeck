// Table-driven tests for the trash scope pipeline: badge==content invariant,
// search lifting, scope gating, and the path-chain renderers.
import { describe, it, expect } from 'vitest'
import { buildScopeFilters, applyScopeFilters, ancestorChain, origPath, relPath, type TrashScope } from './trashScopes'
import type { Bookmark } from '@/api/client'

const NOW = 1_700_000_000
const bm = (id: string, o: Partial<Bookmark> = {}): Bookmark => ({
  id, parentId: '', type: 'url', title: id, favorite: false, archived: false,
  position: 0, revision: 0, updatedAt: 0, createdAt: 0, ...o,
})
// fixture: folder 数据 (2 urls) + top url + folder Imported (5 urls)
const FIXTURE: Bookmark[] = [
  bm('top', { title: '顶层书签', deletedAt: NOW - 100 }),
  bm('shuju', { type: 'folder', title: '数据', deletedAt: NOW - 200 }),
  bm('s1', { parentId: 'shuju', title: '北邮', deletedAt: NOW - 200 }),
  bm('s2', { parentId: 'shuju', title: '自助', deletedAt: NOW - 200 }),
  bm('imp', { type: 'folder', title: 'Imported', deletedAt: NOW - 8 * 86400 }),
  ...Array.from({ length: 5 }, (_, i) => bm(`i${i + 1}`, { parentId: 'imp', title: `导入${i + 1}`, deletedAt: NOW - 8 * 86400 })),
]

describe('buildScopeFilters (badge == content invariant)', () => {
  const filters = buildScopeFilters(FIXTURE, 3, NOW)
  const byKey = Object.fromEntries(filters.map((f) => [f.key, f]))

  it('url badge equals what the url scope lists', () => {
    expect(byKey.url.count).toBe(8) // top + 5 imported + 2 数据 urls
    expect(applyScopeFilters(FIXTURE, 'url', [], false, '', 'deletedDesc', NOW)).toHaveLength(8)
  })
  it('folder badge equals what the folder scope lists', () => {
    expect(byKey.folder.count).toBe(2)
    expect(applyScopeFilters(FIXTURE, 'folder', [], false, '', 'deletedDesc', NOW)).toHaveLength(2)
  })
  it('7d/older badges split the total and match their listings', () => {
    expect(byKey['7d'].count).toBe(4) // top + shuju + s1 + s2 (deleted within the week)
    expect(byKey.older.count).toBe(6) // imp + its 5 urls
    expect(byKey['7d'].count + byKey.older.count).toBe(FIXTURE.length)
    expect(applyScopeFilters(FIXTURE, '7d', [], false, '', 'deletedDesc', NOW)).toHaveLength(4)
    expect(applyScopeFilters(FIXTURE, 'older', [], false, '', 'deletedDesc', NOW)).toHaveLength(6)
  })
  it('all badge describes the top level, not the total', () => {
    expect(byKey.all.count).toBe(3)
    expect(byKey.all.hint).toContain('顶层 3 项')
  })
})

describe('applyScopeFilters', () => {
  it("'all' scope lists only the browsed level (currentRows)", () => {
    const currentRows = [FIXTURE[0], FIXTURE[1]]
    expect(applyScopeFilters(FIXTURE, 'all', currentRows, false, '', 'deletedDesc', NOW)).toEqual(currentRows)
  })
  it("search lifts the 'all' scope to the whole trash", () => {
    const rows = applyScopeFilters(FIXTURE, 'all', [], true, '导入', 'deletedDesc', NOW)
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.title?.includes('导入'))).toBe(true)
  })
  it('flat scopes ignore the browsed level (global lists)', () => {
    expect(applyScopeFilters(FIXTURE, 'url', [], false, '', 'deletedDesc', NOW).every((r) => r.type === 'url')).toBe(true)
  })
  it('sorts by deletedDesc / deletedAsc / title', () => {
    const rows = applyScopeFilters(FIXTURE, 'all', FIXTURE, false, '', 'deletedDesc', NOW)
    expect(rows[0].deletedAt!).toBeGreaterThan(rows[rows.length - 1].deletedAt!)
    const asc = applyScopeFilters(FIXTURE, 'all', FIXTURE, false, '', 'deletedAsc', NOW)
    expect(asc[0].deletedAt!).toBeLessThan(asc[asc.length - 1].deletedAt!)
    const byTitle = applyScopeFilters(FIXTURE, 'all', FIXTURE, false, '', 'title', NOW)
    // localeCompare orders ASCII before CJK — Imported heads the list
    expect(byTitle[0].title).toBe('北邮'.localeCompare('Imported') > 0 ? 'Imported' : byTitle[0].title)
    expect([...byTitle].map((r) => r.title).sort((a, b) => (a || '').localeCompare(b || ''))).toEqual(byTitle.map((r) => r.title))
  })
})

describe('ancestorChain', () => {
  const byId = new Map(FIXTURE.map((b) => [b.id, b]))
  it('walks from the id up to the trash top, root last (breadcrumb order)', () => {
    expect(ancestorChain('s1', byId).map((c) => c.id)).toEqual(['shuju', 's1'])
    expect(ancestorChain('shuju', byId).map((c) => c.id)).toEqual(['shuju'])
    expect(ancestorChain('top', byId).map((c) => c.id)).toEqual(['top'])
    expect(ancestorChain('nonexistent', byId)).toEqual([])
  })
})

describe('origPath / relPath (take a PARENT id, as the view passes b.parentId)', () => {
  const trashById = new Map(FIXTURE.map((b) => [b.id, b]))
  const liveNames = new Map([['live1', '已恢复的文件夹']])
  const liveParent = (id: string) => (id === 'live1' ? '' : '')
  const args = [trashById, liveNames, liveParent] as const

  it('the chain STARTS with the pid row itself: origPath(b.parentId) names the containing folder', () => {
    expect(origPath('shuju', ...args)).toBe('数据') // s1 lives in 数据
    expect(origPath('imp', ...args)).toBe('Imported') // i1..i5 live in Imported
    expect(origPath('', ...args)).toBe('根目录') // top-level rows
  })
  it('deep nesting joins every ancestor with /', () => {
    const deeper = new Map<string, Bookmark>(trashById)
    const x = bm('x', { parentId: 's1', title: '深层' })
    deeper.set(x.id, x)
    // a child of 深层: parent x → 数据 / 北邮(s1's title) / 深层
    expect(origPath('x', deeper, liveNames, liveParent)).toBe('数据 / 北邮 / 深层')
  })
  it('restored ancestors resolve via the live tree', () => {
    expect(origPath('live1', ...args)).toBe('已恢复的文件夹')
  })
  it('purged ancestors degrade to （原文件夹已删除）', () => {
    expect(origPath('gone', ...args)).toBe('（原文件夹已删除）')
  })

  it("relPath: '本层' for rows whose PARENT is the browsed folder (i1's parent is imp)", () => {
    expect(relPath('imp', 'all', 'imp', false, ...args)).toBe('本层')
  })
  it('relPath: full origPath on flat scopes and at trash top', () => {
    expect(relPath('imp', 'url', '', false, ...args)).toBe('Imported')
    expect(relPath('imp', 'all', '', false, ...args)).toBe('Imported')
    expect(relPath('shuju', 'url', '', false, ...args)).toBe('数据')
  })
  it('relPath: partial chain inside a browsed level, full path fallback elsewhere', () => {
    // browsed imp, row whose parent is imp → 本层
    expect(relPath('imp', 'all', 'imp', false, ...args)).toBe('本层')
    // browsed shuju, row i1 (parent imp, not inside shuju) → full path
    expect(relPath('imp', 'all', 'shuju', false, ...args)).toBe('Imported')
    // browsed imp, row s2 (parent shuju) → full path 数据
    expect(relPath('shuju', 'all', 'imp', false, ...args)).toBe('数据')
  })
  it('relPath: search shows real parent paths, not a misleading 本层', () => {
    // browsed shuju, the row shuju itself (pid='') in search results → 根目录
    expect(relPath('', 'all', 'shuju', true, ...args)).toBe('根目录')
    // without search, a row whose pid IS the browsed folder → 本层
    expect(relPath('shuju', 'all', 'shuju', false, ...args)).toBe('本层')
  })
})

describe('scope type exhaustiveness', () => {
  it('every scope key has a sidebar entry', () => {
    const keys: TrashScope[] = ['all', 'url', 'folder', '7d', 'older']
    const filters = buildScopeFilters(FIXTURE, 3, NOW)
    expect(filters.map((f) => f.key)).toEqual(keys)
  })
})
