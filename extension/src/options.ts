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

// ---- sync diagnostics: pinpoint WHERE the chain breaks ----
// (pair -> permission -> push/pull -> WS realtime -> local apply)
async function runDiagnostics() {
  const card = document.getElementById('diagCard')!
  const rows = document.getElementById('diagRows')!
  const summary = document.getElementById('diagSummary')!
  const hint = document.getElementById('diagHint')!
  card.style.display = 'block'
  rows.innerHTML = ''
  const row = (ok: boolean | null, label: string, detail = '') => {
    const div = document.createElement('div')
    const icon = ok === true ? '✅' : ok === false ? '❌' : '⏳'
    div.innerHTML = `${icon} ${label}${detail ? ` <span style="color:var(--text3)">${detail}</span>` : ''}`
    rows.appendChild(div)
    return ok
  }

  let broken: string | null = null
  const fail = (why: string) => { if (!broken) broken = why }

  // 1. config exists?
  const cfg = (await chrome.storage.local.get('md_config')).md_config as {
    server?: string; token?: string; rev?: number
  } | undefined
  if (!cfg?.token) {
    row(false, '配对状态', '未配对')
    fail('尚未完成配对')
  } else {
    row(true, '配对状态', cfg.server)
  }

  // 2. host permission granted? (MV3 fetch silently fails without it)
  if (cfg?.server) {
    let granted = false
    try {
      const origin = new URL(cfg.server).origin + '/*'
      granted = await chrome.permissions.contains({ origins: [origin] })
    } catch { /* malformed url */ }
    if (granted) row(true, '站点访问权限')
    else {
      row(false, '站点访问权限', '未授权 — fetch 将全部失败')
      fail('未授予服务器站点的访问权限（配对时应有弹窗授权）')
    }
  }

  // 3. live reachability from the extension's own context
  if (cfg?.server) {
    let reachable = false
    let serverRev = -1
    try {
      const r = await fetch(cfg.server.replace(/\/+$/, '') + '/api/auth/state', { signal: AbortSignal.timeout(6000) })
      reachable = r.ok
    } catch { /* offline */ }
    if (reachable) {
      try {
        const pr = await fetch(cfg.server.replace(/\/+$/, '') + '/api/sync/status', {
          headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(6000),
        })
        if (pr.ok) serverRev = (await pr.json()).head
        row(true, '服务器可达')
        if (serverRev >= 0) row(true, '服务端最新版本号 (head)', 'rev=' + serverRev)
        else row(false, '服务端最新版本号', 'status 接口异常')
      } catch {
        row(false, '服务端最新版本号', '查询失败')
        fail('服务器可达但同步接口异常')
      }
    } else {
      row(false, '服务器可达', 'extension 内 fetch 失败')
      fail('插件无法访问服务器（权限或网络）')
    }

    // 4. local pull progress vs server head
    const rev = Number(cfg.rev) || 0
    if (serverRev >= 0) {
      if (rev >= serverRev && serverRev >= 0) row(true, '本地同步进度', `rev=${rev}/${serverRev}（已追平）`)
      else {
        row(null, '本地同步进度', `rev=${rev}/${serverRev}（落后，等待/触发同步）`)
      }
    }

    // 5. offline queue
    const qRaw = (await chrome.storage.local.get('md_queue')).md_queue
    const q = Array.isArray(qRaw) ? qRaw.length : 0
    if (q === 0) row(true, '离线队列', '空')
    else row(null, '离线队列', `${q} 条待推送`)

    // 6. WS realtime channel
    const st = (await chrome.storage.local.get('md_status')).md_status
    if (st === 'online') row(true, '实时通道 (WebSocket)')
    else if (st === 'disconnected') {
      row(false, '实时通道 (WebSocket)', '未连接')
      fail('WebSocket 未连上（服务器可达时通常是 token 失效前兆或网络抖动）')
    } else if (st === 'unauthorized') {
      row(false, '实时通道 (WebSocket)', '令牌失效')
      fail('设备令牌已失效，需要重新配对')
    }

    // 7. deep compare: server rows vs browser tree
    let deep: any = null
    try {
      deep = await chrome.runtime.sendMessage({ type: 'deepDiag' })
    } catch { deep = null }
    if (!deep?.ok) {
      // SW may be asleep and the message channel unavailable; the hook
      // path exists for tests, so surface the failure plainly either way
      row(false, '内容对比', deep?.error || '查询失败（service worker 未响应）')
    } else {
      row(null, '内容对比', `服务端 ${deep.serverUrls} 条 URL / 浏览器 ${deep.localUrls} 条`)
      if (deep.sampleMissing === 0) {
        row(true, '书签一致性', '浏览器已包含服务端全部 URL')
      } else {
        row(false, '书签一致性', `服务端有 ${deep.sampleMissing} 条 URL 浏览器没有（示例: ${deep.missingLocally.slice(0, 3).join(', ')}）`)
        fail('拉取已完成但应用环节没有写入浏览器 — 点下方「强制重建同步」')
        // expose the rebuild action next to the failed row
        const card = document.getElementById('diagCard')!
        if (!document.getElementById('rebuildBtn')) {
          const actions = card.querySelector('.actions')!
          const btn = document.createElement('button')
          btn.id = 'rebuildBtn'
          btn.className = 'btn-primary'
          btn.textContent = '⚡ 强制重建同步（清空映射并重新全量拉取）'
          btn.onclick = async () => {
            btn.disabled = true
            btn.textContent = '重建中…'
            try {
              const resp = await chrome.runtime.sendMessage({ type: 'forceResync' })
              if (resp?.ok) {
                const a = resp.applied || {}
                summary.textContent =
                  `重建完成 — 拉取 ${resp.pulled} 行 | 计划 ${a.planned ?? '?'} | 新建 ${a.created ?? '?'} | ` +
                  `采纳 ${a.adopted ?? '?'} | 更新 ${a.updated ?? '?'} | 失败 ${a.failed ?? '?'} | ` +
                  `浏览器现有 ${resp.bookmarkUrls} 条 URL、映射 ${resp.mappings} 条。点「重新检测」确认`
                if ((a.errors || []).length) {
                  summary.textContent += ' | 失败样例: ' + a.errors.slice(0, 2).join(' / ')
                }
              } else {
                summary.textContent = '重建失败: ' + (resp?.error || '未知错误')
              }
            } finally {
              btn.disabled = false
              btn.textContent = '⚡ 强制重建同步（清空映射并重新全量拉取）'
            }
          }
          actions.appendChild(btn)
        }
      }
      row(null, '映射表健康', `server→local ${deep.mappingRows} 条 / local→server ${deep.l2sRows} 条，一致=${deep.idMapConsistent ? '是' : '否'}`)
    }
  }

  summary.textContent = broken
    ? '发现问题：' + broken
    : '各项正常 — 若服务端书签仍未出现在浏览器，点击「手动全量同步」并确认浏览器书签栏'
  hint.textContent = broken
    ? '按上面第一个 ❌ 项处理后点「重新检测」。'
    : '浏览器书签同步范围 = 书签栏 + 其他书签；远端文件夹会原样出现在这两处。'
}
$('diagRefresh').onclick = runDiagnostics
runDiagnostics()

export {}
