// View-mode (list | grid) + grid-density persistence, shared by the
// bookmarks and trash views. Previously copy-pasted in both views and had
// already drifted (different localStorage keys, one-shot apply vs watch).
import { ref, watch } from 'vue'

export type ViewMode = 'list' | 'grid'
export type GridSize = 'small' | 'medium' | 'large'

// grid density shares one global attribute + key across views so both grids
// stay in sync (same --grid-min variable); viewMode is per-view.
export function useViewMode(storageKey: string) {
  const viewMode = ref<ViewMode>(
    (localStorage.getItem(storageKey) as ViewMode) || 'list',
  )
  watch(viewMode, (v) => localStorage.setItem(storageKey, v))
  return viewMode
}

// apply on composable creation too: entering the view directly (deep link /
// refresh) must still see the stored density — the html attribute only
// carries over when another view set it earlier this session
export function useGridSize() {
  const gridSize = ref<GridSize>(
    (localStorage.getItem('md-grid-size') as GridSize) || 'medium',
  )
  watch(gridSize, (v) => {
    localStorage.setItem('md-grid-size', v)
    document.documentElement.setAttribute('data-gridsize', v)
  })
  if (!document.documentElement.getAttribute('data-gridsize')) {
    document.documentElement.setAttribute('data-gridsize', gridSize.value)
  }
  return gridSize
}

// right-click menu / toggle button helper: flips the persisted mode
export function flipViewMode(mode: RefLike<ViewMode>) {
  mode.value = mode.value === 'list' ? 'grid' : 'list'
}
type RefLike<T> = { value: T }
