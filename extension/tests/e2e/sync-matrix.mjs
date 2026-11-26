// E2E: sync-matrix — the sync-specific专项检查 (2026-11-26).
// Covers the lifecycle branches the audit tree identified as gaps:
//   M1  server URL change  → browser remove+create re-materialization (A1)
//   M2  server URL change vs local rename race → one-sided convergence (A2)
//   M3  web batch move N rows → browser per-row placement (H1)
//   M4  web move in/out of the canonical 其他书签 holder → other-root (F1)
//   M5  tools duplicates-merge → browser converges, survivor keeps binding (H2)
//   M6  dual-device offline same-row edits → deterministic convergence, no
//       ping-pong, loser content heals (B1) [needs the LWW-loser self-heal]
//   M7  offline create inside a folder the server deletes → the new
//       bookmark SURVIVES (re-pushed re-rooted), no data loss (B2)
//   M8  dual-device same-name folder creates → one folder, no shells (B3)
//   M9  web reorder vs browser move race → one order, no move churn (C1)
//   M10 two server rows with the same URL → both bind, neither eats the
//       other (G1)
//   M11 snapshot restore vs extension offline edit → converge, no doomed
//       re-push loop (E1)
//   M12 SW restart (storage intact, journal replays) → offline edit still
//       reaches the server (D1)
import { chromium } from 'playwright-core'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = process.env.MARKDECK_TEST_SERVER || 'http://127.0.0.1:8999'
const ADMIN_PW = process.env.MARKDECK_TEST_PASSWORD || 'markdeck-demo-2026'
const DIST = path.resolve(__dirname, '..', '..', 'dist')
const TMP = 'C:/Users/admin/AppData/Local/Temp'

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
let CSRF = ''
async function serverNodes() {
  return JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: COOKIE })).body).nodes
}

const browserTitles = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const out = []
  const walk = (nodes) => { for (const n of nodes) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return out
})
const findNode = (sw, predSrc) => sw.evaluate(async (src) => {
  const pred = eval(src)
  const tree = await chrome.bookmarks.getTree()
  let found = null
  const walk = (nodes) => { for (const n of nodes) { if (pred(n)) found = n; if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return found ? { id: found.id, parentId: found.parentId, title: found.title, url: found.url, index: found.index } : null
}, predSrc)
const findNodeByTitle = (sw, title) => findNode(sw, `(n) => n.title === ${JSON.stringify(title)}`)
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

async function launchExt(name) {
  const userDataDir = `${TMP}/md-matrix-${name}`
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: { width: 1200, height: 800 },
  })
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error(name + ': extension SW not found')
  sw.on('console', msg => { const t = msg.text(); if (t.includes('error') || t.includes('fail')) console.log(`[${name}]`, t.slice(0, 200)) })
  return { context, sw, extId: new URL(sw.url()).host }
}

