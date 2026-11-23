// Graveyard-bind E2E: reproduces the user's exact residual failure —
// duplicate server rows for one URL where one is LIVE and one is a
// TOMBSTONE. Every rebuild used to delete the live browser node because
// the tombstone's binding pointed at it. Asserts the node SURVIVES
// rebuilds and stays bound to the live row.
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
const browserNodeByTitle = (sw, title) => sw.evaluate(async (t) => {
  const tree = await chrome.bookmarks.getTree()
  let found = null
  const walk = (nodes) => { for (const n of nodes) { if (n.title === t && !found) found = n; if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return found ? { id: found.id, parentId: found.parentId, title: found.title, url: found.url } : null
}, title)
const resync = (sw) => sw.evaluate(() => globalThis.__markdeckResync())
const forceResync = (sw) => sw.evaluate(async () =>
  typeof globalThis.__markdeckForceResync === 'function'
    ? await globalThis.__markdeckForceResync()
    : chrome.runtime.sendMessage({ type: 'forceResync' }))
const folderDupCount = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const folders = new Map()
  let dups = 0
  const walk = (ns, parent) => {
    for (const x of ns) {
      if (!x.url) {
        const key = parent + '|' + x.title
        folders.set(key, (folders.get(key) || 0) + 1)
        if (folders.get(key) > 1) dups++
        if (x.children) walk(x.children, x.id)
      }
    }
  }
  const roots = tree[0]?.children ?? []
  for (const r of roots) if (r.children) walk(r.children, r.id)
  return dups
})

