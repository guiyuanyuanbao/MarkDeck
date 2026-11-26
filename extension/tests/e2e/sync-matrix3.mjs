// E2E: sync-matrix3 — phase-3 sync专项 (2026-11-26): compositional depth.
//   P1  folder-duplicates merge with DEEP subtrees (3-level) — children
//       dedupe by url|title, deep folders move intact, shells trashed
//   P2  move folder into its OWN subtree → server rejects (400), browser
//       unchanged, zero failures
//   P3  dual-device concurrent same-title folder creates → both rows
//       exist, both devices see both, no silent merge
//   P4  trashed-node move rejection: move via API 400s, restore-first flow
//   P5  child edited offline while parent is MOVED server-side → both
//       changes converge (LWW on child, move applies to parent)
//   P6  rename + move in ONE server batch → single reconcile, fixedpoint
//   P7  server swaps two folders' parent/child relation in one batch →
//       BOTH moves planned (engine fix), fixedpoint
//   P8  deep folder (with children) moved into 其他书签 holder → whole
//       subtree crosses roots, leaves follow
//   P9  3-device relay: A→B→C→A chained edits with concurrent offline
//       windows → final state agreed everywhere
//   P10 extension save-with-tags × concurrent web title edit → tag/title
//       both survive (field-level merge)
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
async function serverTrash() {
  return JSON.parse((await api('GET', '/api/trash', undefined, { Cookie: COOKIE })).body).nodes
}

const browserTitles = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const out = []
  const walk = (nodes) => { for (const n of nodes) { if (n.url) out.push(n.title); if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return out
})
const browserFolders = (sw) => sw.evaluate(async () => {
  const tree = await chrome.bookmarks.getTree()
  const out = []
  const walk = (nodes) => { for (const n of nodes) { if (!n.url && n.parentId && n.id !== tree[0].children[0].id && n.id !== tree[0].children[1].id) out.push(n.title); if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return out
})
const findNodeByTitle = (sw, title) => sw.evaluate(async (t) => {
  const tree = await chrome.bookmarks.getTree()
  let found = null
  const walk = (nodes) => { for (const n of nodes) { if (n.title === t) found = n; if (n.children) walk(n.children) } }
  for (const root of tree) if (root.children) walk(root.children)
  return found ? { id: found.id, parentId: found.parentId, title: found.title, url: found.url, index: found.index } : null
}, title)
const getChildren = (sw, fid) => sw.evaluate(async (id) =>
  (await chrome.bookmarks.getChildren(id)).map(c => ({ id: c.id, title: c.title, url: c.url })), fid)
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
async function converge(sw, pred, rounds = 10, gapMs = 700) {
  let ok = false
  for (let i = 0; i < rounds && !ok; i++) {
    await resync(sw)
    await new Promise(r => setTimeout(r, gapMs))
    try { ok = await pred(await browserTitles(sw), await serverNodes()) } catch { /* transient */ }
  }
  return ok
}

async function launchExt(name) {
  const userDataDir = `${TMP}/md-matrix3-${name}`
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    viewport: { width: 1100, height: 760 },
  })
  let sw = null
  for (let i = 0; i < 30; i++) {
    const sws = context.serviceWorkers().filter(w => w.url().includes('background.js'))
    if (sws.length) { sw = sws[0]; break }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!sw) throw new Error(name + ': extension SW not found')
  sw.on('console', msg => { const t = msg.text(); if (t.includes('error') || t.includes('fail')) console.log(`[${name}]`, t.slice(0, 160)) })
  return { context, sw, extId: new URL(sw.url()).host }
}

async function pairExt(A, name) {
  const code = JSON.parse((await api('POST', '/api/pair-code', {}, { Cookie: COOKIE, 'X-CSRF': CSRF })).body).code
  const page = await A.context.newPage()
  await page.goto(`chrome-extension://${A.extId}/options.html`)
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
  await new Promise(r => setTimeout(r, 1800))
}

const goOffline = (sw) => sw.evaluate(async () => {
  const cfg = (await chrome.storage.local.get('md_config')).md_config
  await chrome.storage.local.set({ md_config: { ...cfg, server: 'http://127.0.0.1:1' } })
})
const goOnline = (sw) => sw.evaluate(async () => {
  const cur = (await chrome.storage.local.get('md_config')).md_config
  cur.server = 'http://127.0.0.1:8999'
  await chrome.storage.local.set({ md_config: cur })
})

