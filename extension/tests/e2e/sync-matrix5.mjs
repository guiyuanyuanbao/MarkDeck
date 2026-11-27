// E2E: sync-matrix5 — 排序专项 (2026-11-27): bidirectional position sync.
// Companion to the engine-level tests (tests/reorder-matrix.test.ts); this
// suite drives the SAME stories through a real browser + real server.
//
//   O1  browser drag (move within bar) → server order matches the browser
//       drag; next reconcile is a fixedpoint (no revert)
//   O2  web reorder → browser converges to the web order (existing path
//       must keep working — the sweep must NOT fight server-side sorts)
//   O3  browser drag vs web reorder race: LWW decides, both ends converge
//       to ONE order, no churn
//   O4  browser bookmark-manager full sort (onChildrenReordered) → the
//       whole sibling order pushes
//   O5  drag inside a nested folder → folder children reorder on the
//       server, bar-level siblings untouched
//   O6  drag inside 其他书签 (other-root) → holder children reorder
//   O7  offline drag (server unreachable) → order lands after reconnect
//   O8  dual device: A drags, B absorbs the new order
//   O9  rename + drag combined → both title and order land
//   O10 new bookmark created in the middle (browser insert at index) →
//       its position and the siblings' shifted ranks all land
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
const getChildren = (sw, id) => sw.evaluate(async (cid) =>
  (await chrome.bookmarks.getChildren(cid)).map(c => ({ id: c.id, title: c.title, index: c.index, url: c.url })), id)
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

// drive resyncs until the predicate holds (WS debounce makes a bare waitB
// flaky; explicit resync polling is deterministic)
async function pollWithResync(sw, pred, tries = 10, gap = 800) {
  for (let i = 0; i < tries; i++) {
    await resync(sw)
    await new Promise(r => setTimeout(r, gap))
    let ok = false
    try { ok = await pred() } catch { /* transient */ }
    if (ok) return true
  }
  return false
}

const serverOrder = async (pred) => (await serverNodes()).filter(pred)
  .sort((a, b) => a.position - b.position).map(x => x.title)

const serverRows = async (pred) => (await serverNodes()).filter(pred)
  .sort((a, b) => a.position - b.position)