async function main() {
  console.log('== MarkDeck graveyard-bind E2E ==')
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-grave', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-grave' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  const l = state.setup
    ? await api('POST', '/api/auth/setup', { password: ADMIN_PW })
    : await api('POST', '/api/auth/login', { password: ADMIN_PW })
  COOKIE = l.cookies[0].split(';')[0]
  const csrf = JSON.parse(l.body).csrf
  const H = { Cookie: COOKIE, 'X-CSRF': csrf }

  // ---- G1: create a duplicate-URL pair: live row + tombstone row ----
  const live = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '墓地测试书签', url: 'https://grave.test/page' }, H)).body)
  // a second row with the SAME url, then tombstone it
  const doomed = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '墓地测试书签-重复', url: 'https://grave.test/page' }, H)).body)
  await api('DELETE', `/api/bookmarks/${doomed.id}`, undefined, H)
  const treeNow = await serverNodes()
  const trashNow = JSON.parse((await api('GET', '/api/trash', undefined, { Cookie: COOKIE })).body).nodes || []
  const tomb = trashNow.find(n => n.id === doomed.id)
  log('G1 setup: live row + tombstone row with same URL',
    !!live && tomb?.deletedAt > 0 && treeNow.some(n => n.id === live.id && n.url === 'https://grave.test/page'),
    'tombstone in trash=' + (tomb?.deletedAt > 0))

  // ---- pair extension ----
  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-grave-profile'
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
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, H)).body).code
  const extId = new URL(sw.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/options.html`)
  await page.fill('#server', SERVER)
  await page.fill('#code', code)
  await page.click('#pairBtn')
  for (let i = 0; i < 30; i++) {
    const m = await page.textContent('#pairMsg')
    if (m.includes('配对成功') || m.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  await page.close()
  await new Promise(r => setTimeout(r, 2500))
  log('extension paired', true)

  // ---- G2: the live bookmark must be in the browser ----
  let node = await browserNodeByTitle(sw, '墓地测试书签')
  log('G2: live bookmark present after first sync', !!node, JSON.stringify(node))

  // ---- G3: THREE consecutive rebuilds — node must survive every one ----
  let survived = 0
  const auditTrail = []
  for (let i = 0; i < 3; i++) {
    const fr = await forceResync(sw)
    auditTrail.push({ pulled: fr?.pulled, failed: fr?.applied?.failed, removed: fr?.applied?.removed, adopted: fr?.applied?.adopted })
    await new Promise(r => setTimeout(r, 2000))
    node = await browserNodeByTitle(sw, '墓地测试书签')
    if (node) survived++
  }
  log('G3: bookmark survives 3 consecutive rebuilds (no graveyard deletion)',
    survived === 3, `survived=${survived}/3 audits=${JSON.stringify(auditTrail)}`)

  // ---- G4: no root-folder modification errors anywhere ----
  const lastAudit = await forceResync(sw)
  const rootErr = (lastAudit?.applied?.errors || []).some(e => e.includes('root bookmark'))
  log('G4: no "Can\'t modify the root bookmark folders" failures', !rootErr,
    'errors=' + JSON.stringify(lastAudit?.applied?.errors || []))

  // ---- G5: folder shells stay deduplicated across rebuilds ----
  const dups = await folderDupCount(sw)
  log('G5: no duplicate folder shells after 4 rebuilds', dups === 0, 'dupFolderTitles=' + dups)

  // ---- G6: still fully bidirectional ----
  await resync(sw)
  const mod = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '重建后新增', url: 'https://post-grave.test/x' }, H)).body)
  let arrived = false
  for (let i = 0; i < 15; i++) {
    if (await browserNodeByTitle(sw, '重建后新增')) { arrived = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  log('G6: post-rebuild realtime sync still works', arrived)

  // ---- G7: trailing-slash URL divergence must adopt, not duplicate ----
  // (server row imported as 'https://x.com/' vs browser node 'https://x.com')
  await api('POST', '/api/bookmarks',
    { type: 'url', title: '斜杠归一化书签', url: 'https://slash.test/' }, H)
  await resync(sw)
  let node1 = null
  for (let i = 0; i < 15; i++) {
    node1 = await browserNodeByTitle(sw, '斜杠归一化书签')
    if (node1) break
    await new Promise(r => setTimeout(r, 500))
  }
  log('G7 setup: slash-URL bookmark synced to browser', !!node1, JSON.stringify(node1))
  // TWO rebuilds: adoption must bind both times, no duplicates
  await forceResync(sw)
  await forceResync(sw)
  await new Promise(r => setTimeout(r, 2000))
  const slashCopies = await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    let n = 0
    const walk = (ns) => { for (const x of ns) { if (x.url === 'https://slash.test/' || x.url === 'https://slash.test') n++; if (x.children) walk(x.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    return n
  })
  log('G7: slash-URL survives 2 rebuilds as ONE node (normalized adoption)',
    slashCopies === 1, 'copies=' + slashCopies)

  // ---- G8: overlapping ops — web edit races browser edit on the SAME node ----
  const race = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '竞态书签', url: 'https://race.test/x' }, H)).body)
  await resync(sw)
  let raceNode = null
  for (let i = 0; i < 15; i++) {
    raceNode = await browserNodeByTitle(sw, '竞态书签')
    if (raceNode) break
    await new Promise(r => setTimeout(r, 500))
  }
  // both sides edit simultaneously (within the same second)
  const p1 = api('PUT', `/api/bookmarks/${race.id}`, { title: '网页端竞态改名' }, H)
  const p2 = sw.evaluate(async (id) => {
    await chrome.bookmarks.update(id, { title: '浏览器端竞态改名' })
  }, raceNode.id)
  await Promise.all([p1, p2])
  await resync(sw)
  await new Promise(r => setTimeout(r, 2000))
  const webT = (await serverNodes()).find(n => n.id === race.id)?.title
  const hasWeb = await browserNodeByTitle(sw, '网页端竞态改名')
  const hasExt = await browserNodeByTitle(sw, '浏览器端竞态改名')
  const converged = (webT === '网页端竞态改名' && !!hasWeb && !hasExt) ||
                    (webT === '浏览器端竞态改名' && !!hasExt && !hasWeb)
  log('G8: same-second edit race converges to ONE title on BOTH ends',
    converged, 'srv=' + JSON.stringify(webT) + ' web=' + !!hasWeb + ' ext=' + !!hasExt)

  // ---- G9: delete races create (web deletes while browser renames) ----
  const g9 = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '删除竞态书签', url: 'https://del-race.test/x' }, H)).body)
  await resync(sw)
  let g9node = null
  for (let i = 0; i < 15; i++) {
    g9node = await browserNodeByTitle(sw, '删除竞态书签')
    if (g9node) break
    await new Promise(r => setTimeout(r, 500))
  }
  const p3 = api('DELETE', `/api/bookmarks/${g9.id}`, undefined, H)
  const p4 = sw.evaluate(async (id) => {
    await chrome.bookmarks.update(id, { title: '删除竞态-浏览器改名' })
  }, g9node.id)
  await Promise.all([p3, p4])
  await resync(sw)
  await new Promise(r => setTimeout(r, 2500))
  await resync(sw)
  const srvStill = (await serverNodes()).some(n => n.id === g9.id && !(n.deletedAt > 0))
  const extGone = !(await browserNodeByTitle(sw, '删除竞态书签'))
  const extRenamed = !!(await browserNodeByTitle(sw, '删除竞态-浏览器改名'))
  // acceptable outcomes: tombstone wins (node gone everywhere) OR rename won
  // and got pushed (row revived) — but NOT node in server + old title in ext
  const g9ok = (srvStill === false && extGone) || (srvStill === true && extRenamed)
  log('G9: delete-vs-edit race reaches a consistent state',
    g9ok, 'srvAlive=' + srvStill + ' extGone=' + extGone + ' extRenamed=' + extRenamed)

  await context.close()
  console.log('\n=== GRAVEYARD-BIND E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