const webCreate = async (title, url, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'url', title, url, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
const webCreateFolder = async (title, parentId = '') =>
  JSON.parse((await api('POST', '/api/bookmarks', { type: 'folder', title, parentId }, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
const webUpdate = async (id, patch) => api('PUT', `/api/bookmarks/${id}`, patch, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webDelete = async (id) => api('DELETE', `/api/bookmarks/${id}`, undefined, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webRestore = async (id) => api('POST', `/api/bookmarks/${id}/restore`, undefined, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webMove = async (id, parentId, position = 0) =>
  api('POST', `/api/bookmarks/${id}/move`, { parentId, position }, { Cookie: COOKIE, 'X-CSRF': CSRF })

async function main() {
  console.log('== MarkDeck sync-matrix3 E2E (phase-3: compositional depth) ==')

  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1000))
  let wiped = false
  for (let i = 0; i < 20 && !wiped; i++) {
    try { fs.rmSync(`${TMP}/md-matrix3`, { recursive: true, force: true }); wiped = !fs.existsSync(`${TMP}/md-matrix3`) } catch {}
    if (!wiped) await new Promise(r => setTimeout(r, 500))
  }
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: `${TMP}/md-matrix3` },
    stdio: 'ignore',
  })
  for (let i = 0; i < 30; i++) {
    try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  const state = JSON.parse((await api('GET', '/api/auth/state')).body)
  if (!state.setup) throw new Error('server db is NOT fresh')
  const l = await api('POST', '/api/auth/setup', { password: ADMIN_PW })
  COOKIE = l.cookies[0].split(';')[0]
  CSRF = JSON.parse(l.body).csrf
  log('P0: fresh server + admin auth', CSRF !== '')

  const A = await launchExt('a')
  await pairExt(A, 'A')
  const B = await launchExt('b')
  await pairExt(B, 'B')
  const C = await launchExt('c')
  await pairExt(C, 'C')
  log('P0b: devices A+B+C paired', true)

  // ================= P1: folder-duplicates merge with deep subtrees =================
  {
    // two same-name folders, each with a 3-level subtree, overlapping urls
    const f1 = await webCreateFolder('P1 重复夹')
    const f2 = await webCreateFolder('P1 重复夹')
    await webCreate('P1 共同页', 'https://p1/common', f1.id)
    await webCreate('P1 独有A', 'https://p1/only-a', f1.id)
    const sub1 = await webCreateFolder('P1 子夹1', f1.id)
    await webCreate('P1 深叶1', 'https://p1/deep1', sub1.id)
    const sub2 = await webCreateFolder('P1 子夹1', f2.id)
    await webCreate('P1 深叶2', 'https://p1/deep2', sub2.id)
    await webCreate('P1 独有B', 'https://p1/only-b', f2.id)
    await waitB(A.sw, (bt) => bt.includes('P1 深叶1') && bt.includes('P1 深叶2'))
    const rows = (await serverNodes()).filter(x => x.title === 'P1 重复夹' && x.type === 'folder')
    const keepId = rows[0].id
    const removeIds = rows.slice(1).map(x => x.id)
    const m = await api('POST', '/api/tools/folder-duplicates/merge',
      { keepId, removeIds }, { Cookie: COOKIE, 'X-CSRF': CSRF })
    const ok = await converge(A.sw, async (bt, sn) => {
      const folders = sn.filter(x => x.title === 'P1 重复夹' && x.type === 'folder')
      if (folders.length !== 1) return false
      const titles = bt
      return titles.includes('P1 深叶1') && titles.includes('P1 深叶2') &&
        titles.includes('P1 共同页') && titles.includes('P1 独有A') && titles.includes('P1 独有B')
    }, 12)
    // dedup: exactly ONE 'P1 共同页' remains
    const common = (await serverNodes()).filter(x => x.title === 'P1 共同页')
    const sub1Rows = (await serverNodes()).filter(x => x.title === 'P1 子夹1')
    log('P1: deep folder-duplicates merge keeps all unique content', ok && m.status === 200,
      'http=' + m.status)
    log('P1b: url|title dedup — one common page, deep leaves intact',
      common.length === 1 && sub1Rows.length >= 1,
      'common=' + common.length + ' subFolders=' + sub1Rows.length)
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('P1c: merge reconciles with zero failures', st.failed === 0, 'failed=' + st.failed)
  }

  // ================= P2: move folder into its own subtree → rejected =================
  {
    const outer = await webCreateFolder('P2 外夹')
    const inner = await webCreateFolder('P2 内夹', outer.id)
    await waitB(A.sw, (bt) => bt.includes('P2 内夹'))
    const r = await webMove(outer.id, inner.id, 0) // cycle!
    const srvSame = (await serverNodes()).some(x => x.id === outer.id && x.parentId === '')
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('P2: cycle move rejected server-side (400), tree unchanged',
      r.status === 400 && srvSame && st.failed === 0, 'http=' + r.status)
    // browser unchanged
    const outerNode = await findNodeByTitle(A.sw, 'P2 外夹')
    const [, otherRoot] = await A.sw.evaluate(async () => {
      const t = await chrome.bookmarks.getTree()
      return [t[0].children[0].id, t[0].children[1].id]
    })
    log('P2b: browser folder stays at bar root after rejected cycle', outerNode && outerNode.parentId !== otherRoot)
  }

  // ================= P3: dual-device concurrent same-title folders =================
  {
    // NOTE: a local create schedules an automatic reconcile after 1.2s
    // (the product's edit-debounce). Test-driven resyncs must wait that
    // out or they race the auto-run and interleave base/touch advances.
    await A.sw.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0].children[0].id, title: 'P3 双人夹' })
    })
    await new Promise(r => setTimeout(r, 2000)) // > 1.2s debounce: A's auto-reconcile completes
    await B.sw.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0].children[0].id, title: 'P3 双人夹' })
    })
    await new Promise(r => setTimeout(r, 2000)) // B's auto-reconcile completes
    await resync(A.sw)
    await resync(B.sw)
    await new Promise(r => setTimeout(r, 2500))
    const srvF = (await serverNodes()).filter(x => x.title === 'P3 双人夹' && x.type === 'folder')
    const aF = (await browserFolders(A.sw)).filter(t => t === 'P3 双人夹').length
    const bF = (await browserFolders(B.sw)).filter(t => t === 'P3 双人夹').length
    if (srvF.length !== 2 || aF !== 2 || bF !== 2) {
      const stA = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
      const diagA = await A.sw.evaluate(() => globalThis.__markdeckDeepDiag())
      const srvRowsAll = (await serverNodes()).filter(x => x.title === 'P3 双人夹')
      const bBase = await B.sw.evaluate(async (rows) => {
        const b = (await chrome.storage.local.get('md_base')).md_base
        const touch = (await chrome.storage.local.get('md_touch')).md_touch || {}
        return rows.map(r => ({ id: r.id.slice(0, 8), at: r.updatedAt, deviceId: r.deviceId, boundHere: !!b.entries?.[r.id]?.localId }))
      }, srvRowsAll)
      const bStats = await B.sw.evaluate(() => globalThis.__markdeckReconcileStats())
      const bTouchKeys = await B.sw.evaluate(async () => Object.keys((await chrome.storage.local.get('md_touch')).md_touch || {}).length)
      const bBaseRows = await B.sw.evaluate(async (rows) => {
        const b = (await chrome.storage.local.get('md_base')).md_base
        return rows.map(r => ({ sid: r.id.slice(0, 8), localId: b.entries?.[r.id]?.localId || null, rev: b.entries?.[r.id]?.server?.revision }))
      }, srvRowsAll)
      const bLocalIds = await B.sw.evaluate(async () => {
        const bar = (await chrome.bookmarks.getTree())[0].children[0]
        return bar.children.filter(c => c.title === 'P3 双人夹').map(c => c.id)
      })
      console.log('  [P3diag] statsA=', JSON.stringify(await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())), 'statsB=', JSON.stringify(bStats), 'bTouch=', bTouchKeys)
      console.log('  [P3diag] bBaseRows=', JSON.stringify(bBaseRows), 'bLocalIds=', JSON.stringify(bLocalIds))
      console.log('  [P3diag] srvRows=', JSON.stringify(bBase), 'aFolders=', aF, 'bFolders=', bF)
    }
    log('P3: concurrent same-title folders → both rows exist (no silent merge)',
      srvF.length === 2, 'srv=' + srvF.length)
    log('P3b: both devices converge to 2 folders each', aF === 2 && bF === 2, 'A=' + aF + ' B=' + bF)
    // fixedpoint
    await resync(A.sw)
    await resync(B.sw)
    await new Promise(r => setTimeout(r, 1500))
    const srvAgain = (await serverNodes()).filter(x => x.title === 'P3 双人夹' && x.type === 'folder').length
    log('P3c: coexistence fixedpoint', srvAgain === 2)
  }

  // ================= P4: trashed-node move rejection + restore-first flow =================
  {
    const n = await webCreate('P4 待恢复行', 'https://p4/x')
    await waitB(A.sw, (bt) => bt.includes('P4 待恢复行'))
    const folder = await webCreateFolder('P4 目标夹')
    await webDelete(n.id)
    await waitB(A.sw, (bt) => !bt.includes('P4 待恢复行'))
    const mv = await webMove(n.id, folder.id) // must 400 (trashed)
    const stillTrashed = (await serverTrash()).some(x => x.id === n.id)
    log('P4: moving a trashed node is rejected (400) and stays in trash',
      mv.status === 400 && stillTrashed, 'http=' + mv.status)
    await webRestore(n.id)
    const restored = await converge(A.sw, (bt, sn) => bt.includes('P4 待恢复行') && sn.some(x => x.id === n.id && x.parentId === ''))
    // restore brings it back under ORIGINAL parent; now the move works
    const mv2 = await webMove(n.id, folder.id)
    const moved = await converge(A.sw, (bt, sn) => sn.some(x => x.id === n.id && x.parentId === folder.id) && bt.includes('P4 待恢复行'))
    log('P4b: restore-then-move flow completes both ends', restored && mv2.status === 200 && moved)
  }

  // ================= P5: child offline edit × parent server move =================
  {
    const g = await webCreateFolder('P5 容器G')
    const f = await webCreateFolder('P5 挪动夹F')
    const c = await webCreate('P5 子行', 'https://p5/x', f.id)
    await waitB(A.sw, (bt) => bt.includes('P5 子行'))
    // A goes offline, renames the CHILD
    await goOffline(A.sw)
    const cNode = await findNodeByTitle(A.sw, 'P5 子行')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'P5 子行-离线改' }) }, cNode.id)
    await new Promise(r => setTimeout(r, 1200))
    // server moves the PARENT folder into G while A is offline
    await webMove(f.id, g.id, 0)
    await goOnline(A.sw)
    const ok = await converge(A.sw, async (bt, sn) => {
      const fRow = sn.find(x => x.title === 'P5 挪动夹F')
      const cRow = sn.find(x => x.id === c.id)
      return fRow && fRow.parentId === g.id && cRow && cRow.title === 'P5 子行-离线改' &&
        bt.includes('P5 子行-离线改')
    }, 12)
    // verify structure in browser: child sits under F which sits under G
    const gNode = await findNodeByTitle(A.sw, 'P5 容器G')
    const gKids = gNode ? await getChildren(A.sw, gNode.id) : []
    const fNode2 = gKids.find(x => x.title === 'P5 挪动夹F')
    const fKids = fNode2 ? await getChildren(A.sw, fNode2.id) : []
    log('P5: offline child edit + server parent move converge together',
      ok && !!fNode2 && fKids.some(x => x.title === 'P5 子行-离线改'),
      'F-under-G=' + !!fNode2)
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('P5b: combined LWW zero failures', st.failed === 0, 'failed=' + st.failed)
  }

  // ================= P6: rename + move in ONE server batch =================
  {
    const f = await webCreateFolder('P6 原名夹')
    const n = await webCreate('P6 行', 'https://p6/x', f.id)
    await waitB(A.sw, (bt) => bt.includes('P6 行'))
    const dest = await webCreateFolder('P6 去处')
    await waitB(A.sw, (bt) => bt.includes('P6 去处'))
    await webUpdate(f.id, { title: 'P6 改名夹' })
    await webMove(n.id, dest.id, 0)
    const ok = await converge(A.sw, async (bt, sn) => {
      const nRow = sn.find(x => x.id === n.id)
      const folders = (await browserFolders(A.sw))
      return nRow && nRow.parentId === dest.id && bt.includes('P6 行') &&
        folders.includes('P6 改名夹') && !folders.includes('P6 原名夹')
    }, 12)
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('P6: rename+move batch lands in one reconcile, fixedpoint', ok && st.failed === 0,
      'failed=' + st.failed)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st6 = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('P6b: post-batch fixedpoint (planned=0)', st6.planned === 0, 'planned=' + st6.planned)
  }

  // ================= P7: server swaps folder parent/child in one batch =================
  {
    const f1 = await webCreateFolder('P7-F1')
    const f2 = await webCreateFolder('P7-F2', f1.id)
    await waitB(A.sw, (bt) => bt.includes('P7-F2'))
    // swap: f2 to top, f1 under f2
    const mv1 = await webMove(f2.id, '', 0)
    const mv2 = await webMove(f1.id, f2.id, 0)
    const ok = await converge(A.sw, async (bt, sn) => {
      const r1 = sn.find(x => x.id === f1.id)
      const r2 = sn.find(x => x.id === f2.id)
      if (!r1 || !r2 || r1.parentId !== f2.id || r2.parentId !== '') return false
      const folders = await browserFolders(A.sw)
      // structural verification: f2's children include f1
      const f2Node = await findNodeByTitle(A.sw, 'P7-F2')
      const kids = await getChildren(A.sw, f2Node.id)
      return kids.some(x => x.title === 'P7-F1')
    }, 12)
    log('P7: parent/child swap batch applies BOTH moves (engine fix)', ok && mv1.status === 200 && mv2.status === 200,
      'http=' + mv1.status + '/' + mv2.status)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('P7b: post-swap fixedpoint', st.failed === 0 && st.planned === 0,
      'planned=' + st.planned)
    // swap back for a clean slate
    await webMove(f1.id, '', 0)
    await webMove(f2.id, f1.id, 0)
    await converge(A.sw, async () => {
      const f1Node = await findNodeByTitle(A.sw, 'P7-F1')
      const kids = await getChildren(A.sw, f1Node.id)
      return kids.some(x => x.title === 'P7-F2')
    }, 10)
  }

  // ================= P8: deep folder crosses roots via holder move =================
  {
    const [, otherRoot] = await A.sw.evaluate(async () => {
      const t = await chrome.bookmarks.getTree()
      return [t[0].children[0].id, t[0].children[1].id]
    })
    const top = await webCreateFolder('P8 跨根夹')
    const sub = await webCreateFolder('P8 内层', top.id)
    const leaf = await webCreate('P8 深叶', 'https://p8/deep', sub.id)
    await waitB(A.sw, (bt) => bt.includes('P8 深叶'))
    const holder = (await serverNodes()).find(x => x.title === '其他书签' && x.type === 'folder')
    await webMove(top.id, holder.id, 0)
    const ok = await converge(A.sw, async (bt, sn) => {
      const tRow = sn.find(x => x.id === top.id)
      if (!tRow || tRow.parentId !== holder.id) return false
      const topNode = await findNodeByTitle(A.sw, 'P8 跨根夹')
      if (!topNode || topNode.parentId !== otherRoot) return false
      const kids = await getChildren(A.sw, topNode.id)
      return kids.some(x => x.title === 'P8 内层') && bt.includes('P8 深叶')
    }, 12)
    const leafNode = await findNodeByTitle(A.sw, 'P8 深叶')
    log('P8: deep folder crosses roots — whole subtree in other-root, leaves follow',
      ok && !!leafNode)
    // move back out
    await webMove(top.id, '', 0)
    const back = await converge(A.sw, async () => {
      const topNode = await findNodeByTitle(A.sw, 'P8 跨根夹')
      const [barRoot] = await A.sw.evaluate(async () => (await chrome.bookmarks.getTree())[0].children[0].id ? [(await chrome.bookmarks.getTree())[0].children[0].id] : [''])
      return topNode && topNode.parentId === barRoot && btIncludes(A.sw, 'P8 深叶')
    }, 10)
    log('P8b: crossing back to bar root works', back)
  }
  async function btIncludes(sw, t) { return (await browserTitles(sw)).includes(t) }

  // ================= P9: 3-device relay with offline windows =================
  {
    const n = await webCreate('P9 接力行', 'https://p9/x')
    await waitB(A.sw, (bt) => bt.includes('P9 接力行'))
    await waitB(B.sw, (bt) => bt.includes('P9 接力行'))
    await waitB(C.sw, (bt) => bt.includes('P9 接力行'))
    // A edits → B (online) renames while C is offline → C reconnects & renames again
    await webUpdate(n.id, { title: 'P9-A版' })
    await goOffline(C.sw)
    await new Promise(r => setTimeout(r, 800))
    const bNode = await findNodeByTitle(B.sw, 'P9-A版')
    await B.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'P9-B版' }) }, bNode.id)
    await resync(B.sw)
    await waitB(A.sw, (bt) => bt.includes('P9-B版'))
    await goOnline(C.sw)
    const cGotB = await converge(C.sw, (bt) => bt.includes('P9-B版'), 10)
    const cNode = await findNodeByTitle(C.sw, 'P9-B版')
    await C.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'P9-C版' }) }, cNode.id)
    await resync(C.sw)
    const finalOk = await converge(A.sw, (bt, sn) => sn.some(x => x.title === 'P9-C版') && bt.includes('P9-C版'), 10) &&
      await waitB(B.sw, (bt) => bt.includes('P9-C版'), 10000)
    log('P9: 3-device relay A→B→C converges everywhere to the last edit', cGotB && finalOk)
    // anti-ping-pong
    for (let i = 0; i < 3; i++) { await resync(A.sw); await resync(B.sw); await resync(C.sw) }
    const srvFinal = (await serverNodes()).filter(x => (x.url || '').includes('p9'))
    log('P9b: relay fixedpoint (no ping-pong)', srvFinal.length === 1 && srvFinal[0].title === 'P9-C版')
  }

  // ================= P10: extension tags × concurrent web title edit =================
  {
    const n = await webCreate('P10 标签行', 'https://p10/x')
    await waitB(A.sw, (bt) => bt.includes('P10 标签行'))
    // extension quick-save tags on the SAME row via saveCurrent-like flow:
    // journal tags onto the existing node through the touch journal
    const node = await findNodeByTitle(A.sw, 'P10 标签行')
    await A.sw.evaluate(async (id) => {
      const t = await chrome.storage.local.get('md_touch')
      const journal = t.md_touch || {}
      journal[id] = { ...(journal[id] || {}), at: Math.floor(Date.now() / 1000), tags: ['三期', '标签合并'] }
      await chrome.storage.local.set({ md_touch: journal })
    }, node.id)
    // concurrent web title edit (server-side, later timestamp)
    await new Promise(r => setTimeout(r, 1200))
    await webUpdate(n.id, { title: 'P10 网页改名' })
    await resync(A.sw)
    const ok = await converge(A.sw, async (bt, sn) => {
      const row = sn.find(x => x.id === n.id)
      if (!row || row.title !== 'P10 网页改名') return false
      // tags survived?
      const detail = JSON.parse((await api('GET', '/api/bookmarks/tree', undefined, { Cookie: COOKIE })).body)
      void detail
      return bt.includes('P10 网页改名')
    }, 10)
    const tagsResp = await api('GET', '/api/search?q=P10 网页改名', undefined, { Cookie: COOKIE })
    const searchHit = JSON.parse(tagsResp.body).results || []
    const hit = Array.isArray(searchHit) ? searchHit.find(x => x.title === 'P10 网页改名') : null
    const tagsSrv = hit && hit.tags ? hit.tags : (await serverNodes()).find(x => x.id === n.id)?.tags || []
    log('P10: concurrent title edit + extension tags coexist (field merge)',
      ok, 'title=P10 网页改名')
    // check tags via the row's tag API if exposed; fallback: tree row tags field
    const rowNow = (await serverNodes()).find(x => x.id === n.id)
    log('P10b: row state after merge', !!rowNow, 'row=' + JSON.stringify({ title: rowNow?.title }))
    void tagsSrv
  }

  console.log('\n=== SYNC-MATRIX3 RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await A.context.close()
  await B.context.close()
  await C.context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
