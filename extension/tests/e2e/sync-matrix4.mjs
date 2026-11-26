// E2E: sync-matrix4 — phase-4 sync专项 (2026-11-26): protocol races,
// recovery flows, permission boundaries, clock semantics.
//   Q1  mixed LWW batch: one push wins + one push loses in the SAME
//       apply → winner lands, loser absorbed, fixedpoint, no re-push
//   Q2  fractional-position insert (web between two rows) → per-rank
//       placement, browser order matches, fixedpoint
//   Q3  emptied folder survives server-side child delete (empty folder
//       is legal), fixedpoint
//   Q4  token revocation MID-EDIT: offline edit queued → token revoked →
//       reconnect → unauthorized sticky, edits NOT lost locally, re-pair
//       → edits reach the NEW device identity (no silent loss)
//   Q5  server clock forward-jump: op with future updatedAt (clamped
//       +300) beats a normal edit — document semantics, converge
//   Q6  snapshot restore with PENDING device backlog: restore rewrites
//       rows while a device holds unpushed creates → creates land after
//       restore (both merge), no loss
//   Q7  rapid revoke/re-pair cycles (3×) → each re-pair adopts without
//       duplicates, WS alive at the end
//   Q8  offline create + OFFLINE rename of the same node (compound touch)
//       → one create with the final title
//   Q9  offline delete + offline re-create same URL (delete→make-new) →
//       new node lands, no ghost
//   Q10 concurrent apply from two devices in the same second → both
//       batches fully applied (no lost update), both devices converge
//   Q11 WS reconnect storm: kill server 3× while devices idle → all
//       devices recover to online and stay in sync
//   Q12 extension storage corruption: md_base holds an entry whose
//       localId no longer exists → reconcile self-heals (recreate/adopt),
//       no crash loop
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
  const userDataDir = `${TMP}/md-matrix4-${name}`
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
const webMove = async (id, parentId, position = 0) =>
  api('POST', `/api/bookmarks/${id}/move`, { parentId, position }, { Cookie: COOKIE, 'X-CSRF': CSRF })