const webCreate = async (title, url, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'url', title, url, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
const webReorder = async (parentId, ids) =>
  api('POST', '/api/bookmarks/reorder', { parentId, ids }, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webCreateFolder = async (title, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'folder', title, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)

async function launchExt(name) {
  const userDataDir = `${TMP}/md-matrix5-${name}`
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

// drag a browser bookmark to a new index within its parent via
// chrome.bookmarks.move — exactly what a user's drag in the bookmark
// manager produces (onMoved journal + shifted sibling indexes)
const browserMove = (sw, id, parentId, index) =>
  sw.evaluate(async ([nid, pid, idx]) => { await chrome.bookmarks.move(nid, { parentId: pid, index: idx }) }, [id, parentId, index])

async function main() {
  console.log('== MarkDeck sync-matrix5 E2E (排序专项: bidirectional position sync) ==')

  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  // ---- fresh server ----
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1000))
  let wiped = false
  for (let i = 0; i < 20 && !wiped; i++) {
    try { fs.rmSync(`${TMP}/md-matrix5`, { recursive: true, force: true }); wiped = !fs.existsSync(`${TMP}/md-matrix5`) } catch {}
    if (!wiped) await new Promise(r => setTimeout(r, 500))
  }
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: `${TMP}/md-matrix5` },
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
  log('O0: fresh server + admin auth', CSRF !== '')

  const A = await launchExt('a')
  await pairExt(A, 'A')
  log('O0b: device A paired', true)

  const [barRoot, otherRoot] = await A.sw.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree()
    return [tree[0].children[0].id, tree[0].children[1].id]
  })

  // ================= O1: browser drag → server order follows =================
  {
    const made = []
    for (let i = 0; i < 3; i++) made.push(await webCreate(`O1 排序${i}`, `https://o1/${i}`))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    // the bar now holds [O1 排序0, O1 排序1, O1 排序2]; drag 排序2 to index 0
    const n2 = await findNodeByTitle(A.sw, 'O1 排序2')
    await browserMove(A.sw, n2.id, barRoot, 0)
    await new Promise(r => setTimeout(r, 1500))
    const landed = await pollWithResync(A.sw, async () =>
      JSON.stringify(await serverOrder(x => x.title.startsWith('O1 排序'))) ===
      JSON.stringify(['O1 排序2', 'O1 排序0', 'O1 排序1']))
    log('O1: browser drag order reaches the server', landed,
      'srv=' + JSON.stringify(await serverOrder(x => x.title.startsWith('O1 排序'))))
    // the browser order is UNCHANGED (not reverted by the next reconcile)
    const kids = await getChildren(A.sw, barRoot)
    const m9 = kids.filter(k => k.title.startsWith('O1 排序')).map(k => k.title)
    log('O1b: browser keeps the dragged order (no revert)',
      JSON.stringify(m9) === JSON.stringify(['O1 排序2', 'O1 排序0', 'O1 排序1']),
      'browser=' + JSON.stringify(m9))
    // fixedpoint: further reconciles plan nothing and keep both orders
    await resync(A.sw); await new Promise(r => setTimeout(r, 1200))
    await resync(A.sw); await new Promise(r => setTimeout(r, 1200))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    const kids2 = await getChildren(A.sw, barRoot)
    const m92 = kids2.filter(k => k.title.startsWith('O1 排序')).map(k => k.title)
    const srv2 = await serverOrder(x => x.title.startsWith('O1 排序'))
    log('O1c: fixedpoint — no churn, both ends agree after repeat reconciles',
      stats.failed === 0 &&
      JSON.stringify(m92) === JSON.stringify(['O1 排序2', 'O1 排序0', 'O1 排序1']) &&
      JSON.stringify(srv2) === JSON.stringify(['O1 排序2', 'O1 排序0', 'O1 排序1']),
      'failed=' + stats.failed + ' planned=' + stats.planned + ' browser=' + JSON.stringify(m92) + ' srv=' + JSON.stringify(srv2))
  }

  // ================= O2: web reorder → browser converges =================
  {
    // isolation folder: sweep writes absolute positions 1..n, so every
    // scenario reorders ITS OWN bucket — shared-bar assertions would fight
    // sibling scenarios' sweeps
    const folder = await webCreateFolder('O2 网页夹')
    const made = []
    for (let i = 0; i < 3; i++) made.push(await webCreate(`O2 网页序${i}`, `https://o2/${i}`, folder.id))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    const fNode = await findNodeByTitle(A.sw, 'O2 网页夹')
    const before = await serverRows(x => x.parentId === folder.id)
    const want = [...before.map(x => x.title)].reverse()
    const r = await webReorder(folder.id, [...before.map(x => x.id)].reverse())
    const converged = await pollWithResync(A.sw, async () => {
      const kids = await getChildren(A.sw, fNode.id)
      const titles = kids.map(k => k.title)
      return JSON.stringify(titles) === JSON.stringify(want)
    })
    log('O2: web reorder reaches the browser', converged && r.status === 200,
      'browser=' + JSON.stringify((await getChildren(A.sw, fNode.id)).map(k => k.title)) + ' want=' + JSON.stringify(want))
    // fixedpoint
    await resync(A.sw); await new Promise(r => setTimeout(r, 1200))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('O2b: web-driven order is a fixedpoint (no sweep counterattack)',
      stats.failed === 0, 'failed=' + stats.failed + ' planned=' + stats.planned)
  }

  // ================= O3: drag vs web reorder race =================
  {
    const folder = await webCreateFolder('O3 竞速夹')
    const made = []
    for (let i = 0; i < 3; i++) made.push(await webCreate(`O3 竞速${i}`, `https://o3/${i}`, folder.id))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    const fNode = await findNodeByTitle(A.sw, 'O3 竞速夹')
    // web reorders [2,1,0]; the browser simultaneously drags 竞速0 to the top
    const before = await serverRows(x => x.parentId === folder.id)
    const r = await webReorder(folder.id, [...before.map(x => x.id)].reverse())
    const n0 = await findNodeByTitle(A.sw, 'O3 竞速0')
    if (n0) await browserMove(A.sw, n0.id, fNode.id, 0)
    await new Promise(r => setTimeout(r, 2500))
    await pollWithResync(A.sw, async () => {
      const titles = (await getChildren(A.sw, fNode.id)).map(k => k.title)
      const srv = (await serverRows(x => x.parentId === folder.id)).map(x => x.title)
      // ONE consistent order on both ends (whichever won, they agree)
      return JSON.stringify(titles) === JSON.stringify(srv)
    }, 12, 900)
    const titles = (await getChildren(A.sw, fNode.id)).map(k => k.title)
    const srv = (await serverRows(x => x.parentId === folder.id)).map(x => x.title)
    const agree = JSON.stringify(titles) === JSON.stringify(srv)
    const uniq = new Set(titles).size === 3
    log('O3: drag/reorder race settles to ONE order on both ends',
      r.status === 200 && agree && uniq, 'browser=' + JSON.stringify(titles) + ' srv=' + JSON.stringify(srv))
    // fixedpoint
    await resync(A.sw); await new Promise(r => setTimeout(r, 1200))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('O3b: race settled state is a fixedpoint', stats.failed === 0,
      'failed=' + stats.failed + ' planned=' + stats.planned)
  }

  // ================= O4: bookmark-manager sort (reverse all) =================
  {
    const made = []
    for (let i = 0; i < 4; i++) made.push(await webCreate(`O4 全排序${i}`, `https://o4/${i}`))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    const beforeKids = await getChildren(A.sw, barRoot)
    const before = beforeKids.filter(k => k.title.startsWith('O4 全排序')).map(k => k.title)
    // simulate the manager's 按标题排序: full sequence reversal (each move
    // journals onMoved; the sweep must vouch off those child entries)
    const nodeIds = []
    for (const t of before) nodeIds.push((await findNodeByTitle(A.sw, t)))
    const reversed = [...nodeIds].reverse()
    for (let i = 0; i < reversed.length; i++) {
      await browserMove(A.sw, reversed[i].id, barRoot, i)
    }
    await new Promise(r => setTimeout(r, 1500))
    const want = reversed.map(x => x.title)
    const landed = await pollWithResync(A.sw, async () =>
      JSON.stringify(await serverOrder(x => x.title.startsWith('O4 全排序'))) === JSON.stringify(want))
    log('O4: full reversal pushes the whole sibling order', landed,
      'srv=' + JSON.stringify(await serverOrder(x => x.title.startsWith('O4 全排序'))) + ' want=' + JSON.stringify(want))
    const kids = await getChildren(A.sw, barRoot)
    const after = kids.filter(k => k.title.startsWith('O4 全排序')).map(k => k.title)
    log('O4b: browser keeps the reversed order', JSON.stringify(after) === JSON.stringify(want),
      'browser=' + JSON.stringify(after))
  }

  // ================= O5: nested folder drag =================
  {
    const folder = await webCreateFolder('O5 嵌套夹')
    const made = []
    for (let i = 0; i < 3; i++) made.push(await webCreate(`O5 内序${i}`, `https://o5/${i}`, folder.id))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    const fNode = await findNodeByTitle(A.sw, 'O5 嵌套夹')
    const kids = await getChildren(A.sw, fNode.id)
    const kid2 = kids.find(k => k.title === 'O5 内序2')
    await browserMove(A.sw, kid2.id, fNode.id, 0)
    await new Promise(r => setTimeout(r, 1500))
    const landed = await pollWithResync(A.sw, async () => {
      const srvKids = await serverOrder(x => x.parentId === folder.id && x.title.startsWith('O5 内序'))
      return JSON.stringify(srvKids) === JSON.stringify(['O5 内序2', 'O5 内序0', 'O5 内序1'])
    })
    log('O5: nested-folder drag reorders the folder server-side', landed,
      'srv=' + JSON.stringify(await serverOrder(x => x.parentId === folder.id && x.title.startsWith('O5 内序'))))
    // bar-level rows untouched: O1..O4 rows keep their relative order
    const barNow = (await getChildren(A.sw, barRoot)).map(k => k.title)
    const srvBar = (await serverNodes()).filter(x => x.parentId === '' && !x.title.includes('其他书签'))
      .sort((a, b) => a.position - b.position).map(x => x.title)
    log('O5b: other buckets untouched by the nested sweep',
      JSON.stringify(srvBar) === JSON.stringify(barNow.filter(t => srvBar.includes(t))),
      'srvBar=' + JSON.stringify(srvBar))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('O5c: nested sweep fixedpoint', stats.failed === 0, 'failed=' + stats.failed)
  }

  // ================= O6: drag inside 其他书签 =================
  {
    const m1 = await webCreate('O6 其他一', 'https://o6/1')
    const m2 = await webCreate('O6 其他二', 'https://o6/2')
    // land them in the holder via server move (web create defaults to top)
    const holder = (await serverNodes()).find(x => x.type === 'folder' && x.title.includes('其他书签'))
    await api('POST', `/api/bookmarks/${m1.id}/move`, { parentId: holder.id, position: 1 }, { Cookie: COOKIE, 'X-CSRF': CSRF })
    await api('POST', `/api/bookmarks/${m2.id}/move`, { parentId: holder.id, position: 2 }, { Cookie: COOKIE, 'X-CSRF': CSRF })
    await waitB(A.sw, (bt) => bt.includes('O6 其他一') && bt.includes('O6 其他二'), 15000)
    // browser-side drag: 其他二 above 其他一 within the other-root
    const n2 = await findNodeByTitle(A.sw, 'O6 其他二')
    await browserMove(A.sw, n2.id, otherRoot, 0)
    await new Promise(r => setTimeout(r, 1500))
    const landed = await pollWithResync(A.sw, async () =>
      JSON.stringify(await serverOrder(x => x.title.startsWith('O6 其他'))) ===
      JSON.stringify(['O6 其他二', 'O6 其他一']))
    log('O6: drag inside 其他书签 reorders holder children server-side', landed,
      'srv=' + JSON.stringify(await serverOrder(x => x.title.startsWith('O6 其他'))))
    await resync(A.sw); await new Promise(r => setTimeout(r, 1000))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('O6b: holder sweep fixedpoint', stats.failed === 0, 'failed=' + stats.failed)
  }

  // ================= O7: offline drag lands after reconnect =================
  {
    const made = []
    for (let i = 0; i < 3; i++) made.push(await webCreate(`O7 离线${i}`, `https://o7/${i}`))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    // go offline
    await A.sw.evaluate(async () => {
      const cfg = (await chrome.storage.local.get('md_config')).md_config
      await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
    })
    const n2 = await findNodeByTitle(A.sw, 'O7 离线2')
    await browserMove(A.sw, n2.id, barRoot, 0)
    await new Promise(r => setTimeout(r, 1200))
    // back online: the offline drag replays
    await A.sw.evaluate(async () => {
      const cur = (await chrome.storage.local.get('md_config')).md_config
      cur.server = 'http://127.0.0.1:8999'
      await chrome.storage.local.set({ md_config: cur })
    })
    const landed = await pollWithResync(A.sw, async () =>
      JSON.stringify(await serverOrder(x => x.title.startsWith('O7 离线'))) ===
      JSON.stringify(['O7 离线2', 'O7 离线0', 'O7 离线1']), 14, 900)
    log('O7: offline drag order lands after reconnect', landed,
      'srv=' + JSON.stringify(await serverOrder(x => x.title.startsWith('O7 离线'))))
    const kids = await getChildren(A.sw, barRoot)
    const after = kids.filter(k => k.title.startsWith('O7 离线')).map(k => k.title)
    log('O7b: browser keeps the offline-dragged order', JSON.stringify(after) === JSON.stringify(['O7 离线2', 'O7 离线0', 'O7 离线1']),
      'browser=' + JSON.stringify(after))
  }

  // ================= O8: dual device — A drags, B absorbs =================
  const B = await launchExt('b')
  await pairExt(B, 'B')
  log('O8 setup: device B paired', true)
  {
    const made = []
    for (let i = 0; i < 3; i++) made.push(await webCreate(`O8 双端${i}`, `https://o8/${i}`))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    await waitB(B.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    const n2 = await findNodeByTitle(A.sw, 'O8 双端2')
    await browserMove(A.sw, n2.id, barRoot, 0)
    await new Promise(r => setTimeout(r, 1500))
    const landed = await pollWithResync(A.sw, async () =>
      JSON.stringify(await serverOrder(x => x.title.startsWith('O8 双端'))) ===
      JSON.stringify(['O8 双端2', 'O8 双端0', 'O8 双端1']))
    const bArrived = await pollWithResync(B.sw, async () => {
      const srv = await serverOrder(x => x.title.startsWith('O8 双端'))
      return JSON.stringify(srv) === JSON.stringify(['O8 双端2', 'O8 双端0', 'O8 双端1'])
    })
    // device B's browser must converge to the same order (server → local)
    let bOrderOk = false
    for (let i = 0; i < 10 && !bOrderOk; i++) {
      await resync(B.sw)
      await new Promise(r => setTimeout(r, 800))
      const bkids = await getChildren(B.sw, (await B.sw.evaluate(async () =>
        (await chrome.bookmarks.getTree())[0].children[0].id)))
      const titles = bkids.filter(k => k.title.startsWith('O8 双端')).map(k => k.title)
      bOrderOk = JSON.stringify(titles) === JSON.stringify(['O8 双端2', 'O8 双端0', 'O8 双端1'])
    }
    log('O8: A-side drag lands server-side', landed && bArrived,
      'srv=' + JSON.stringify(await serverOrder(x => x.title.startsWith('O8 双端'))))
    log('O8b: device B converges to the same order', bOrderOk,
      'Bbrowser=' + JSON.stringify(((await getChildren(B.sw, (await B.sw.evaluate(async () =>
        (await chrome.bookmarks.getTree())[0].children[0].id)))) || []).filter(k => k.title.startsWith('O8 双端')).map(k => k.title)))
    // B-side drag now flows back to the server and then to A
    const bBar = await B.sw.evaluate(async () => (await chrome.bookmarks.getTree())[0].children[0].id)
    const bn1 = await findNodeByTitle(B.sw, 'O8 双端1')
    await browserMove(B.sw, bn1.id, bBar, 0)
    await new Promise(r => setTimeout(r, 1500))
    const backOk = await pollWithResync(B.sw, async () =>
      JSON.stringify(await serverOrder(x => x.title.startsWith('O8 双端'))) ===
      JSON.stringify(['O8 双端1', 'O8 双端2', 'O8 双端0']))
    log('O8c: B-side drag flows back (bidirectional)', backOk,
      'srv=' + JSON.stringify(await serverOrder(x => x.title.startsWith('O8 双端'))))
  }

  // ================= O9: rename + drag combined =================
  {
    const made = []
    for (let i = 0; i < 2; i++) made.push(await webCreate(`O9 改名${i}`, `https://o9/${i}`))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    const n1 = await findNodeByTitle(A.sw, 'O9 改名1')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'O9 改名1-新' }) }, n1.id)
    await browserMove(A.sw, n1.id, barRoot, 0)
    await new Promise(r => setTimeout(r, 1500))
    const landed = await pollWithResync(A.sw, async () => {
      const srv = await serverNodes()
      const row = srv.find(x => x.url === 'https://o9/1')
      const order = srv.filter(x => x.title.startsWith('O9')).sort((a, b) => a.position - b.position).map(x => x.title)
      return row && row.title === 'O9 改名1-新' &&
        JSON.stringify(order) === JSON.stringify(['O9 改名1-新', 'O9 改名0'])
    })
    log('O9: rename + drag both land (title and order)', landed,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => x.title.startsWith('O9')).sort((a, b) => a.position - b.position).map(x => x.title)))
  }

  // ================= O10: browser create-in-middle shifts sibling ranks =================
  {
    // isolation folder: sibling scenarios' sweeps rewrite absolute bar
    // positions (raw 1..n) — a shared bar would make this scenario's
    // assertion read the OTHER scenarios' overwrites
    const folder = await webCreateFolder('O10 中插夹')
    const made = []
    for (let i = 0; i < 2; i++) made.push(await webCreate(`O10 中插${i}`, `https://o10/${i}`, folder.id))
    await waitB(A.sw, (bt) => made.every(m => bt.includes(m.title)), 15000)
    const fNode = await findNodeByTitle(A.sw, 'O10 中插夹')
    // create a new bookmark at index 1 (between the two) in the browser
    await A.sw.evaluate(async (fid) => {
      await chrome.bookmarks.create({ parentId: fid, title: 'O10 中插新', url: 'https://o10/new', index: 1 })
    }, fNode.id)
    await new Promise(r => setTimeout(r, 1500))
    const landed = await pollWithResync(A.sw, async () => {
      const srv = await serverNodes().then(rows => {
        const kids = rows.filter(x => x.parentId === folder.id)
        return kids.sort((a, b) => a.position - b.position).map(x => x.title)
      })
      return JSON.stringify(srv) === JSON.stringify(['O10 中插0', 'O10 中插新', 'O10 中插1'])
    })
    const srvNow = (await serverNodes()).filter(x => x.parentId === folder.id).sort((a, b) => a.position - b.position).map(x => x.title)
    log('O10: browser create-in-middle lands with correct final order', landed,
      'srv=' + JSON.stringify(srvNow))
    // fixedpoint
    await resync(A.sw); await new Promise(r => setTimeout(r, 1200))
    const stats = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('O10b: mid-insert settle is a fixedpoint', stats.failed === 0, 'failed=' + stats.failed)
  }

  console.log('\n=== SYNC-MATRIX5 RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await A.context.close()
  await B.context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
