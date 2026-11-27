// Bookmark clipboard: internal copy/cut/paste for the bookmarks view
// (previously inline in BookmarksView). Cut is one-shot (moved once then
// cleared); copy re-creates each row under the target folder. The
// double-fire guard swallows Ctrl+V auto-repeat.
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { bookmarksApi, type Bookmark } from '@/api/client'

export function useBookmarkClipboard(targetFolderId: () => string, onDone: () => void) {
  const clipboard = ref<{ mode: 'copy' | 'cut'; ids: string[] } | null>(null)
  let pasting = false

  // selectedIds is injected (the view's checked set as an array) — clipboard
  // always operates on the current selection
  let selectedIds: () => string[] = () => []
  function setSelectionSource(fn: () => string[]) {
    selectedIds = fn
  }

  function copySelected(mode: 'copy' | 'cut') {
    const ids = selectedIds()
    if (!ids.length) return
    clipboard.value = { mode, ids }
    ElMessage.success(mode === 'copy' ? `已复制 ${ids.length} 项` : `已剪切 ${ids.length} 项`)
  }

  async function paste() {
    const clip = clipboard.value
    if (!clip || pasting) return // Ctrl+V auto-repeat / double-fire guard
    pasting = true
    try {
      if (clip.mode === 'cut') {
        await bookmarksApi.batch({ ids: clip.ids, action: 'move', parentId: targetFolderId() })
        clipboard.value = null // cut is one-shot
        ElMessage.success('已粘贴（移动）')
      } else {
        let done = 0
        let failed = 0
        for (const id of clip.ids) {
          const src = flatLookup(id)
          if (!src) continue
          try {
            await bookmarksApi.create({
              type: src.type,
              parentId: targetFolderId(),
              title: src.title,
              url: src.url || '',
              note: src.note || '',
              favorite: src.favorite,
              tags: src.tags || [],
            })
            done++
          } catch { failed++ }
        }
        if (failed) ElMessage.warning(`已粘贴 ${done} 项，${failed} 项失败`)
        else ElMessage.success(`已复制 ${done} 项`)
      }
      onDone()
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : '粘贴失败')
    } finally {
      pasting = false
    }
  }

  // row source lookup is injected (avoids importing the view's flat map here)
  let flatLookup: (id: string) => Bookmark | undefined = () => undefined
  function setLookup(fn: (id: string) => Bookmark | undefined) {
    flatLookup = fn
  }

  return { clipboard, copySelected, paste, setLookup, setSelectionSource }
}
