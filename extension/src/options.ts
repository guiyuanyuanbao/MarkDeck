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

// live connection status card (always visible)
async function refreshConnStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'status' })
    const card = document.getElementById('connCard')!
    const dot = document.getElementById('connDot')!
    const title = document.getElementById('connTitle')!
    const desc = document.getElementById('connDesc')!
    card.style.display = 'block'
    const q = resp.queued > 0 ? `，本地已保存 ${resp.queued} 条待同步` : ''
    switch (resp.status) {
      case 'online':
        dot.className = 'dot online'
        title.textContent = '✓ 已连接服务器'
        desc.textContent = '书签双向实时同步中' + q
        break
      case 'disconnected':
        dot.className = 'dot off'
        title.textContent = '⚠ 与服务器断联'
        desc.textContent = '改动已保存在本地（' + (resp.queued || 0) + ' 条待同步），恢复连接后自动同步；书签查看与搜索不受影响。'
        break
      case 'unauthorized':
        dot.className = 'dot err'
        title.textContent = '设备令牌已失效'
        desc.textContent = '请在下方重新配对以恢复同步。'
        break
      default:
        dot.className = 'dot none'
        title.textContent = '尚未配对'
        desc.textContent = '填写上方服务器地址与配对码完成连接。'
    }
  } catch { /* ignore */ }
}
refreshConnStatus()
setInterval(refreshConnStatus, 10000)

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
      document.getElementById('openSyncSettings')!.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'openSyncSettings' })
      })
    }
  } catch { /* ignore */ }
}
checkConflict()

export {}
