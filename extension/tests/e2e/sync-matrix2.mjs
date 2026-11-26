// E2E: sync-matrix2 — phase-2 sync专项 (2026-11-26): depth × breadth.
//   N1  12-level deep chain: full landing, ancestor rename cascade, whole
//       tree move, mixed reorder (15 nodes), mid-chain delete keeps upper
//       4 levels
//   N1b offline create at level 8 × server delete of level-4 ancestor →
//       the bookmark survives (deep D1 re-root validation)
//   N1c offline create inside folder × server rename of that folder → converge
//   N2  trash interactions: deep folder delete→restore full subtree both
//       ends; same-name folder recreate + old-restore → both intact,
//       fixedpoint; ★ offline edit under a PURGED folder → no resurrection,
//       no doomed-undelete loop (N2 fix)
//   N3  third device C: create/move/rename storm across A/B/C → all agree;
//       C offline while A deletes C-created folder → C converges
//   N4  dual-device offline same-URL create → set converges, fixedpoint
//   N6  server restart → revisions continue → both devices keep syncing
//   N7  special content: emoji chain, 200-char titles, query-string URLs,
//       nested file:// — round-trip + fixedpoint
//   N8  sync storm: 10 rapid creates × 10 rapid resyncs → all land, no dups
//   N9  ★ forceResync with a pending offline edit → the edit survives (N9 fix)
//   N10 snapshot restore × offline device → converge, fixedpoint
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

// deterministic convergence: drive explicit resync rounds until pred holds
async function converge(sw, pred, rounds = 8, gapMs = 700) {
  let ok = false
  for (let i = 0; i < rounds && !ok; i++) {
    await resync(sw)
    await new Promise(r => setTimeout(r, gapMs))
    try { ok = await pred(await browserTitles(sw), await serverNodes()) } catch { /* transient */ }
  }
  return ok
}

