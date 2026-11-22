// Popup: quick-save current page + instant local search (offline-capable).

const $ = ((id: string) => document.getElementById(id)!) as (id: string) => HTMLElement

const AVATAR_COLORS = [
  'linear-gradient(135deg,#6474f3,#8b5cf6)',
  'linear-gradient(135deg,#22b07d,#17a2b8)',
  'linear-gradient(135deg,#f7b955,#f2874b)',
  'linear-gradient(135deg,#ec6f9c,#d84f75)',
  'linear-gradient(135deg,#38a2e8,#2b7de0)',
]
function avatarFor(n: { id?: string; url?: string }): string {
  let h = 0
  for (const c of n.url || n.id || '?') h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
function initial(t?: string): string {
  return (t || '?').trim().slice(0, 1).toUpperCase()
}

async function checkConflict() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'conflictStatus' })
    if (resp.hasConflict) {
      ($('conflictBar') as HTMLElement).style.display = 'block'
    }
  } catch { /* status endpoint unavailable */ }
}

// 常驻功能：一键打开浏览器自带的同步设置页（Chrome/Edge 自动区分）
function initSyncSettingsButton() {
  ($('openSyncSettings') as HTMLButtonElement).onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'openSyncSettings' })
    window.close()
  }
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'status' })
    const dot = $('dot')
    const text = $('statusText')
    dot.className = 'dot ' + (resp.status === 'online' ? 'online' : resp.status === 'unconfigured' ? 'unconfigured' : resp.status === 'unauthorized' ? 'unauthorized' : 'off')
    text.textContent =
      resp.status === 'online' ? '已连接' :
      resp.status === 'unconfigured' ? '未配置 — 打开设置完成配对' :
      resp.status === 'unauthorized' ? '令牌失效，请重新配对' : '离线（改动将自动排队同步）'
    if (resp.queued > 0) $('queueInfo').textContent = `待同步 ${resp.queued}`
    else $('queueInfo').textContent = ''
  } catch {
    $('statusText').textContent = '状态获取失败'
  }
}

async function initSave() {
  let tab: chrome.tabs.Tab | undefined
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }) } catch { /* noop */ }
  ;($('title') as HTMLInputElement).value = tab?.title || ''
  ;($('saveBtn') as HTMLButtonElement).onclick = async () => {
    const title = ($('title') as HTMLInputElement).value || tab?.title || tab?.url || ''
    const resp = await chrome.runtime.sendMessage({
      type: 'saveCurrent',
      url: tab?.url,
      title,
      tags: ($('tags') as HTMLInputElement).value,
    })
    $('savedMsg').textContent = resp.ok ? '已收藏 ✓' : resp.error || '失败'
    setTimeout(() => ($('savedMsg').textContent = ''), 2200)
  }
}

// instant local search over chrome.bookmarks (works offline)
function initSearch() {
  const input = $('localSearch') as HTMLInputElement
  const out = $('searchResults')
  input.addEventListener('input', async () => {
    const q = input.value.trim()
    out.innerHTML = ''
    if (!q) return
    const results = await chrome.bookmarks.search(q)
    let shown = 0
    for (const r of results) {
      if (!r.url || shown >= 6) continue
      shown++
      const a = document.createElement('a')
      a.href = r.url
      const ico = document.createElement('span')
      ico.className = 'fav-ico'
      ico.style.background = avatarFor(r)
      ico.textContent = initial(r.title || r.url)
      a.appendChild(ico)
      const span = document.createElement('span')
      span.textContent = r.title || r.url
      a.appendChild(span)
      a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: r.url }) }
      out.appendChild(a)
    }
    if (!shown) {
      const p = document.createElement('div')
      p.style.cssText = 'color:var(--text3); font-size:12px; padding:4px 8px'
      p.textContent = '没有匹配的书签'
      out.appendChild(p)
    }
  })
}

$('optionsBtn').onclick = () => chrome.runtime.openOptionsPage()

refreshStatus()
checkConflict()
initSave()
initSearch()
initSyncSettingsButton()

export {}
