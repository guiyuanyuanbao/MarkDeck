// Business-state E2E: the data lifecycle as a state machine, exercised
// end-to-end across server + extension.
//
//   active ──delete──> trashed ──restore──> active (WHOLE SUBTREE revives)
//                       trashed ──purge──> purged (terminal, no resurrection)
//   trashed ──move────> rejected (must restore first)
//   active: favorite/tags/note/archived are server-owned metadata that must
//   survive pulls and not be clobbered by bookmark syncs
//   snapshot ──restore──> reconciles both existing and purged rows
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
const trashNodes = async () => {
  const body = JSON.parse((await api('GET', '/api/trash', undefined, { Cookie: COOKIE })).body)
  return body.nodes || []
}

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
  console.log('== MarkDeck business-state E2E ==')
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-bs', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-bs' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  let l
  if (state.setup) l = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  else l = await api('POST', '/api/auth/login', { password: ADMIN_PW })
  if (l.status !== 200) throw new Error('auth: ' + l.body)
  COOKIE = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf
  const H = { Cookie: COOKIE, 'X-CSRF': csrf }
  log('server + auth ready', true)

  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-bs-profile'
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: { width: 1280, height: 800 },
  })
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error('extension SW not found')
  sw.on('console', msg => { const t = msg.text(); if (t.includes('[enq]') || t.includes('error')) console.log('[SW]', t) })

  // pair via real options UI
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, H)).body).code
  const extId = new URL(sw.url()).host
  const optPage = await context.newPage()
  await optPage.goto(`chrome-extension://${extId}/options.html`)
  await optPage.fill('#server', SERVER)
  await optPage.fill('#code', code)
  await optPage.click('#pairBtn')
  for (let i = 0; i < 30; i++) {
    const m = await optPage.textContent('#pairMsg')
    if (m.includes('配对成功') || m.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  await optPage.close()
  log('extension paired', true)

  // ---- B1: delete folder -> whole subtree goes to trash ----
  const folder = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'folder', title: '回收站文件夹' }, H)).body)
  const childA = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '子书签A', url: 'https://trash.sm/a', parentId: folder.id }, H)).body)
  const subFolder = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'folder', title: '子文件夹', parentId: folder.id }, H)).body)
  const grandChild = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '孙书签', url: 'https://trash.sm/g', parentId: subFolder.id }, H)).body)
  await resync(sw)
  await waitB(sw, (bt) => bt.includes('孙书签'), 10000)

  const del = await api('DELETE', `/api/bookmarks/${folder.id}`, undefined, H)
  const trashIds = JSON.parse(del.body).deleted || []
  log('B1: deleting a folder tombstones the WHOLE subtree', trashIds.length === 4,
    'tombstoned=' + trashIds.length + '/4')

  await resync(sw)
  const allGone = await waitB(sw, (bt) =>
    !bt.includes('子书签A') && !bt.includes('孙书签'), 10000)
  log('B1b: subtree removal reaches the browser', allGone,
    'titles=' + JSON.stringify(await browserTitles(sw)))

  // ---- B2: restore folder -> whole subtree revives on server AND browser ----
  const rest = await api('POST', `/api/bookmarks/${folder.id}/restore`, undefined, H)
  log('B2 setup: restore API', rest.status === 200, 'status=' + rest.status)
  const srvAfter = await serverNodes()
  const srvTitles = srvAfter.map(n => n.title)
  const subtreeBack = ['回收站文件夹', '子书签A', '子文件夹', '孙书签'].every(t => srvTitles.includes(t))
  log('B2: restore revives the whole subtree on the server', subtreeBack,
    'titles=' + JSON.stringify(srvTitles.filter(t => t.includes('书签') || t.includes('文件夹'))))
  // child must still be attached to its restored parent (structure intact)
  const childSrv = srvAfter.find(n => n.title === '子书签A')
  const folderSrv = srvAfter.find(n => n.title === '回收站文件夹')
  log('B2b: restored child keeps its parent link', childSrv?.parentId === folderSrv?.id,
    'child.parent=' + childSrv?.parentId + ' folder=' + folderSrv?.id)

  await resync(sw)
  const b2dbg = await sw.evaluate(() => globalThis.__markdeckReconcileStats())
  console.log('[B2dbg] stats after resync:', JSON.stringify(b2dbg))
  const browserBack = await waitB(sw, (bt) => bt.includes('子书签A') && bt.includes('孙书签'), 12000)
  const bGrand = await browserNodeByTitle(sw, '孙书签')
  const bSub = await browserNodeByTitle(sw, '子文件夹')
  log('B2c: restored subtree reaches the browser', browserBack)
  log('B2d: browser nest structure intact after restore',
    !!bGrand && !!bSub && bGrand.parentId === bSub.id,
    `grand.parent=${bGrand?.parentId} sub=${bSub?.id}`)

  // ---- B3: move a trashed node is rejected (no silent resurrection) ----
  await api('DELETE', `/api/bookmarks/${childA.id}`, undefined, H)
  const mvTrashed = await api('POST', `/api/bookmarks/${childA.id}/move`, { parentId: '', position: 1 }, H)
  const stillTrashed = (await trashNodes()).some(n => n.title === '子书签A')
  log('B3: moving a trashed node is rejected and it stays in trash',
    mvTrashed.status === 400 && stillTrashed,
    'status=' + mvTrashed.status + ' msg=' + JSON.parse(mvTrashed.body).error)
  await api('POST', `/api/bookmarks/${childA.id}/restore`, undefined, H)

  // ---- B4: purge is terminal — no resurrection by any path ----
  const pg = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '永久删除书签', url: 'https://purge.sm/x' }, H)).body)
  await api('DELETE', `/api/bookmarks/${pg.id}`, undefined, H)
  const purgeResp = await api('POST', `/api/bookmarks/${pg.id}/purge`, undefined, H)
  const restoreAfterPurge = await api('POST', `/api/bookmarks/${pg.id}/restore`, undefined, H)
  const srvHasPurged = (await serverNodes()).some(n => n.title === '永久删除书签')
  const trashHasPurged = (await trashNodes()).some(n => n.title === '永久删除书签')
  log('B4: purge is terminal (restore cannot revive, gone from tree+trash)',
    purgeResp.status === 200 && !srvHasPurged && !trashHasPurged,
    'restoreStatus=' + restoreAfterPurge.status + ' inTree=' + srvHasPurged + ' inTrash=' + trashHasPurged)
  // a device that still has the purged node locally must not resurrect it
  await resync(sw)
  await new Promise(r => setTimeout(r, 1500))
  const resurrected = (await serverNodes()).some(n => n.title === '永久删除书签')
  log('B4b: extension sync after purge does not resurrect the row', !resurrected)

  // ---- B5: server-owned metadata (favorite/tags/note) survives pulls ----
  const meta = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '元数据书签', url: 'https://meta.sm/x' }, H)).body)
  await api('PUT', `/api/bookmarks/${meta.id}`,
    { favorite: true, note: '这是备注', tags: ['工作', '重要'] }, H)
  await resync(sw)
  await waitB(sw, (bt) => bt.includes('元数据书签'), 10000)
  // an extension-side edit must not wipe the metadata
  await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    let n = null
    const walk = (ns) => { for (const x of ns) { if (x.title === '元数据书签') n = x; if (x.children) walk(x.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    await chrome.bookmarks.update(n.id, { title: '元数据书签-改名' })
  })
  await resync(sw)
  const renameArrived = await waitB(sw, (bt, sn) => sn.some(n => n.title === '元数据书签-改名'), 10000)
  const qLen = await sw.evaluate(async () => Object.keys((await chrome.storage.local.get('md_touch')).md_touch || {}).length)
  const metaAll = (await serverNodes()).filter(n => (n.title || '').includes('元数据'))
  console.log('[B5dbg] renameArrived=' + renameArrived + ' queue=' + qLen
    + ' serverMetaRows=' + JSON.stringify(metaAll.map(n => ({ id: n.id.slice(0, 8), title: n.title }))))
  const metaAfter = (await serverNodes()).find(n => n.title === '元数据书签-改名')
  log('B5: extension rename keeps favorite/note/tags intact',
    !!metaAfter && metaAfter.favorite === true && metaAfter.note === '这是备注'
      && Array.isArray(metaAfter.tags) && metaAfter.tags.includes('工作') && metaAfter.tags.includes('重要'),
    JSON.stringify({ fav: metaAfter?.favorite, note: metaAfter?.note, tags: metaAfter?.tags }))

  // ---- B6: archive flag round-trips and does not delete ----
  await api('PUT', `/api/bookmarks/${meta.id}`, { archived: true }, H)
  await new Promise(r => setTimeout(r, 1200))
  const arch = (await serverNodes()).find(n => n.id === meta.id)
  const browserStillHas = (await browserTitles(sw)).includes('元数据书签-改名')
  log('B6: archive keeps the row and the browser copy', !!arch && arch.archived === true && browserStillHas,
    'archived=' + arch?.archived + ' inBrowser=' + browserStillHas)
  await api('PUT', `/api/bookmarks/${meta.id}`, { archived: false }, H)

  // ---- B7: snapshot restore reconciles deletions made after the snapshot ----
  const snap = await api('POST', '/api/snapshots', undefined, H)
  const snapBody = JSON.parse(snap.body || '{}')
  const snaps = JSON.parse((await api('GET', '/api/snapshots', undefined, H)).body)
  const snapList = (Array.isArray(snaps) ? snaps : snaps.snapshots || [])
  const newSnap = snapBody.snapshot || snapBody
  log('B7 setup: snapshot created', snap.status < 300 && (newSnap.id || snapList.length > 0),
    'status=' + snap.status + ' list=' + snapList.length)
  if (newSnap.id || snapList.length) {
    const sid = newSnap.id || snapList[0].id
    const victim = (await serverNodes()).find(n => n.title === '元数据书签-改名')
    await api('DELETE', `/api/bookmarks/${victim.id}`, undefined, H)
    await resync(sw)
    await waitB(sw, (bt) => !bt.includes('元数据书签-改名'), 8000)
    const rs = await api('POST', `/api/snapshots/${sid}/restore`, undefined, H)
    const backSrv = (await serverNodes()).some(n => n.title === '元数据书签-改名')
    console.log('[B7dbg] restore=' + rs.status + ' backSrv=' + backSrv
      + ' row=' + JSON.stringify((await serverNodes()).find(n => (n.title || '').includes('元数据'))))
    await resync(sw)
    const extState = await sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      const q = (await chrome.storage.local.get('md_touch')).md_touch || {}
      return { rev: cfg?.rev, status: (await chrome.storage.local.get('md_status')).md_status, queue: q.length }
    })
    console.log('[B7dbg-ext]', JSON.stringify(extState))
    // manual re-pull from 0 to force the extension to see the restored rows
    const manual = await sw.evaluate(async (server) => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      const r = await fetch(server.replace(/\/+$/, '') + '/api/sync/tree', {
        headers: { Authorization: 'Bearer ' + cfg.token } })
      const data = await r.json()
      const rows = (data.nodes || []).filter(c => (c.title || '').includes('元数据'))
      return { n: (data.nodes || []).length, rows: rows.map(x => ({ rev: x.revision, del: x.deletedAt, t: x.title })) }
    }, SERVER)
    console.log('[B7dbg-pull]', JSON.stringify(manual))
    const backExt = await waitB(sw, (bt) => bt.includes('元数据书签-改名'), 12000)
    log('B7: snapshot restore undoes a later deletion on both ends',
      rs.status === 200 && backSrv && backExt,
      'srv=' + backSrv + ' ext=' + backExt)
  }

  // ---- B8: tag rename keeps bookmark links consistent ----
  const tg = JSON.parse((await api('GET', '/api/tags', undefined, H)).body)
  const tagList = Array.isArray(tg) ? tg : tg.tags || []
  const hasWork = tagList.some(t => (t.tag || t.name) === '工作')
  const ren = await api('POST', '/api/tags/rename', { from: '工作', to: '办公' }, H)
  const metaRow = (await serverNodes()).find(n => n.title === '元数据书签-改名')
  log('B8: tag rename updates the bookmark link', hasWork && ren.status === 200
    && Array.isArray(metaRow?.tags) && metaRow.tags.includes('办公') && !metaRow.tags.includes('工作'),
    'tags=' + JSON.stringify(metaRow?.tags) + ' status=' + ren.status)

  console.log('\n=== BUSINESS-STATE E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