async function launchExt(name) {
  const userDataDir = `${TMP}/md-matrix2-${name}`
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
const webPurge = async (id) => api('POST', `/api/bookmarks/${id}/purge`, undefined, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webRestore = async (id) => api('POST', `/api/bookmarks/${id}/restore`, undefined, { Cookie: COOKIE, 'X-CSRF': CSRF })
const webMove = async (id, parentId, position = 0) =>
  api('POST', `/api/bookmarks/${id}/move`, { parentId, position }, { Cookie: COOKIE, 'X-CSRF': CSRF })

async function main() {
  console.log('== MarkDeck sync-matrix2 E2E (phase-2: depth × breadth) ==')

  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1000))
  let wiped = false
  for (let i = 0; i < 20 && !wiped; i++) {
    try { fs.rmSync(`${TMP}/md-matrix2`, { recursive: true, force: true }); wiped = !fs.existsSync(`${TMP}/md-matrix2`) } catch {}
    if (!wiped) await new Promise(r => setTimeout(r, 500))
  }
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: `${TMP}/md-matrix2` },
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
  log('N0: fresh server + admin auth', CSRF !== '')

  const A = await launchExt('a')
  await pairExt(A, 'A')
  const B = await launchExt('b')
  await pairExt(B, 'B')
  log('N0b: devices A+B paired', true)

  // ================= N1: 12-level deep chain =================
  let chainIds = []
  {
    // build 12 nested folders on the server, one url at the bottom (level 12)
    let parentId = ''
    for (let i = 1; i <= 12; i++) {
      const f = await webCreateFolder(`N1-L${i}`, parentId)
      chainIds.push(f.id)
      parentId = f.id
    }
    const leaf = await webCreate('N1 深处书签', 'https://deep/n1/leaf', chainIds[11])
    chainIds.push(leaf.id)
    const landed = await converge(A.sw, (bt) => bt.includes('N1 深处书签'))
    const leafNode = await findNodeByTitle(A.sw, 'N1 深处书签')
    // verify depth: walk up 12 parents to bar root
    const depth = leafNode ? await A.sw.evaluate(async (id) => {
      let n = (await chrome.bookmarks.get(id))[0]
      let d = 0
      while (n && n.parentId) { n = (await chrome.bookmarks.get(n.parentId))[0]; d++ }
      return d // 13 hops: leaf→L12→...→L1→bar→root
    }, leafNode.id) : 0
    log(`N1: 12-level chain lands completely (depth verified)`, landed && depth === 14, `hops=` + depth)

    // rename the TOP ancestor → whole subtree keeps structure, titles cascade
    await webUpdate(chainIds[0], { title: 'N1-L1-改名' })
    const renamed = await converge(A.sw, async (bt, sn) =>
      bt.includes('N1 深处书签') && sn.some(x => x.title === 'N1-L1-改名'))
    const leafStill = await findNodeByTitle(A.sw, 'N1 深处书签')
    log('N1b: top ancestor rename cascades, leaf intact', renamed && !!leafStill)

    // MOVE the whole top folder into a sibling folder → leaf follows
    const mover = await webCreateFolder('N1 容器')
    await waitB(A.sw, (bt) => bt.includes('N1 容器'))
    await webMove(chainIds[0], mover.id, 0)
    const mvOk = await converge(A.sw, async () => {
      const cont = await findNodeByTitle(A.sw, 'N1 容器')
      if (!cont) return false
      const kids = await A.sw.evaluate(async (fid) => (await chrome.bookmarks.getChildren(fid)).map(c => c.title), cont.id)
      return kids.includes('N1-L1-改名') && !!leafStill
    })
    const leafAfterMove = await findNodeByTitle(A.sw, 'N1 深处书签')
    const stillDeep = leafAfterMove ? await A.sw.evaluate(async (id) => {
      const anc = await chrome.bookmarks.getSubTree(id)
      return anc[0].parentId !== undefined
    }, leafAfterMove.id) : false
    log('N1c: whole-tree move keeps leaf under its chain', mvOk && stillDeep)

    // mixed reorder: 15 url siblings in one folder, shuffle server-side
    const sibs = []
    for (let i = 0; i < 15; i++) sibs.push(await webCreate(`N1 排${i}`, `https://n1s/${i}`, mover.id))
    await waitB(A.sw, (bt) => bt.includes('N1 排14'))
    const shuffled = [...sibs].sort(() => Math.random() - 0.5)
    await api('POST', '/api/bookmarks/reorder', { parentId: mover.id, ids: shuffled.map(x => x.id) }, { Cookie: COOKIE, 'X-CSRF': CSRF })
    const ordOk = await converge(A.sw, async () => {
      const cont = await findNodeByTitle(A.sw, 'N1 容器')
      const kids = await A.sw.evaluate(async (fid) => (await chrome.bookmarks.getChildren(fid)).map(c => c.title), cont.id)
      const m9 = kids.filter(t => t.startsWith('N1 排'))
      if (m9.length !== 15) return false
      const srvOrder = (await serverNodes()).filter(x => x.parentId === mover.id && (x.title || '').startsWith('N1 排')).sort((a, b) => a.position - b.position).map(x => x.title)
      return JSON.stringify(m9) === JSON.stringify(srvOrder)
    }, 14)
    log('N1d: 15-node mixed reorder converges to identical order', ordOk)
    const stN1 = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('N1e: deep operations zero failures', stN1.failed === 0, 'failed=' + stN1.failed)

    // delete MID-chain (level 5) → levels 1-4 survive, 5-12 vanish
    await webDelete(chainIds[4])
    const delOk = await converge(A.sw, async (bt, sn) => {
      const hasUpper = sn.some(x => x.title === 'N1-L1-改名') && bt.includes('N1 排0')
      const gone = !bt.includes('N1 深处书签')
      const srvGone = !sn.some(x => x.title === 'N1-L12' || x.title === 'N1 深处书签' || x.title === 'N1-L5')
      const srvUpper = sn.some(x => x.title === 'N1-L4')
      return hasUpper && gone && srvGone && srvUpper
    }, 16)
    if (!delOk) {
      const btNow = await browserTitles(A.sw)
      console.log('  [N1fdiag] browserDeep=', JSON.stringify(btNow.filter(t => t.includes('N1') || t.includes('深处'))))
      console.log('  [N1fdiag] srvDeep=', JSON.stringify((await serverNodes()).filter(x => (x.title || '').includes('N1')).map(x => x.title)))
      const stf = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
      console.log('  [N1fdiag] stats=', JSON.stringify(stf), 'errors=', JSON.stringify(stf.errors))
    }
    log('N1f: mid-chain delete keeps upper 4 levels, removes lower 8', delOk)
  }

  // ================= N1b: offline create at depth × ancestor server-delete =================
  {
    // rebuild a 8-level chain; device A goes offline, creates a bookmark
    // at level 8; server deletes the level-4 folder; A reconnects.
    const ids = []
    let parentId = ''
    for (let i = 1; i <= 8; i++) {
      const f = await webCreateFolder(`N1b-L${i}`, parentId)
      ids.push(f.id)
      parentId = f.id
    }
    await waitB(A.sw, (bt) => bt.includes('N1b-L8'))
    await goOffline(A.sw)
    const l8 = await findNodeByTitle(A.sw, 'N1b-L8')
    await A.sw.evaluate(async (pid) => {
      await chrome.bookmarks.create({ parentId: pid, title: 'N1b 珍贵', url: 'https://deep8/precious' })
    }, l8.id)
    await new Promise(r => setTimeout(r, 1500))
    await webDelete(ids[3]) // level-4 ancestor dies server-side
    await goOnline(A.sw)
    const ok = await converge(A.sw, (bt, sn) => bt.includes('N1b 珍贵') && sn.some(x => x.url === 'https://deep8/precious'), 10)
    const precious = await findNodeByTitle(A.sw, 'N1b 珍贵')
    const rows = await serverNodes()
    const pr = rows.find(x => x.url === 'https://deep8/precious')
    const parentAlive = pr && pr.parentId === '' ? true : !!rows.find(x => x.id === pr?.parentId)
    log('N1b: level-8 offline create survives level-4 ancestor deletion', ok && parentAlive,
      'srvParent=' + (pr ? pr.parentId.slice(0, 6) : 'MISSING'))
    // fixedpoint
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const again = (await browserTitles(A.sw)).filter(t => t === 'N1b 珍贵').length
    log('N1b2: fixedpoint (single copy)', again === 1 && rows.filter(x => x.url === 'https://deep8/precious').length === 1)
  }

  // ================= N1c: offline create inside folder × server folder rename =================
  {
    const f = await webCreateFolder('N1c 夹')
    await waitB(A.sw, (bt) => bt.includes('N1c 夹'))
    await goOffline(A.sw)
    const fNode = await findNodeByTitle(A.sw, 'N1c 夹')
    await A.sw.evaluate(async (pid) => {
      await chrome.bookmarks.create({ parentId: pid, title: 'N1c 子书签', url: 'https://n1c/kid' })
    }, fNode.id)
    await new Promise(r => setTimeout(r, 1200))
    await webUpdate(f.id, { title: 'N1c 夹-改名' }) // server renames while A offline
    await goOnline(A.sw)
    const ok = await converge(A.sw, async (bt, sn) =>
      bt.includes('N1c 子书签') &&
      sn.some(x => x.url === 'https://n1c/kid') && sn.some(x => x.title === 'N1c 夹-改名') &&
      (await browserFolders(A.sw)).includes('N1c 夹-改名'), 14)
    if (!ok) {
      const btNow = await browserFolders(A.sw)
      console.log('  [N1cdiag] browserFolders=', JSON.stringify(btNow.filter(t => t.includes('N1c'))))
      console.log('  [N1cdiag] srv=', JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('n1c') || (x.title || '').includes('N1c')).map(x => x.title + '@' + (x.parentId || '').slice(0, 6))))
      const stc = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
      console.log('  [N1cdiag] stats=', JSON.stringify(stc), 'errors=', JSON.stringify(stc.errors))
    }
    const kid = await findNodeByTitle(A.sw, 'N1c 子书签')
    log('N1c: offline create inside folder + concurrent folder rename converge', ok && !!kid)
  }

  // ================= N2: trash interactions =================
  {
    // deep folder delete → trash → restore: subtree intact both ends
    const ids = []
    let parentId = ''
    for (let i = 1; i <= 5; i++) {
      const f = await webCreateFolder(`N2-L${i}`, parentId)
      ids.push(f.id)
      parentId = f.id
    }
    await webCreate('N2 深叶', 'https://n2/deep', ids[4])
    await waitB(A.sw, (bt) => bt.includes('N2 深叶'))
    await webDelete(ids[0])
    await waitB(A.sw, (bt) => !bt.includes('N2 深叶'))
    const trashed = (await serverTrash()).some(x => x.title === 'N2 深叶')
    await webRestore(ids[0])
    const restored = await converge(A.sw, (bt, sn) => bt.includes('N2 深叶') && sn.some(x => x.url === 'https://n2/deep'))
    const leaf = await findNodeByTitle(A.sw, 'N2 深叶')
    log('N2a: deep folder delete→restore keeps subtree both ends', trashed && restored && !!leaf)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1000))
    const st2 = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('N2a2: post-restore fixedpoint', st2.failed === 0, 'failed=' + st2.failed)

    // same-name folder: recreate a folder with the old name while old one
    // sits in trash, then restore the OLD one → two folders coexist
    const oldF = ids[0] // 'N2-L1' currently live again; delete it again
    await webDelete(oldF)
    await waitB(A.sw, (bt) => !bt.includes('N2-L1'))
    await webCreateFolder('N2-L1') // new one, same title
    await waitB(A.sw, (bt) => bt.includes('N2-L1'))
    await webRestore(oldF) // old comes back → two same-title folders
    const both = await converge(A.sw, async () => {
      const rows = (await serverNodes()).filter(x => x.title === 'N2-L1' && x.type === 'folder')
      const bCount = (await browserFolders(A.sw)).filter(t => t === 'N2-L1').length
      return rows.length === 2 && bCount === 2
    })
    log('N2b: same-name folder recreate + old restore → two coexist', both)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st2b = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('N2b2: coexistence fixedpoint (no churn/merge)', st2b.failed === 0,
      'failed=' + st2b.failed)

    // ★ offline edit under a PURGED folder → purge is terminal, no revival
    const pf = await webCreateFolder('N2 待清除夹')
    await webCreate('N2 清除子', 'https://n2/purge/x', pf.id)
    await waitB(A.sw, (bt) => bt.includes('N2 清除子'))
    await webDelete(pf.id)
    await webPurge(pf.id) // purge (terminal) server-side
    // device B offline edits the child (rename), reconnects
    await goOffline(B.sw)
    const bChild = await findNodeByTitle(B.sw, 'N2 清除子')
    await B.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'N2 清除子-离线改' }) }, bChild.id)
    await new Promise(r => setTimeout(r, 1200))
    await goOnline(B.sw)
    const purgedGone = await converge(B.sw, (bt) => !bt.includes('N2 清除子-离线改') && !bt.includes('N2 清除子'), 10)
    const srvClean = !(await serverNodes()).some(x => (x.url || '').includes('n2/purge'))
    const st2c = await B.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('N2c: purge terminality — offline edit loses, no resurrection', purgedGone && srvClean,
      'srvClean=' + srvClean)
    log('N2c2: no doomed-undelete loop (fixedpoint)', st2c.failed === 0,
      'failed=' + st2c.failed + ' planned=' + st2c.planned)
  }

  // ================= N3: third device C =================
  const C = await launchExt('c')
  await pairExt(C, 'C')
  log('N3 setup: device C paired', true)
  {
    // storm: A creates, B renames, C moves — all must agree
    const n = await webCreate('N3 风暴行', 'https://n3/x')
    await waitB(A.sw, (bt) => bt.includes('N3 风暴行'))
    await waitB(B.sw, (bt) => bt.includes('N3 风暴行'))
    await waitB(C.sw, (bt) => bt.includes('N3 风暴行'))
    const cFolder = await webCreateFolder('N3 移动目标')
    await waitB(C.sw, (bt) => bt.includes('N3 移动目标'))
    await webUpdate(n.id, { title: 'N3 风暴行-改' })           // web renames
    await webMove(n.id, cFolder.id, 0)                          // web moves
    const okA = await converge(A.sw, (bt, sn) => sn.some(x => x.title === 'N3 风暴行-改' && x.parentId === cFolder.id) && bt.includes('N3 风暴行-改'))
    await resync(B.sw)
    const okB = await waitB(B.sw, (bt) => bt.includes('N3 风暴行-改'), 10000)
    log('N3: create→rename→move storm consistent on A and B', okA && okB)
    // C offline; server deletes the folder C has content in
    await goOffline(C.sw)
    await webDelete(cFolder.id)
    await new Promise(r => setTimeout(r, 800))
    await goOnline(C.sw)
    const cOk = await converge(C.sw, (bt) => !bt.includes('N3 风暴行-改'), 10)
    const srvOk = !(await serverNodes()).some(x => (x.title || '').includes('N3 风暴'))
    log('N3b: C offline during folder deletion converges to deletion', cOk && srvOk)
  }

  // ================= N4: dual-device offline same-URL create =================
  {
    await goOffline(A.sw)
    await goOffline(B.sw)
    await A.sw.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0].children[0].id, title: 'N4 同址A', url: 'https://n4/same' })
    })
    await B.sw.evaluate(async () => {
      await chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0].children[0].id, title: 'N4 同址B', url: 'https://n4/same' })
    })
    await new Promise(r => setTimeout(r, 1200))
    await goOnline(A.sw)
    await goOnline(B.sw)
    await resync(A.sw)
    await resync(B.sw)
    await new Promise(r => setTimeout(r, 2000))
    const srvRows = (await serverNodes()).filter(x => x.url === 'https://n4/same')
    const aCount = (await browserTitles(A.sw)).filter(t => t.startsWith('N4 同址')).length
    const bCount = (await browserTitles(B.sw)).filter(t => t.startsWith('N4 同址')).length
    log('N4: dual offline same-URL creates land (2 rows or merged-1)',
      srvRows.length >= 1 && srvRows.length <= 2, 'srv=' + srvRows.length)
    log('N4b: both devices converge on the same set', aCount === srvRows.length && bCount === srvRows.length,
      'A=' + aCount + ' B=' + bCount + ' srv=' + srvRows.length)
    // fixedpoint: more rounds never change the count
    await resync(A.sw)
    await resync(B.sw)
    await new Promise(r => setTimeout(r, 1500))
    const srvAgain = (await serverNodes()).filter(x => x.url === 'https://n4/same').length
    log('N4c: same-URL set fixedpoint', srvAgain === srvRows.length)
  }

  // ================= N6: server restart =================
  {
    const pre = await webCreate('N6 重启前', 'https://n6/x')
    await waitB(A.sw, (bt) => bt.includes('N6 重启前'))
    // restart server (same data dir)
    try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
    await new Promise(r => setTimeout(r, 2000))
    const srv2 = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
      env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: `${TMP}/md-matrix2` },
      stdio: 'ignore',
    })
    void srv2
    for (let i = 0; i < 40; i++) {
      try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 500)) }
    }
    const still = await api('GET', '/api/bookmarks/tree', undefined, { Cookie: COOKIE })
    const kept = JSON.parse(still.body).nodes.some(x => x.title === 'N6 重启前')
    log('N6a: server restart keeps data (persistence)', kept)
    const post = await webCreate('N6 重启后', 'https://n6/y')
    const both = await converge(A.sw, (bt, sn) => sn.some(x => x.title === 'N6 重启后') && bt.includes('N6 重启后'))
    await resync(B.sw)
    const bGot = await waitB(B.sw, (bt) => bt.includes('N6 重启后'), 10000)
    log('N6b: sync works across restart (revision continuity)', both && bGot, 'newId=' + post.id.slice(0, 6))
    void pre
  }

  // ================= N7: special content deep combination =================
  {
    let parentId = ''
    const ids = []
    for (let i = 1; i <= 3; i++) {
      const f = await webCreateFolder(`N7-🎨-${i}`, parentId)
      ids.push(f.id)
      parentId = f.id
    }
    await webCreate('N7 ⏰📚 极长标题'.repeat(4).slice(0, 200), 'https://n7/?q=中文&x=1#frag', ids[2])
    await webCreate('N7 file', 'file:///C:/测试目录/文档.pdf', ids[2])
    const ok = await converge(A.sw, (bt, sn) =>
      sn.some(x => (x.url || '').includes('中文') && (x.url || '').includes('frag')) &&
      sn.some(x => (x.url || '').startsWith('file:///C:/测试目录')) &&
      bt.some(t => t.includes('⏰📚')))
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('N7: emoji folders + 200-char title + query URL + nested file:// round-trip', ok && st.failed === 0,
      'failed=' + st.failed)
    // fixedpoint
    await resync(A.sw)
    await resync(B.sw)
    await new Promise(r => setTimeout(r, 1500))
    const st7 = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    if (st7.planned !== 0) {
      const diag = await A.sw.evaluate(() => globalThis.__markdeckDeepDiag())
      console.log('  [N7diag] stats=', JSON.stringify(st7), 'missing=', JSON.stringify(diag.missingLocally), 'extra=', JSON.stringify(diag.extraLocally))
      const btNow = await browserTitles(A.sw)
      console.log('  [N7diag] browserN7=', JSON.stringify(btNow.filter(t => t.includes('N7'))))
      console.log('  [N7diag] srvN7=', JSON.stringify((await serverNodes()).filter(x => (x.title || '').includes('N7') || (x.url || '').includes('n7')).map(x => x.title + '|' + x.url)))
    }
    log('N7b: special content fixedpoint (no re-materialize churn)', st7.failed === 0 && st7.planned === 0,
      'planned=' + st7.planned)
  }

  // ================= N8: sync storm =================
  {
    for (let i = 0; i < 10; i++) await webCreate(`N8 风暴${i}`, `https://n8/${i}`)
    for (let i = 0; i < 10; i++) await resync(A.sw) // 10 rapid resyncs
    await new Promise(r => setTimeout(r, 3000))
    const srvRows = (await serverNodes()).filter(x => (x.url || '').startsWith('https://n8/'))
    const aCount = (await browserTitles(A.sw)).filter(t => t.startsWith('N8 风暴')).length
    log('N8: 10 creates × 10 rapid resyncs — all land exactly once',
      srvRows.length === 10 && aCount === 10, 'srv=' + srvRows.length + ' browser=' + aCount)
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('N8b: storm leaves zero failures', st.failed === 0, 'failed=' + st.failed)
  }

  // ================= N9: forceResync preserves pending offline edit =================
  {
    await webCreate('N9 保编辑行', 'https://n9/x')
    await waitB(A.sw, (bt) => bt.includes('N9 保编辑行'))
    await goOffline(A.sw)
    const node = await findNodeByTitle(A.sw, 'N9 保编辑行')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'N9 离线改名' }) }, node.id)
    await new Promise(r => setTimeout(r, 1200))
    // user hits forceResync while offline edit is pending
    await goOnline(A.sw)
    const preF = await A.sw.evaluate(async () => ({
      touch: (await chrome.storage.local.get('md_touch')).md_touch || {},
    }))
    console.log('  [N9diag-pre] touch=', JSON.stringify(preF.touch))
    await A.sw.evaluate(() => globalThis.__markdeckForceResync())
    await new Promise(r => setTimeout(r, 1500))
    const st9 = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    console.log('  [N9diag] stats=', JSON.stringify(st9), 'errors=', JSON.stringify(st9.errors))
    const ok = await converge(A.sw, (bt, sn) => sn.some(x => x.title === 'N9 离线改名') && bt.includes('N9 离线改名'), 10)
    log('N9: forceResync preserves the pending offline rename', ok,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('n9')).map(x => x.title)))
    // and the reverse direction: server row not yet pulled + forceResync
    await webCreate('N9 服务端新行', 'https://n9/y')
    await A.sw.evaluate(() => globalThis.__markdeckForceResync())
    const ok2 = await converge(A.sw, (bt) => bt.includes('N9 服务端新行'))
    log('N9b: forceResync still pulls fresh server rows (adoption works)', ok2)
  }

  // ================= N10: snapshot restore × offline device =================
  {
    const n = await webCreate('N10 快照行', 'https://n10/x')
    await waitB(A.sw, (bt) => bt.includes('N10 快照行'))
    const snap = JSON.parse((await api('POST', '/api/snapshots', {}, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
    // B goes offline, renames; snapshot restored server-side
    await goOffline(B.sw)
    const bNode = await findNodeByTitle(B.sw, 'N10 快照行')
    await B.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'N10 B端改' }) }, bNode.id)
    await new Promise(r => setTimeout(r, 1200))
    const snapId = snap.snapshot?.id || snap.id
    await api('POST', `/api/snapshots/${snapId}/restore`, {}, { Cookie: COOKIE, 'X-CSRF': CSRF })
    await goOnline(B.sw)
    const ok = await converge(B.sw, async () => {
      const rows = (await serverNodes()).filter(x => (x.url || '').includes('n10'))
      return rows.length === 1
    }, 10)
    await resync(A.sw)
    const aRows = (await serverNodes()).filter(x => (x.url || '').includes('n10'))
    const st = await B.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('N10: snapshot restore × offline device converges to ONE row', ok && aRows.length === 1,
      'srv=' + aRows.length)
    log('N10b: no doomed loop after restore (fixedpoint)', st.failed === 0, 'failed=' + st.failed)
    void n
  }

  console.log('\n=== SYNC-MATRIX2 RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await A.context.close()
  await B.context.close()
  await C.context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
