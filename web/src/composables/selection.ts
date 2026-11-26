// Selection composable: file-manager style click-to-select with ctrl/shift
// range semantics, shared by BookmarksView and TrashView (previously
// copy-pasted in both). rows must be a reactive ref of the currently listed
// items in display order — shift ranges index into it.
import { ref, computed, type Ref } from 'vue'

export function useSelection(rows: Ref<{ id: string }[]>) {
  const checked = ref<Set<string>>(new Set())
  let lastIndex = -1

  const allChecked = computed(
    () => rows.value.length > 0 && rows.value.every((b) => checked.value.has(b.id))
  )
  const selectedCount = computed(() => checked.value.size)

  function toggleAll() {
    if (allChecked.value) checked.value = new Set()
    else checked.value = new Set(rows.value.map((b) => b.id))
  }

  function selectRow(b: { id: string }, ev: MouseEvent, idx: number) {
    if (ev.ctrlKey || ev.metaKey) {
      if (checked.value.has(b.id)) checked.value.delete(b.id)
      else checked.value.add(b.id)
      lastIndex = idx
      return
    }
    if (ev.shiftKey && lastIndex >= 0) {
      const [a, z] = lastIndex < idx ? [lastIndex, idx] : [idx, lastIndex]
      for (let i = a; i <= z; i++) checked.value.add(rows.value[i].id)
      return
    }
    checked.value = new Set([b.id])
    lastIndex = idx
  }

  function clearSelection() {
    checked.value = new Set()
    lastIndex = -1
  }

  // selectOnly replaces the selection with one row (right-click under cursor,
  // drag start) and remembers the anchor index for later shift-ranges.
  function selectOnly(id: string, idx: number) {
    checked.value = new Set([id])
    lastIndex = idx
  }

  // keep ids that still exist: a background revision mid-selection used to
  // wipe the user's checked set entirely
  function retainOnly(liveIds: Set<string>) {
    checked.value = new Set([...checked.value].filter((id) => liveIds.has(id)))
  }

  return { checked, allChecked, selectedCount, toggleAll, selectRow, selectOnly, clearSelection, retainOnly }
}
