// Popup: quick-save current page + instant local search (offline-capable).

const $ = ((id: string) => document.getElementById(id)!) as (id: string) => HTMLElement

async function refreshStatus() {
  const resp = await chrome.runtime.sendMessage({ type: 'status' })
  const dot = $('dot')
  const text = $('statusText')
  dot.className = 'dot ' + (resp.status === 'online' ? 'online' : resp.status === 'unconfigured' ? 'unconfigured' : 'off')
  text.textContent =
    resp.status === 'online' ? '已连接' :
    resp.status === 'unconfigured' ? '未配置（打开设置完成配对）' :
    resp.status === 'unauthorized' ? '设备令牌失效，请重新配对' : '离线（可继续使用，恢复后自动同步）'
  if (resp.queued > 0) $('queueInfo').textContent = `待同步 ${resp.queued} 条`
}

async function initSave() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  ;($('title') as HTMLInputElement).value = tab?.title || ''
  ;($('saveBtn') as HTMLButtonElement).onclick = async () => {
    const title = ($('title') as HTMLInputElement).value || tab?.title || tab?.url || ''
    const resp = await chrome.runtime.sendMessage({
      type: 'saveCurrent',
      url: tab?.url,
      title,
      tags: ($('tags') as HTMLInputElement).value,
    })
    $('savedMsg').textContent = resp.ok ? '已收藏 ✓' : resp.error
    setTimeout(() => ($('savedMsg').textContent = ''), 2000)
  }
}

// instant local search over chrome.bookmarks (works offline)
$('searchBtn').onclick = () => chrome.runtime.openOptionsPage()
$('optionsBtn').onclick = () => chrome.runtime.openOptionsPage()

const input = document.createElement('input')
input.placeholder = '本地搜索书签…'
input.style.margin = '0'
document.querySelector('.row:last-child')!.prepend(input)
input.addEventListener('input', async () => {
  const q = input.value.trim()
  const out = $('searchResults')
  if (!q) { out.textContent = ''; return }
  const results = await chrome.bookmarks.search(q)
  out.innerHTML = ''
  for (const r of results.slice(0, 8)) {
    if (!r.url) continue
    const a = document.createElement('a')
    a.href = r.url
    a.textContent = r.title || r.url
    a.style.cssText = 'display:block; color:#409eff; text-decoration:none; padding:2px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap'
    a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: r.url }) }
    out.appendChild(a)
  }
})

refreshStatus()
initSave()

export {}
