<script setup lang="ts">
// Shared bookmark avatar: favicon with per-host fallback to the letter
// gradient. Extracted from BookmarksView so list rows and grid cards
// render identically without duplicating the fallback logic.
import { ref, watch, onBeforeUnmount } from 'vue'
import type { Bookmark } from '../api/client'

const props = withDefaults(defineProps<{
  b: Bookmark
  size?: number
}>(), { size: 22 })

const failed = ref(false)
// icon version: bumped whenever a revision event arrives (server data
// changed → favicons may have been re-pushed). Appended to the favicon URL
// so updated icons bust the browser cache instantly instead of sticking
// for the CDN lifetime.
//
// ONE module-level listener instead of one per instance: a 100-row list
// used to register 100 window listeners (and write localStorage 100×),
// none of them ever removed. `failed` also resets on the bump — previously
// an icon that failed once kept showing the letter fallback forever even
// after the server got the real icon.
const iconVer = ref(Number(localStorage.getItem('md-icon-ver') || 0))
function onRevision() {
  iconVer.value++
  failed.value = false
  localStorage.setItem('md-icon-ver', String(iconVer.value))
}
window.addEventListener('md:revision', onRevision)
onBeforeUnmount(() => window.removeEventListener('md:revision', onRevision))

watch(() => props.b.url, () => { failed.value = false })

function hostOf(b: Bookmark): string | null {
  try {
    return new URL(b.url || '').hostname || null
  } catch {
    return null
  }
}
function faviconSrc(b: Bookmark): string | null {
  const h = hostOf(b)
  return h ? '/api/favicon/' + encodeURIComponent(h) + '?v=' + iconVer.value : null
}
function avatarColor(b: Bookmark): string {
  const colors = [
    'linear-gradient(135deg, #6b7cf6, #8b5cf6)',
    'linear-gradient(135deg, #38b2ac, #2b8a84)',
    'linear-gradient(135deg, #f6ad55, #ed8936)',
    'linear-gradient(135deg, #fc8181, #f56565)',
    'linear-gradient(135deg, #63b3ed, #4299e1)',
    'linear-gradient(135deg, #b794f4, #9f7aea)',
  ]
  let hash = 0
  const key = b.url || b.title || 'x'
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return colors[hash % colors.length]
}
function initial(b: Bookmark): string {
  return (b.title || '?').trim().charAt(0).toUpperCase() || '?'
}
</script>

<template>
  <div
    class="bm-avatar"
    :class="b.type === 'folder' ? 'folder' : 'icon'"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <!-- folder: inline svg -->
    <svg v-if="b.type === 'folder'" :width="Math.round(size * 0.58)" :height="Math.round(size * 0.58)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
    <!-- url: favicon, letter fallback on error -->
    <img
      v-else-if="!failed && faviconSrc(b)"
      :src="faviconSrc(b)!"
      :width="Math.round(size * 0.62)"
      :height="Math.round(size * 0.62)"
      loading="lazy"
      alt=""
      @error="failed = true"
    >
    <span
      v-else
      class="bm-avatar-letter"
      :style="{ background: avatarColor(b), fontSize: Math.round(size * 0.46) + 'px', width: '100%', height: '100%' }"
    >{{ initial(b) }}</span>
  </div>
</template>
