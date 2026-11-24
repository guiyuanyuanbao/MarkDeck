// E2E: real extension in real Playwright chromium against a real server.
// Covers: pair + initial import (with pre-pair bookmarks), bidirectional
// sync of urls/folders/moves/renames, other-bookmarks root, realtime WS
// propagation (no manual resync), LWW conflict, purge, popup UI, device
// revocation and re-pairing through the real options UI.
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
async function serverNodes() {
  return JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: COOKIE })).body).nodes
}

// ---- browser-side probes (run inside the SW) ----
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
// resync = drive one full sync cycle through the test hook
const resync = (sw) => sw.evaluate(() => globalThis.__markdeckResync())

// resolve the browser's real root ids by the Chromium positional invariant
// (children[0] = bar, children[1] = other) — never assume '1'/'2'
const rootIds = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const kids = tree[0].children
  return [kids[0].id, kids[1].id]
})

// poll until pred(browserTitles, serverNodes) holds; predicates may be async
async function waitB(sw, pred, timeoutMs = 10000, label = '') {
  for (let i = 0; i < timeoutMs / 400; i++) {
    let ok = false
    try { ok = await pred(await browserTitles(sw), await serverNodes()) } catch { /* transient */ }
    if (ok) return true
    await new Promise(r => setTimeout(r, 400))
  }
  console.log('  [timeout waiting] ' + label)
  return false
}

