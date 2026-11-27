// Tests for the shared UI helpers: tree assembly from flat server rows and
// the confirmAct cancel-is-silent contract.
import { describe, it, expect, vi } from 'vitest'
import { buildTree, folderTree, fmtDate, confirmAct } from './ui'

// element-plus ElMessageBox is mocked so confirmAct's cancel path is tested
// without a dialog actually rendering (jsdom has no overlay).
vi.mock('element-plus', () => ({
  ElMessageBox: {
    confirm: vi.fn(),
  },
}))
import { ElMessageBox } from 'element-plus'

describe('buildTree', () => {
  const rows = [
    { id: 'root1', parentId: '', type: 'folder', title: '根一', position: 1 },
    { id: 'root2', parentId: '', type: 'folder', title: '根二', position: 0 },
    { id: 'urlTop', parentId: '', type: 'url', title: '顶层链接', position: 2 },
    { id: 'kid1', parentId: 'root1', type: 'url', title: '子链接', position: 0 },
    { id: 'kid2', parentId: 'root1', type: 'folder', title: '子文件夹', position: 1 },
    { id: 'grand', parentId: 'kid2', type: 'url', title: '孙链接', position: 0 },
  ]
  it('keeps folders only, sorted by position, urls ignored', () => {
    const tree = buildTree(rows)
    expect(tree.map((n) => n.id)).toEqual(['root2', 'root1']) // position 0 before 1
  })
  it('nests folder children; url rows are dropped at every level', () => {
    const tree = buildTree(rows)
    const root1 = tree[1]
    expect(root1.children.map((n: { id: string }) => n.id)).toEqual(['kid2']) // url child filtered
    // grand is a url under kid2 — the sidebar tree keeps folders only
    expect(root1.children[0].children).toEqual([])
    expect(root1.children[0].isLeaf).toBe(false)
    expect(root1.children[0].label).toBe('子文件夹')
  })
  it('labels untitled folders as (未命名)', () => {
    const tree = buildTree([{ id: 'x', parentId: '', type: 'folder', title: '', position: 0 }])
    expect(tree[0].label).toBe('(未命名)')
  })
})

describe('folderTree', () => {
  it('builds the dialog-picker shape: folders only, no leaf flag', () => {
    const rows = [
      { id: 'f1', parentId: '', type: 'folder', title: '一' },
      { id: 'f2', parentId: 'f1', type: 'folder', title: '二' },
      { id: 'u1', parentId: 'f1', type: 'url', title: '链接' },
    ]
    const tree = folderTree(rows)
    expect(tree).toEqual([{ id: 'f1', label: '一', children: [{ id: 'f2', label: '二' }] }])
  })
})

describe('fmtDate', () => {
  it('renders a timestamp and falls back to — for absent values', () => {
    expect(fmtDate(0)).toBe('—')
    expect(fmtDate(undefined)).toBe('—')
    expect(fmtDate(1700000000)).not.toBe('—')
  })
})

describe('confirmAct', () => {
  it('runs the action when the dialog confirms', async () => {
    vi.mocked(ElMessageBox.confirm).mockResolvedValueOnce('confirm' as never)
    const action = vi.fn()
    await confirmAct('msg', 'title', action)
    expect(ElMessageBox.confirm).toHaveBeenCalledWith('msg', 'title', { type: 'warning' })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('silently skips the action when the user cancels', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel' as never)
    const action = vi.fn()
    await expect(confirmAct('m', 't', action)).resolves.toBeUndefined()
    expect(action).not.toHaveBeenCalled()
  })

  it('skips on close rejection too (either dismiss path is silent)', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('close' as never)
    const action = vi.fn()
    await expect(confirmAct('m', 't', action)).resolves.toBeUndefined()
    expect(action).not.toHaveBeenCalled()
  })

  it('passes opts.type through to the dialog', async () => {
    vi.mocked(ElMessageBox.confirm).mockResolvedValueOnce('confirm' as never)
    await confirmAct('m', 't', () => {}, { type: 'error' })
    expect(ElMessageBox.confirm).toHaveBeenCalledWith('m', 't', { type: 'error' })
  })
})
