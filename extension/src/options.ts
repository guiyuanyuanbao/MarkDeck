// Options page: server pairing + manual resync.
import { CONFIG_KEY, TOUCH_KEY, STATUS_KEY, TIMEOUTS, apiBase, browserDisplayName } from './constants'

const $ = ((id: string) => document.getElementById(id)!) as (id: string) => HTMLElement

chrome.storage.local.get(CONFIG_KEY).then((st: any) => { const md_config = st[CONFIG_KEY];
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

  // step feedback: pairing runs several network operations (exchange ->
  // initial import -> full sync); without progress text a failure at any
  // step looked like the whole thing hung
  msg.className = 'msg'
  msg.textContent = '① 正在连接服务器…'
  try {
    const st = await fetch(server + '/api/auth/state', { signal: AbortSignal.timeout(TIMEOUTS.stateProbe) })
    if (!st.ok) throw new Error('服务器响应异常 HTTP ' + st.status)
  } catch (e: any) {
    msg.className = 'msg err'
    msg.textContent = '无法连接服务器: ' + (e?.message || '网络错误')
    return
  }
  msg.textContent = '② 正在交换配对码…'
  const resp = await chrome.runtime.sendMessage({
    type: 'pair', server, code,
    name: browserDisplayName(),
  })
  if (resp?.ok) {
    msg.className = 'msg ok'; msg.textContent = '配对成功，首次同步已开始'
    // update the status card / topbar chip immediately — the SW status
    // flips to 'online' on the first successful reconcile, and waiting
    // for the 5s poll made success feel unverifiable
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300))
      await refreshConnStatus()
      if (document.getElementById('pairChipText')!.textContent !== '未配对') break
    }
    runDiagnostics()
  } else {
    msg.className = 'msg err'; msg.textContent = '配对失败: ' + (resp?.error || '未知错误') +
      (String(resp?.error || '').includes('pairing code') ? '（配对码已过期，请重新生成）' : '')
  }
}

$('resyncBtn').onclick = async () => {
  const msg = $('pairMsg')
  await chrome.runtime.sendMessage({ type: 'resync' })
  msg.className = 'msg ok'; msg.textContent = '✓ 已触发全量同步'
}

// version check: server publishes the extension version it ships; when it
// differs from this build, surface a one-click upgrade banner (unpacked
// installs can't self-update — this is the practical substitute)
;(async () => {
  // header version badge: always show the running version (it doubles as the
  // "which zip am I running" answer the user needs on unpacked installs)
  const mine = chrome.runtime.getManifest().version
  const badge = document.getElementById('versionBadge')
  if (badge) badge.textContent = 'v' + mine

  const st: any = await chrome.storage.local.get(CONFIG_KEY)
  const server = st[CONFIG_KEY]?.server
  if (!server) return
  try {
    const r = await fetch(apiBase(server) + '/api/extension/update', { signal: AbortSignal.timeout(TIMEOUTS.stateProbe) })
    if (!r.ok) return
    const d = await r.json()
    if (!d.version || d.version === mine) return
    const card = document.getElementById('connCard')!
    const up = document.createElement('div')
    up.style.cssText = 'margin-top:12px;padding:10px 13px;background:var(--primary-soft);border-radius:10px;display:flex;align-items:center;gap:10px'
    up.innerHTML = '<span style="font-size:12.5px;color:var(--text)">有新版本 <b>v' + d.version + '</b>（当前 v' + mine + '）</span>'
    const btn = document.createElement('button')
    btn.className = 'btn-primary'
    btn.style.padding = '7px 14px'
    btn.style.fontSize = '12.5px'
    btn.textContent = '下载升级包'
    btn.onclick = () => {
      const a = document.createElement('a')
      a.href = d.url
      a.download = ''
      a.click()
    }
    up.appendChild(btn)
    card.appendChild(up)
  } catch { /* server older than this feature: silence */ }
})()

// live connection status card (always visible) + topbar pairing chip.
// The chip answers "did it pair?" at a glance; the steps/how-to block is
// hidden once paired so the page reads as "connected" instead of as a
// setup wizard. Pairing success refreshes immediately (no 10s wait).
function applyChip(status: string) {
  const chip = document.getElementById('pairChip')!
  const dot = document.getElementById('pairChipDot')!
  const text = document.getElementById('pairChipText')!
  const stateLabel = document.getElementById('connStateLabel')!
  const steps = document.getElementById('pairSteps')!
  const paired = status === 'online'
  const known = status === 'online' || status === 'disconnected' || status === 'unauthorized'
  chip.className = 'pair-chip ' + (status === 'online' ? 'paired' : status === 'unauthorized' ? 'broken' : known ? 'offline' : '')
  dot.className = 'dot ' + (status === 'online' ? 'online' : status === 'unauthorized' ? 'err' : known ? 'off' : 'none')
  text.textContent =
    status === 'online' ? '已配对' :
    status === 'unauthorized' ? '令牌失效' :
    status === 'disconnected' ? '已配对 · 离线' : '未配对'
  stateLabel.textContent = paired ? '已配对' : ''
  steps.style.display = paired ? 'none' : ''
}

