// Options page: server pairing + manual resync.

const $ = ((id: string) => document.getElementById(id)!) as (id: string) => HTMLElement

chrome.storage.local.get('md_config').then((st: any) => { const { md_config } = st;
  if (md_config?.server) ($('server') as HTMLInputElement).value = md_config.server
})

$('pairBtn').onclick = async () => {
  const server = ($('server') as HTMLInputElement).value.trim().replace(/\/+$/, '')
  const code = ($('code') as HTMLInputElement).value.trim()
  const msg = $('pairMsg')
  if (!/^https?:\/\//.test(server)) { msg.className = 'msg err'; msg.textContent = '服务器地址需以 http(s):// 开头'; return }
  if (!/^\d{6}$/.test(code)) { msg.className = 'msg err'; msg.textContent = '配对码为 6 位数字'; return }

  // request host permission for the server origin (MV3 optional hosts)
  try {
    const origin = new URL(server).origin + '/*'
    const granted = await chrome.permissions.request({ origins: [origin] })
    if (!granted) { msg.className = 'msg err'; msg.textContent = '未授予该站点的访问权限'; return }
  } catch { /* chrome may auto-grant in dev */ }

  msg.className = 'msg'; msg.textContent = '配对中…'
  const resp = await chrome.runtime.sendMessage({
    type: 'pair', server, code,
    name: navigator.userAgent.includes('Edg') ? 'Edge 浏览器' : 'Chrome 浏览器',
  })
  if (resp?.ok) {
    msg.className = 'msg ok'; msg.textContent = '✓ 配对成功，首次同步已开始'
  } else {
    msg.className = 'msg err'; msg.textContent = '配对失败: ' + (resp?.error || '未知错误')
  }
}

$('resyncBtn').onclick = async () => {
  const msg = $('pairMsg')
  await chrome.runtime.sendMessage({ type: 'resync' })
  msg.className = 'msg ok'; msg.textContent = '✓ 已触发全量同步'
}

// conflict detection: duplicated bookmarks hint at double-sync
async function checkConflict() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'conflictStatus' })
    if (resp?.hasConflict) {
      const card = document.getElementById('conflictCard')!
      card.style.display = 'block'
      const total = resp.groups.reduce((a: number, g: any) => a + g.count, 0)
      document.getElementById('conflictDesc')!.textContent =
        `发现 ${resp.groups.length} 组完全相同的书签（共 ${total} 条）。`
      for (const id of ['openSyncSettings', 'openSyncSettingsFromWarning']) {
        document.getElementById(id)!.addEventListener('click', async () => {
          await chrome.runtime.sendMessage({ type: 'openSyncSettings' })
        })
      }
    }
  } catch { /* ignore */ }
}
checkConflict()

export {}