async function main() {
  console.log('== MarkDeck extension E2E (real chromium, expanded suite) ==')

  // E2E needs granted host_permissions (Playwright can't drive the runtime
  // permission prompt); patches dist/manifest.json, test-only, never shipped
  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  // ---- fresh server ----
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 800))
  try { fs.rmSync('C:/Users/admin/AppData/Local/Temp/md-e2e', { recursive: true, force: true }) } catch {}
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: 'C:/Users/admin/AppData/Local/Temp/md-e2e' },
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
  log('admin auth ready', true)

  // ---- server has a bookmark BEFORE the extension pairs ----
  const mk = await api('POST', '/api/bookmarks',
    { type: 'url', title: '服务器预置书签', url: 'https://preset.test/page' },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  log('server pre-bookmark created', mk.status === 201)

  // ---- launch chromium with extension ----
  const userDataDir = 'C:/Users/admin/AppData/Local/Temp/md-e2e-profile'
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: { width: 1280, height: 800 },
  })
  log('chromium launched with extension', true)

  // find SW
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error('extension SW not found')
  sw.on('console', msg => console.log('[SW]', msg.text()))
  log('extension service worker running', true)

  // ---- pre-pair local content: the first reconcile adopts these into
  //      fresh server rows, including a folder with a child and an
  //      other-root bookmark. Root ids resolved by position, never '1'/'2'.
  const [barRoot, otherRoot] = await rootIds(sw)
  const prePair = await sw.evaluate(async ([barRoot, otherRoot]) => {
    const f = await chrome.bookmarks.create({ parentId: barRoot, title: '本机文件夹' })
    await chrome.bookmarks.create({ parentId: f.id, title: '文件夹里的书签', url: 'https://local.test/child' })
    await chrome.bookmarks.create({ parentId: barRoot, title: '本机已有书签A', url: 'https://local.test/a' })
    await chrome.bookmarks.create({ parentId: otherRoot, title: '本机其他书签', url: 'https://local.test/other' })
    return true
  }, [barRoot, otherRoot])
  log('pre-pair browser bookmarks created (folder + child + other-root)', prePair === true)

  // ---- pair through the REAL options UI: exercises the pair message,
  //      initialImport() of the pre-pair content, and first fullSync ----
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: COOKIE, 'X-CSRF': csrf })).body).code
  const extId = new URL(sw.url()).host
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
  log('pair via options UI', pairMsg.includes('配对成功'), 'msg=' + JSON.stringify(pairMsg))
  await new Promise(r => setTimeout(r, 2500)) // let initialImport + first pull settle
  await optPage.close()

  // ---- T1: server pre-bookmark loaded into browser ----
  let titles = await browserTitles(sw)
  log('T1: server bookmark loaded into browser', titles.includes('服务器预置书签'),
    'browser titles: ' + JSON.stringify(titles))

  // ---- T2: initial import — pre-pair nodes on server with UUID ids and
  //      folder/child structure intact (mapping persistence) ----
  let nodes = await serverNodes()
  const importedA = nodes.filter(n => n.title === '本机已有书签A')
  const folderNode = nodes.find(n => n.title === '本机文件夹')
  const childNode = nodes.find(n => n.title === '文件夹里的书签')
  const othersHolder = nodes.find(n => n.title === '其他书签' && n.type === 'folder')
  const otherNode = nodes.find(n => n.title === '本机其他书签')
  log('T2a: pre-pair bookmark imported once with fresh UUID',
    importedA.length === 1 && /^[0-9a-f-]{36}$/i.test(importedA[0].id),
    'count=' + importedA.length + ' id=' + importedA[0]?.id)
  log('T2b: folder + child structure preserved on server',
    !!folderNode && !!childNode && childNode.parentId === folderNode.id,
    `folder=${folderNode?.id} child.parent=${childNode?.parentId}`)
  log('T2c: other-root content imported under 其他书签 holder',
    !!othersHolder && !!otherNode && otherNode.parentId === othersHolder.id,
    `holder=${othersHolder?.id} node.parent=${otherNode?.parentId}`)

  // ---- T3: rename of an IMPORTED bookmark must update, not duplicate ----
  await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    let target = null
    const walk = (ns) => { for (const n of ns) { if (n.title === '本机已有书签A') target = n; if (n.children) walk(n.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    await chrome.bookmarks.update(target.id, { title: '本机已有书签A-改名' })
  })
  await resync(sw)
  await waitB(sw, async (bt, sn) =>
    bt.includes('本机已有书签A-改名') && sn.filter(n => n.title === '本机已有书签A-改名').length === 1, 8000)
  nodes = await serverNodes()
  const renamed = nodes.filter(n => n.title === '本机已有书签A-改名')
  log('T3: imported bookmark rename updated server node (no duplicate)',
    renamed.length === 1 && !nodes.some(n => n.title === '本机已有书签A'),
    'count=' + renamed.length)

  // ---- T4: browser bookmark creation syncs to server as top-level ----
  const created = await sw.evaluate(async (barRoot) =>
    await chrome.bookmarks.create({ parentId: barRoot, title: '浏览器新建E2E', url: 'https://browser.test/x' }), barRoot)
  log('T4 setup: browser bookmark created', !!created.id)
  await resync(sw)
  await waitB(sw, (bt, sn) => sn.some(n => n.title === '浏览器新建E2E'), 8000)
  nodes = await serverNodes()
  const bCreated = nodes.find(n => n.title === '浏览器新建E2E')
  log('T4: browser creation on server with top-level parent (not ghost "1")',
    !!bCreated && bCreated.parentId === '',
    'parentId=' + JSON.stringify(bCreated?.parentId))

  // ---- T5: server delete propagates to browser ----
  const pre = nodes.find(n => n.title === '服务器预置书签')
  const delResp = await api('DELETE', `/api/bookmarks/${pre.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
  log('T5 setup: server delete API', delResp.status === 200, 'status=' + delResp.status)
  await resync(sw)
  await waitB(sw, (bt) => !bt.includes('服务器预置书签'), 8000)
  titles = await browserTitles(sw)
  log('T5: server delete removed browser bookmark', !titles.includes('服务器预置书签'),
    'after titles: ' + JSON.stringify(titles))
  if (titles.includes('服务器预置书签')) {
    const dbg = await sw.evaluate(async () => {
      const st = (await chrome.storage.local.get('md_status')).md_status
      const base = (await chrome.storage.local.get('md_base')).md_base || { entries: {} }
      const stats = globalThis.__markdeckReconcileStats ? globalThis.__markdeckReconcileStats() : null
      return { status: st, boundRows: Object.values(base.entries || {}).filter(e => e.localId).length,
        baseIds: Object.keys(base.entries || {}).length, stats }
    })
    console.log('[T5dbg]', JSON.stringify(dbg))
  }

  // ---- T6: realtime WS propagation WITHOUT manual resync ----
  await api('POST', '/api/bookmarks',
    { type: 'url', title: '实时推送书签', url: 'https://realtime.test/x' },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  const rt = await waitB(sw, (bt) => bt.includes('实时推送书签'), 12000, 'realtime arrival')
  log('T6: realtime WS push reaches browser without manual resync', rt)

  // ---- T7: server folder + child land in browser with structure intact ----
  const sf = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'folder', title: '同步文件夹' }, { Cookie: COOKIE, 'X-CSRF': csrf })).body)
  await api('POST', '/api/bookmarks',
    { type: 'url', title: '文件夹内书签', url: 'https://infolder.test/x', parentId: sf.id },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  await waitB(sw, async () => {
    const c = await browserNodeByTitle(sw, '文件夹内书签')
    const f = await browserNodeByTitle(sw, '同步文件夹')
    return !!(c && f && c.parentId === f.id)
  }, 8000)
  const bChild = await browserNodeByTitle(sw, '文件夹内书签')
  const bFolder = await browserNodeByTitle(sw, '同步文件夹')
  log('T7: server folder+child in browser, child under folder',
    !!bChild && !!bFolder && bChild.parentId === bFolder.id,
    `child.parent=${bChild?.parentId} folder=${bFolder?.id}`)

  // ---- T8: server rename updates browser in place (no duplicate) ----
  await api('PUT', `/api/bookmarks/${sf.id}`, { title: '同步文件夹-改名' },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  await waitB(sw, async () => !!(await browserNodeByTitle(sw, '同步文件夹-改名')), 8000)
  const oldFolder = await browserNodeByTitle(sw, '同步文件夹')
  const newFolder = await browserNodeByTitle(sw, '同步文件夹-改名')
  log('T8: server folder rename updated browser in place',
    !oldFolder && !!newFolder,
    'oldExists=' + !!oldFolder + ' newExists=' + !!newFolder)

  // ---- T9: server move into folder updates browser parent ----
  nodes = await serverNodes()
  const mvNode = nodes.find(n => n.title === '实时推送书签')
  const sfR = nodes.find(n => n.title === '同步文件夹-改名')
  await api('POST', `/api/bookmarks/${mvNode.id}/move`, { parentId: sfR.id, position: 1 },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  await waitB(sw, async () => {
    const m = await browserNodeByTitle(sw, '实时推送书签')
    const f = await browserNodeByTitle(sw, '同步文件夹-改名')
    return !!(m && f && m.parentId === f.id)
  }, 8000)
  const movedB = await browserNodeByTitle(sw, '实时推送书签')
  const sfB = await browserNodeByTitle(sw, '同步文件夹-改名')
  log('T9: server move lands node under folder in browser',
    !!movedB && !!sfB && movedB.parentId === sfB.id,
    `moved.parent=${movedB?.parentId} folder=${sfB?.id}`)

  // ---- T10: browser move into folder pushes new parent to server ----
  const bNode = await browserNodeByTitle(sw, '浏览器新建E2E')
  const bFolder2 = await browserNodeByTitle(sw, '本机文件夹')
  await sw.evaluate(async ([nodeId, parentId]) => {
    await chrome.bookmarks.move(nodeId, { parentId })
  }, [bNode.id, bFolder2.id])
  await resync(sw)
  await waitB(sw, async (bt, sn) => {
    const n2 = sn.find(n => n.title === '浏览器新建E2E')
    const f2 = sn.find(n => n.title === '本机文件夹')
    return !!(n2 && f2 && n2.parentId === f2.id)
  }, 8000)
  nodes = await serverNodes()
  const srvMoved = nodes.find(n => n.title === '浏览器新建E2E')
  const srvFolder = nodes.find(n => n.title === '本机文件夹')
  log('T10: browser move updates server parent',
    !!srvMoved && !!srvFolder && srvMoved.parentId === srvFolder.id,
    `node.parent=${srvMoved?.parentId} folder=${srvFolder?.id}`)

  // ---- T11: other-bookmarks root syncs both ways ----
  await sw.evaluate(async (otherRoot) =>
    await chrome.bookmarks.create({ parentId: otherRoot, title: '浏览器其他书签', url: 'https://other.test/x' }), otherRoot)
  await resync(sw)
  await waitB(sw, async (bt, sn) => {
    const n2 = sn.find(n => n.title === '浏览器其他书签')
    const h = sn.find(n => n.title === '其他书签' && n.type === 'folder')
    return !!(n2 && h && n2.parentId === h.id)
  }, 8000)
  nodes = await serverNodes()
  const holder = nodes.find(n => n.title === '其他书签' && n.type === 'folder')
  const srvOther = nodes.find(n => n.title === '浏览器其他书签')
  log('T11a: browser other-root creation lands under 其他书签 holder',
    !!holder && !!srvOther && srvOther.parentId === holder.id,
    `node.parent=${srvOther?.parentId} holder=${holder?.id}`)
  await api('POST', '/api/bookmarks',
    { type: 'url', title: '服务端其他书签', url: 'https://srv-other.test/x', parentId: holder.id },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  await waitB(sw, async () => {
    const n = await browserNodeByTitle(sw, '服务端其他书签')
    return !!(n && n.parentId === otherRoot)
  }, 8000)
  const bOther = await browserNodeByTitle(sw, '服务端其他书签')
  log('T11b: server other-root child lands in browser other-root',
    !!bOther && bOther.parentId === otherRoot, 'parent=' + bOther?.parentId)

  // ---- T12: special characters survive round-trips ----
  const weirdTitle = '日文"引用"&<>🎉 中文长标题—测试'
  await api('POST', '/api/bookmarks',
    { type: 'url', title: weirdTitle, url: 'https://weird.test/x?a=1&b=2' },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  await waitB(sw, (bt) => bt.includes(weirdTitle), 8000)
  const weirdB = await browserNodeByTitle(sw, weirdTitle)
  log('T12: special-char title survives server→browser',
    !!weirdB && weirdB.title === weirdTitle, 'title=' + JSON.stringify(weirdB?.title))
  const weirdBTitle = '浏览器端🎉特殊"标题"'
  await sw.evaluate(async ([t, barRoot]) =>
    await chrome.bookmarks.create({ parentId: barRoot, title: t, url: 'https://weird-b.test/x' }), [weirdBTitle, barRoot])
  await resync(sw)
  await waitB(sw, async (bt, sn) =>
    sn.some(n => n.title === weirdBTitle && n.url === 'https://weird-b.test/x'), 8000)
  log('T12b: special-char title+url survive browser→server',
    (await serverNodes()).some(n => n.title === weirdBTitle && n.url === 'https://weird-b.test/x'))

  // ---- T13: rapid burst of 10 creates all reach the server ----
  await sw.evaluate(async (barRoot) => {
    for (let i = 0; i < 10; i++) {
      await chrome.bookmarks.create({ parentId: barRoot, title: '连发书签' + i, url: 'https://burst.test/' + i })
    }
  }, barRoot)
  await resync(sw)
  await waitB(sw, async (bt, sn) =>
    sn.filter(n => n.title.startsWith('连发书签')).length >= 10, 10000)
  const burstCount = (await serverNodes()).filter(n => n.title.startsWith('连发书签')).length
  if (burstCount !== 10) {
    const q = await sw.evaluate(async () => (await chrome.storage.local.get('md_touch')).md_touch || {})
    const missing = []
    for (let i = 0; i < 10; i++) {
      if (!(await serverNodes()).some(n => n.title === '连发书签' + i)) missing.push(i)
    }
    console.log('[T13dbg] pending=' + JSON.stringify(Object.keys(q)) +
      ' missing=' + JSON.stringify(missing))
    // one more push cycle before judging: the straggler may just be pending
    await resync(sw)
    await new Promise(r => setTimeout(r, 2500))
  }
  const burstCount2 = (await serverNodes()).filter(n => n.title.startsWith('连发书签')).length
  log('T13: rapid burst of 10 creates all reach server', burstCount2 === 10,
    'count=' + burstCount2 + ' (first-check=' + burstCount + ')')

  // ---- T14: LWW conflict — newer server edit beats older browser edit ----
  const cw = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '冲突测试书签', url: 'https://lww.test/x' },
    { Cookie: COOKIE, 'X-CSRF': csrf })).body)
  await resync(sw)
  await waitB(sw, (bt) => bt.includes('冲突测试书签'), 8000)
  await sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    let n = null
    const walk = (ns) => { for (const x of ns) { if (x.title === '冲突测试书签') n = x; if (x.children) walk(x.children) } }
    for (const root of tree) if (root.children) walk(root.children)
    await chrome.bookmarks.update(n.id, { title: '浏览器先改版' })
  })
  await new Promise(r => setTimeout(r, 1000))
  // server edit lands later → strictly newer updatedAt → must win
  await api('PUT', `/api/bookmarks/${cw.id}`, { title: '服务端后改版' },
    { Cookie: COOKIE, 'X-CSRF': csrf })
  await resync(sw)
  await waitB(sw, (bt) => bt.includes('服务端后改版'), 10000)
  titles = await browserTitles(sw)
  log('T14: LWW — newer server edit wins over older browser edit',
    titles.includes('服务端后改版') && !titles.includes('浏览器先改版'),
    'olderTitleStillThere=' + titles.includes('浏览器先改版'))

  // ---- T15: purge keeps the node gone on both sides ----
  const pg = JSON.parse((await api('POST', '/api/bookmarks',
    { type: 'url', title: '待清除书签', url: 'https://purge.test/x' },
    { Cookie: COOKIE, 'X-CSRF': csrf })).body)
  await resync(sw)
  await waitB(sw, (bt) => bt.includes('待清除书签'), 8000)
  await api('DELETE', `/api/bookmarks/${pg.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
  const purgeResp = await api('POST', `/api/bookmarks/${pg.id}/purge`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
  const srvClean = (await serverNodes()).every(n => n.title !== '待清除书签')
  await resync(sw)
  await waitB(sw, (bt) => !bt.includes('待清除书签'), 8000)
  titles = await browserTitles(sw)
  log('T15: purge keeps node gone on server and browser',
    purgeResp.status === 200 && srvClean && !titles.includes('待清除书签'),
    'purge=' + purgeResp.status + ' serverClean=' + srvClean + ' browserClean=' + !titles.includes('待清除书签'))

  // ---- T16: popup UI — status, local search, quick save with tags ----
  const popupPage = await context.newPage()
  await popupPage.goto(`chrome-extension://${extId}/popup.html`)
  await popupPage.waitForTimeout(800)
  const statusText = await popupPage.textContent('#statusText')
  log('T16a: popup shows online status', statusText?.includes('已连接'), 'text=' + JSON.stringify(statusText))
  await popupPage.fill('#localSearch', 'E2E')
  await popupPage.waitForTimeout(500)
  const hits = await popupPage.$$eval('#searchResults a', as => as.map(a => a.textContent))
  log('T16b: popup local search finds bookmarks', hits.length >= 1, JSON.stringify(hits))
  const saved = await popupPage.evaluate(async () =>
    await chrome.runtime.sendMessage({
      type: 'saveCurrent', url: 'https://popup.test/page', title: '快速收藏页', tags: 'e2e,popup测试',
    }))
  log('T16c: popup quick-save accepted', saved?.ok === true, JSON.stringify(saved))
  await resync(sw)
  await waitB(sw, async (bt, sn) => {
    const n = sn.find(x => x.title === '快速收藏页')
    return !!(n && Array.isArray(n.tags) && n.tags.includes('e2e') && n.tags.includes('popup测试'))
  }, 8000)
  const tagNode = (await serverNodes()).find(n => n.title === '快速收藏页')
  log('T16d: quick-saved page on server with tags',
    !!tagNode && tagNode.tags?.includes('e2e') && tagNode.tags?.includes('popup测试'),
    JSON.stringify(tagNode?.tags))
  await popupPage.close()

  // ---- T17: device revocation → extension must show unauthorized ----
  const devices = JSON.parse((await api('GET', '/api/devices', undefined, { Cookie: COOKIE })).body)
  const devList = Array.isArray(devices) ? devices : devices.devices || []
  const e2eDev = devList.find(d => d.name === 'Chrome 浏览器') || devList[0]
  log('T17 setup: device listed', !!e2eDev, JSON.stringify(devList.map(d => d.name)))
  if (e2eDev) {
    const revResp = await api('DELETE', `/api/devices/${e2eDev.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': csrf })
    log('T17 setup: device revoked via API', revResp.status === 200 || revResp.status === 204, 'status=' + revResp.status)
    await resync(sw)
    await new Promise(r => setTimeout(r, 2000))
    const status = await sw.evaluate(async () =>
      (await chrome.storage.local.get('md_status')).md_status)
    log('T17: extension status shows unauthorized after revocation', status === 'unauthorized', 'status=' + status)
  }

  // ---- T18: re-pair through the real options UI ----
  const code2 = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: COOKIE, 'X-CSRF': csrf })).body).code
  const optPage2 = await context.newPage()
  await optPage2.goto(`chrome-extension://${extId}/options.html`)
  await optPage2.fill('#server', SERVER)
  await optPage2.fill('#code', code2)
  await optPage2.click('#pairBtn')
  let pairMsg2 = ''
  for (let i = 0; i < 30; i++) {
    pairMsg2 = await optPage2.textContent('#pairMsg')
    if (pairMsg2.includes('配对成功') || pairMsg2.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  log('T18a: options UI re-pair succeeds', pairMsg2.includes('配对成功'), 'msg=' + JSON.stringify(pairMsg2))
  // first sync after re-pair must not duplicate imported content
  await new Promise(r => setTimeout(r, 4000))
  nodes = await serverNodes()
  const dupA = nodes.filter(n => n.title === '本机已有书签A-改名')
  const status2 = await sw.evaluate(async () =>
    (await chrome.storage.local.get('md_status')).md_status)
  log('T18b: re-pair initial import does not duplicate existing bookmarks',
    dupA.length === 1, 'count=' + dupA.length)
  log('T18c: status back to online after re-pair', status2 === 'online', 'status=' + status2)
  await optPage2.close()

  console.log('\n=== E2E RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