async function refreshConnStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'status' })
    const card = document.getElementById('connCard')!
    const dot = document.getElementById('connDot')!
    const title = document.getElementById('connTitle')!
    const desc = document.getElementById('connDesc')!
    card.style.display = 'block'
    applyChip(resp.status)
    const q = resp.queued > 0 ? `，待同步 ${resp.queued} 条` : ''
    switch (resp.status) {
      case 'online':
        dot.className = 'dot online'
        title.textContent = '已配对，同步正常'
        desc.textContent = '书签双向实时同步中' + q
        break
      case 'disconnected':
        dot.className = 'dot off'
        title.textContent = '已配对，当前离线'
        desc.textContent = '改动已保存在本地，恢复连接后自动同步' + (resp.queued ? `（${resp.queued} 条）` : '')
        break
      case 'unauthorized':
        dot.className = 'dot err'
        title.textContent = '设备令牌已失效'
        desc.textContent = '请在下方重新配对'
        break
      default:
        dot.className = 'dot none'
        title.textContent = '尚未配对'
        desc.textContent = '填写上方地址与配对码完成连接'
    }
  } catch { /* ignore */ }
}
refreshConnStatus()
setInterval(refreshConnStatus, 5000)

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
  card.style.display = 'block'
  rows.innerHTML = ''
  const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
  const CROSS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>'
  const WAIT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>'
  const row = (ok: boolean | null, label: string, detail = '') => {
    const div = document.createElement('div')
    div.className = 'diag-row ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'pending')
    const svg = ok === true ? CHECK_SVG : ok === false ? CROSS_SVG : WAIT_SVG
    div.innerHTML = `<span class="diag-ico icon">${svg}</span><span class="diag-label">${label}${detail ? ` <span class="diag-detail">${detail}</span>` : ''}</span>`
    rows.appendChild(div)
    return ok
  }

  let broken: string | null = null
  const fail = (why: string) => { if (!broken) broken = why }

  // 1. config exists?
  const cfg = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as {
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
      row(false, '站点访问权限', '未授权')
      fail('未授予服务器站点访问权限')
    }
  }

  // 3. live reachability from the extension's own context
  if (cfg?.server) {
    let reachable = false
    let serverRev = -1
    try {
      const r = await fetch(cfg.server.replace(/\/+$/, '') + '/api/auth/state', { signal: AbortSignal.timeout(TIMEOUTS.stateProbe) })
      reachable = r.ok
    } catch { /* offline */ }
    if (reachable) {
      try {
        const pr = await fetch(cfg.server.replace(/\/+$/, '') + '/api/sync/status', {
          headers: { Authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(TIMEOUTS.stateProbe),
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

    // 5. pending local edits (touch journal replaces the old offline queue)
    const tRaw = (await chrome.storage.local.get(TOUCH_KEY))[TOUCH_KEY] || {}
    const q = Object.keys(tRaw).length
    if (q === 0) row(true, '待同步改动', '无')
    else row(null, '待同步改动', `${q} 条待对账`)

    // 6. WS realtime channel
    const st = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY]
    if (st === 'online') row(true, '实时通道 (WebSocket)')
    else if (st === 'disconnected') {
      row(false, '实时通道 (WebSocket)', '未连接')
      fail('WebSocket 未连接')
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
      row(false, '内容对比', deep?.error || '查询失败')
    } else {
      row(null, '内容对比', `服务端 ${deep.serverUrls} 条 URL / 浏览器 ${deep.localUrls} 条`)
      if ((deep.missingCount ?? 0) === 0) {
        row(true, '书签一致性', '一致')
      } else {
        row(false, '书签一致性', `服务端有 ${deep.missingCount} 条 URL 浏览器没有（示例: ${(deep.missingLocally || []).slice(0, 3).join(', ')}）`)
        fail('内容未写入浏览器 — 点「强制重建同步」')
        // expose the rebuild action next to the failed row
        const card = document.getElementById('diagCard')!
        if (!document.getElementById('rebuildBtn')) {
          const actions = card.querySelector('.actions')!
          const btn = document.createElement('button')
          btn.id = 'rebuildBtn'
          btn.className = 'btn-primary'
          btn.textContent = '⚡ 强制重建同步'
          btn.onclick = async () => {
            btn.disabled = true
            btn.textContent = '重建中…'
            try {
              const resp = await chrome.runtime.sendMessage({ type: 'forceResync' })
              if (resp?.ok) {
                summary.textContent =
                  `重建完成：新建 ${resp.created ?? '?'}，失败 ${resp.failed ?? '?'}。点「重新检测」确认`
                if ((resp.errors || []).length) {
                  summary.textContent += ' | 失败样例: ' + resp.errors.slice(0, 2).join(' / ')
                }
              } else {
                summary.textContent = '重建失败: ' + (resp?.error || '未知错误')
              }
            } finally {
              btn.disabled = false
              btn.textContent = '⚡ 强制重建同步'
            }
          }
          actions.appendChild(btn)
        }
      }
      row(null, '绑定健康', `已绑定 ${deep.bindings ?? '?'} 条 / 服务端 ${deep.serverUrls ?? '?'} 条 URL；浏览器缺 ${deep.missingCount ?? '?'} 条、多 ${deep.extraCount ?? '?'} 条`)
    }
  }

  summary.textContent = broken
    ? '发现问题：' + broken
    : '各项正常'
}
$('diagRefresh').onclick = runDiagnostics
runDiagnostics()

export {}