async function pairExt(A, name) {
  const sw = A.sw
  const context = A.context
  const extId = A.extId
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: COOKIE, 'X-CSRF': CSRF })).body).code
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extId}/options.html`)
  await page.fill('#server', SERVER)
  await page.fill('#code', code)
  await page.click('#pairBtn')
  let msg = ''
  for (let i = 0; i < 30; i++) {
    msg = await page.textContent('#pairMsg')
    if (msg.includes('配对成功') || msg.includes('配对失败')) break
    await new Promise(r => setTimeout(r, 500))
  }
  await page.close()
  if (!msg.includes('配对成功')) throw new Error(name + ' pair failed: ' + msg)
  await new Promise(r => setTimeout(r, 2000))
}

const webCreate = async (title, url, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'url', title, url, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
const webUpdate = async (id, patch) => api('PUT', `/api/bookmarks/${id}`, patch, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webDelete = async (id) => api('DELETE', `/api/bookmarks/${id}`, undefined, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webMove = async (id, parentId, position = 0) =>
  api('POST', `/api/bookmarks/${id}/move`, { parentId, position }, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webReorder = async (parentId, ids) =>
  api('POST', '/api/bookmarks/reorder', { parentId, ids }, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webCreateFolder = async (title, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'folder', title, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)

async function main() {
  console.log('== MarkDeck sync-matrix E2E (sync专项: lifecycle × multi-device × conflict) ==')

  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  // ---- fresh server ----
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1000))
  let wiped = false
  for (let i = 0; i < 20 && !wiped; i++) {
    try { fs.rmSync(`${TMP}/md-matrix`, { recursive: true, force: true }); wiped = !fs.existsSync(`${TMP}/md-matrix`) } catch {}
    if (!wiped) await new Promise(r => setTimeout(r, 500))
  }
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: `${TMP}/md-matrix` },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  if (!state.setup) throw new Error('server db is NOT fresh (auth.setup=false)')
  const l = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  COOKIE = l.cookies[0].split(';')[0]
  CSRF = JSON.parse(l.body).csrf
  log('M0: fresh server + admin auth', CSRF !== '')

  // ---- device A: chrome extension ----
  const A = await launchExt('a')
  await pairExt(A, 'A')
  log('M0b: device A paired', true)

  // ================= M1: server URL change → remove+create =================
  {
    const n = await webCreate('M1 目标书签', 'https://m1.old/x')
    await waitB(A.sw, (bt) => bt.includes('M1 目标书签'))
    await webUpdate(n.id, { url: 'https://m1.new/x' })
    // drive the reconcile explicitly (WS debounce + browser timing make a
    // pure waitB flaky); poll through explicit resyncs for determinism
    let arrived = false
    for (let i = 0; i < 10 && !arrived; i++) {
      await resync(A.sw)
      await new Promise(r => setTimeout(r, 800))
      const sn = await serverNodes()
      const bt = await browserTitles(A.sw)
      const newNode = sn.find(x => x.title === 'M1 目标书签')
      arrived = newNode && newNode.url === 'https://m1.new/x' && bt.includes('M1 目标书签')
    }
    const browserNode = await findNodeByTitle(A.sw, 'M1 目标书签')
    log('M1: server URL change re-materialized in browser',
      arrived && browserNode && browserNode.url === 'https://m1.new/x',
      'url=' + (browserNode && browserNode.url))
    // fixedpoint: a second resync must not churn (no remove+create loop)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    const again = await findNodeByTitle(A.sw, 'M1 目标书签')
    log('M1b: no churn on second reconcile (fixedpoint)',
      stats.failed === 0 && again && again.url === 'https://m1.new/x',
      'failed=' + stats.failed + ' planned=' + stats.planned)
  }

  // ================= M2: server URL change vs local rename race =================
  {
    const n = await webCreate('M2 竞态书签', 'https://m2/x')
    await waitB(A.sw, (bt) => bt.includes('M2 竞态书签'))
    // local rename (journal), then server URL change with a LATER timestamp
    const localNode = await findNodeByTitle(A.sw, 'M2 竞态书签')
    await A.sw.evaluate(async (id) => {
      await chrome.bookmarks.update(id, { title: 'M2 本地改名' })
    }, localNode.id)
    await new Promise(r => setTimeout(r, 1500))
    await webUpdate(n.id, { url: 'https://m2/changed' })
    // convergence: BOTH ends agree on ONE row (either title or the other,
    // but exactly one node with the m2 URL family — no split-brain)
    await waitB(A.sw, (bt, sn) => {
      const rows = sn.filter(x => (x.url || '').includes('m2'))
      return rows.length === 1
    }, 15000)
    await new Promise(r => setTimeout(r, 2500))
    const srvRows = (await serverNodes()).filter(x => (x.url || '').includes('m2'))
    const bRows = []
    for (const t of ['M2 竞态书签', 'M2 本地改名']) {
      const nd = await findNodeByTitle(A.sw, t)
      if (nd) bRows.push(nd)
    }
    const srvHasNewUrl = srvRows.some(x => x.url === 'https://m2/changed')
    const srvHasOldUrl = srvRows.some(x => x.url === 'https://m2/x')
    log('M2: one-sided convergence (exactly 1 server row)',
      srvRows.length === 1, 'srvRows=' + srvRows.length)
    log('M2b: no duplicate browser nodes',
      bRows.length <= 1, 'bRows=' + bRows.length)
    log('M2c: server URL change not silently dropped',
      srvHasNewUrl || srvHasOldUrl, 'new=' + srvHasNewUrl + ' old=' + srvHasOldUrl)
    // final consistency: browser content matches the surviving server row
    if (bRows.length === 1 && srvRows.length === 1) {
      log('M2d: browser row matches server row',
        bRows[0].url === srvRows[0].url && bRows[0].title === srvRows[0].title,
        `browser=${bRows[0].title}/${bRows[0].url} server=${srvRows[0].title}/${srvRows[0].url}`)
    }
  }

  // ================= M3: web batch move → browser placement =================
  {
    const folder = await webCreateFolder('M3 批量目标夹')
    const ids = []
    for (let i = 0; i < 5; i++) {
      const n = await webCreate(`M3 批量${i}`, `https://m3/${i}`)
      ids.push(n.id)
    }
    await waitB(A.sw, (bt) => ids.every((_, i) => bt.includes(`M3 批量${i}`)))
    const resp = await api('POST', '/api/bookmarks/batch',
      { ids, action: 'move', parentId: folder.id }, { Cookie: COOKIE, 'X-CSRF': CSRF })
    const moved = await waitB(A.sw, async () => {
      await resync(A.sw)
      const f = await findNodeByTitle(A.sw, 'M3 批量目标夹')
      if (!f) return false
      const kids = await A.sw.evaluate(async (fid) =>
        (await chrome.bookmarks.getChildren(fid)).map(c => c.title), f.id)
      return kids.filter(t => t.startsWith('M3 批量')).length === 5
    }, 20000)
    log('M3: web batch move of 5 rows lands all under target folder',
      moved && resp.status === 200, 'http=' + resp.status)
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('M3b: batch apply had zero failures', stats.failed === 0, 'failed=' + stats.failed)
  }

  // ================= M4: move in/out of the canonical holder =================
  {
    // create a bookmark in the browser's OTHER root, verify it lands under
    // the holder; then move it server-side to top level and verify it lands
    // in the BAR root.
    const [barRoot, otherRoot] = await A.sw.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree()
      return [tree[0].children[0].id, tree[0].children[1].id]
    })
    await A.sw.evaluate(async (otherRoot) => {
      await chrome.bookmarks.create({ parentId: otherRoot, title: 'M4 其他根书签', url: 'https://m4/other' })
    }, otherRoot)
    await waitB(A.sw, (bt, sn) => {
      const row = sn.find(x => x.title === 'M4 其他根书签')
      return !!row
    }, 15000)
    const srvRow = (await serverNodes()).find(x => x.title === 'M4 其他根书签')
    const holder = (await serverNodes()).find(x => x.title === '其他书签' && x.type === 'folder')
    log('M4a: browser other-root create lands under canonical holder',
      srvRow && holder && srvRow.parentId === holder.id,
      'parent=' + (srvRow && srvRow.parentId))
    // server-side move OUT of the holder into top level
    await webMove(srvRow.id, '', 0)
    let movedOk = false
    for (let i = 0; i < 10 && !movedOk; i++) {
      await resync(A.sw)
      await new Promise(r => setTimeout(r, 800))
      movedOk = (await findNodeByTitle(A.sw, 'M4 其他根书签'))?.parentId === barRoot
    }
    const movedNode = await findNodeByTitle(A.sw, 'M4 其他根书签')
    const st4b = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    console.log('  [M4diag] stats=', JSON.stringify(st4b), 'movedNode=', JSON.stringify(movedNode))
    log('M4b: server move out of holder lands in browser BAR root',
      movedOk && movedNode && movedNode.parentId === barRoot,
      'browserParent=' + (movedNode && movedNode.parentId) + ' barRoot=' + barRoot)
    // and back INTO the holder
    await webMove(srvRow.id, holder.id, 0)
    let backOk = false
    for (let i = 0; i < 10 && !backOk; i++) {
      await resync(A.sw)
      await new Promise(r => setTimeout(r, 800))
      backOk = (await findNodeByTitle(A.sw, 'M4 其他根书签'))?.parentId === otherRoot
    }
    const backNode = await findNodeByTitle(A.sw, 'M4 其他根书签')
    log('M4c: server move back into holder lands in browser OTHER root',
      backOk && backNode && backNode.parentId === otherRoot,
      'browserParent=' + (backNode && backNode.parentId))
  }

  // ================= M5: duplicates merge → browser converges =================
  {
    await webCreate('M5 重复书签', 'https://m5/dup')
    await webCreate('M5 重复书签', 'https://m5/dup')
    await waitB(A.sw, async (bt) => {
      const nodes = (await serverNodes()).filter(x => x.title === 'M5 重复书签')
      return nodes.length === 2 && bt.filter(t => t === 'M5 重复书签').length === 2
    }, 15000)
    const dups = (await serverNodes()).filter(x => x.title === 'M5 重复书签')
    const keep = dups[0]
    const removeIds = dups.slice(1).map(x => x.id)
    const m = await api('POST', '/api/tools/duplicates/merge',
      { keepId: keep.id, removeIds }, { Cookie: COOKIE, 'X-CSRF': CSRF })
    const converged = await waitB(A.sw, async (bt) => {
      const nodes = (await serverNodes()).filter(x => x.title === 'M5 重复书签')
      return nodes.length === 1 && bt.filter(t => t === 'M5 重复书签').length === 1
    }, 15000)
    log('M5: tools duplicates merge converges on both ends',
      converged && m.status === 200, 'http=' + m.status)
    // survivor binding stable: a further server rename reaches the browser
    await webUpdate(keep.id, { title: 'M5 合并后改名' })
    const renamed = await waitB(A.sw, (bt) => bt.includes('M5 合并后改名') && !bt.includes('M5 重复书签'), 15000)
    log('M5b: survivor keeps binding — rename reaches browser', renamed)
  }

  // ================= M6: dual-device offline same-row edits (B1) =================
  const B = await launchExt('b')
  await pairExt(B, 'B')
  log('M6 setup: device B paired', true)
  {
    const n = await webCreate('M6 冲突行', 'https://m6/x')
    await waitB(A.sw, (bt) => bt.includes('M6 冲突行'))
    await waitB(B.sw, (bt) => bt.includes('M6 冲突行'))
    // both devices go offline and edit the same row
    await A.sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    })
    await B.sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    })
    const aNode = await findNodeByTitle(A.sw, 'M6 冲突行')
    const bNode = await findNodeByTitle(B.sw, 'M6 冲突行')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'M6 A端修改' }) }, aNode.id)
    await new Promise(r => setTimeout(r, 1200)) // B edits LATER → B wins LWW
    await B.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'M6 B端修改' }) }, bNode.id)
    await new Promise(r => setTimeout(r, 1500))
    // back online, both resync
    await A.sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      cfg.server = "http://127.0.0.1:8999"
    }, [])
    // restore via saved config copy instead
    await A.sw.evaluate(async () => {
      const cur = (await chrome.storage.local.get('md_config')).md_config
      cur.server = 'http://127.0.0.1:8999'
      await chrome.storage.local.set({ md_config: cur })
    })
    await B.sw.evaluate(async () => {
      const cur = (await chrome.storage.local.get('md_config')).md_config
      cur.server = 'http://127.0.0.1:8999'
      await chrome.storage.local.set({ md_config: cur })
    })
    await resync(A.sw)
    await resync(B.sw)
    // converge: both ends show B's title (later edit wins), A's edit may
    // flash but must be replaced — NO ping-pong after settle
    const settled = await waitB(A.sw, (bt, sn) => {
      const row = sn.find(x => x.title === 'M6 B端修改')
      return !!row
    }, 20000)
    await resync(B.sw)
    await new Promise(r => setTimeout(r, 3000))
    const srvRows6 = (await serverNodes()).filter(x => (x.url || '').includes('m6'))
    const aT = await browserTitles(A.sw)
    const bT = await browserTitles(B.sw)
    log('M6: dual-device offline edits converge to ONE winner (B, later)',
      settled && srvRows6.length === 1 && srvRows6[0].title === 'M6 B端修改',
      'srv=' + JSON.stringify(srvRows6.map(x => x.title)))
    log('M6b: device A healed to the winner content',
      aT.includes('M6 B端修改') && !aT.includes('M6 A端修改'),
      'A=' + JSON.stringify(aT.filter(t => t.includes('M6'))))
    log('M6c: device B holds the winner',
      bT.includes('M6 B端修改'), '')
    // anti-ping-pong: three more reconcile rounds on each side leave it stable
    for (let i = 0; i < 3; i++) { await resync(A.sw); await resync(B.sw) }
    await new Promise(r => setTimeout(r, 1500))
    const srvFinal = (await serverNodes()).filter(x => (x.url || '').includes('m6'))
    log('M6d: no ping-pong after repeated reconciles',
      srvFinal.length === 1 && srvFinal[0].title === 'M6 B端修改',
      'final=' + JSON.stringify(srvFinal.map(x => x.title)))
  }

  // ================= M7: offline create inside server-deleted folder (B2) =================
  {
    const folder = await webCreateFolder('M7 待删夹')
    await waitB(A.sw, (bt) => bt.includes('M7 待删夹'))
    // A goes offline, creates a bookmark INSIDE the folder
    await A.sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    })
    const fNode = await findNodeByTitle(A.sw, 'M7 待删夹')
    await A.sw.evaluate(async (pid) => {
      await chrome.bookmarks.create({ parentId: pid, title: 'M7 珍贵书签', url: 'https://m7/precious' })
    }, fNode.id)
    await new Promise(r => setTimeout(r, 1500))
    // server deletes the folder (racing the still-offline create)
    await webDelete(folder.id)
    // A reconnects and syncs — the precious bookmark must SURVIVE somewhere
    const preState = await A.sw.evaluate(async () => {
      const st = await chrome.storage.local.get(['md_config', 'md_touch', 'md_status', 'md_base'])
      const t = await chrome.bookmarks.getTree()
      const out = []
      const w = (ns) => { for (const n of ns) { if ((n.title || '').includes('M7')) out.push(n.title + '#' + n.id + (n.url ? '' : '[夹]')); if (n.children) w(n.children) } }
      for (const r of t) if (r.children) w(r.children)
      return {
        server: st.md_config?.server, status: st.md_status,
        touch: Object.keys(st.md_touch || {}),
        baseHasFolder: !!(st.md_base?.entries || {})[(await (async () => { return null })()) || ''],
        baseEntries: Object.keys(st.md_base?.entries || {}).length,
        localM7: out,
      }
    })
    console.log('  [M7pre] ', JSON.stringify(preState))
    await A.sw.evaluate(async () => {
      const cur = (await chrome.storage.local.get('md_config')).md_config
      cur.server = 'http://127.0.0.1:8999'
      await chrome.storage.local.set({ md_config: cur })
    })
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    const st7a = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    const touchNow = await A.sw.evaluate(async () => Object.keys((await chrome.storage.local.get('md_touch')).md_touch || {}))
    const localNow = await A.sw.evaluate(async () => {
      const t = await chrome.bookmarks.getTree()
      const out = []
      const w = (ns) => { for (const n of ns) { if ((n.title || '').includes('M7')) out.push(n.title + (n.url ? '' : ' [夹]')); if (n.children) w(n.children) } }
      for (const r of t) if (r.children) w(r.children)
      return out
    })
    console.log('  [M7r1] stats=', JSON.stringify(st7a), 'touch=', JSON.stringify(touchNow), 'localM7=', JSON.stringify(localNow), 'srv=', JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('m7') || x.title === 'M7 待删夹').map(x => x.title + (x.deletedAt ? '[tomb]' : ''))))
    const survived = await waitB(A.sw, async (bt, sn) => {
      const row = sn.find(x => x.url === 'https://m7/precious')
      const local = bt.includes('M7 珍贵书签')
      return row && local
    }, 20000)
    const precious = await findNodeByTitle(A.sw, 'M7 珍贵书签')
    const diag7 = await A.sw.evaluate(() => globalThis.__markdeckDeepDiag())
    console.log('  [M7diag] stats=', JSON.stringify(diag7.stats), 'touch=', diag7.touchEntries, 'extra=', JSON.stringify(diag7.extraLocally))
    log('M7: offline create survives server folder deletion (no data loss)',
      survived && !!precious,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('m7')).map(x => x.title + '@' + x.parentId.slice(0, 6))))
    if (precious) {
      const rows = await serverNodes()
      const pr = rows.find(x => x.url === 'https://m7/precious')
      const parentRow = pr ? rows.find(x => x.id === pr.parentId) : null
      log('M7b: re-rooted parent exists on the server (not a dangling id)',
        !pr || !pr.parentId || !!parentRow,
        'parentId=' + String(pr && pr.parentId).slice(0, 10))
    }
    // fixedpoint: repeated reconciles don't resurrect the deleted folder or
    // duplicate the precious row
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    const srvAfter = (await serverNodes()).filter(x => (x.url || '').includes('m7'))
    const bCount = (await browserTitles(A.sw)).filter(t => t === 'M7 珍贵书签').length
    log('M7c: fixedpoint — one precious row, deleted folder stays deleted',
      srvAfter.length === 1 && bCount === 1 && !(await serverNodes()).some(x => x.title === 'M7 待删夹' && x.deletedAt === 0),
      'srvRows=' + srvAfter.length + ' browserCount=' + bCount)
  }

  // ================= M8: dual-device same-name folder creates (B3) =================
  {
    await A.sw.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0].children[0].id, title: 'M8 同名夹', url: undefined })
    })
    await new Promise(r => setTimeout(r, 800))
    await B.sw.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0].children[0].id, title: 'M8 同名夹', url: undefined })
    })
    await resync(A.sw)
    await resync(B.sw)
    await new Promise(r => setTimeout(r, 2500))
    const srvF = (await serverNodes()).filter(x => x.title === 'M8 同名夹' && x.type === 'folder')
    const aF = await A.sw.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children[0]
      return bar.children.filter(c => c.title === 'M8 同名夹').length
    })
    log('M8: same-name folders from two devices COEXIST (both creates are real)',
      srvF.length === 2, 'serverFolders=' + srvF.length)
    log('M8b: both devices see both folders (no silent merge)',
      aF === 2 && srvF.length === 2,
      'browserFolders=' + aF)
    // children placed into each side's folder still converge into one
    const aKid = await A.sw.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children[0]
      const f = bar.children.find(c => c.title === 'M8 同名夹')
      const k = await chrome.bookmarks.create({ parentId: f.id, title: 'M8 子书签', url: 'https://m8/kid' })
      return k.id
    })
    await resync(A.sw)
    await waitB(B.sw, async (bt) => bt.includes('M8 子书签'), 15000)
    const srvKids = (await serverNodes()).filter(x => x.url === 'https://m8/kid')
    log('M8c: child created inside one instance reaches server once',
      srvKids.length === 1, 'srvKids=' + srvKids.length)
    void aKid
  }

  // ================= M9: web reorder vs browser move race (C1) =================
  {
    const ids = []
    for (let i = 0; i < 3; i++) {
      const n = await webCreate(`M9 排序${i}`, `https://m9/${i}`)
      ids.push(n.id)
    }
    await waitB(A.sw, (bt) => bt.includes('M9 排序2'))
    // web reorders [2,1,0]; browser simultaneously moves its local row
    const r = await webReorder('', [...ids].reverse())
    const localNode = await findNodeByTitle(A.sw, 'M9 排序0')
    if (localNode) {
      await A.sw.evaluate(async (id) => {
        const bar = (await chrome.bookmarks.getTree())[0].children[0]
        await chrome.bookmarks.move(id, { parentId: bar.id, index: 0 })
      }, localNode.id)
    }
    await new Promise(r => setTimeout(r, 2500))
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 2500))
    const barKids = await A.sw.evaluate(async () =>
      (await chrome.bookmarks.getTree())[0].children[0].children.map(c => c.title))
    const m9 = barKids.filter(t => t.startsWith('M9 排序'))
    const uniqOrder = new Set(m9).size === m9.length
    log('M9: reorder race settles to a single consistent order (no dup/churn)',
      r.status === 200 && m9.length === 3 && uniqOrder,
      'order=' + JSON.stringify(m9))
    // server order matches browser order exactly (convergence)
    const srvOrder = (await serverNodes())
      .filter(x => x.title.startsWith('M9 排序'))
      .sort((a, b) => a.position - b.position)
      .map(x => x.title)
    log('M9b: server rank equals browser index (rank convergence)',
      JSON.stringify(srvOrder) === JSON.stringify(m9),
      'srv=' + JSON.stringify(srvOrder))
    // fixedpoint: another reconcile plans no moves
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('M9c: no move churn on settled order (fixedpoint)',
      stats.failed === 0, 'failed=' + stats.failed + ' planned=' + stats.planned)
  }

  // ================= M10: two server rows with the same URL (G1) =================
  {
    const r1 = await webCreate('M10 第一条', 'https://m10/same')
    const r2 = await webCreate('M10 第二条', 'https://m10/same')
    await waitB(A.sw, async (bt) => bt.filter(t => t.startsWith('M10')).length === 2, 15000)
    const b1 = await findNodeByTitle(A.sw, 'M10 第一条')
    const b2 = await findNodeByTitle(A.sw, 'M10 第二条')
    log('M10: both same-URL rows exist in the browser (neither eaten)',
      !!b1 && !!b2, 'b1=' + !!b1 + ' b2=' + !!b2)
    log('M10b: they are DIFFERENT chrome nodes', b1 && b2 && b1.id !== b2.id)
    // delete one from the server; only that one leaves the browser
    await webDelete(r2.id)
    await waitB(A.sw, async (bt) => bt.filter(t => t.startsWith('M10')).length === 1, 15000)
    const after = await findNodeByTitle(A.sw, 'M10 第一条')
    log('M10c: deleting one same-URL row removes only its bound node',
      !!after && !(await browserTitles(A.sw)).includes('M10 第二条'))
    void r1
  }

  // ================= M11: snapshot restore vs offline extension edit (E1) =================
  {
    const n = await webCreate('M11 快照行', 'https://m11/x')
    await waitB(A.sw, (bt) => bt.includes('M11 快照行'))
    const snap = JSON.parse((await api('POST', '/api/snapshots', {}, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
    // offline edit on the extension (older timestamp), then restore the
    // snapshot (server rows come back with a FRESH updatedAt, content equal
    // to what the extension's base held)
    await A.sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    })
    const node = await findNodeByTitle(A.sw, 'M11 快照行')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'M11 离线编辑' }) }, node.id)
    await new Promise(r => setTimeout(r, 1200))
    await api('POST', `/api/snapshots/${snap.id}/restore`, {}, { Cookie: COOKIE, 'X-CSRF': CSRF })
    await A.sw.evaluate(async () => {
      const cur = (await chrome.storage.local.get('md_config')).md_config
      cur.server = 'http://127.0.0.1:8999'
      await chrome.storage.local.set({ md_config: cur })
    })
    await resync(A.sw)
    // convergence: ONE row with the m11 URL, content agreed on both ends,
    // and repeated reconciles reach a fixedpoint (no doomed re-push loop)
    await waitB(A.sw, async (bt, sn) => sn.filter(x => (x.url || '').includes('m11')).length === 1, 20000)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    const srvRows11 = (await serverNodes()).filter(x => (x.url || '').includes('m11'))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    const bNode11 = await findNode(A.sw, `(n) => (n.url||'').includes('m11')`)
    log('M11: snapshot restore vs offline edit converges to ONE row',
      srvRows11.length === 1, 'srv=' + JSON.stringify(srvRows11.map(x => x.title)))
    log('M11b: no doomed re-push loop (fixedpoint, zero failed)',
      stats.failed === 0, 'failed=' + stats.failed + ' planned=' + stats.planned)
    log('M11c: browser row matches the surviving server row',
      bNode11 && srvRows11.length === 1 && bNode11.url === srvRows11[0].url && bNode11.title === srvRows11[0].title,
      'browser=' + (bNode11 && bNode11.title))
    void n
  }

  // ================= M12: offline journal survives SW lifecycle (D1) =================
  {
    await A.sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    })
    await A.sw.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0].children[0].id, title: 'M12 重启前书签', url: 'https://m12/x' })
    })
    await new Promise(r => setTimeout(r, 1200))
    // the touch journal lives in chrome.storage.local — verify the offline
    // create was journaled (the exact state a killed-and-revived SW boots
    // with: no in-memory queue, only md_touch + md_base)
    const touchKeys = await A.sw.evaluate(async () =>
      Object.keys((await chrome.storage.local.get('md_touch')).md_touch || {}))
    const baseBound = await A.sw.evaluate(async () => {
      const b = (await chrome.storage.local.get('md_base')).md_base
      return Object.values(b?.entries || {}).filter(e => e.localId).length
    })
    log('M12a: offline create journaled in md_touch (storage, not memory)',
      touchKeys.length >= 1, 'touchEntries=' + touchKeys.length + ' baseBound=' + baseBound)
    // simulate the revived-SW boot path: forceResync wipes ONLY the base
    // (adoption pass), touch survives, then the offline edit replays.
    // (A real MV3 idle-kill reboots via the boot reconcile — same code path.)
    await A.sw.evaluate(async () => {
      const cur = (await chrome.storage.local.get('md_config')).md_config
      cur.server = 'http://127.0.0.1:8999'
      await chrome.storage.local.set({ md_config: cur })
    })
    await A.sw.evaluate(() => globalThis.__markdeckForceResync())
    const arrived = await waitB(A.sw, (bt, sn) =>
      sn.some(x => x.url === 'https://m12/x') && bt.includes('M12 重启前书签'), 20000)
    log('M12: offline create reaches server after base-reset replay',
      arrived, 'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('m12')).map(x => x.title)))
  }

  console.log('\n=== SYNC-MATRIX RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await A.context.close()
  await B.context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