async function main() {
  console.log('== MarkDeck sync-matrix4 E2E (phase-4: protocol races × recovery × boundaries) ==')

  execSync(`node "${path.resolve(__dirname, '..', 'helpers', 'patch-manifest-e2e.js')}"`, { stdio: 'ignore' })

  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  await new Promise(r => setTimeout(r, 1000))
  let wiped = false
  for (let i = 0; i < 20 && !wiped; i++) {
    try { fs.rmSync(`${TMP}/md-matrix4`, { recursive: true, force: true }); wiped = !fs.existsSync(`${TMP}/md-matrix4`) } catch {}
    if (!wiped) await new Promise(r => setTimeout(r, 500))
  }
  const srv = spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
    env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: `${TMP}/md-matrix4` },
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
  log('Q0: fresh server + admin auth', CSRF !== '')

  const A = await launchExt('a')
  await pairExt(A, 'A')
  const B = await launchExt('b')
  await pairExt(B, 'B')
  log('Q0b: devices A+B paired', true)

  // ================= Q1: mixed LWW batch (1 winner + 1 loser) =================
  {
    const x1 = await webCreate('Q1 行一', 'https://q1/1')
    const x2 = await webCreate('Q1 行二', 'https://q1/2')
    await waitB(A.sw, (bt) => bt.includes('Q1 行一') && bt.includes('Q1 行二'))
    // A goes offline FIRST, renames BOTH (both edits get offline timestamps)
    await goOffline(A.sw)
    const n1 = await findNodeByTitle(A.sw, 'Q1 行一')
    const n2 = await findNodeByTitle(A.sw, 'Q1 行二')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'Q1 本地版一' }) }, n1.id)
    await new Promise(r => setTimeout(r, 1500))
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'Q1 本地版二' }) }, n2.id)
    await new Promise(r => setTimeout(r, 1500))
    // WHILE A is offline the server renames x1 (later timestamp → x1's
    // server edit must WIN; x2's offline edit is the newest overall → x2 wins)
    await webUpdate(x1.id, { title: 'Q1 服务端版' })
    await goOnline(A.sw)
    const ok = await converge(A.sw, async (bt, sn) => {
      const r1 = sn.find(x => x.id === x1.id)
      const r2 = sn.find(x => x.id === x2.id)
      return r1?.title === 'Q1 服务端版' && r2?.title === 'Q1 本地版二' &&
        bt.includes('Q1 服务端版') && bt.includes('Q1 本地版二')
    }, 12)
    log('Q1: mixed batch — loser absorbed, winner pushed, both converge', ok,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('q1')).map(x => x.title)))
    // fixedpoint: no re-push loop
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q1b: mixed-batch fixedpoint (planned=0, failed=0)', st.failed === 0 && st.planned === 0,
      'planned=' + st.planned)
  }

  // ================= Q2: fractional-position insert between rows =================
  {
    const f = await webCreateFolder('Q2 夹')
    await webCreate('Q2 A', 'https://q2/a', f.id)
    await webCreate('Q2 B', 'https://q2/b', f.id)
    await waitB(A.sw, (bt) => bt.includes('Q2 B'))
    // web inserts C between A and B via move with fractional landing
    const c = await webCreate('Q2 C', 'https://q2/c')
    const rows = (await serverNodes()).filter(x => x.parentId === f.id)
    const aRow = rows.find(x => x.title === 'Q2 A')
    await webMove(c.id, f.id, 1) // between A (pos1) and B (pos2)
    const ok = await converge(A.sw, async () => {
      const fNode = await findNodeByTitle(A.sw, 'Q2 夹')
      const kids = await getChildren(A.sw, fNode.id)
      const order = kids.map(x => x.title).filter(t => t.startsWith('Q2 '))
      return JSON.stringify(order) === JSON.stringify(['Q2 A', 'Q2 C', 'Q2 B'])
    }, 12)
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q2: fractional-position insert lands between (A,C,B) order', ok && st.failed === 0,
      'failed=' + st.failed)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st2 = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q2b: fractional order fixedpoint (planned=0)', st2.planned === 0, 'planned=' + st2.planned)
    void c
    void aRow
  }

  // ================= Q3: emptied folder survives child delete =================
  {
    const f = await webCreateFolder('Q3 将空夹')
    await webCreate('Q3 独子', 'https://q3/x', f.id)
    await waitB(A.sw, (bt) => bt.includes('Q3 独子'))
    const rows = (await serverNodes())
    const child = rows.find(x => x.title === 'Q3 独子')
    await webDelete(child.id)
    const ok = await converge(A.sw, async (bt, sn) =>
      !bt.includes('Q3 独子') && !sn.some(x => x.id === child.id) &&
      (await browserFolders(A.sw)).includes('Q3 将空夹'))
    log('Q3: server child delete leaves an empty folder (kept, legal)', ok)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q3b: empty-folder fixedpoint (folder not re-created/removed)', st.failed === 0 && st.planned === 0,
      'planned=' + st.planned)
  }

  // ================= Q10: same-second concurrent apply from two devices =================
  {
    const f = await webCreateFolder('Q10 竞技场')
    await waitB(A.sw, (bt) => bt.includes('Q10 竞技场'))
    // both devices fire a batch in the SAME second via their tokens
    const cfgA = await A.sw.evaluate(async () => (await chrome.storage.local.get('md_config')).md_config)
    const cfgB = await B.sw.evaluate(async () => (await chrome.storage.local.get('md_config')).md_config)
    const now = Math.floor(Date.now() / 1000)
    const opsA = Array.from({ length: 5 }, (_, i) => ({
      id: 'q10a-' + i, op: 'create', type: 'url', parentId: f.id,
      title: `Q10 A${i}`, url: `https://q10/a${i}`, position: i + 1, updatedAt: now, deviceId: cfgA.deviceId,
    }))
    const opsB = Array.from({ length: 5 }, (_, i) => ({
      id: 'q10b-' + i, op: 'create', type: 'url', parentId: f.id,
      title: `Q10 B${i}`, url: `https://q10/b${i}`, position: i + 1, updatedAt: now, deviceId: cfgB.deviceId,
    }))
    const [rA, rB] = await Promise.all([
      api('POST', '/api/sync/apply', opsA, { Authorization: 'Bearer ' + cfgA.token }),
      api('POST', '/api/sync/apply', opsB, { Authorization: 'Bearer ' + cfgB.token }),
    ])
    const bA = JSON.parse(rA.body || '{}')
    const bB = JSON.parse(rB.body || '{}')
    const errA = (bA.results || []).filter(x => x.error)
    const errB = (bB.results || []).filter(x => x.error)
    const winA = (bA.results || []).filter(x => x.win).length
    const winB = (bB.results || []).filter(x => x.win).length
    const q10Now = (await serverNodes()).filter(x => (x.url || '').startsWith('https://q10/'))
    console.log('  [Q10diag] winA=', winA, 'winB=', winB, 'errs=', JSON.stringify([...errA, ...errB].slice(0, 4)),
      'srvIds=', JSON.stringify(q10Now.map(x => x.id)))
    const srvRows = (await serverNodes()).filter(x => (x.url || '').startsWith('https://q10/'))
    const ok = await converge(A.sw, (bt, sn) => sn.filter(x => (x.url || '').startsWith('https://q10/')).length === 10, 12)
    const bOk = await waitB(B.sw, (bt) => bt.filter(t => t.startsWith('Q10 ')).length === 10, 12000)
    log('Q10: same-second dual-device batches — all 10 rows land (no lost update)',
      rA.status === 200 && rB.status === 200 && srvRows.length === 10 && ok && bOk,
      'srv=' + srvRows.length)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q10b: concurrent-batch fixedpoint', st.failed === 0, 'failed=' + st.failed)
  }

  // ================= Q4: revoke mid-edit → re-pair → edits survive =================
  {
    const n = await webCreate('Q4 撤销行', 'https://q4/x')
    await waitB(A.sw, (bt) => bt.includes('Q4 撤销行'))
    await goOffline(A.sw)
    const node = await findNodeByTitle(A.sw, 'Q4 撤销行')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'Q4 撤销行-离线改' }) }, node.id)
    await new Promise(r => setTimeout(r, 1200))
    // revoke A's device token while the edit is still pending
    const devs = JSON.parse((await api('GET', '/api/devices', undefined, { Cookie: COOKIE })).body)
    const devList = Array.isArray(devs) ? devs : devs.devices || []
    const devRow = devList[0]
    console.log('  [Q4diag] devices=', JSON.stringify(devList.map(d => d.name || d.client_name)))
    if (!devRow) throw new Error('no devices listed')
    const rv = await api('DELETE', `/api/devices/${devRow.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': CSRF })
    await goOnline(A.sw)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1500))
    const st4 = await A.sw.evaluate(() => (chrome.storage.local.get('md_status')).then(s => s.md_status))
    log('Q4a: revoked mid-edit → unauthorized sticky', rv.status === 200 && st4 === 'unauthorized',
      'status=' + st4)
    // local edit must NOT be lost
    const stillLocal = await findNodeByTitle(A.sw, 'Q4 撤销行-离线改')
    log('Q4b: pending edit survives revocation locally', !!stillLocal)
    // re-pair (fresh device identity) → adoption binds, then the pending
    // edit pushes under the new token
    await pairExt(A, 'A2')
    const ok = await converge(A.sw, (bt, sn) => sn.some(x => x.title === 'Q4 撤销行-离线改') && bt.includes('Q4 撤销行-离线改'), 12)
    log('Q4c: after re-pair the pending edit reaches the server (no loss)', ok,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('q4')).map(x => x.title)))
  }

  // ================= Q5: future-timestamp op (clamp semantics) =================
  {
    // push an op with updatedAt = now + 10s (within the 300s clamp) — it
    // wins LWW vs an older normal edit; both devices converge on it
    const n = await webCreate('Q5 时钟行', 'https://q5/x')
    await waitB(A.sw, (bt) => bt.includes('Q5 时钟行'))
    await goOffline(B.sw)
    const bNode = await findNodeByTitle(B.sw, 'Q5 时钟行')
    await B.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'Q5 普通版' }) }, bNode.id)
    await new Promise(r => setTimeout(r, 1200))
    // device-token apply with a future timestamp (clamp window)
    const cfg = await A.sw.evaluate(async () => (await chrome.storage.local.get('md_config')).md_config)
    const future = Math.floor(Date.now() / 1000) + 10
    const r = await api('POST', '/api/sync/apply', [
      { id: n.id, op: 'update', title: 'Q5 未来版', updatedAt: future, deviceId: 'time-travel', observedRevision: 0 },
    ], { Authorization: 'Bearer ' + cfg.token })
    await goOnline(B.sw)
    const ok = await converge(B.sw, (bt, sn) => sn.some(x => x.title === 'Q5 未来版') && bt.includes('Q5 未来版'), 12)
    await resync(A.sw)
    const aOk = await waitB(A.sw, (bt) => bt.includes('Q5 未来版'), 8000)
    log('Q5: future-stamped op (within clamp) wins and converges everywhere',
      r.status === 200 && ok && aOk,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('q5')).map(x => x.title)))
  }

  // ================= Q6: snapshot restore with a pending device backlog =================
  {
    const n = await webCreate('Q6 快照行', 'https://q6/x')
    await waitB(A.sw, (bt) => bt.includes('Q6 快照行'))
    const snap = JSON.parse((await api('POST', '/api/snapshots', {}, { Cookie: COOKIE, 'X-CSRF': CSRF })).body)
    // B goes offline and CREATES two new bookmarks (pending backlog)
    await goOffline(B.sw)
    await B.sw.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children[0]
      await chrome.bookmarks.create({ parentId: bar.id, title: 'Q6 离线建一', url: 'https://q6/new1' })
      await chrome.bookmarks.create({ parentId: bar.id, title: 'Q6 离线建二', url: 'https://q6/new2' })
    })
    await new Promise(r => setTimeout(r, 1500))
    // server-side: delete the snapshot row, then restore the snapshot
    await webDelete(n.id)
    const snapId = snap.snapshot?.id || snap.id
    const rs = await api('POST', `/api/snapshots/${snapId}/restore`, {}, { Cookie: COOKIE, 'X-CSRF': CSRF })
    await goOnline(B.sw)
    const restored = await converge(B.sw, (bt, sn) => sn.some(x => x.title === 'Q6 快照行') && bt.includes('Q6 快照行'), 12)
    const created = await converge(B.sw, (bt, sn) => sn.some(x => x.url === 'https://q6/new1') && sn.some(x => x.url === 'https://q6/new2') && bt.includes('Q6 离线建一') && bt.includes('Q6 离线建二'), 12)
    await resync(A.sw)
    const aAll = await waitB(A.sw, (bt) => bt.includes('Q6 快照行') && bt.includes('Q6 离线建一') && bt.includes('Q6 离线建二'), 10000)
    log('Q6: snapshot restore × pending backlog — restore lands AND backlog lands',
      rs.status === 200 && restored && created && aAll,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('q6')).map(x => x.title)))
    const st = await B.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q6b: restore+backlog zero failures (no loss)', st.failed === 0, 'failed=' + st.failed)
  }

  // ================= Q8: offline create + offline rename (compound touch) =================
  {
    await goOffline(A.sw)
    await A.sw.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children[0]
      await chrome.bookmarks.create({ parentId: bar.id, title: 'Q8 初名', url: 'https://q8/x' })
    })
    await new Promise(r => setTimeout(r, 1200))
    const node = await findNodeByTitle(A.sw, 'Q8 初名')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.update(id, { title: 'Q8 终名' }) }, node.id)
    await new Promise(r => setTimeout(r, 1200))
    await goOnline(A.sw)
    const ok = await converge(A.sw, (bt, sn) => sn.some(x => x.title === 'Q8 终名') && bt.includes('Q8 终名'), 10)
    const ghosts = (await serverNodes()).filter(x => (x.url || '').includes('q8'))
    log('Q8: offline create+rename compounds into ONE row with the final title',
      ok && ghosts.length === 1 && ghosts[0].title === 'Q8 终名',
      'srv=' + JSON.stringify(ghosts.map(x => x.title)))
  }

  // ================= Q9: offline delete + offline re-create same URL =================
  {
    const n = await webCreate('Q9 重生行', 'https://q9/x')
    await waitB(A.sw, (bt) => bt.includes('Q9 重生行'))
    await goOffline(A.sw)
    const node = await findNodeByTitle(A.sw, 'Q9 重生行')
    await A.sw.evaluate(async (id) => { await chrome.bookmarks.removeTree(id) }, node.id)
    await new Promise(r => setTimeout(r, 1000))
    await A.sw.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children[0]
      await chrome.bookmarks.create({ parentId: bar.id, title: 'Q9 重生行-新', url: 'https://q9/x' })
    })
    await new Promise(r => setTimeout(r, 1200))
    await goOnline(A.sw)
    const ok = await converge(A.sw, (bt, sn) => {
      const rows = sn.filter(x => (x.url || '').includes('q9'))
      return rows.length === 1 && rows[0].title === 'Q9 重生行-新' && bt.includes('Q9 重生行-新')
    }, 12)
    log('Q9: offline delete→recreate same URL → one fresh row, no ghost', ok,
      'srv=' + JSON.stringify((await serverNodes()).filter(x => (x.url || '').includes('q9')).map(x => x.title)))
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q9b: delete-recreate fixedpoint', st.failed === 0 && st.planned === 0, 'planned=' + st.planned)
  }

  // ================= Q11: server restart × 3 with idle devices =================
  {
    await webCreate('Q11 重启行', 'https://q11/x')
    let allOk = true
    for (let i = 0; i < 3; i++) {
      try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
      await new Promise(r => setTimeout(r, 1500))
      spawn('D:/Code/AiWorkSpace/ZCode/MarkDeck/.tools/markdeck-test/markdeck-final.exe', [], {
        env: { ...process.env, MARKDECK_ADDR: '127.0.0.1:8999', MARKDECK_DATA: `${TMP}/md-matrix4` },
        stdio: 'ignore',
      })
      for (let k = 0; k < 40; k++) {
        try { await fetch(SERVER + '/api/auth/state'); break } catch { await new Promise(r => setTimeout(r, 500)) }
      }
      await resync(A.sw)
      await resync(B.sw)
      // status may lag (WS reconnect): poll briefly before judging
      let aSt = '', bSt = ''
      for (let k = 0; k < 15; k++) {
        aSt = await A.sw.evaluate(async () => (await chrome.storage.local.get('md_status')).md_status)
        bSt = await B.sw.evaluate(async () => (await chrome.storage.local.get('md_status')).md_status)
        if (aSt === 'online' && bSt === 'online') break
        await new Promise(r => setTimeout(r, 600))
      }
      if (aSt !== 'online' || bSt !== 'online') { allOk = false; console.log('  [Q11diag] round', i, 'aSt=' + aSt, 'bSt=' + bSt); break }
    }
    const row = (await serverNodes()).some(x => x.title === 'Q11 重启行')
    const aHas = (await browserTitles(A.sw)).includes('Q11 重启行')
    const bHas = (await browserTitles(B.sw)).includes('Q11 重启行')
    log('Q11: 3× server restarts — both devices recover online, content intact',
      allOk && row && aHas && bHas)
  }

  // ================= Q12: corrupted md_base entry self-heals =================
  {
    const n = await webCreate('Q12 自愈行', 'https://q12/x')
    await waitB(A.sw, (bt) => bt.includes('Q12 自愈行'))
    // inject a bogus base entry: serverId that doesn't exist, localId of a
    // real node — simulates torn storage; reconcile must not crash-loop
    await A.sw.evaluate(async (realLocalId) => {
      const st = await chrome.storage.local.get('md_base')
      const base = st.md_base
      base.entries['ghost-row-id'] = { server: { id: 'ghost-row-id', parentId: '', type: 'url', title: '幽灵', url: 'https://ghost/x', position: 1, revision: 1, updatedAt: 1 }, localId: realLocalId, appliedAt: 0 }
      await chrome.storage.local.set({ md_base: base })
    }, n.id)
    const r = await resync(A.sw)
    // fullSync returns undefined by design; "ok" = the evaluate did not throw
    const ok = true
    const nodeStill = await findNodeByTitle(A.sw, 'Q12 自愈行')
    const srvStill = (await serverNodes()).some(x => x.id === n.id)
    const st = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    const ghostLeft = await A.sw.evaluate(async () =>
      Object.keys((await chrome.storage.local.get('md_base')).md_base?.entries || {}).includes('ghost-row-id'))
    console.log('  [Q12diag] ghostInBase=', ghostLeft, 'nodeStill=', !!nodeStill, 'srvStill=', srvStill)
    log('Q12: torn md_base entry self-heals (no crash, content intact)',
      ok && !!nodeStill && srvStill && !ghostLeft,
      'failed=' + st.failed + ' planned=' + st.planned)
    await resync(A.sw)
    await new Promise(r => setTimeout(r, 1200))
    const st2 = await A.sw.evaluate(() => globalThis.__markdeckReconcileStats())
    log('Q12b: post-heal fixedpoint (no crash loop)', st2.failed === 0, 'failed=' + st2.failed + ' planned=' + st2.planned)
  }

  // ================= Q7: rapid revoke/re-pair cycles (LAST - it revokes tokens) =================
  {
    const n = await webCreate('Q7 循环行', 'https://q7/x')
    await waitB(A.sw, (bt) => bt.includes('Q7 循环行'))
    let allOk = true
    for (let i = 0; i < 3; i++) {
      const devs = JSON.parse((await api('GET', '/api/devices', undefined, { Cookie: COOKIE })).body)
      const devList = Array.isArray(devs) ? devs : devs.devices || []
      const devRow = devList.find(d => (d.name || '').includes('A') || (d.client_name || '').includes('A')) || devList[0]
      if (!devRow) { allOk = false; break }
      await api('DELETE', `/api/devices/${devRow.id}`, undefined, { Cookie: COOKIE, 'X-CSRF': CSRF })
      await resync(A.sw)
      await new Promise(r => setTimeout(r, 800))
      await pairExt(A, `A-Q7-${i}`)
      const online = await A.sw.evaluate(async () => (await chrome.storage.local.get('md_status')).md_status)
      if (online !== 'online') { allOk = false; break }
      const dup = (await browserTitles(A.sw)).filter(t => t === 'Q7 循环行').length
      if (dup !== 1) { allOk = false; break }
    }
    const srvCount = (await serverNodes()).filter(x => (x.url || '').includes('q7')).length
    const finalStatus = await A.sw.evaluate(async () => (await chrome.storage.local.get('md_status')).md_status)
    log('Q7: 3× revoke/re-pair cycles adopt cleanly (1 row, online at end)',
      allOk && srvCount === 1 && finalStatus === 'online',
      'srv=' + srvCount + ' status=' + finalStatus)
    await webUpdate(n.id, { title: 'Q7 循环行-改' })
    const rt = await waitB(A.sw, (bt) => bt.includes('Q7 循环行-改'), 12000)
    log('Q7b: WS still delivers realtime after cycles', rt)
  }

  console.log('\n=== SYNC-MATRIX4 RESULT ===')
  console.log(`${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`)
  await A.context.close()
  await B.context.close()
  try { srv.kill() } catch {}
  try { execSync('taskkill /F /IM markdeck-final.exe', { stdio: 'ignore' }) } catch {}
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

main().catch(e => { console.error('E2E_FATAL', e); process.exit(2) })
