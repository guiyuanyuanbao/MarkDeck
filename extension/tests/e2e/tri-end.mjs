// Tri-end E2E: server + web UI + extension in one real chromium.
// The web admin UI and the extension service worker live in the SAME browser
// (two tabs), exercising real user flows: login page, bookmark edits in the
// web UI, tags, trash, snapshots, import, cross-end conflict convergence,
// and >2000-row paged pull after a big import.
'use strict'
import { chromium } from 'playwright-core'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = process.env.MARKDECK_TEST_SERVER || 'http://127.0.0.1:8999'
const ADMIN_PW = process.env.MARKDECK_TEST_PASSWORD || 'markdeck-demo-2026'
const DIST = path.resolve(__dirname, '..', '..', 'dist')

const results = []
function log(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? '✓' : '✗ FAIL'), name, detail || '')
}

async function api(method, p, body, headers = {}) {
  const r = await fetch(SERVER + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: await r.text(), cookies: r.headers.getSetCookie() }
}

let COOKIE = ''
const serverNodes = async () =>
  JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: COOKIE })).body).nodes

const browserTitles = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const out = []
  const walk = (nodes) => { for (const n of nodes) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return out
})
const browserNodeByTitle = (sw, title) => sw.evaluate(async (t) => {
  const tree = await chrome.bookmarks.getTree()
  let found = null
  const walk = (nodes) => { for (const n of nodes) { if (n.title === t) found = n; if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return found ? { id: found.id, parentId: found.parentId, title: found.title, url: found.url } : null
}, title)
const resync = (sw) => sw.evaluate(() => globalThis.__markdeckResync())

async function waitB(sw, pred, timeoutMs = 12000, label = '') {
  for (let i = 0; i < timeoutMs / 400; i++) {
    let ok = false
    try { ok = await pred(await browserTitles(sw), await serverNodes()) } catch { /* transient */ }
    if (ok) return true
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('  [timeout waiting] ' + label)
  return false
}


// root ids resolved at runtime — newer Chromium profiles use GUID permanent
// node ids, never assume legacy '1'/'2' (v0.0.16 root-cause)
let barRootId = null, otherRootId = null
async function resolveBarRoot() {
  if (!barRootId) {
    const tree = await chrome.bookmarks.getTree()
    barRootId = tree[0].children[0].id
  }
  return barRootId
}
async function resolveOtherRoot() {
  if (!otherRootId) {
    const tree = await chrome.bookmarks.getTree()
    otherRootId = tree[0].children[1].id
  }
  return otherRootId
}

async function main() {
  console.log('== MarkDeck tri-end E2E (web UI + extension in one chromium) ==')
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  // ---- fresh server with embedded web UI ----
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-tri', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-tri' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  log('server started fresh', true)

  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  let l
  if (state.setup) l = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  else l = await api('POST', '/api/auth/login', { password: ADMIN_PW })
  if (l.status !== 200) throw new Error('auth: ' + l.body)
  COOKIE = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf

  // server pre-content the extension will pull
  await api('POST', '/api/bookmarks',
    { type: 'url', title: '服务端预置', url: 'https://preset.tri/x' },
    { Cookie: COOKIE, 'X-CSRF': csrf })

  // ---- launch chromium: extension loaded ----
  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-tri-profile'
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: { width: 1360, height: 900 },
  })
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error('extension SW not found')
  sw.on('console', msg => { if (msg.text().includes('error')) console.log('[SW]', msg.text()) })

  // ---- pair extension through real options UI (first, so web edits push to it) ----
  const extId = new URL(sw.url()).host
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: COOKIE, 'X-CSRF': csrf })).body).code
  const optPage = await context.newPage()
  await optPage.goto(`chrome-extension://${extId}/options.html`)
  await optPage.fill('#server', SERVER)
  await optPage.fill('#code', code)
  await optPage.click('#pairBtn')
  let pairMsg = ''
  for (let i = 0; i < 30; i++) {
    pairMsg = await optPage.textContent('#pairMsg')
    if (pairMsg.includes('配对成功') || pairMsg.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  log('X0: extension paired via options UI', pairMsg.includes('配对成功'), 'msg=' + pairMsg)
  await optPage.close()
  await new Promise(r => setTimeout(r, 2000))
  log('X0b: server preset reached browser',
    (await browserTitles(sw)).includes('服务端预置'))
  // device token for later sync/apply calls (read from the SW's storage)
  const pairToken = await sw.evaluate(async () =>
    (await chrome.storage.local.get('md_config')).md_config?.token || '')

  // ---- X1: log into the REAL web UI in a tab ----
  const webPage = await context.newPage()
  await webPage.goto(SERVER + '/login')
  await webPage.waitForSelector('input[type="password"]', { timeout: 10000 })
  await webPage.fill('input[type="password"]', ADMIN_PW)
  await webPage.keyboard.press('Enter')
  await webPage.waitForURL(/\/(bookmarks|.*manage.*)?/, { timeout: 10000 }).catch(() => {})
  await webPage.waitForTimeout(1500)
  const webUrl = webPage.url()
  log('X1: web UI login via real form', !webUrl.includes('/login'), 'url=' + webUrl)

  // ---- X2: create a bookmark THROUGH THE WEB UI -> extension receives realtime ----
  await webPage.locator('button', { hasText: '新书签' }).first().click()
  const dlg = webPage.locator('.el-dialog').first()
  await dlg.waitFor({ timeout: 5000 })
  await dlg.locator('input[placeholder="显示名称"]').fill('网页端新建书签')
  await dlg.locator('input[placeholder="https://…"]').fill('https://web.tri/page')
  await dlg.locator('button', { hasText: '保存' }).first().click()
  await webPage.waitForTimeout(800)
  const arrived = await waitB(sw, (bt) => bt.includes('网页端新建书签'), 12000, 'web create -> extension')
  log('X2: web UI create reaches extension in realtime (no resync)', arrived,
    'titles=' + JSON.stringify((await browserTitles(sw)).slice(0, 8)))

  // expose WS diagnostics: open a probe socket, then trigger a server change
  // and see whether a broadcast frame arrives on it
  const wsProbe = await sw.evaluate(async (server) => {
    const cfg = (await chrome.storage.local.get('md_config')).md_config
    const r = await fetch(server + '/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify({ type: 'url', title: 'WS探测书签', url: 'https://wsprobe.test/x' }),
    })
    return { pushStatus: r.status }
  }, SERVER)
  console.log('[WSprobe]', JSON.stringify(wsProbe))
  const diag = await sw.evaluate(() => globalThis.__markdeckWsDiag)
  console.log('[WSdiag]', JSON.stringify(diag))
  const gotFrame = await waitB(sw, (bt) => bt.includes('WS探测书签'), 8000, 'WS-triggered pull')
  log('X2b: server apply broadcast drives extension reconcile (WS realtime)',
    gotFrame, 'wsState=' + diag.state)

  // ---- X3: rename in web UI -> extension updates in place ----
  // re-open the same bookmark in the edit dialog by clicking its row
  await webPage.locator('text=网页端新建书签').first().dblclick()
  await webPage.waitForTimeout(800)
  const dlg2 = webPage.locator('.el-dialog').first()
  const opened = await dlg2.isVisible().catch(() => false)
  if (opened) {
    await dlg2.locator('input[placeholder="显示名称"]').fill('网页端改名书签')
    await dlg2.locator('button', { hasText: '保存' }).first().click()
    const renamed = await waitB(sw, async () => !!(await browserNodeByTitle(sw, '网页端改名书签')), 12000)
    const noDup = !(await browserNodeByTitle(sw, '网页端新建书签'))
    log('X3: web UI rename propagates to extension without duplicate', renamed && noDup)
  } else {
    // fallback: API rename (UI path differs per build), still exercises propagation
    const node = (await serverNodes()).find(n => n.title === '网页端新建书签')
    await api('PUT', `/api/bookmarks/${node.id}`, { title: '网页端改名书签' }, { Cookie: COOKIE, 'X-CSRF': csrf })
    const renamed = await waitB(sw, async () => !!(await browserNodeByTitle(sw, '网页端改名书签')), 12000)
    // diagnosis: did the WS ping even fire a pull, and what did it apply?
    const dbg = await sw.evaluate(async (server) => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      const r = await fetch(server.replace(/\/+$/, '') + '/api/sync/tree', {
        headers: { Authorization: 'Bearer ' + cfg.token } })
      const data = await r.json()
      const row = (data.nodes || []).find(c => c.title && c.title.includes('改名'))
      return { head: data.head, rowFound: !!row, rowTitle: row?.title }
    }, SERVER)
    console.log('[X3dbg]', JSON.stringify(dbg))
    await resync(sw)
    const renamed2 = !!(await browserNodeByTitle(sw, '网页端改名书签'))
    log('X3: web rename propagates to extension (api fallback)', renamed || renamed2, 'dbg=' + JSON.stringify(dbg))
  }

  // ---- X4: delete in web UI -> extension removes ----
  const node2 = (await serverNodes()).find(n => n.title === '网页端改名书签')
  await api('DELETE', `/api/bookmarks/${node2.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
  const gone = await waitB(sw, (bt) => !bt.includes('网页端改名书签'), 12000)
  log('X4: server delete propagates to extension', gone)

  // ---- X5: three-end conflict convergence (offline ext edit vs web edit) ----
  const cw = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '三端冲突书签', url: 'https://tri.test/x' },
    { Cookie: COOKIE, 'X-CSRF': csrf })).body)
  await resync(sw)
  await waitB(sw, (bt) => bt.includes('三端冲突书签'), 8000)
  // extension goes offline and edits
  await sw.evaluate(async () => {
    const cfg = (await chrome.storage.local.get('md_config')).md_config
    await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    const n = await (async () => {
      const tree = await chrome.bookmarks.getTree()
      let found = null
      const walk = (ns) => { for (const x of ns) { if (x.title === '三端冲突书签') found = x; if (x.children) walk(x.children) } }
      for (const root of tree) if (root.children) walk(root.children)
      return found
    })()
    await chrome.bookmarks.update(n.id, { title: '插件离线修改' })
    await new Promise(r => setTimeout(r, 1200))
    await chrome.storage.local.set({ md_config: cfg })
  })
  // web edits meanwhile (server wins with later timestamp)
  await new Promise(r => setTimeout(r, 1000))
  await api('PUT', `/api/bookmarks/${cw.id}`, { title: '网页端同时修改' },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  const converged = await waitB(sw, (bt) => bt.includes('网页端同时修改'), 12000)
  const extTitles = await browserTitles(sw)
  const srvTitles = (await serverNodes()).map(n => n.title)
  log('X5: three-end LWW converges (web later edit wins)',
    converged && extTitles.includes('网页端同时修改') && srvTitles.includes('网页端同时修改'),
    'srv=' + JSON.stringify(srvTitles.filter(t => t.includes('冲突') || t.includes('修改'))))

  // ---- X6: 2500-row backlog -> extension paged-pull gets ALL (no silent skip) ----
  const N = 2500
  const ops = []
  for (let i = 0; i < N; i++) {
    ops.push({ id: 'imp-' + i, type: 'url', parentId: '', title: '批量导入' + i, url: 'https://bulk.tri/' + i, position: i + 1, updatedAt: Math.floor(Date.now() / 1000), deviceId: 'bulk-import' })
  }
  let pushedOk = true
  for (let i = 0; i < ops.length; i += 500) {
    const r = await api('POST', '/api/sync/apply', ops.slice(i, i + 500).map(o => ({ ...o, op: 'create' })),
      { Authorization: 'Bearer ' + pairToken })
    if (r.status !== 200) pushedOk = false
  }
  log('X6 setup: 2500 nodes pushed as backlog', pushedOk)
  await resync(sw)
  // poll browser until every single one arrived (or 40s cap)
  let allArrived = false
  for (let i = 0; i < 100 && !allArrived; i++) {
    allArrived = await sw.evaluate(async (n) => {
      const tree = await chrome.bookmarks.getTree()
      let count = 0
      const walk = (ns) => { for (const x of ns) { if (x.title?.startsWith('批量导入')) count++; if (x.children) walk(x.children) } }
      for (const root of tree) if (root.children) walk(root.children)
      return count >= n
    }, N)
    if (!allArrived) await resync(sw)
    await new Promise(r => setTimeout(r, 400))
  }
  const extBulk = await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    let count = 0
    const walk = (ns) => { for (const x of ns) { if (x.title?.startsWith('批量导入')) count++; if (x.children) walk(x.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    return count
  })
  log('X6: extension paged-pull receives ALL 2500 (>2000 page limit)', allArrived && extBulk === N,
    'received=' + extBulk + '/' + N)

  // ---- X7: snapshot -> restore -> server + extension converge back ----
  const snap = JSON.parse((await api('POST', '/api/snapshots', undefined, { Cookie: COOKIE, 'X-CSRF': csrf }).catch(() => ({ status: 0 }))).body || '{}')
  const snapList = JSON.parse((await api('GET', '/api/snapshots', undefined, { Cookie: COOKIE }).catch(() => ({ body: '[]' }))).body || '[]')
  const snaps = Array.isArray(snapList) ? snapList : snapList.snapshots || []
  log('X7 setup: snapshot created', snaps.length > 0 || snap.id, JSON.stringify(snaps.map(s => s.id || s.name).slice(0, 3)))
  if (snaps.length) {
    const sid = snaps[0].id || snaps[0].name
    // delete a node, then restore the snapshot: both ends must agree again
    const victim = (await serverNodes()).find(n => n.title === '服务端预置')
    if (victim) {
      await api('DELETE', `/api/bookmarks/${victim.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
      await resync(sw)
      await waitB(sw, (bt) => !bt.includes('服务端预置'), 8000)
      const restored = await api('POST', `/api/snapshots/${sid}/restore`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
      log('X7 setup: restore API called', restored.status === 200 || restored.status < 300, 'status=' + restored.status)
      await resync(sw)
      const backSrv = (await serverNodes()).some(n => n.title === '服务端预置')
      const backExt = await waitB(sw, (bt) => bt.includes('服务端预置'), 12000)
      log('X7: snapshot restore brings node back on BOTH ends', backSrv && backExt,
        'srv=' + backSrv + ' ext=' + backExt)
    }
  }
  await webPage.close()

  console.log('\n=== TRI-END E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
