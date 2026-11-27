// Table-driven tests for useSelection: file-manager click semantics
// (plain = replace, ctrl = toggle, shift = range from anchor) and the
// retainOnly contract that keeps mid-reload selections alive.
import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { useSelection } from './selection'

function mkrows(ids: string[]) {
  return ref(ids.map((id) => ({ id })))
}
// fake MouseEvent flags — the composable only reads ctrlKey/metaKey/shiftKey
function ev(flags: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}): MouseEvent {
  return {
    ctrlKey: !!flags.ctrl,
    metaKey: !!flags.meta,
    shiftKey: !!flags.shift,
  } as unknown as MouseEvent
}

describe('useSelection', () => {
  it('plain click selects exactly one row and re-anchors', () => {
    const rows = mkrows(['a', 'b', 'c'])
    const s = useSelection(rows)
    s.selectRow(rows.value[0], ev(), 0)
    expect([...s.checked.value]).toEqual(['a'])
    s.selectRow(rows.value[2], ev(), 2)
    expect([...s.checked.value]).toEqual(['c'])
  })

  it('ctrl click toggles membership without losing others', () => {
    const rows = mkrows(['a', 'b', 'c'])
    const s = useSelection(rows)
    s.selectRow(rows.value[0], ev(), 0)
    s.selectRow(rows.value[1], ev({ ctrl: true }), 1)
    expect([...s.checked.value].sort()).toEqual(['a', 'b'])
    s.selectRow(rows.value[0], ev({ ctrl: true }), 0)
    expect([...s.checked.value]).toEqual(['b'])
  })

  it('meta click behaves like ctrl (mac)', () => {
    const rows = mkrows(['a', 'b'])
    const s = useSelection(rows)
    s.selectRow(rows.value[0], ev({ meta: true }), 0)
    s.selectRow(rows.value[1], ev({ meta: true }), 1)
    expect([...s.checked.value].sort()).toEqual(['a', 'b'])
  })

  it('shift click selects the inclusive anchor→idx range', () => {
    const rows = mkrows(['a', 'b', 'c', 'd'])
    const s = useSelection(rows)
    s.selectRow(rows.value[1], ev(), 1) // anchor
    s.selectRow(rows.value[3], ev({ shift: true }), 3)
    expect([...s.checked.value].sort()).toEqual(['b', 'c', 'd'])
  })

  it('shift click backwards (anchor > idx) still spans the range', () => {
    const rows = mkrows(['a', 'b', 'c', 'd'])
    const s = useSelection(rows)
    s.selectRow(rows.value[2], ev(), 2)
    s.selectRow(rows.value[0], ev({ shift: true }), 0)
    expect([...s.checked.value].sort()).toEqual(['a', 'b', 'c'])
  })

  it('toggleAll selects all rows, then empties on second call', () => {
    const rows = mkrows(['a', 'b'])
    const s = useSelection(rows)
    s.toggleAll()
    expect(s.allChecked.value).toBe(true)
    expect(s.selectedCount.value).toBe(2)
    s.toggleAll()
    expect(s.selectedCount.value).toBe(0)
    expect(s.allChecked.value).toBe(false)
  })

  it('retainOnly drops ids that no longer exist, keeps the rest', () => {
    const rows = mkrows(['a', 'b', 'c'])
    const s = useSelection(rows)
    s.selectRow(rows.value[0], ev(), 0)
    s.checked.value.add('gone')
    s.retainOnly(new Set(['a', 'b', 'c']))
    expect([...s.checked.value]).toEqual(['a'])
  })

  it('clearSelection empties the set', () => {
    const rows = mkrows(['a'])
    const s = useSelection(rows)
    s.toggleAll()
    s.clearSelection()
    expect(s.selectedCount.value).toBe(0)
  })

  it('selectOnly replaces the whole set with one id', () => {
    const rows = mkrows(['a', 'b', 'c'])
    const s = useSelection(rows)
    s.toggleAll()
    s.selectOnly('c', 2)
    expect([...s.checked.value]).toEqual(['c'])
  })
})
